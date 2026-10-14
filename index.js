/**
 * dsh-taptap-maker-dev — TapTap Maker 本地开发插件 (Host half).
 *
 * What it wires into a dsh composition:
 *
 *  1. A high-priority system-prompt section (`taptap-maker-dev:policy`) that
 *     FORBIDS spending TapTap Maker MCP built-in generation quota unless the
 *     user explicitly asks, steers the model to the custom image lane + bundled
 *     skills first, and leaves read-only Maker tools (status/build/LSP) free.
 *
 *  2. A skill provider over the plugin's bundled `skills/` plus an updatable
 *     cache dir, so the game-development skills ship with the plugin and the
 *     updater can add/refresh more each cycle.
 *
 *  3. Slash commands: `/taptap-setup` (install + init guidance), `/taptap-image`
 *     (custom image lane usage + config), `/taptap-skills` (list + update).
 *
 *  4. A periodic skills-update check (best-effort, offline-safe no-op) that
 *     invalidates the skill registry when new/changed skills arrive.
 *
 * Everything persisted lives under $DSH_HOME (never inside a Maker project
 * workspace, which the Maker runtime auto-commits).
 *
 * Nothing is hard-required: each facility is reached through `ctx.inject`, so a
 * composition missing `skills`, `commands`, or `systemPrompt` degrades that one
 * feature instead of failing the plugin.
 *
 * @module index.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TaptapSkillProvider } from './src/skills-provider.js'
import { runUpdate } from './src/taptap-skills-update.mjs'
import { ensureLibrary, searchAudio, newAssetUuid, installRemoteMatch } from './src/audio-library.mjs'
import { SOURCES } from './src/audio-sources.mjs'
import { dataDir, defaultCacheDir, imageConfigPath, readJson, writeJson, resolveDshHome, skillsDisabledPath, readDisabledSkills, writeDisabledSkills, readPolicyBlock, writePolicyBlock, readImageConfigRaw, writeImageConfigPatch, readMusicConfigRaw, writeMusicConfigPatch, musicConfigPath } from './src/paths.js'
import { MUSIC_MODELS, MINIMAX_MUSIC_URL } from './src/taptap-music.mjs'

export const name = 'taptap-maker-dev'

/** Hard-require nothing; optional services are reached via ctx.inject below. */
export const inject = []

/**
 * Settings-page form: DSH renders a plugin config form from a schemastery
 * `Config` export. `@deepseek-ai/schemastery` is a host-provided peer (a cold
 * `node` process cannot resolve it, but the DSH host injects it at load time,
 * exactly like the reference plugin does). The import is wrapped so that if the
 * host ever does NOT provide it, `Config` stays undefined and the plugin still
 * loads (falling back to file-based config) instead of crashing.
 *
 * apply() still defaults every field defensively, so behaviour is identical
 * whether the config arrived via the form, cordis.patch.yml, or defaults.
 */
let Config
try {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  Config = Schema.object({
    maker: Schema.object({
      blockCreditTools: Schema.boolean().default(true)
        .description('额度红线：禁止调用消耗 Maker 额度的生成工具（除非用户在对话中明确要求）'),
    }).description('额度治理'),
    image: Schema.object({
      baseURL: Schema.string().default('')
        .description('OpenAI 兼容生图端点，填到 /v1（代码自动拼 /images/generations）'),
      apiKey: Schema.string().role('secret').default('').description('生图 API Key'),
      model: Schema.string().default('').description('生图模型 id，例如 gpt-image-2.5'),
      size: Schema.string().default('1024x1024').description('默认出图尺寸（仅缺省回退，可在每次调用用 --size 覆盖，不固定）'),
      credentialsFile: Schema.string().default('')
        .description('可选：外部凭据 JSON 的绝对路径（优先级高于以上字段）'),
    }).description('自定义生图（OpenAI 兼容 /images）'),
    audio: Schema.object({
      autoEnsure: Schema.boolean().default(true)
        .description('首次用到音效/BGM 时自动下载 Kenney CC0 音频库（约 7MB）'),
      cacheDir: Schema.string().default('')
        .description('音频库缓存目录，留空用 $DSH_HOME/taptap-maker-dev/skills-cache/audio'),
    }).description('CC0 音效 / BGM（Kenney，可商用免署名）'),
    music: Schema.object({
      apiKey: Schema.string().role('secret').default('')
        .description('MiniMax API Key（M Plan / 付费用户；端点已固定，无需填 URL）'),
      model: Schema.string().default('music-3.0').description('MiniMax 音乐模型 id'),
      format: Schema.string().default('mp3').description('输出格式 mp3 / wav'),
    }).description('MiniMax 音乐生成（自带 Key，不走 Maker 额度）'),
    skills: Schema.object({
      autoUpdate: Schema.boolean().default(true).description('定期检查并拉取 skill 更新'),
      updateIntervalHours: Schema.number().default(24).description('更新检查间隔（小时）'),
      sources: Schema.array(Schema.string()).default([])
        .description("skill 源：'git:<repo>.git' / 'dir:<本地目录>' / 'https://.../SKILL.md'"),
    }).description('Skills（内置 + 可更新缓存）'),
  }).description('TapTap Maker 本地开发插件')
} catch {
  Config = undefined // host did not provide schemastery → no form, plugin still loads
}
export { Config }

