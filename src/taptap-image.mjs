#!/usr/bin/env node
/**
 * taptap-image — generate a game image asset through an OpenAI-compatible
 * `/images/generations` endpoint, using the user's own model/key/URL.
 *
 * This is the custom image lane for TapTap Maker development: it never touches
 * the Maker MCP built-in image quota. Configure it once (see README), then the
 * agent calls this CLI from pwsh instead of `generate_image`.
 *
 * Usage:
 *   node taptap-image.mjs --prompt "一只橙色小猫，扁平矢量风格" --out D:\tmp\cat.png
 *   node taptap-image.mjs --prompt "..." --out out.png --size 1536x1024 --n 1
 *   node taptap-image.mjs --prompt "蓝色盾牌图标，扁平居中留白" --out icon.png --transparent --downscale 128x128
 *   node taptap-image.mjs --config         # print effective config (key masked)
 *
 * Size is NOT fixed: `--size WxH` passes through to the endpoint. If the
 * endpoint only accepts 1024x1024 / 1024x1536 / 1536x1024, a size-rejection is
 * retried once at the nearest allowed size automatically.
 *
 * Small assets (icons, small UI): generate a clean LARGE image (optionally
 * `--transparent`) then `--downscale WxH` to shrink it with a high-quality
 * resampler. Direct tiny generations come out muddy, so we never ask the model
 * for a sub-256 size. Downscale uses ImageMagick (`magick`) or Python Pillow if
 * present; otherwise the full image is kept and the exact command is printed.
 *
 * Credentials precedence (see src/paths.js resolveImageConfig):
 *   credentialsFile JSON > env (TAPTAP_IMAGE_*) > $DSH_HOME/taptap-maker-dev/image.json
 *
 * Safety: the resolved API key is NEVER printed in full and must live outside
 * any TapTap Maker project workspace (the Maker runtime auto-commits the repo).
 *
 * @module src/taptap-image.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolveImageConfig, maskSecret, imageConfigPath, resolveDshHome } from './paths.js'
import { flagOf, looksLikeFlag, consumeFlags, splitTokens, flagValue, flagList } from './tokens.mjs'
import {
  assertReferenceOutputIsSeparate,
  expandReferencePath,
  prepareReferenceImages,
  publicReferencePreparation,
} from './reference-image-preparation.mjs'

const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024'])

/**
 * 解析 `/taptap-image <描述> [--ref …] [--size …] [--transparent …]` 的斜杠命令输入。
 *
 * 为什么不能用正则剥 flag（旧写法）：flag 表是人工维护的白名单，漏一个就是
 * 「合法参数没人认领」。实测过的真实后果：
 *   - `--transparent` **既不剥掉也不转发**：用户写「盾牌图标 --transparent」，
 *     字面 `--transparent` 被当成画面描述发给模型，而且**不会要透明底**
 *     （本模块的 generateImage 本来就支持 transparent 参数）；
 *   - `--size=512x512` 等号连写整段留在提示词里、size 值丢失；
 *   - `--ref` 漏值时把下一个 flag 名当参考图（`--ref --size 512x512` →
 *     refs=["--size"]，而 `512x512` 漏进提示词）。
 * 现在统一走 tokens.mjs 的 consumeFlags：flag 语义只有一份，加参数只改这张表。
 *
 * 导出以便测试直接打真实实现（在测试里复刻一份 spec 表等于没测）。
 */
export function parseSlashArgs(raw) {
  const res = consumeFlags(splitTokens(raw), {
    ref: { into: 'refs', list: true },
    refs: { into: 'refs', list: true },
    reference: { into: 'refs', list: true },
    references: { into: 'refs', list: true },
    r: { into: 'refs', list: true },
    size: { into: 'size' },
    s: { into: 'size' },
    downscale: { into: 'downscale' },
    d: { into: 'downscale' },
    transparent: { into: 'transparent', kind: 'bool' },
    'multi-ref': { into: 'multiRef', kind: 'bool' },
    'single-ref': { into: 'singleRef', kind: 'bool' },
    // --prompt 的值并进提示词（只丢 flag 名，不丢整段）。
    prompt: { into: '@rest' },
  })
  return {
    prompt: res.prompt,
    refs: flagList(res, 'refs'),
    size: flagValue(res, 'size'),
    downscale: flagValue(res, 'downscale'),
    transparent: res.bools.transparent === true,
    multiRef: res.bools['multi-ref'] === true,
    singleRef: res.bools['single-ref'] === true,
    missing: res.missing,
  }
}

