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

const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024'])

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i += 1
    }
  }
  return args
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
      lastError = error
      await sleep(5000 + attempt * 3000)
      continue
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
  if (typeof args.prompt !== 'string' || typeof args.out !== 'string') {
    process.stderr.write(
      'usage: taptap-image --prompt "<text>" --out <file.png> [--size WxH] [--n 1] [--transparent] [--downscale WxH]\n',
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
    process.exitCode = 1
  })
}