const PKG_DIR = fileURLToPath(new URL('./', import.meta.url))
const BUNDLED_SKILL_DIR = path.join(PKG_DIR, 'skills')

/** The exact Maker MCP tools that spend built-in generation quota. */
const CREDIT_TOOLS = [
  'generate_image', 'batch_generate_images', 'edit_image',
  'create_video_task', 'query_video_task',
  'text_to_music', 'text_to_sound_effect', 'batch_sound_effects',
  'audition_voices_for_character', 'confirm_character_voice', 'text_to_dialogue',
  'create_3d_asset',
]

/** Build the governance system-prompt text. */
function policyText(config) {
  const tools = CREDIT_TOOLS.map((t) => `\`${t}\``).join('、')
  return [
    '## TapTap Maker 开发守则（dsh-taptap-maker-dev 插件注入）',
    '',
    '**额度红线：非经用户在当前对话中明确要求，禁止调用任何消耗 TapTap Maker MCP 内置额度的生成工具。**',
    `受限工具：${tools}。`,
    '- 用户没有明说要用内置额度 / 要用这些工具时，一律视为禁止，不要“顺手”生成，也不要为补素材而自作主张调用。',
    '- 只有当用户明确说“用内置额度 / 用 Maker 的 generate_image / 用 2.5 生成视频”之类时才可调用，并遵守其原有的二次确认与计费提示规则。',
    '- 只读 / 状态 / 构建 / 反馈 / LSP 类 Maker 工具（如 maker 状态、构建、玩家反馈、Lua LSP）不消耗生成额度，可正常使用。',
    '',
    '**图片资源优先走自定义通道**：需要游戏图片素材时，优先使用本插件的 OpenAI 兼容生图通道',
    '（`taptap-image` CLI / `/taptap-image` 命令，可用 `node <插件>/src/taptap-image.mjs` 调用），或复用项目内已有素材；',
    '不要默认去用内置 `generate_image`。生成的中间产物放在 Maker 工作区 `assets/` 之外，裁好后再搬进 `assets/`，并补同名 `.meta`。',
    '',
    '**优先查用内置 skills**：开发前先查本插件内置的 `taptap-maker-*` 与通用游戏设计类 skills（见 skill 列表）；',
    '遇到风格化 UI / 美术 / 系统玩法需求，先查是否有对应 skill，不要凭空编造。',
    '若有符合当下主题的热门玩法 / 梗，在不违反上面红线的前提下可优先采用。',
    '',
    '**自然语言即可触发初始化**：当用户用任意中文说法表达“安装 / 初始化 / 配置 / 搭建 TapTap Maker（制造）”',
    '或“帮我建一个 Maker 游戏项目”时，不要求用户去记 `/taptap-setup` 斜杠命令——直接给出并（在确认后）执行下面两步：',
    '  1) 安装 Maker MCP：`npx -y @taptap/maker install --ide codex,cursor,claude`（部分 Agent 装后需重启）；',
    '  2) 在空白本地目录初始化项目：`npx -y @taptap/maker init`。',
    '斜杠命令只是等价快捷方式；识别到自然语言意图就应主动响应。涉及联网/安装属中风险，先说明再执行。',
    '',
    '**生图尺寸按需、不固定**：游戏资源有大有小，调用 `taptap-image` 时按目标用途传 `--size`（如 1024x1024 做大图、',
    '1536x1024 做横幅）。做图标 / 小 UI 这类小资源：先用 `--transparent` 出一张干净的大图（1024，构图留白、主体居中），',
    '再用 `--downscale <宽>x<高>`（如 128x128 / 64x64）高质量缩小，切忌直接让模型出极小尺寸（细节糊）。',
    '',
    '**Skill 管理**：用户想隐藏/删除某些用不上的 skill 时，用 `/taptap-skills disable <名字>`（可空格或逗号分隔多个），',
    '`/taptap-skills enable <名字>` 恢复，`/taptap-skills list` 查看全部及禁用状态；禁用项不会再进入 skill 候选。',
    '',
    '**音效 / 背景音乐必须优先走 CC0 本地库（自动触发）**：只要用户表达“加个音效 / 来个背景音乐 / 配个 BGM /',
    '加个点击音 / 金币声 / 胜利音效”等需求，**不要调用 `text_to_sound_effect` / `text_to_music` / `batch_sound_effects`**',
    '（这些消耗 Maker 内置额度），而是按顺序走下面两条自建通道：',
    '  ① 音效资源库（首选，零成本）：',
    '     - 搜索：`node <插件>/src/taptap-audio.mjs search "<中文描述>"`；',
    '     - 安装：`node <插件>/src/taptap-audio.mjs add "<中文描述>" --project <Maker项目目录> [--out 名字.wav]`',
    '       —— 自动写入 `assets/audio/{sfx|bgm}/` 并生成同名 `.meta`（uuid）；',
    '     - 查看来源：`node <插件>/src/taptap-audio.mjs sources`。',
    '     本地库 Kenney（CC0，可商用/可修改/无需署名，约 706 个）优先命中；本地没有时自动回落到',
    '     Mixkit（Mixkit Free License，可商用免署名）、小森平（中文页明写商业利用可）、',
    '     効果音ラボ（FAQ 明写商用免费、无需署名/报告，可嵌入游戏有偿销售）——这些只在用户真正安装时',
    '     单文件按需下载，绝不整站抓取。',
    '     **未接入**：Freesound（需用户自己的 API Key，裸请求实测 401）、OpenGameArt（授权混杂，含禁商用的 CC-BY-NC）。',
    '  ② MiniMax 音乐生成（用户已配 Key 时，用于 CC0 库没有的**完整 BGM**）：',
    '     - `node <插件>/src/taptap-music.mjs --prompt "<风格情绪描述>" --out <文件.mp3> [--instrumental]`；',
    '     - 端点固定为 `https://api.minimax.cn/v1/music_generation`，用户只需填 apiKey 与 model；',
    '     - 用的是用户自己的 MiniMax 订阅，**不消耗 Maker 内置额度**。',
    '**诚实限制（必须如实告知）**：',
    '  - Kenney 音乐包只有 1~3 秒短 jingle，没有可无缝循环的完整 BGM；',
    '  - MiniMax 付费音乐模型（music-3.0 / music-2.6 / music-cover）**M Plan 与付费用户可正常使用**（RPM 120）；',
    '    厂商公告仅说明「自 2026-08-20 起不再面向新用户开放」以及三个 *-free 限免模型停服——**不影响已有 M Plan 用户**；',
    '  - 所以：短音效走 ①；完整 BGM 走 ②（M Plan 用户直接用）。若 MiniMax 仍返回错误，',
    '    **把错误原文如实告诉用户**，不要臆测成「停服」，也不要擅自改用消耗额度的内置生成工具。',
  ].join('\n')
}