/** 导出以便测试直接打真实实现（复刻一份解析器等于没测）。 */
export function parseArgs(argv) {
  // 用 tokens.mjs 的 flagOf / looksLikeFlag（对齐 Python argparse），与
  // taptap-gpt / taptap-sfx / taptap-zaiduyu 同一套语义。之前各写一套判断
  // （`startsWith('--')` / `startsWith('-')` / 正则），同一句话在不同链路上
  // 结果不同 —— 属于最难查的一类 bug。本 CLI 对外只承诺长格式，短开关照旧忽略。
  const args = { _: [] }
  const list = argv ?? []
  const put = (key, value) => {
    // 重复出现的键收成数组（`--in a.png --in b.png`）；单次仍是字符串，
    // 保持既有调用方（resolveImageConfig 读 args.apiKey 等）不受影响。
    args[key] = args[key] === undefined
      ? value
      : (Array.isArray(args[key]) ? [...args[key], value] : [args[key], value])
  }
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i])
    if (token === '--') { args._.push(...list.slice(i + 1).map(String)); break }
    const f = flagOf(token)
    if (f === null) { args._.push(token); continue }
    // 短开关不在本 CLI 的支持面内：原样当位置参数，不猜它的含义。
    if (!f.raw.startsWith('--')) { args._.push(token); continue }
    if (f.inline !== null) { put(f.name, f.inline); continue }
    const next = list[i + 1]
    if (next === undefined || looksLikeFlag(next)) put(f.name, true)
    else { put(f.name, String(next)); i += 1 }
  }
  return args
}

/**
 * 收集所有输入图（支持 `--in a.png --in b.png`、`--in a.png,b.png`、`--refs`）。
 *
 * 多图参考是 OpenAI 兼容 `/images/edits` 的标准能力（`image[]` 数组，gpt-image-1
 * 最多 16 张）。但**不是所有模型都支持**：老式 DALL·E 系只吃一张，很多中转站
 * 自建模型也只实现单图。这里只负责收集，是否允许多图由调用方按模型判断。
 */
function collectInputs(args) {
  const raw = []
  for (const key of ['in', 'input', 'ref', 'refs']) {
    const v = args[key]
    if (v === undefined || v === true) continue
    const list = Array.isArray(v) ? v : [v]
    for (const item of list) {
      if (typeof item !== 'string' || item.trim() === '') continue
      // 逗号分隔是用户手写多图的常见形式；但 Windows 路径不含英文逗号，
      // 所以按逗号切分是安全的。
      for (const part of item.split(',')) {
        const p = part.trim()
        if (p.length > 0) raw.push(p)
      }
    }
  }
  // 去重但保序：同一个文件重复传会让上游把权重放大，通常不是用户本意。
  const seen = new Set()
  const out = []
  for (const p of raw) {
    const abs = expandReferencePath(p)
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push(abs)
  }
  return out
}

/**
 * 已知**只支持单图**的模型特征。命中即拒绝多图，而不是把多图发给它再吃一个
 * 语焉不详的 400（那会浪费一次请求，用户还看不出原因）。
 *
 * 判定刻意保守：只列出「确定单图」的老模型；其余交给用户用 `--multi-ref`
 * 显式声明或让上游如实报错。宁可让上游说，也不要替用户猜错而少传一张图。
 */
const SINGLE_IMAGE_MODEL_HINTS = [
  /dall-?e[-_ ]?3/i,
  /dall-?e[-_ ]?2/i,
  /stable-?diffusion/i,
  /\bsdxl\b/i,
  /flux[-_.]?1[-_.]?(schnell|dev)(?!.*kontext)/i,
]