/** Seed $DSH_HOME/taptap-maker-dev/image.json from config without clobbering edits. */
function seedImageConfig(config, home) {
  const file = imageConfigPath(home)
  const existing = readJson(file) ?? {}
  const merged = { ...existing }
  let changed = false
  const image = config.image ?? {}
  for (const key of ['baseURL', 'apiKey', 'model', 'size', 'credentialsFile']) {
    const value = image[key]
    if (typeof value === 'string' && value.length > 0 && existing[key] !== value) {
      merged[key] = value
      changed = true
    }
  }
  if (!fs.existsSync(file)) {
    // First run: write a template so the user has something to edit.
    writeJson(file, {
      _comment: '自定义生图（OpenAI 兼容 /images/generations）。此文件在 $DSH_HOME 下，不在任何 Maker 工作区内。',
      baseURL: merged.baseURL ?? '',
      apiKey: merged.apiKey ?? '',
      model: merged.model ?? '',
      size: merged.size ?? '1024x1024',
      credentialsFile: merged.credentialsFile ?? '',
    })
    return file
  }
  if (changed) writeJson(file, merged)
  return file
}

/**
 * Fetch model ids from an OpenAI-compatible `{baseURL}/models` endpoint.
 * Runs on the host (no browser CORS), returns a de-duped, sorted id list.
 */
async function fetchModelIds(baseURL, apiKey) {
  const url = `${baseURL.replace(/\/$/, '')}/models`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  let json
  try { json = JSON.parse(text) } catch { throw new Error('响应不是 JSON') }
  const data = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : [])
  const ids = data
    .map((m) => (typeof m === 'string' ? m : m?.id))
    .filter((id) => typeof id === 'string' && id.length > 0)
  return Array.from(new Set(ids)).sort()
}

export function apply(ctx, config = {}) {
  const home = resolveDshHome(config.dshHome)
  const skillsCfg = config.skills ?? {}
  const audioCfg = config.audio ?? {}
  const cacheDir = (skillsCfg.cacheDir && skillsCfg.cacheDir.length > 0)
    ? path.resolve(skillsCfg.cacheDir)
    : defaultCacheDir(home)
  fs.mkdirSync(cacheDir, { recursive: true })
  dataDir(home)
  const audioCacheDir = (audioCfg.cacheDir && audioCfg.cacheDir.length > 0)
    ? path.resolve(audioCfg.cacheDir)
    : path.join(cacheDir, 'audio')
  const disabledFile = skillsDisabledPath(home)
  const imageFile = seedImageConfig(config, home)
  ctx.logger?.info?.(`taptap-maker-dev: data=${dataDir(home)} skills-cache=${cacheDir} image-config=${imageFile}`)

  // --- 1b. CC0 audio library (lazy: fetched on first audio request) -------
  // Nothing is downloaded at startup — the first `search`/`add` triggers it, so
  // plugin load stays fast. After that it is fully local and offline.
  let audioReady = false
  let audioEnsuring = null
  const ensureAudio = async () => {
    if (audioReady) return
    if (audioEnsuring !== null) return audioEnsuring
    audioEnsuring = (async () => {
      const result = await ensureLibrary(audioCacheDir)
      audioReady = true
      if (result.errors.length > 0) {
        ctx.logger?.warn?.(`taptap-maker-dev audio: ${result.errors.length} pack error(s)`)
      }
      return result
    })()
    return audioEnsuring
  }

  // --- 1. Governance system-prompt section (live-toggleable) -------------
  // The section is added/removed through the disposer that systemPrompt.section
  // returns, so the settings-page switch engages/disengages the red-line
  // without a restart. policy.json persists the choice across restarts.
  let policyEnabled = readPolicyBlock(home, config.maker?.blockCreditTools)
  let policyDispose = null
  let systemPromptService = null
  const applyPolicySection = () => {
    if (systemPromptService === null) return
    if (policyEnabled && policyDispose === null) {
      policyDispose = systemPromptService.section({
        name: 'taptap-maker-dev:policy',
        order: 300,
        text: policyText(config),
      })
    } else if (!policyEnabled && policyDispose !== null) {
      try { policyDispose() } catch { /* already gone */ }
      policyDispose = null
    }
  }
  const setPolicyEnabled = (enabled) => {
    policyEnabled = enabled !== false
    writePolicyBlock(home, policyEnabled)
    applyPolicySection()
    return policyEnabled
  }
  ctx.inject(['systemPrompt'], (scoped) => {
    systemPromptService = scoped.systemPrompt
    policyDispose = null // fresh service scope; any prior disposer is already gone
    applyPolicySection()
  })

  // --- 2. Skill provider (bundled + updatable cache) ---------------------
  let invalidateSkills = () => {}
  let skillProvider = null
  ctx.inject(['skills'], (scoped) => {
    scoped.skills.registerProvider((control) => {
      invalidateSkills = control.invalidate
      skillProvider = new TaptapSkillProvider('taptap-maker-dev', [
        { dir: cacheDir, rank: skillsCfg.rankCache ?? 350 },
        { dir: BUNDLED_SKILL_DIR, rank: skillsCfg.rankBundled ?? 360 },
      ], { disabledFile })
      return skillProvider
    })
  })

  // --- 4. Periodic skills-update check -----------------------------------
  const intervalMs = Math.max(1, Number(skillsCfg.updateIntervalHours ?? 24)) * 3600 * 1000
  const runUpdateOnce = async () => {
    try {
      const summary = await runUpdate({
        dshHome: home,
        cacheDir,
        sources: skillsCfg.sources ?? [],
        // Don't re-clone on every startup: only re-check once per interval.
        minIntervalMs: intervalMs,
      })
      if (summary.added.length > 0 || summary.updated.length > 0) {
        ctx.logger?.info?.(
          `taptap-maker-dev skills updated: +${summary.added.length} new, ~${summary.updated.length} changed`,
        )
        skillProvider?.reset()
        invalidateSkills()
      }
      if (summary.errors.length > 0) {
        ctx.logger?.warn?.(`taptap-maker-dev skills-update: ${summary.errors.length} source error(s)`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`taptap-maker-dev skills-update failed: ${error?.message ?? error}`)
    }
  }

  if (skillsCfg.autoUpdate !== false) {
    // Defer the first check well past UI startup so it never competes with the
    // plugin page render; the freshness gate makes it a cheap no-op most boots.
    const first = setTimeout(runUpdateOnce, 60000)
    if (typeof first.unref === 'function') first.unref()
    const loop = setInterval(runUpdateOnce, intervalMs)
    if (typeof loop.unref === 'function') loop.unref()
    ctx.effect(function* () {
      yield () => { clearTimeout(first); clearInterval(loop) }
    }, 'taptap-maker-dev skills-update loop')
  }

  // --- Shared skill helpers (used by the web API route and slash commands) --
  const buildSkillProvider = () => new TaptapSkillProvider('taptap-maker-dev', [
    { dir: cacheDir, rank: 350 },
    { dir: BUNDLED_SKILL_DIR, rank: 360 },
  ], { disabledFile })
  const refreshSkills = () => { skillProvider?.reset(); invalidateSkills() }

  // --- 2b. Settings-page web API (so the UI manages skills without commands) --
  // The web client half fetches these same-origin routes; the host serves them
  // through the optional `webServer` service (pends until it appears, like the
  // reference plugin). Absent webServer → the UI falls back to slash commands.
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    const sendJson = (res, status, obj) => {
      const payload = JSON.stringify(obj)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(payload)
    }
    const readBody = (req) => new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => { size += c.length; if (size <= 1_000_000) chunks.push(c) })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
    const handler = async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const sub = url.pathname.replace(/^\/api\/taptap-maker-dev\/?/, '').replace(/\/+$/, '')
        if (req.method === 'GET' && (sub === 'skills' || sub === '')) {
          const skills = buildSkillProvider().listAll()
          return sendJson(res, 200, { ok: true, skills, disabled: readDisabledSkills(home) })
        }
        if (req.method === 'POST' && sub === 'disabled') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const names = Array.isArray(parsed?.disabled) ? parsed.disabled : []
          const next = writeDisabledSkills(home, names)
          refreshSkills()
          return sendJson(res, 200, { ok: true, disabled: next })
        }
        if (req.method === 'GET' && sub === 'policy') {
          return sendJson(res, 200, { ok: true, blockCreditTools: policyEnabled })
        }
        if (req.method === 'POST' && sub === 'policy') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const value = setPolicyEnabled(parsed?.blockCreditTools !== false)
          return sendJson(res, 200, { ok: true, blockCreditTools: value })
        }
        if (req.method === 'GET' && sub === 'image') {
          const raw = readImageConfigRaw(home)
          return sendJson(res, 200, {
            ok: true,
            baseURL: raw.baseURL ?? '',
            apiKey: raw.apiKey ?? '',
            model: raw.model ?? '',
            size: raw.size ?? '1024x1024',
            credentialsFile: raw.credentialsFile ?? '',
          })
        }
        if (req.method === 'POST' && sub === 'image') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const merged = writeImageConfigPatch(home, {
            baseURL: typeof parsed.baseURL === 'string' ? parsed.baseURL.trim() : undefined,
            apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : undefined,
            model: typeof parsed.model === 'string' ? parsed.model.trim() : undefined,
            size: typeof parsed.size === 'string' ? parsed.size.trim() : undefined,
          })
          return sendJson(res, 200, {
            ok: true,
            baseURL: merged.baseURL ?? '',
            model: merged.model ?? '',
            size: merged.size ?? '',
            hasApiKey: Boolean(merged.apiKey),
            file: imageConfigPath(home),
          })
        }
        if (req.method === 'GET' && sub === 'audio-sources') {
          return sendJson(res, 200, {
            ok: true,
            sources: [
              { id: 'kenney', title: 'Kenney（本地 CC0）', license: 'CC0 — 可商用、可修改、无需署名', note: '本地缓存，706 个音频' },
              ...SOURCES.map((s) => ({ id: s.id, title: s.title, license: s.license, home: s.home, note: s.note })),
            ],
            excluded: [
              { id: 'freesound', reason: '需要用户自己的 API Key（实测裸请求 401）' },
              { id: 'opengameart', reason: '授权混杂，含禁止商用的 CC-BY-NC' },
            ],
          })
        }
        if (req.method === 'GET' && sub === 'music') {
          const raw = readMusicConfigRaw(home)
          return sendJson(res, 200, {
            ok: true,
            endpoint: MINIMAX_MUSIC_URL,
            apiKey: raw.apiKey ?? '',
            model: raw.model ?? 'music-3.0',
            format: raw.format ?? 'mp3',
            models: MUSIC_MODELS.map((m) => m.id),
          })
        }
        if (req.method === 'POST' && sub === 'music') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const merged = writeMusicConfigPatch(home, {
            apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
            model: typeof parsed.model === 'string' ? parsed.model : undefined,
            format: typeof parsed.format === 'string' ? parsed.format : undefined,
          })
          return sendJson(res, 200, {
            ok: true, model: merged.model ?? '', format: merged.format ?? '', hasApiKey: Boolean(merged.apiKey),
            file: musicConfigPath(home),
          })
        }
        if (req.method === 'GET' && sub === 'audio') {
          const ready = fs.existsSync(path.join(audioCacheDir, 'index.json'))
          return sendJson(res, 200, {
            ok: true,
            cacheDir: audioCacheDir,
            ready,
            count: ready ? (readJson(path.join(audioCacheDir, 'index.json'))?.items?.length ?? 0) : 0,
          })
        }
        if (req.method === 'POST' && sub === 'audio-search') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const limit = Number(parsed.limit ?? 8)
          try {
            await ensureAudio()
            const result = await searchAudio(audioCacheDir, String(parsed.query ?? ''), {
              limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 20) : 8,
            })
            return sendJson(res, 200, {
              ok: true,
              matches: result.matches.map((m) => ({ pack: m.pack, file: m.file, kb: m.kb, kind: m.kind })),
              note: result.note, total: result.total,
            })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        if (req.method === 'POST' && sub === 'audio-sync') {
          try {
            const result = await ensureLibrary(audioCacheDir, { force: true })
            audioReady = true
            return sendJson(res, 200, { ok: result.errors.length === 0, count: result.index.length, errors: result.errors })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        if (req.method === 'POST' && sub === 'models') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const raw = readImageConfigRaw(home)
          const baseURL = (typeof parsed.baseURL === 'string' && parsed.baseURL.trim()) || raw.baseURL || ''
          const apiKey = (typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) || raw.apiKey || ''
          if (!baseURL || !apiKey) return sendJson(res, 400, { ok: false, error: '缺少 baseURL 或 apiKey' })
          try {
            const models = await fetchModelIds(baseURL, apiKey)
            return sendJson(res, 200, { ok: true, models })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        return sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
      }
    }
    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/taptap-maker-dev', handler }),
      'taptap-maker-dev: settings API routes')
  })

  // --- 3. Slash commands --------------------------------------------------
  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'taptap-setup',
      description: 'TapTap Maker MCP 安装与项目初始化引导（也可直接用中文说“帮我初始化 taptap maker”触发）',
      handler: () => ({
        kind: 'success',
        text: [
          'TapTap Maker 初始指令（直接说中文“安装/初始化 taptap maker”也会触发，不必记这个命令）：',
          '',
          '一、安装 Maker MCP（部分 Agent 装后需重启）：',
          '  npx -y @taptap/maker install --ide codex,cursor,claude',
          '',
          '二、在一个空白本地目录中初始化项目：',
          '  npx -y @taptap/maker init',
          '',
          '提示：本插件已注入“非用户主动不消耗 Maker MCP 额度”的守则，',
          '需要图片素材优先用 /taptap-image 的自定义生图通道。',
        ].join('\n'),
      }),
    })

    scoped.commands.register({
      name: 'taptap-image',
      description: '查看/说明自定义 OpenAI 兼容生图通道（URL/key/model 配置与调用方式）',
      input: { hint: '可留空；或粘贴想生成的提示词以获得调用示例' },
      handler: (invocation) => {
        const cfg = readJson(imageFile) ?? {}
        const configured = Boolean(cfg.baseURL && cfg.apiKey && cfg.model)
        const prompt = (invocation?.rawInput ?? '').trim() || '一只橙色小猫，扁平矢量风格'
        const cli = path.join(PKG_DIR, 'src', 'taptap-image.mjs')
        return {
          kind: 'success',
          text: [
            `自定义生图配置文件：${imageFile}`,
            `状态：${configured ? '已配置' : '未配置（请填 baseURL / apiKey / model）'}`,
            `  baseURL=${cfg.baseURL || '(未设)'}  model=${cfg.model || '(未设)'}`,
            '',
            '调用示例（PowerShell）：',
            `  node "${cli}" --prompt "${prompt}" --out D:\\tmp\\out.png --size 1024x1024`,
            `  node "${cli}" --prompt "一个蓝色盾牌图标，扁平，居中留白" --out D:\\tmp\\icon.png --transparent --downscale 128x128`,
            `  node "${cli}" --config    # 查看生效配置（key 掩码）`,
            '',
            '尺寸按需传 --size（不再固定）；端点若只认 1024x1024 / 1024x1536 / 1536x1024，会自动回退到最接近的一档并重试。',
            '小资源（图标 / 小 UI）方案：--transparent 出干净大图，再 --downscale <宽>x<高>（如 128x128、64x64）高质量缩小。',
            '不消耗任何 Maker MCP 内置额度。',
          ].join('\n'),
        }
      },
    })

    scoped.commands.register({
      name: 'taptap-audio',
      description: 'CC0 音效 / BGM：搜索并安装到项目（不消耗 Maker 额度）',
      input: { hint: 'search/add "<描述>"；add 需 --project 项目目录 [--out 名字.wav]；或 sync 更新库' },
      handler: async (invocation) => {
        const raw = (invocation?.rawInput ?? '').trim()
        const cli = path.join(PKG_DIR, 'src', 'taptap-audio.mjs')
        if (raw === '' || raw === 'help') {
          return {
            kind: 'success',
            text: [
              'CC0 音效 / BGM（Kenney，可商用、免署名，不消耗任何 Maker 额度）：',
              '',
              `  node "${cli}" search "金币音效"`,
              `  node "${cli}" add "金币音效" --project D:\\tapyx --out coin.wav`,
              `  node "${cli}" sync     # 下载/更新音频库`,
              '',
              `音频库缓存：${audioCacheDir}`,
              '首次使用会自动下载（约 7MB，九个包、六百多个音频），之后走本地缓存。',
              '注意：音乐包只有 1~3 秒短 jingle，没有可无缝循环的完整 BGM。',
            ].join('\n'),
          }
        }
        // `add 描述 --project dir [--out x.wav]`
        const m = /^(add|install|添加|安装)\s+(.+)$/.exec(raw)
        if (m !== null) {
          const rest = m[2]
          const pm = /--project\s+(\S+)/.exec(rest)
          const om = /--out\s+(\S+)/.exec(rest)
          const desc = rest.replace(/--project\s+\S+/, '').replace(/--out\s+\S+/, '').trim()
          if (pm === null) {
            return { kind: 'error', text: '用法：/taptap-audio add "<描述>" --project <Maker项目目录> [--out 名字.wav]' }
          }
          const project = path.resolve(pm[1].replace(/^["']|["']$/g, ''))
          if (!fs.existsSync(path.join(project, 'assets'))) {
            return { kind: 'error', text: `${project} 看起来不是 Maker 项目（没有 assets/ 目录）` }
          }
          await ensureAudio()
          const result = await searchAudio(audioCacheDir, desc, { limit: 5 })
          if (result.matches.length === 0) {
            return { kind: 'error', text: `CC0 库里没找到匹配「${desc}」的音效。可用 /taptap-audio search "<描述>" 换关键词试试。` }
          }
          const chosen = result.matches[0]
          const kind = chosen.kind === 'bgm' ? 'bgm' : 'sfx'
          const outName = om !== null ? om[1] : `${chosen.name}${chosen.ext}`
          // Remote source → download that single file, then write .meta.
          if (chosen.local === false) {
            const remote = await installRemoteMatch(chosen, project, kind, outName)
            if (!remote.ok) {
              return { kind: 'error', text: `下载失败：${remote.error}\n来源：${chosen.pack}/${chosen.file}` }
            }
            return {
              kind: 'success',
              text: [
                `已安装：${remote.target}`,
                `来源：${chosen.pack}/${chosen.file}`,
                `授权：${chosen.license}`,
                `已生成 ${remote.meta}（uuid=${remote.uuid}）`,
                '',
                result.note ? `注意：${result.note}` : '',
                result.matches.length > 1
                  ? `其他候选：${result.matches.slice(1, 5).map((x) => `${x.pack}/${x.file}`).join('、')}`
                  : '',
              ].filter(Boolean).join('\n'),
            }
          }
          const target = path.join(project, 'assets', 'audio', kind, outName)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.copyFileSync(chosen.abs, target)
          const metaFile = `${target}.meta`
          if (!fs.existsSync(metaFile)) {
            fs.writeFileSync(metaFile, `${JSON.stringify({ uuid: newAssetUuid() }, null, 2)}\n`)
          }
          const uuid = JSON.parse(fs.readFileSync(metaFile, 'utf8')).uuid
          return {
            kind: 'success',
            text: [
              `已安装：${target}`,
              `来源：${chosen.pack}/${chosen.file}`,
              '授权：CC0（Kenney）—— 可商用、可修改、无需署名。',
              `已生成 ${metaFile}（uuid=${uuid}）`,
              '',
              result.note ? `注意：${result.note}` : '',
              result.matches.length > 1
                ? `其他候选：${result.matches.slice(1, 5).map((x) => `${x.pack}/${x.file}`).join('、')}`
                : '',
            ].filter(Boolean).join('\n'),
          }
        }
        // default: search
        const desc = raw.replace(/^(search|find|搜索)\s*/, '').trim()
        await ensureAudio()
        const result = await searchAudio(audioCacheDir, desc, { limit: 8 })
        if (result.matches.length === 0) {
          return { kind: 'error', text: `没找到匹配「${desc}」的 CC0 音效。试试更通用的词（点击 / 金币 / 胜利 / 打击 / 门 / 脚步 / 激光…）。` }
        }
        return {
          kind: 'success',
          text: [
            `「${desc}」CC0 匹配（库共 ${result.total} 个音频）：`,
            ...result.matches.map((x, i) => `  ${i + 1}. ${x.pack}/${x.file}  (${x.kb}KB)`),
            '',
            `安装：/taptap-audio add "${desc}" --project <项目目录> [--out 名字.wav]`,
            result.note ? `注意：${result.note}` : '',
            '授权：CC0（Kenney）—— 可商用、免署名。不消耗 Maker 内置额度。',
          ].filter(Boolean).join('\n'),
        }
      },
    })

    scoped.commands.register({
      name: 'taptap-audio-convert',
      description: '用 ffmpeg 批量转换/压缩/响度归一游戏音频（本地离线，不耗额度）',
      input: { hint: '--in <文件或目录> --out <目标> [--to wav|mp3|ogg] [--mono] [--rate 44100] [--normalize] [--trim] [--loop N]' },
      handler: (invocation) => {
        const cli = path.join(PKG_DIR, 'src', 'taptap-audio-convert.mjs')
        const raw = (invocation?.rawInput ?? '').trim()
        const fm = /--in\s+(\S+)/.exec(raw)
        const to = /--to\s+(\w+)/.exec(raw)
        return {
          kind: 'success',
          text: [
            '音频转换（ffmpeg，本地离线，不消耗任何额度）：',
            '',
            '  · CC0 下载来的 ogg/mp3 转成 Maker 项目习惯的 wav：',
            `    node "${cli}" --in D:\\tmp\\sfx --out D:\\tapyx\\assets\\audio\\sfx --to wav --mono --rate 44100`,
            '  · 压缩体积（适合小游戏）：',
            `    node "${cli}" --in big.wav --out small.mp3 --to mp3 --bitrate 64k --mono`,
            '  · 统一响度 + 去首尾静音 + 淡出：',
            `    node "${cli}" --in sfx --out out --to wav --normalize --trim --fade-out 0.05`,
            '  · 短音拼成一段可循环 BGM：',
            `    node "${cli}" --in one_shot.ogg --out bgm_loop.mp3 --loop 8`,
            '  · 查看时长：',
            `    node "${cli}" --probe some.ogg`,
            '',
            fm !== null
              ? `你现在可以直接跑：\n  node "${cli}" ${raw}`
              : '支持格式：wav / mp3 / ogg / opus / m4a / flac。需要 ffmpeg（winget install Gyan.FFmpeg）。',
            to !== null ? `目标格式：${to[1]}` : '',
          ].filter(Boolean).join('\n'),
        }
      },
    })

    scoped.commands.register({
      name: 'taptap-music',
      description: 'MiniMax 音乐生成（用自己的 Key，不消耗 Maker 额度）',
      input: { hint: '留空=查看用法；或 "风格情绪描述" --out <文件.mp3> [--instrumental]' },
      handler: (invocation) => {
        const musicCfg = config.music ?? {}
        const raw = (invocation?.rawInput ?? '').trim()
        const cli = path.join(PKG_DIR, 'src', 'taptap-music.mjs')
        const stored = readMusicConfigRaw(home)
        const keySet = Boolean(stored.apiKey || musicCfg.apiKey || process.env.MINIMAX_API_KEY)
        const model = stored.model || musicCfg.model || 'music-3.0'
        const om = /--out\s+(\S+)/.exec(raw)
        const desc = raw.replace(/--out\s+\S+/, '').replace(/--instrumental/, '').trim()
        return {
          kind: 'success',
          text: [
            `MiniMax 音乐生成（端点固定 ${MINIMAX_MUSIC_URL}）`,
            `配置：${musicConfigPath(home)}`,
            `状态：${keySet ? `已配置（model=${model}）` : '未配置 API Key'}`,
            '',
            desc.length > 0 && om !== null
              ? `建议执行：\n  node "${cli}" --prompt "${desc}" --out ${om[1]}${raw.includes('--instrumental') ? ' --instrumental' : ''}`
              : `调用示例：\n  node "${cli}" --prompt "史诗管弦战斗音乐，紧张" --out D:\\tmp\\bgm.mp3 --instrumental\n  node "${cli}" --models   # 可用模型 id`,
            '',
            '可用模型：' + MUSIC_MODELS.map((m) => m.id).join('、'),
            '说明：用的是你自己的 MiniMax 订阅，不消耗 Maker 内置额度。',
            'M Plan / 付费用户可正常使用 music-3.0 / music-2.6 / music-cover（RPM 120）。',
            '厂商公告仅涉及「新用户不再开放」与三个 *-free 限免模型停服，不影响已有 M Plan 用户。',
            '若调用仍失败，请把错误原文贴给用户，不要臆测原因、也不要擅自改用内置 text_to_music。',
          ].join('\n'),
        }
      },
    })

    scoped.commands.register({
      name: 'taptap-skills',
      description: '管理游戏开发 skills：list / disable <名> / enable <名> / reset / update',
      input: { hint: '留空=列表+更新检测；disable <名>…；enable <名>…；reset；update' },
      handler: async (invocation) => {
        const raw = (invocation?.rawInput ?? '').trim()
        const parts = raw.split(/[\s,，]+/).filter(Boolean)
        const sub = (parts[0] ?? '').toLowerCase()
        const argNames = parts.slice(1)
        const provider = buildSkillProvider()
        const refresh = refreshSkills

        // disable / 隐藏 / 删除
        if (sub === 'disable' || sub === '隐藏' || sub === '删除' || sub === 'remove') {
          if (argNames.length === 0) return { kind: 'error', text: '用法：/taptap-skills disable <skill名> [更多名…]' }
          const all = new Set(provider.listAll().map((s) => s.name))
          const unknown = argNames.filter((n) => !all.has(n))
          const next = writeDisabledSkills(home, [...readDisabledSkills(home), ...argNames])
          refresh()
          return {
            kind: 'success',
            text: [
              `已禁用：${argNames.join('、')}`,
              unknown.length ? `（注意：这些名字当前目录里没找到，但已记入禁用表：${unknown.join('、')}）` : '',
              `当前禁用共 ${next.length} 个。用 /taptap-skills enable <名> 可恢复。`,
            ].filter(Boolean).join('\n'),
          }
        }

        // enable / 启用 / 恢复
        if (sub === 'enable' || sub === '启用' || sub === '恢复') {
          if (argNames.length === 0) return { kind: 'error', text: '用法：/taptap-skills enable <skill名> [更多名…]' }
          const remove = new Set(argNames)
          const next = writeDisabledSkills(home, readDisabledSkills(home).filter((n) => !remove.has(n)))
          refresh()
          return { kind: 'success', text: `已恢复：${argNames.join('、')}。当前禁用共 ${next.length} 个。` }
        }

        // reset：清空禁用表
        if (sub === 'reset' || sub === '清空') {
          writeDisabledSkills(home, [])
          refresh()
          return { kind: 'success', text: '已清空禁用表，所有 skill 恢复可用。' }
        }

        // update：强制跑一次更新（忽略冷却）
        if (sub === 'update' || sub === '更新') {
          const summary = await runUpdate({ dshHome: home, cacheDir, sources: skillsCfg.sources ?? [], minIntervalMs: 0 })
          if (summary.added.length > 0 || summary.updated.length > 0) refresh()
          return {
            kind: 'success',
            text: `更新检测：源 ${summary.sourceCount} 个，新增 ${summary.added.length}，变更 ${summary.updated.length}，错误 ${summary.errors.length}。`
              + (skillsCfg.sources?.length ? '' : '\n（未配置更新源，为安全空操作。）'),
          }
        }

        // 默认：列出全部（含禁用标记）+ 做一次（带冷却的）更新检测
        const all = provider.listAll()
        const active = all.filter((s) => !s.disabled)
        const disabled = all.filter((s) => s.disabled)
        const summary = await runUpdate({ dshHome: home, cacheDir, sources: skillsCfg.sources ?? [], minIntervalMs: 0 })
        if (summary.added.length > 0 || summary.updated.length > 0) refresh()
        const fmt = (s) => `  - ${s.name}${s.disabled ? ' 〔已禁用〕' : ''} — ${s.description}`
        return {
          kind: 'success',
          text: [
            `skills 共 ${all.length} 个（启用 ${active.length}，禁用 ${disabled.length}）：`,
            ...all.map(fmt),
            '',
            '管理：/taptap-skills disable <名>（隐藏）、enable <名>（恢复）、reset（全部恢复）、update（强制更新）。',
            `更新检测：源 ${summary.sourceCount} 个，新增 ${summary.added.length}，变更 ${summary.updated.length}，错误 ${summary.errors.length}。`,
            skillsCfg.sources?.length ? '' : '（当前未配置更新源，检测为安全空操作；在插件 config.skills.sources 里填 git/目录/URL 即可。）',
          ].filter(Boolean).join('\n'),
        }
      },
    })
  })
}