/** 这个模型名看起来只支持单图参考吗？ */
function looksSingleImageModel(model) {
  const m = String(model ?? '')
  if (m.length === 0) return false
  return SINGLE_IMAGE_MODEL_HINTS.some((re) => re.test(m))
}

/** Parse "WxH" into { w, h } or null. */
function parseWH(spec) {
  const m = /^(\d+)x(\d+)$/.exec(String(spec || '').trim())
  if (m === null) return null
  return { w: Number(m[1]), h: Number(m[2]) }
}

/** Snap an arbitrary size to the sizes the common endpoints accept (retry fallback). */
function snapSize(size) {
  if (ALLOWED_SIZES.has(size)) return size
  const wh = parseWH(size)
  if (wh === null) return '1024x1024'
  if (wh.w === wh.h) return '1024x1024'
  return wh.w > wh.h ? '1536x1024' : '1024x1536'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Downscale an image file to fit within WxH using the first available tool.
 * Keeps aspect ratio. Returns { ok, tool, hint }.
 */
export function downscaleFile(src, dst, spec) {
  const wh = parseWH(spec)
  if (wh === null) return { ok: false, hint: `invalid --downscale "${spec}" (expected WxH)` }
  const quiet = { stdio: 'ignore' }
  // 1) ImageMagick v7 (magick) / v6 (convert)
  for (const [bin, pre] of [['magick', []], ['convert', []]]) {
    const probe = spawnSync(bin, ['-version'], quiet)
    if (probe.status === 0) {
      const r = spawnSync(bin, [...pre, src, '-resize', `${wh.w}x${wh.h}`, dst], quiet)
      if (r.status === 0 && fs.existsSync(dst)) return { ok: true, tool: bin }
    }
  }
  // 2) Python + Pillow
  const py = `from PIL import Image\nim=Image.open(${JSON.stringify(src)})\nim.thumbnail((${wh.w},${wh.h}),Image.LANCZOS)\nim.save(${JSON.stringify(dst)})`
  for (const bin of ['python', 'python3', 'py', process.env.TAPTAP_PY].filter(Boolean)) {
    const r = spawnSync(bin, ['-c', py], quiet)
    if (r.status === 0 && fs.existsSync(dst)) return { ok: true, tool: `${bin}+Pillow` }
  }
  return {
    ok: false,
    hint: `no resizer found (install ImageMagick or Python+Pillow). Full image kept at ${src}. `
      + `Manual: magick "${src}" -resize ${wh.w}x${wh.h} "${dst}"`,
  }
}

/**
 * Generate one or more images and write the first (or all) to disk.
 * - size passes through; a size-rejection is retried once snapped.
 * - --transparent requests a transparent background; a param rejection is
 *   retried once without it.
 * - HTTP 400 content_policy is retried with slow backoff (random relay false
 *   positives, not prompt errors).
 */
export async function generateImage(options) {
  const cfg = resolveImageConfig(options)
  if (cfg.baseURL.length === 0 || cfg.apiKey.length === 0 || cfg.model.length === 0) {
    throw new Error(
      `custom image endpoint not configured. Set baseURL / apiKey / model in ${imageConfigPath(options.dshHome)} ` +
      '(or TAPTAP_IMAGE_BASE_URL / TAPTAP_IMAGE_API_KEY / TAPTAP_IMAGE_MODEL env). Run with --config to inspect.',
    )
  }
  let size = String(options.size || cfg.size || '1024x1024').trim()
  let background = options.transparent === true || options.transparent === 'true' ? 'transparent' : undefined
  const n = Number(options.n || cfg.n || 1)
  // This endpoint is still text-to-image. Declared inputs do not change that
  // route, but none of its actual output/backup paths may overwrite them.
  const referencePaths = collectInputs(options)
  const assertTargetSeparate = (target) => {
    if (referencePaths.length === 0) return
    assertReferenceOutputIsSeparate(target, referencePaths)
    if (options.downscale) {
      const ext = path.extname(target)
      assertReferenceOutputIsSeparate(target.replace(/(\.[a-z0-9]+)?$/i, `.full${ext || '.png'}`), referencePaths)
    }
  }
  try {
    if (referencePaths.length > 0) {
      const count = Number.isSafeInteger(n) && n > 1 ? n : 1
      // Bound local alias checks rather than hanging on a huge requested n.
      // Reject explicitly; never silently clamp the number of paid images.
      if (count > 4096) {
        throw Object.assign(new Error('参考图输出保护无法预检超过 4096 个输出路径；请减少本次 --n，未提交生成。'),
          { code: 'reference_output_count_unbounded', kind: 'input' })
      }
      for (let index = 0; index < count; index += 1) {
        assertTargetSeparate(n === 1 ? options.out : options.out.replace(/(\.[a-z0-9]+)?$/i, `_${index + 1}$1`))
      }
    }
  } catch (error) {
    Object.assign(error, { phase: 'preflight', submitted: false, requiresLogin: false })
    throw error
  }
  const url = `${cfg.baseURL.replace(/\/$/, '')}/images/generations`
  const maxAttempts = 7
  let snapped = false
  let droppedBg = false
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const payload = { model: cfg.model, prompt: options.prompt, size, n }
    if (background) payload.background = background
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Number(options.timeoutMs || 180000)),
      })
    } catch (error) {
      // 🚫 传输层失败**不重试**。请求已经发出去了，我们不知道服务端收没收到 ——
      //    盲目重试很可能生成多张图、扣多次费（和视频那边的「结果未知」同源）。
      //    这里如实报错，让用户确认端点状态后再决定要不要重来。
      const detail = error?.message ?? String(error)
      throw new Error(
        `连接 ${url} 失败：${detail}\n`
        + '请求可能已经发出、服务端也可能已经在生成 —— 重试有重复扣费的风险。\n'
        + '请先确认端点可用再重试（不要连续重发）。',
      )
    }
    const text = await response.text()

    if (response.ok) {
      // A 200 with an HTML page (wrong baseURL, proxy error page, gateway) used
      // to surface as "Unexpected token '<' in JSON" — useless for diagnosing.
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`endpoint returned non-JSON 200 (check baseURL "${cfg.baseURL}"): ${text.slice(0, 200)}`)
      }
      const items = Array.isArray(json.data) ? json.data : []
      if (items.length === 0) throw new Error('endpoint returned no image data')
      const outputs = []
      const notes = []
      // Also validate the response's real output count before writing anything;
      // an upstream can return more images than the requested n.
      for (let index = 0; index < items.length; index += 1) {
        try {
          assertTargetSeparate(n === 1 ? options.out : options.out.replace(/(\.[a-z0-9]+)?$/i, `_${index + 1}$1`))
        } catch (error) {
          Object.assign(error, { phase: 'postprocess', submitted: true, requiresLogin: false })
          throw error
        }
      }
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        const target = n === 1
          ? options.out
          : options.out.replace(/(\.[a-z0-9]+)?$/i, `_${index + 1}$1`)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
          fs.writeFileSync(target, Buffer.from(item.b64_json, 'base64'))
        } else if (typeof item.url === 'string') {
          const img = await fetch(item.url, { signal: AbortSignal.timeout(120000) })
          fs.writeFileSync(target, Buffer.from(await img.arrayBuffer()))
        } else {
          continue
        }
        // Optional downscale for small assets: keep the full image alongside.
        if (options.downscale) {
          const ext = path.extname(target)
          const full = target.replace(/(\.[a-z0-9]+)?$/i, `.full${ext || '.png'}`)
          fs.copyFileSync(target, full)
          const res = downscaleFile(full, target, options.downscale)
          if (res.ok) {
            notes.push(`downscaled → ${options.downscale} via ${res.tool} (full kept: ${full})`)
          } else {
            fs.rmSync(full, { force: true })
            notes.push(res.hint)
          }
        }
        outputs.push(target)
      }
      return { outputs, size, model: cfg.model, background: background ?? null, notes }
    }

    // Retry only the known random content_policy false-positive on 400.
    if (response.status === 400 && /content_policy/i.test(text)) {
      lastError = new Error(`content_policy (attempt ${attempt}): ${text.slice(0, 200)}`)
      await sleep(15000 + (attempt - 1) * 8000)
      continue
    }
    // Endpoint rejected the size → snap to the nearest allowed size once.
    if (response.status === 400 && !snapped && !ALLOWED_SIZES.has(size) && /size|dimension|resolution|support/i.test(text)) {
      size = snapSize(size)
      snapped = true
      continue
    }
    // Endpoint rejected the transparent-background param → drop it once.
    if (response.status === 400 && background && !droppedBg && /background|unknown|unexpected|unsupported|param|field/i.test(text)) {
      background = undefined
      droppedBg = true
      continue
    }
    throw new Error(`image endpoint HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  throw new Error(`image generation failed after ${maxAttempts} attempts: ${lastError?.message ?? 'unknown'}`)
}

/**
 * Image-to-image edit through an OpenAI-compatible `/images/edits` endpoint.
 *
 * This is the reskin lane: send the ORIGINAL image + a style prompt, get a
 * re-rendered image back. Used by the spine-rig workflow to restyle a whole
 * character while keeping the layout (the caller then slices the output back
 * into per-part regions — pixel positions carry over because the good
 * endpoints keep composition).
 *
 * Transport notes:
 *  - multipart/form-data (the OpenAI /images/edits shape): `image` file field,
 *    `prompt`, `model`, optional `size`/`n`. gpt-image-* style endpoints.
 *  - Some relays only accept JSON with a base64 `image`; we try multipart
 *    first and fall back to JSON+b64 on a 400 that mentions the body format.
 *  - Transport-layer failures are NOT retried (same rule as generations:
 *    the request may already be generating server-side).
 *
 * @returns {Promise<{outputs: string[], size: string, model: string, notes: string[]}>}
 */
export async function editImage(options) {
  const inputError = (message, code) => Object.assign(new Error(message), {
    code, kind: 'input', phase: 'preflight', submitted: false, requiresLogin: false,
  })
  const cfg = resolveImageConfig(options)
  if (cfg.baseURL.length === 0 || cfg.apiKey.length === 0 || cfg.model.length === 0) {
    throw inputError(
      `custom image endpoint not configured. Set baseURL / apiKey / model in ${imageConfigPath(options.dshHome)} `
      + '(or TAPTAP_IMAGE_BASE_URL / TAPTAP_IMAGE_API_KEY / TAPTAP_IMAGE_MODEL env). Run with --config to inspect.',
    )
  }
  // 多图参考：--in 可重复 / 逗号分隔，或 --refs。
  const inputPaths = collectInputs(options)
  if (inputPaths.length === 0) {
    throw inputError(
      '没有输入图：用 --in <原图>（可重复：--in a.png --in b.png，或逗号分隔）\n'
      + '（editImage 需要至少一张参考图）',
    )
  }
  for (const p of inputPaths) {
    if (!fs.existsSync(p)) throw inputError(`--in 文件不存在：${p}`, 'missing_reference')
  }
  const out = String(options.out ?? '')
  if (out.length === 0) throw inputError('editImage 需要 --out <输出文件>')
  // Protect every original, including refs deliberately skipped by --single-ref.
  // edit writes only out (it does not downscale or create numbered outputs).
  try { assertReferenceOutputIsSeparate(out, inputPaths) }
  catch (error) { error.requiresLogin = false; throw error }
  const size = String(options.size || '').trim()
  const url = `${cfg.baseURL.replace(/\/$/, '')}/images/edits`
  const notes = []

  // 多图能力判断：不是所有模型都吃多张参考图。
  //  - 显式 --single-ref：用户知道这个模型只吃一张，强制只传第一张。
  //  - --multi-ref：用户确认模型支持多图（覆盖下面的保守判断）。
  //  - 都没有：只对**确定单图**的已知模型名拒绝多图，其余交给上游。
  let usePaths = inputPaths
  const multi = inputPaths.length > 1
  if (multi) {
    if (options['single-ref'] === true) {
      usePaths = inputPaths.slice(0, 1)
      notes.push(`模型声明为单图（--single-ref）：只传第 1 张，忽略其余 ${inputPaths.length - 1} 张`)
    } else if (options['multi-ref'] !== true && looksSingleImageModel(cfg.model)) {
      throw inputError(
        `模型「${cfg.model}」看起来只支持单图参考，但你传了 ${inputPaths.length} 张。\n\n`
        + '可选做法：\n'
        + '  · 只传一张：--in <最重要的那张>\n'
        + `  · 若你确认这个模型其实支持多图：加 --multi-ref 强制多图\n`
        + `  · 若这个模型确实只吃一张：用 --single-ref 明确只用第一张\n\n`
        + '（插件不会悄悄丢图，也不会把多图硬塞给只吃一张的模型——那会白花一次请求）',
      )
    }
  }

  // Prepare the actual selected refs before submitting. Let the helper resolve
  // explicit > env > lane defaults; relayImage favours PNG compatibility.
  let prepared
  try {
    prepared = await prepareReferenceImages(usePaths, {
      lane: 'relayImage',
      dshHome: options.dshHome,
      cacheDir: options.referenceCacheDir,
      maxEdge: options.referenceMaxEdge,
      maxBytes: options.referenceMaxBytes,
      maxTotalBytes: options.referenceMaxTotalBytes,
    })
  } catch (error) {
    Object.assign(error, { phase: 'preflight', submitted: false, requiresLogin: false })
    error.notes = [...notes, ...(error.notes ?? [])]
    throw error
  }
  const uploadItems = prepared.items
  const referencePreparation = publicReferencePreparation(prepared)
  notes.push(...prepared.notes)
  let submitted = false

  const attempt = async (useJsonB64) => {
    let response
    try {
      if (useJsonB64) {
        // JSON 形态：单图用 image，多图用 image 数组（各家的习惯字段名不一，
        // 这里同时提供 image / images 两个键，让宽松的实现至少能认一个）。
        const b64s = uploadItems.map((item) => `data:${item.mime};base64,${fs.readFileSync(item.uploadPath).toString('base64')}`)
        const payload = {
          model: cfg.model,
          prompt: options.prompt,
          ...(size ? { size } : {}),
          image: b64s.length === 1 ? b64s[0] : b64s,
          ...(b64s.length > 1 ? { images: b64s } : {}),
        }
        submitted = true
        response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Number(options.timeoutMs || 240000)),
        })
      } else {
        // multipart: Node 22 has global FormData + Blob
        const form = new FormData()
        form.append('model', cfg.model)
        form.append('prompt', options.prompt)
        if (size) form.append('size', size)
        // OpenAI 标准多图形态：重复的 `image[]` 字段。
        // 单图时仍用 `image`（老实现/老模型只认这个，改成 image[] 会破坏兼容）。
        const field = uploadItems.length === 1 ? 'image' : 'image[]'
        for (const item of uploadItems) {
          form.append(
            field,
            new Blob([fs.readFileSync(item.uploadPath)], { type: item.mime }),
            path.basename(item.uploadPath),
          )
        }
        submitted = true
        response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(Number(options.timeoutMs || 240000)),
        })
      }
    } catch (error) {
      // A cached-file read can fail before fetch. Do not call that an unknown
      // remote submission or hint that the caller needs to log in again.
      if (!submitted) throw error
      const detail = error?.message ?? String(error)
      throw new Error(
        `连接 ${url} 失败：${detail}\n`
        + '请求可能已经发出、服务端也可能已经在生成 —— 重试有重复扣费的风险。\n'
        + '请先确认端点可用再重试（不要连续重发）。',
      )
    }
    const text = await response.text()
    if (!response.ok) return { status: response.status, text }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`endpoint returned non-JSON 200 (check baseURL "${cfg.baseURL}"): ${text.slice(0, 200)}`)
    }
    const items = Array.isArray(json.data) ? json.data : []
    if (items.length === 0) throw new Error('endpoint returned no image data')
    const outputs = []
    for (const item of items) {
      if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, Buffer.from(item.b64_json, 'base64'))
        outputs.push(out)
        break // one output is all this lane needs
      }
      if (typeof item.url === 'string') {
        const img = await fetch(item.url, { signal: AbortSignal.timeout(120000) })
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, Buffer.from(await img.arrayBuffer()))
        outputs.push(out)
        break
      }
    }
    if (outputs.length === 0) throw new Error('endpoint returned no usable image item (need b64_json or url)')
    return {
      ok: true,
      outputs,
      size: size || '(endpoint default)',
      model: cfg.model,
      inputCount: uploadItems.length,
      referencePreparation,
      notes,
    }
  }

  try {
    // Also protect the immutable upload cache if an explicit output names it.
    assertReferenceOutputIsSeparate(out, uploadItems.map((item) => item.uploadPath))
    // 1) multipart（OpenAI 标准形态）
    const first = await attempt(false)
    if (first.ok) return first
    // 2) 只有 400 且正文**明确指向请求体格式**时才换 JSON+b64 再试一次。
    //    业务错误（prompt 违规、参数非法）不能触发格式回退。
    const bodyFormatRejected = first.status === 400
      && /multipart|form-data|content-type|use json|json body|base64|unexpected content/i.test(first.text)
    if (bodyFormatRejected) {
      notes.push('multipart 被拒（400 格式问题），已改用 JSON+base64 重试')
      const second = await attempt(true)
      if (second.ok) return second
      throw new Error(`image edit endpoint HTTP ${second.status}: ${String(second.text).slice(0, 300)}`)
    }
    throw new Error(`image edit endpoint HTTP ${first.status}: ${String(first.text).slice(0, 300)}`)
  } catch (error) {
    error.referencePreparation = referencePreparation
    error.notes = [...notes]
    error.phase ??= submitted ? 'generation' : 'preflight'
    error.submitted ??= submitted
    error.requiresLogin ??= false
    throw error
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.config === true) {
    const cfg = resolveImageConfig(args)
    process.stdout.write(`${JSON.stringify({
      configFile: imageConfigPath(args.dshHome),
      dshHome: resolveDshHome(args.dshHome),
      baseURL: cfg.baseURL || '(unset)',
      model: cfg.model || '(unset)',
      apiKey: maskSecret(cfg.apiKey),
      size: cfg.size,
    }, null, 2)}\n`)
    return
  }
  // edit 子命令：图生图（reskin 链路 / 多图参考）
  if (args.edit === true || args._?.[0] === 'edit') {
    const inputs = collectInputs(args)
    if (typeof args.prompt !== 'string' || inputs.length === 0 || typeof args.out !== 'string') {
      process.stderr.write(
        'usage: taptap-image edit --in <原图> --prompt "<风格描述>" --out <输出.png> [--size WxH]\n'
        + '       多图参考：--in a.png --in b.png   （或 --in "a.png,b.png" / --refs ...）\n'
        + '       单图模型：--single-ref（只用第一张）；确认支持多图：--multi-ref\n',
      )
      process.exitCode = 2
      return
    }
    const result = await editImage(args)
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return
  }
  if (typeof args.prompt !== 'string' || typeof args.out !== 'string') {
    process.stderr.write(
      'usage: taptap-image [--prompt "<text>" --out <file.png> [--size WxH] [--n 1] [--transparent] [--downscale WxH]]\n'
      + '       taptap-image edit --in <原图> --prompt "<风格>" --out <输出.png>   # 图生图（spine reskin）\n',
    )
    process.exitCode = 2
    return
  }
  const result = await generateImage(args)
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    // Keep the existing stderr/exit contract, while exposing reference audit to
    // CLI consumers even when preparation or a later request/output step fails.
    if (error?.referencePreparation || error?.phase === 'preflight') {
      process.stdout.write(`${JSON.stringify({
        ok: false, error: error?.message ?? String(error), code: error?.code, kind: error?.kind,
        phase: error?.phase, submitted: error?.submitted, requiresLogin: error?.requiresLogin === true,
        ...(error?.referencePreparation ? { referencePreparation: error.referencePreparation } : {}),
        ...(error?.notes ? { notes: error.notes } : {}),
      }, null, 2)}\n`)
    }
    process.exitCode = 1
  })
}
