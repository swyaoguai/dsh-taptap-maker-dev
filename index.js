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
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TaptapSkillProvider } from './src/skills-provider.js'
import { runUpdate } from './src/taptap-skills-update.mjs'
import { ensureLibrary, searchAudio, newAssetUuid, installRemoteMatch } from './src/audio-library.mjs'
import { status as bgmStatus, generateWithRotation as bgmGenerateWithRotation, login as bgmLogin, logout as bgmLogout, credits as bgmCredits, detectSite as bgmDetectSite, saveSite as bgmSaveSite, profileDir, downloadDir, releaseProfile as bgmReleaseProfile } from './src/taptap-bgm-web.mjs'
import { dataDir, defaultCacheDir, imageConfigPath, readJson, writeJson, maskSecret, resolveDshHome, skillsDisabledPath, readDisabledSkills, writeDisabledSkills, readPolicyBlock, writePolicyBlock, readImageConfigRaw, writeImageConfigPatch, buildBgmPrompt, suggestBgmForProject, readBgmConfig, writeBgmConfig, readMinimaxConfigRaw, readMinimaxConfigWithSource, writeMinimaxConfigPatch, discoverMinimaxKey, readVideoRelayConfigRaw, writeVideoRelayConfigPatch, readSubmitLedger } from './src/paths.js'
import {
  composeJobSheet, createJob as createVideoJob, doctor as videoDoctor, extractJobFrames,
  getJob as getVideoJob, importToMaker, keyJobFrames, nextStepOf, pollJobVideo, saveJob as saveVideoJob,
  setReference as setVideoReference, clearReference as clearVideoReference, submitJobVideo, useLocalVideo,
  listJobs as listVideoJobs, deleteJob as deleteVideoJob,
} from './src/video-sequence.mjs'
import { listModels as listVideoModels, estimateCostCny, detectKeyKind, describeKey } from './src/minimax-video.mjs'
import { normalizeRelayConfig, relayListModels, relayReady, RELAY_PROTOCOLS } from './src/video-relay.mjs'
import {
  GROUPS as LANE_GROUPS_IDS, LANE_GROUPS, lanesConfigPath, quotaSignal,
  readLanes, writeLanes, laneEnabled as isLaneEnabledFor,
} from './src/lanes.mjs'
import { resolveAssetDir as resolveAssetDirForApi } from './src/assets.mjs'
import { guardUserSetting, guardrailLines, hasApproval, requireApproval } from './src/guards.mjs'
import { killProcessesContaining } from './src/win-proc.mjs'
import { startBackgroundCheck, currentVersion, checkForUpdates, readCachedCheck, shouldCheck } from './src/version-checker.mjs'

// API 层的短别名：路由函数里反复写 readLanes/writeLanes 太长，且和已有的
// read*FromApi 风格不一致。
const readLanesForApi = readLanes
const writeLanesForApi = writeLanes
const lanesConfigPathForApi = lanesConfigPath
const LANE_GROUPS_FOR_API = LANE_GROUPS
const relayReadyForApi = relayReady
/** 「生成通道」卡里 relayImage 逐条开关是否开着（/taptap-image 入口用）。 */
const relayImageLaneEnabled = (home) => {
  try { return isLaneEnabledFor(home, 'image', 'relayImage') } catch { return true }
}

/** 「开着但还没配」时给界面的一句话 —— 要具体，否则用户不知道该去哪儿填。 */
const LANE_UNREADY_REASON = {
  gptWeb: '需要先登录 ChatGPT 账号（/taptap-gpt login）',
  relayImage: '需要在下面「中转站生图」填 baseURL / Key / 模型',
  relay: '需要在下面「视频中转站」填地址 / Key / 模型',
  minimax: '需要在下面「MiniMax」填 API Key',
  local: '',
  bgmWeb: '需要先登录 MiniMax 账号（/taptap-bgm login）',
}
import { convertFile as ffmpegConvert, probeDuration as ffprobeDuration, probeDurationAsync as ffprobeDurationAsync } from './src/taptap-audio-convert.mjs'
import { installFile as installAudioAsset } from './src/taptap-audio.mjs'
import os from 'node:os'
import { status as gptStatus, login as gptLogin, logout as gptLogout, generateWithRotation as gptGenerateWithRotation, generateImage as gptGenerateImage, grab as gptGrab, resolveDownloadDir, gptAccountProfileDir, releaseProfile as gptReleaseProfile } from './src/taptap-gpt.mjs'
import { readGptPool, writeGptPool, touchGptAccount as gptTouchAccount, pickGptAccount, readGptLaneEnabled, writeGptLaneEnabled, readGptDownloadDir, writeGptDownloadDir, readBgmPool, writeBgmPool, touchBgmAccount as bgmTouchAccount, readGptPending } from './src/paths.js'

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
    video: Schema.object({
      apiKey: Schema.string().role('secret').default('')
        .description('MiniMax Key：M Plan 订阅 Key（sk-cp-…，Explore/Build 档才有视频额度）或按量计费 Key（sk-api-…）。留空则用环境变量 MINIMAX_API_KEY / mmx 登录态'),
      baseURL: Schema.string().default('https://api.minimaxi.com')
        .description('国内站 https://api.minimaxi.com（人民币计费）或国际站 https://api.minimax.io（美元计费）'),
      model: Schema.string().default('MiniMax-H3')
        .description('视频模型：MiniMax-H3（768P/2K、首尾帧）/ MiniMax-H3-Max（极速）/ MiniMax-Hailuo-02（v1 首尾帧）'),
    }).description('视频生成（MiniMax 图生视频 / 首尾帧 → 抽帧 → 抠图 → 序列帧素材）'),
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

/** Handle `/taptap-gpt pool …` subcommands and render them as human text. */
async function gptPoolCommand(home, raw) {
  const parts = raw.split(/\s+/).filter(Boolean)
  const sub = (parts[1] ?? 'list').toLowerCase()
  const flag = (name) => {
    const m = new RegExp(`(?:--${name})\\s+(\\S+)`).exec(raw)
    return m === null ? undefined : m[1]
  }
  if (sub === 'add' || sub === '加号' || sub === '新增') {
    const id = flag('id')
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, text: '用法：/taptap-gpt pool add --id <短名> [--label 备注]' }
    }
    const pool = readGptPool(home)
    if (pool.accounts.some((a) => a.id === id)) {
      return { ok: false, text: `账号「${id}」已存在。加完记得登录：/taptap-gpt login --account ${id}` }
    }
    const label = flag('label') ?? id
    writeGptPool(home, { accounts: [...pool.accounts, { id, label, status: 'unknown', lastUsedAt: null, note: '' }] })
    return {
      ok: true,
      text: [
        `已加账号「${id}」，现在共 ${readGptPool(home).accounts.length} 个。`,
        '',
        `登录它：/taptap-gpt login --account ${id}`,
        '',
        '⚠️ 多账号轮换会绕过单账号配额，违反 OpenAI 服务条款且有封号风险——风险由你承担。',
      ].join('\n'),
    }
  }
  if (sub === 'remove' || sub === 'rm' || sub === '删除') {
    const id = flag('id')
    if (typeof id !== 'string') return { ok: false, text: '用法：/taptap-gpt pool remove --id <名>' }
    writeGptPool(home, { accounts: readGptPool(home).accounts.filter((a) => a.id !== id) })
    return { ok: true, text: `已移除账号「${id}」（其浏览器登录态也一并删除）。` }
  }
  if (sub === 'ban' || sub === '封禁') {
    const id = flag('id')
    if (typeof id !== 'string') return { ok: false, text: '用法：/taptap-gpt pool ban --id <名>' }
    gptTouchAccount(home, id, { status: 'banned' })
    return { ok: true, text: `已封禁「${id}」，轮换时不再自动选它。恢复：/taptap-gpt pool unban --id ${id}` }
  }
  if (sub === 'unban' || sub === '恢复') {
    const id = flag('id')
    if (typeof id !== 'string') {
      const all = readGptPool(home).accounts
      for (const a of all) gptTouchAccount(home, a.id, { status: 'ok', note: '' })
      return { ok: true, text: `已恢复全部 ${all.length} 个账号（清掉封禁与冷却标记）。` }
    }
    gptTouchAccount(home, id, { status: 'ok', note: '' })
    return { ok: true, text: `已恢复「${id}」。` }
  }
  if (sub === 'rotate' || sub === '轮换') {
    const on = flag('on')
    const next = on === undefined ? !readGptPool(home).autoRotate : on !== 'false'
    writeGptPool(home, { autoRotate: next })
    return { ok: true, text: `账号自动轮换：${next ? '开' : '关'}。` }
  }
  // default: list
  const st = gptStatus(home)
  const p = st.pool
  if (p.total === 0) {
    return {
      ok: true,
      text: [
        '账号池为空（当前用单账号模式）。',
        '',
        '添加账号：/taptap-gpt pool add --id <名>  →  /taptap-gpt login --account <名>',
        '⚠️ 多账号轮换会绕过单账号配额，违反 OpenAI 服务条款且有封号风险——风险由你承担。',
      ].join('\n'),
    }
  }
  return {
    ok: true,
    text: [
      `账号池：共 ${p.total} 个（已登录 ${p.loggedIn}，冷却 ${p.cooling}，封禁 ${p.banned}），轮换 ${p.autoRotate ? '开' : '关'}`,
      ...p.accounts.map((a) => `  - ${a.id}${a.label !== a.id ? `（${a.label}）` : ''} `
        + `${a.loggedIn ? '已登录' : '未登录'}`
        + `${a.status === 'banned' ? ' 〔已封禁〕' : a.status === 'cooling' ? ' 〔冷却中〕' : ''}`),
      '',
      '添加账号：pool add --id <名>  →  login --account <名>',
      '恢复冷却/封禁账号：pool unban --id <名>（不带 id 则恢复全部）',
    ].join('\n'),
  }
}

/** Handle `/taptap-bgm pool …` and render it as human text. */
async function bgmPoolCommand(home, raw) {
  const parts = raw.split(/\s+/).filter(Boolean)
  const sub = (parts[1] ?? 'list').toLowerCase()
  const flag = (name) => {
    const m = new RegExp(`(?:--${name})\\s+(\\S+)`).exec(raw)
    return m === null ? undefined : m[1]
  }
  if (sub === 'add' || sub === '加号' || sub === '新增') {
    const id = flag('id')
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, text: '用法：/taptap-bgm pool add --id <短名> [--label 备注]' }
    }
    const pool = readBgmPool(home)
    if (pool.accounts.some((a) => a.id === id)) {
      return { ok: false, text: `账号「${id}」已存在。登录它：/taptap-bgm login --account ${id}` }
    }
    const label = flag('label') ?? id
    writeBgmPool(home, { accounts: [...pool.accounts, { id, label, status: 'unknown', lastUsedAt: null, note: '' }] })
    return {
      ok: true,
      text: [
        `已加账号「${id}」，现在共 ${readBgmPool(home).accounts.length} 个。`,
        '',
        `登录它：/taptap-bgm login --account ${id}`,
      ].join('\n'),
    }
  }
  if (sub === 'remove' || sub === 'rm' || sub === '删除') {
    const id = flag('id')
    if (typeof id !== 'string') return { ok: false, text: '用法：/taptap-bgm pool remove --id <名>' }
    writeBgmPool(home, { accounts: readBgmPool(home).accounts.filter((a) => a.id !== id) })
    try { fs.rmSync(profileDir(home, id), { recursive: true, force: true }) } catch { /* best effort */ }
    return { ok: true, text: `已移除账号「${id}」（其浏览器登录态也一并删除）。` }
  }
  if (sub === 'ban' || sub === '封禁') {
    const id = flag('id')
    if (typeof id !== 'string') return { ok: false, text: '用法：/taptap-bgm pool ban --id <名>' }
    bgmTouchAccount(home, id, { status: 'banned' })
    return { ok: true, text: `已封禁「${id}」，轮换时不再自动选它。恢复：/taptap-bgm pool unban --id ${id}` }
  }
  if (sub === 'unban' || sub === '恢复') {
    const id = flag('id')
    if (typeof id !== 'string') {
      const all = readBgmPool(home).accounts
      for (const a of all) bgmTouchAccount(home, a.id, { status: 'ok', note: '' })
      return { ok: true, text: `已恢复全部 ${all.length} 个账号（清掉封禁与冷却标记）。` }
    }
    bgmTouchAccount(home, id, { status: 'ok', note: '' })
    return { ok: true, text: `已恢复「${id}」。` }
  }
  if (sub === 'rotate' || sub === '轮换') {
    const on = flag('on')
    const next = on === undefined ? !readBgmPool(home).autoRotate : on !== 'false'
    writeBgmPool(home, { autoRotate: next })
    return { ok: true, text: `BGM 账号自动轮换：${next ? '开' : '关'}。` }
  }
  const st = bgmStatus(home)
  const p = st.pool
  if (p.total === 0) {
    return {
      ok: true,
      text: [
        'BGM 账号池为空（当前单账号模式）。',
        '',
        '加号：/taptap-bgm pool add --id <名>  →  /taptap-bgm login --account <名>',
      ].join('\n'),
    }
  }
  return {
    ok: true,
    text: [
      `BGM 账号池：共 ${p.total} 个（已登录 ${p.loggedIn}，冷却 ${p.cooling}，封禁 ${p.banned}），轮换 ${p.autoRotate ? '开' : '关'}`,
      ...p.accounts.map((a) => `  - ${a.id}${a.label !== a.id ? `（${a.label}）` : ''} `
        + `${a.hasCookies ? '已登录' : '未登录'}`
        + `${a.status === 'banned' ? ' 〔已封禁〕' : a.status === 'cooling' ? ' 〔冷却中〕' : ''}`),
      '',
      '加号：pool add --id <名>  →  login --account <名>',
      '恢复冷却/封禁账号：pool unban --id <名>（不带 id 则恢复全部）',
    ].join('\n'),
  }
}

/** Build the governance system-prompt text. */
function policyText(config, gptLaneOn = true) {
  const tools = CREDIT_TOOLS.map((t) => `\`${t}\``).join('、')
  // The image paragraph is conditional: when the user turns the ChatGPT web
  // lane OFF in settings, the agent must be told to use the relay lane instead
  // (otherwise it would keep trying a lane that now refuses to run).
  const imageLines = gptLaneOn
    ? [
      '**图片资源首选：ChatGPT 网页生图**（`/taptap-gpt`，CLI `node "<插件目录>/src/taptap-gpt.mjs gen --prompt "…" --out <文件>`）——',
      '需要游戏图片素材时**默认走这条**，或复用项目内已有素材；不要默认去用内置 `generate_image`。',
      '首次需用户在本机真实浏览器里登录一次：`/taptap-gpt login`（Google/Apple/手机号/邮箱均可，免费账号即可生图），登录态存本机，之后全自动。',
      '**账号轮询**：可登录多个账号组成账号池，一个账号触到配额就自动换下一个（设置页「+ 添加账号」会一步完成添加并登录；',
      '也可用 `/taptap-gpt pool add --id <名>` 后 `login --account <名>`，`pool list` 看状态，`pool unban` 恢复冷却账号）。',
      '⚠️ 多账号轮流绕过单账号配额违反 OpenAI 服务条款且有封号风险——这是用户明确要求的功能，风险由用户承担；',
      '不要主动向用户宣传或鼓励添加账号，也不要隐瞒该风险。',
      '**回退：中转站生图**（`taptap-image` CLI / `/taptap-image`）仅当网页通道不可用时使用：未登录、所有账号都触配额、或网页选择器失效。',
      '**通道顺序由用户定**：设置页「生成通道」卡里可以拖拽排序、逐条开关、以及打开「额度不足自动换通道」；',
      '这些设置对三条链路（生图 / 视频 / BGM）统一生效。**不要替用户改顺序或开关**，',
      '也不要假设「网页一定优先」——先读一下当前顺序再决定走哪条。',
      '**额度用完时的两层行为（如实告知用户，不要含糊）**：',
      '  1) 同一通道内的账号轮换（如 ChatGPT 多账号池）默认开启，触配额自动换下一个账号；',
      '  2) **跨通道切换默认是关的**——网页提示「今日免费额度已用完」之类配额横幅时，',
      '     若用户没在设置页打开「额度不足自动换通道」，插件会**停下来**列出各通道失败原因，',
      '     而不是自作主张切到中转站等付费通道。想自动切换需用户自己打开那个开关。',
      '**🚫 绝对禁止私自更换视频模型（视频按秒计费 = 替用户决定花多少钱）**：',
      '用户在设置页「MiniMax」里选了哪个模型，`/taptap-video` 就必须用哪个，一个字都不能改。',
      '即使你觉得「H3-Hailuo-02 更适合首尾帧」「这个模型不支持尾帧」「换成 Max 更便宜」，',
      '也**只能停下来把情况和可选方案讲清楚，然后问用户**，由用户自己下指令换。',
      '严禁：不问就换、把「推荐模型」当成「已获授权」、因为提交报错就自动重试另一个模型、',
      '或在没告知的情况下改作业的 model 字段。插件层面也已加硬约束：模型缺失或不兼容会**直接报错**，不会替你选。',
      '**🚫 提交报「结果未知 / fetch failed / 超时」时，绝不可以自动重跑**：',
      '这类错误说明请求**已经发出**、但没收到服务端回应 —— 服务端很可能已经收下并在生成、',
      '额度也可能已经扣了。再跑一次就是**多花一份钱**（这正是「白烧额度」最常见的来源）。',
      '正确做法：先 `/taptap-video status` 看提交台账、`/taptap-video poll` 继续查；',
      '确认服务端确实没有该任务之后，才用 `--yes` 重新提交。插件会拦：不带 `--yes` 不放行。',
      '同理，`poll` 查询失败**不是**任务失败，不要因此重新提交。',
      '**诚实限制**：chatgpt.com 有 Cloudflare 防护（无头浏览器会被挡、裸请求 403），且 OpenAI 界面改动频繁，',
      '网页生图脚本可能失效；失效时如实报告卡在哪一步（steps 里会写明失败阶段），不要假装成功；确认失效后再回退到中转站。',
      '**超时不要重新生成（很关键，会白烧额度）**：网页出图常要 1~3 分钟，我们等不到时会返回 `pendingUrl`（那个对话的链接）。',
      '这时**先等 1~2 分钟再 `taptap-gpt grab`**（或 `/taptap-gpt grab`）把已经生成好的图抓回来——不要立刻再跑一次 `gen`，',
      '`gen` 自己也会先尝试续抓上一轮未完成的图。只有 grab 明确说"没有图"时才考虑重新生成。',
      '**图片落点（默认跟随项目）**：在工作目录（Maker 项目根）执行 `gen` 时，图片默认存到 `<项目>/sucai/images/`，',
      '不再丢到 C 盘；该目录自带 `.gitignore` 防止被 Maker 自动提交。用户可在设置页「ChatGPT 网页生图」卡里自定义',
      '（支持 `{project}` / `{home}` 占位符），也可用 `/taptap-gpt dir --set <路径>`；命令行加 `--dir <目录>` 可单次覆盖。',
      '告诉用户图片存到了哪里（结果里的 `saved` 就是真实路径）。中间产物留在该目录或 `assets/` 之外，',
      '裁好后再搬进 `assets/`，并补同名 `.meta`。',
    ]
    : [
      '**图片资源：ChatGPT 网页生图已被用户在设置里关闭**（总开关 OFF）——',
      '**不要**调用 `/taptap-gpt gen`、也不要尝试网页生图；需要图片素材时改走中转站：',
      '`node "<插件目录>/src/taptap-image.mjs" --prompt "…" --out <文件>`（或 `/taptap-image <描述>`），',
      '或复用项目内已有素材；仍然不要用内置 `generate_image`。',
      '若用户想重新启用网页生图，引导他去设置页「ChatGPT 网页生图」卡打开开关（或 `/taptap-gpt` 里说明），不要自己去改状态。',
      '中转站保存位置可用 `--out` 或 `/taptap-gpt dir` 控制的目录约定；中间产物仍放在 `assets/` 之外，裁好后再搬进 `assets/` 并补 `.meta`。',
    ]
  return [
    '## TapTap Maker 开发守则（dsh-taptap-maker-dev 插件注入）',
    '',
    '**额度红线：非经用户在当前对话中明确要求，禁止调用任何消耗 TapTap Maker MCP 内置额度的生成工具。**',
    `受限工具：${tools}。`,
    '- 用户没有明说要用内置额度 / 要用这些工具时，一律视为禁止，不要“顺手”生成，也不要为补素材而自作主张调用。',
    '- 只有当用户明确说“用内置额度 / 用 Maker 的 generate_image / 用 2.5 生成视频”之类时才可调用，并遵守其原有的二次确认与计费提示规则。',
    '- 只读 / 状态 / 构建 / 反馈 / LSP 类 Maker 工具（如 maker 状态、构建、玩家反馈、Lua LSP）不消耗生成额度，可正常使用。',
    '',
    ...guardrailLines(),
    '',
    ...imageLines,
    '',
    '**优先查用内置 skills**：开发前先查本插件内置的 `taptap-maker-*` 与通用游戏设计类 skills（见 skill 列表）；',
    '遇到风格化 UI / 美术 / 系统玩法需求，先查是否有对应 skill，不要凭空编造。',
    '若有符合当下主题的热门玩法 / 梗，在不违反上面红线的前提下可优先采用。',
    '',
    '**资产视觉验收（别把"能跑"当成"做好了"）**：',
    '- **朝向**：模型朝哪边**算不出来**（朝 +Z 与 −Z 的模型导出后包围盒/节点树/动画完全一致）。',
    '  导入 3D 资产后、宣布完成前，读 `asset-orientation-qa` 并按判据表**看图确认**；',
    '  结论记进资产元数据，**绝不在 gameplay 代码里用 rotation 补偿**（会被静默覆盖）。',
    '- **验收**：结构检查（文件在、格式对、面数够）≠ 视觉可用；',
    '  **编译通过 / 能启动 / 日志无错 ≠ 验证完成**。交付前按 `asset-visual-qa` 真的玩一遍、',
    '  录一小段回看（朝向/附着/穿模/尺度/风格/光照/VFX/操作），详见其 `references/acceptance-gate.md`。',
    '- 看不清就说看不清：**一条错误的朝向记录比没有记录更糟**（会让下次检查直接跳过）。',
    '',
    '**自然语言即可触发初始化**：当用户用任意中文说法表达“安装 / 初始化 / 配置 / 搭建 TapTap Maker（制造）”',
    '或“帮我建一个 Maker 游戏项目”时，不要求用户去记 `/taptap-setup` 斜杠命令——直接给出并（在确认后）执行下面两步：',
    '  1) 安装 Maker MCP：`npx -y @taptap/maker install --ide codex,cursor,claude`（部分 Agent 装后需重启）；',
    '  2) 在空白本地目录初始化项目：`npx -y @taptap/maker init`。',
    '斜杠命令只是等价快捷方式；识别到自然语言意图就应主动响应。涉及联网/安装属中风险，先说明再执行。',
    '',
    '**生图尺寸按需、不固定**：游戏资源有大有小，按目标用途传 `--size`（如 1024x1024 做大图、1536x1024 做横幅）；',
    '`--size` 只在**中转站**通道生效。网页通道（ChatGPT）尺寸由它自己定、`--size` 会被忽略（返回里会写明），',
    '需要特定比例就在提示词里写明，或用 `--downscale` 事后裁切。做图标 / 小 UI 这类小资源：先出一张干净的大图',
    '（构图留白、主体居中），再用 `--downscale <宽>x<高>`（如 128x128 / 64x64）高质量缩小，切忌直接让模型出极小尺寸（细节糊）。',
    '',
    '**图生图 / 参考图（两条通道都支持，用法不同）**：',
    '- 网页通道（`taptap-gpt gen`）：`--ref <图>`（可重复 / 逗号分隔）。本质是把本地图上传进 ChatGPT 输入框的附件；',
    '  网页通道**不能指定尺寸**，尺寸由 ChatGPT 决定。',
    '- 中转站（`taptap-image edit`）：`--in <图>`（可重复 / 逗号分隔）走 `/images/edits`。',
    '  **多图参考不是所有模型都支持**：已知单图模型（如 dall-e-3、多数 SD 系）传多图会**直接拒绝且不发请求**；',
    '  确认模型支持多图可加 `--multi-ref`，确定只吃一张可加 `--single-ref`（只用第一张，并在结果里说明忽略了其余）。',
    '  不要为了让多图「通过」而悄悄丢图 —— 宁可报错让用户决定。',
    '',
    '**Skill 管理**：用户想隐藏/删除某些用不上的 skill 时，用 `/taptap-skills disable <名字>`（可空格或逗号分隔多个），',
    '`/taptap-skills enable <名字>` 恢复，`/taptap-skills list` 查看全部及禁用状态；禁用项不会再进入 skill 候选。',
    '',
    '**音效 / 背景音乐必须优先走 CC0 本地库（自动触发 · 不要只给命令让用户自己跑）**：',
    '只要用户用大白话表达“加个音效 / 来个背景音乐 / 配个 BGM / 加个点击音 / 金币声 / 胜利音效”等需求，',
    '**你必须自己动手完成，不要停在「你可以运行这条命令」**——用户要的是装好的素材，不是命令说明。',
    '任何时候都**不要调用 `text_to_sound_effect` / `text_to_music` / `batch_sound_effects`**（消耗 Maker 内置额度）。',
    '执行顺序（用 pwsh 真正跑命令，不要只打印）：',
    '  ① 音效资源库（首选，零成本）：',
    '     - 搜索：用 pwsh 执行 `node "<插件目录>/src/taptap-audio.mjs" search "<中文描述>"`；',
    '     - 安装：用 pwsh 执行 `node "<插件目录>/src/taptap-audio.mjs" add "<中文描述>" --project <Maker项目目录> [--out 名字.wav]`',
    '       —— 自动写入 `assets/audio/{sfx|bgm}/` 并生成同名 `.meta`（uuid）；',
    '     - 安装完要**告诉用户装到了哪个文件**，并继续该做的事（如接入代码），不要把命令甩给用户。',
    '     - `<插件目录>` 在本机的实际路径见下方「插件目录」一行；`<Maker项目目录>` 用当前工作目录。',
    '     - 查看来源：`node "<插件目录>/src/taptap-audio.mjs" sources`。',
    '     本地库 Kenney（CC0，可商用/可修改/无需署名，约 706 个）优先命中；本地没有时自动回落到',
    '     Mixkit（Mixkit Free License，可商用免署名）、小森平（中文页明写商业利用可）、',
    '     効果音ラボ（FAQ 明写商用免费、无需署名/报告，可嵌入游戏有偿销售）——这些只在用户真正安装时',
    '     单文件按需下载，绝不整站抓取。',
    '     **未接入**：Freesound（需用户自己的 API Key，裸请求实测 401）、OpenGameArt（授权混杂，含禁商用的 CC-BY-NC）。',
    '  ② 完整 BGM——**用户说「要背景音乐/BGM」时走这条**（全程在对话里完成，不要指路设置页）：',
    '     - **需要账号**：生成 BGM 要用用户的 MiniMax 账号登录网页来生成。',
    '       用户说「要 BGM」而尚未登录时，**你直接用 pwsh 执行** `/taptap-bgm login` 对应的',
    '       `node "<插件目录>/src/taptap-bgm-web.mjs" login`（会弹出浏览器让用户登录一次），',
    '       或用 `/taptap-bgm login` 命令；登录态存本机，之后自动。**不要让用户自己去设置页点**。',
    '     - **换号 / 退登录**：用户说「换个号」「退出登录」「登出」时，执行 `/taptap-bgm logout`',
    '       （清掉本机登录态），然后再 login 即可用另一个账号。账号管理入口也在设置页「BGM 账号」卡。',
    '     - **账号池 / 自动轮换**：可登录多个 MiniMax 账号，一个额度用完自动换下一个。',
    '       加号：`/taptap-bgm pool add --id <名>` → `login --account <名>`（设置页「+ 添加账号」会一步完成）；',
    '       `pool list` 看状态、`pool ban/unban` 封禁/恢复、`pool rotate` 开关轮换。',
    '       生成时不要手动挑账号，`/taptap-bgm <描述>` 会自动轮询；报告结果时说明用了哪个账号。',
    '     - **查额度**：用户问「还有多少额度」「是不是没额度了」时，执行 `/taptap-bgm credits`',
    '       （可加 `--account <名>` 查某个账号）。额度为 0 或不足时如实告知：可等恢复、加更多账号，',
    '       不要反复重试生成。',
    '     - **站点自动判断**：按当前网络可达性自动选国内版（minimax.cn）或国际版（minimax.io），',
    '       国际版多为 Google 登录，国内网络下选国内版。选好的站点会记住。',
    '     - **生成**：`/taptap-bgm <风格情绪描述>` —— 自动出提示词并用已登录浏览器完成生成与下载。',
    '       **提示词必须用中文**（站点是国内版、用户看中文）；用户给英文时先翻译成中文再生成，',
    '       并优先套用内置的中文场景模板（战斗/BOSS/胜利/失败/主菜单/探索/紧张/悲伤/商店/升级）。',
    '       也可先读项目里的文档（GAME_RULES.md 等）推断需要哪些场景 BGM，再据此生成提示词。',
    '     - **纯音乐（无歌词）默认开启**：游戏 BGM 大多不需要人声，插件会默认打开该开关。',
    '       **决定有没有人声的是站点上那个「纯音乐」开关，不是提示词** —— 靠写「纯音乐/无人声」是没用的。',
    '       插件会在点「创作」前自动把开关设到期望状态并校验；设不上会直接中止并报 `instrumental_unset`（不花额度）。',
    '       用户明确要带人声/歌词时才加 `--lyrics` 关掉它；开关与生成数量可在设置页「BGM 账号」调整。',
    '     - **导入项目**：`node "<插件目录>/src/taptap-audio.mjs" import --in <下载目录> '
      + '--project <Maker项目目录> --kind bgm --to wav --latest`，自动转格式 + 写 `.meta`。',
    '     - 装完要**告诉用户装到了哪个文件**。' + '不要向用户长篇解释原理，只说清「需要登录账号，之后用它生成」。',
    '     - **生成成功后**：告诉用户可点「输入框旁的 🎵 BGM 挂件」试听、拖波形裁剪、一键导入项目',
    '       （新生成的 BGM 会让挂件亮红点）。用户说「听听 / 裁一下 BGM」时，引导其点挂件操作，',
    '       挂件是纯本地零额度的；不要替用户假设他们已导入。',
    '     - 若网页结构变了拿不到文件，如实报告，提示手动下载后 import。',
    '  ③ 音频转格式 / 压缩（本地 ffmpeg，零成本、不联网）：',
    '     用户说「转成 wav / 压缩一下 / 统一音量 / 去掉静音 / 拼成循环 / 看看时长」时用：',
    '     `node "<插件目录>/src/taptap-audio-convert.mjs" --in <文件或目录> --out <目标> '
      + '[--to wav|mp3|ogg|opus|m4a|flac] [--mono] [--rate 44100] [--normalize] [--trim] '
      + '[--fade-in 0.1] [--fade-out 0.2] [--bitrate 64k] [--loop 8]`，',
    '     或对话里直接说需求（`/taptap-audio-convert` 同义）。需要 ffmpeg，缺失时如实提示安装。',
    '**诚实限制（必须如实告知）**：',
    '  - Kenney 音乐包只有 1~3 秒短 jingle，没有可无缝循环的完整 BGM；',
    '  - 完整 BGM 需要用户的 MiniMax 账号登录网页生成（登录一次即可，之后自动）；',
    '    MiniMax 音乐 API 对新用户返回 410，不要反复重试，也不要说成接口故障；',
    '  - 自部署开源 MiniMax-Music3 需 24GB+ 显存，普通机器跑不动，不要推荐；',
    '  - 若用户在网页也拿不到满意 BGM，如实报告并给选项（用短 jingle 凑 / 找 CC0 曲目 /',
    '    由用户决定是否动用 Maker 内置额度），绝不擅自调用消耗额度的生成工具。',
    '',
    `**插件目录**：\`${PKG_DIR}\`——上面所有 \`<插件目录>\` 都指这个真实路径，`,
    '调 CLI 时直接把它拼进命令（PowerShell 里路径加引号），不要让用户自己去猜路径。',
  ].join('\n')
}

/**
 * Seed $DSH_HOME/taptap-maker-dev/image.json from the config FORM (config.image.*).
 *
 * ⚠️ 仅首次（文件不存在）时 seed：表单值只作为初始值落一次盘。此后一切以
 * 文件为准 —— 旧逻辑「表单非空就覆盖文件」会让设置页/手改的值在每次重启时
 * 被表单旧值改回去（用户改了 baseURL → 重启 → 又变回去，典型「设置不生效」）。
 */
function seedImageConfig(config, home) {
  const file = imageConfigPath(home)
  if (fs.existsSync(file)) return file
  const image = config.image ?? {}
  const value = (key, fb = '') => (typeof image[key] === 'string' && image[key].length > 0 ? image[key] : fb)
  writeJson(file, {
    _comment: '自定义生图（OpenAI 兼容 /images/generations）。此文件在 $DSH_HOME 下，不在任何 Maker 工作区内。',
    baseURL: value('baseURL'),
    apiKey: value('apiKey'),
    model: value('model'),
    size: value('size', '1024x1024'),
    credentialsFile: value('credentialsFile'),
  })
  return file
}

/**
 * Seed minimax.json from the plugin config FORM (config.video.*).
 *
 * ⚠️ 为什么必须有这个：设置页有两处 MiniMax 入口 —— schemastery 表单
 * （config.video，用户在插件配置里填）和 video-minimax 路由（写 minimax.json）。
 * 之前只有后者落盘：用户在表单里填了 Key/站点/模型后，`videoConfigOf()` 读的
 * 却是 minimax.json —— 表单值被静默丢弃，表现为「设置了没生效」。
 * 这里沿用 seedImageConfig 的「不覆盖已有编辑」语义：仅当文件里还是空值时
 * 才从表单补写，用户在设置页保存过的值永远优先。
 */
function seedMinimaxConfig(config, home) {
  const file = minimaxConfigFileOf(home)
  // ⚠️ 只在文件**从未存在**（首次运行）时 seed：用户后来在设置页清空 Key 也
  // 是一种设置，若每次启动都按「空就回填」，表单旧值会把用户删掉的 Key
  // 复活（实测复现：清空 → 重启 → Key 又回来了）。首次之后一切以文件为准。
  if (fs.existsSync(file)) return
  const video = config.video ?? {}
  const patch = {}
  for (const key of ['apiKey', 'baseURL', 'model']) {
    const value = video[key]
    if (typeof value === 'string' && value.trim().length > 0) patch[key] = value.trim()
  }
  if (Object.keys(patch).length === 0) return
  writeMinimaxConfigPatch(home, patch)
}

/** minimax.json 的绝对路径（seedMinimaxConfig 用，避免与路由内重复定义漂移）。 */
function minimaxConfigFileOf(home) {
  return path.join(dataDir(home), 'minimax.json')
}

/**
 * 版本升级迁移：0.1.0 的 MiniMax 配置存在 music.json，0.2.0 改名为 minimax.json。
 *
 * 没有这一步，升级 = 用户在旧版里保存过的 Key「凭空消失」—— 新代码只认
 * minimax.json，旧文件躺在原地没人读。这正是「版本更新后设置页显示已保存、
 * 实际却报没有 Key」的另一条腿（文件名换了的升级从来不迁移）。
 *
 * 规则：minimax.json 已存在（新版里已有配置）就不动；music.json 有实质字段
 * 才迁移，迁完把旧文件改名为 music.json.migrated-<时间戳> 留档不删。
 *
 * ⚠️ logger 由调用方（apply）传入：本函数在模块层，没有 ctx。曾直接写
 * `ctx?.logger` —— 可选链防不了「未声明变量」，0.1.0 升级用户一启动就
 * ReferenceError 崩掉，迁移反而成了升级杀手。
 */
function migrateLegacyConfigs(home, { logger } = {}) {
  const newFile = minimaxConfigFileOf(home)
  if (fs.existsSync(newFile)) return
  const legacy = path.join(dataDir(home), 'music.json')
  const data = readJson(legacy)
  if (!data) return
  const patch = {}
  for (const key of ['apiKey', 'baseURL', 'model']) {
    if (typeof data[key] === 'string' && data[key].trim().length > 0) patch[key] = data[key].trim()
  }
  if (Object.keys(patch).length === 0) return
  writeMinimaxConfigPatch(home, patch)
  try { fs.renameSync(legacy, `${legacy}.migrated-${Date.now().toString(36)}`) } catch { /* 留档失败不影响迁移结果 */ }
  logger?.info?.('taptap-maker-dev: migrated music.json → minimax.json')
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
  // 0.1.0 → 0.2.0：music.json 里的 Key 迁到 minimax.json（不覆盖新版已有配置）。
  // ⚠️ 必须在 seedMinimaxConfig 之前：seed 会创建 minimax.json，迁移见到
  // 「文件已存在」就跳过 —— 顺序反了的话，表单里有 video 字段的升级用户，
  // music.json 里的 Key 永远迁不过来（保存值 > 表单值的优先序）。
  migrateLegacyConfigs(home, { logger: ctx?.logger })
  const imageFile = seedImageConfig(config, home)
  // 表单里填的 MiniMax Key/站点/模型 seed 进 minimax.json（不覆盖设置页保存过的值）。
  seedMinimaxConfig(config, home)
  ctx.logger?.info?.(`taptap-maker-dev: data=${dataDir(home)} skills-cache=${cacheDir} image-config=${imageFile}`)

  // --- 1b. CC0 audio library (lazy: fetched on first audio request) -------
  // Nothing is downloaded at startup — the first `search`/`add` triggers it, so
  // plugin load stays fast. After that it is fully local and offline.
  let audioReady = false
  let audioEnsuring = null
  const ensureAudio = async (opts = {}) => {
    if (audioReady) return
    // 「首次自动下载」是设置项（config.audio.autoEnsure，默认 true）：关掉后
    // 必须真的不自动拉库 —— 否则用户明确关掉的开关照样联网下载 7MB。
    // 显式 sync（设置页「更新素材库」按钮 / audio-sync 路由）传 force 跳过该闸。
    if (audioCfg.autoEnsure === false && opts.force !== true) {
      throw new Error('设置里已关闭「首次用到时自动下载音频库」（config.audio.autoEnsure=false）。'
        + '如需启用：设置页点「更新素材库」，或把该开关打开。')
    }
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
  // The image-lane master switch (imageLane.json) also lives in this text, so
  // flipping it rebuilds the section instead of waiting for a restart.
  let policyEnabled = readPolicyBlock(home, config.maker?.blockCreditTools)
  let gptLaneOn = readGptLaneEnabled(home)
  let policyDispose = null
  let systemPromptService = null
  const applyPolicySection = () => {
    if (systemPromptService === null) return
    // Rebuild whenever the text may have changed: dispose then re-add.
    if (policyDispose !== null) {
      try { policyDispose() } catch { /* already gone */ }
      policyDispose = null
    }
    if (policyEnabled) {
      policyDispose = systemPromptService.section({
        name: 'taptap-maker-dev:policy',
        order: 300,
        text: policyText(config, gptLaneOn),
      })
    }
  }
  const setPolicyEnabled = (enabled) => {
    policyEnabled = enabled !== false
    writePolicyBlock(home, policyEnabled)
    applyPolicySection()
    return policyEnabled
  }
  // Master switch for the ChatGPT web image lane. When OFF the injected policy
  // tells the agent to use the relay lane instead, and /taptap-gpt gen refuses.
  const setGptLane = (enabled) => {
    gptLaneOn = writeGptLaneEnabled(home, enabled)
    applyPolicySection()
    return gptLaneOn
  }
  ctx.inject(['systemPrompt'], (scoped) => {
    systemPromptService = scoped.systemPrompt
    policyDispose = null // fresh service scope; any prior disposer is already gone
    applyPolicySection()
  })

  // --- 1c. 版本检查（GitHub raw 上的 package.json 对比本地版本）----------
  // 缓存在 version-check.json，设置页「关于」卡直接读缓存展示；
  // 后台 6 小时一次，网络失败静默 —— 绝不影响插件主流程。
  startBackgroundCheck(home, { logger: ctx.logger })

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
    const MAX_BODY_BYTES = 1_000_000
    const readBody = (req) => new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size <= MAX_BODY_BYTES) { chunks.push(c); return }
        // Backstop for chunked bodies (no/lying Content-Length): destroying the
        // socket is honest — the old behaviour silently TRUNCATED and every
        // route then failed JSON.parse with a misleading "invalid JSON body".
        try { req.destroy() } catch { /* ignore */ }
        chunks.length = 0
        resolve('')
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })

    // --- BGM workbench helpers (preview / trim / import widget) -----------
    // All local + free: static file streaming and ffmpeg. The widget lives on
    // the MAIN interface (usage), while account config stays on settings.
    const BGM_AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm'])
    const BGM_MIME = {
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
      '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg', '.webm': 'audio/webm',
    }
    const bgmDurationCache = new Map() // abs path -> { mtimeMs, duration }
    const probeBgmDuration = (abs) => {
      try {
        const st = fs.statSync(abs)
        const hit = bgmDurationCache.get(abs)
        if (hit && hit.mtimeMs === st.mtimeMs) return hit.duration
        const duration = ffprobeDuration(abs)
        bgmDurationCache.set(abs, { mtimeMs: st.mtimeMs, duration })
        return duration
      } catch { return null }
    }
    /** Resolve a request-supplied file name to a file inside bgm-downloads. */
    const safeBgmFile = (name) => {
      if (typeof name !== 'string' || name.length === 0 || name.length > 200) return null
      const base = path.basename(name) // kills ../ traversal
      if (!BGM_AUDIO_EXTS.has(path.extname(base).toLowerCase())) return null
      const abs = path.join(downloadDir(home), base)
      try { if (!fs.statSync(abs).isFile()) return null } catch { return null }
      return abs
    }
    /** The Maker project the host is currently sitting in (has assets/). */
    const detectMakerProject = (explicit) => {
      if (typeof explicit === 'string' && explicit.length > 0) {
        const p = path.resolve(explicit)
        if (fs.existsSync(path.join(p, 'assets'))) return p
      }
      const cwd = path.resolve(process.cwd())
      return fs.existsSync(path.join(cwd, 'assets')) ? cwd : null
    }
    /** Never overwrite an existing asset: append (裁剪 2), (裁剪 3)… */
    const dedupeAssetName = (dir, name) => {
      if (!fs.existsSync(path.join(dir, name))) return name
      const ext = path.extname(name)
      const base = path.basename(name, ext)
      for (let i = 2; i < 100; i += 1) {
        const candidate = `${base} ${i}${ext}`
        if (!fs.existsSync(path.join(dir, candidate))) return candidate
      }
      return `${base} ${Date.now()}${ext}`
    }
    const handler = async (req, res) => {
      try {
        // Uniform 413 for oversized uploads (every route posts a tiny JSON
        // config — a big body is never legitimate). Without this a large body
        // used to be silently truncated and die as "invalid JSON body".
        const contentLength = Number(req.headers['content-length'] ?? 0)
        if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close' })
          res.end(JSON.stringify({ ok: false, error: `请求体 ${Math.round(contentLength / 1024)}KB 超过上限 ${Math.round(MAX_BODY_BYTES / 1024)}KB` }))
          try { req.destroy() } catch { /* ignore */ }
          return
        }
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
        if (req.method === 'GET' && sub === 'asset-dirs') {
          // 素材落点：三类统一收在 <项目>/sucai/<类型>/，不在项目里才退回 $DSH_HOME。
          // 设置页用它如实显示「东西到底存哪了」—— 猜目录是用户最常问的问题之一。
          const kinds = { image: 'gpt-images', video: 'video-jobs', bgm: 'bgm-downloads' }
          const configured = { image: readGptDownloadDir(home), video: '', bgm: '' }
          const dirs = {}
          for (const [kind, fallback] of Object.entries(kinds)) {
            const r = resolveAssetDirForApi(home, kind, { configured: configured[kind], fallback })
            dirs[kind] = { dir: r.dir, source: r.source, insideProject: r.insideProject }
          }
          return sendJson(res, 200, { ok: true, dirs, file: lanesConfigPathForApi(home) })
        }
        if (req.method === 'GET' && sub === 'image') {
          const raw = readImageConfigRaw(home)
          return sendJson(res, 200, {
            ok: true,
            baseURL: raw.baseURL ?? '',
            // ⚠️ Key 与 video-relay / video-minimax 同一约定：不回显明文给浏览器。
            // 客户端原样提交掩码串时由 POST 路由识别为「未修改」。
            apiKey: maskSecret(raw.apiKey ?? ''),
            model: raw.model ?? '',
            size: raw.size ?? '1024x1024',
            credentialsFile: raw.credentialsFile ?? '',
          })
        }
        if (req.method === 'POST' && sub === 'image') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          // GET 回的是掩码 Key；设置页整表单回传时 apiKey 就是掩码串 ——
          // 识别为「未修改」（归入空串=不修改），否则掩码会被当成真 Key 存盘。
          const savedImage = readImageConfigRaw(home)
          if (typeof parsed.apiKey === 'string' && parsed.apiKey.trim() !== '' && parsed.apiKey === maskSecret(savedImage.apiKey ?? '')) {
            parsed.apiKey = ''
          }
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
        // ── 视频中转站（与上面「中转站生图」同一套心智，只是视频是异步任务）──
        // GET  /video-relay   → 当前配置 + Key 类型 + 三个后端可用性
        // POST /video-relay   → 保存（空串=不修改；要真清空得传 clear:true）
        // POST /video-relay/models → 用中转站自己的 /models 列模型（免费自检）
        if (req.method === 'GET' && sub === 'video-relay') {
          const cfg = normalizeRelayConfig(readVideoRelayConfigRaw(home))
          const mmx = readMinimaxConfigRaw(home)
          const mmxKey = mmx.apiKey || (process.env.MINIMAX_API_KEY ?? '').trim()
          return sendJson(res, 200, {
            ok: true,
            relay: {
              ...cfg,
              // ⚠️ 与 video-minimax / 生图卡同一安全约定：Key 绝不回显明文给浏览器。
              // 之前这里把 sk-secret 原样发出去（同一设置页三种 Key 三种待遇）。
              // 客户端提交时 apiKey 为空串 → writeVideoRelayConfigPatch 的
              // 「空串=不修改」保住已存的 Key；要清空走 clear: true。
              apiKey: maskSecret(cfg.apiKey),
            },
            hasApiKey: Boolean(cfg.apiKey),
            protocols: RELAY_PROTOCOLS,
            minimax: {
              keyKind: detectKeyKind(mmxKey),
              keyKindText: describeKey(mmxKey),
              baseURL: mmx.baseURL,
              model: mmx.model,
            },
            // 设置页用它画「现在能走哪条」，不用自己再推断。
            backends: {
              relay: Boolean(cfg.enabled && cfg.baseURL && cfg.apiKey && cfg.model),
              minimax: Boolean(mmxKey),
              local: true,
            },
            file: videoRelayConfigFile(home),
          })
        }
        if (req.method === 'POST' && sub === 'video-relay') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          // GET 现在只回掩码 Key（不回显明文）；客户端把整个表单原样提交回来时
          // apiKey 可能就是那个掩码串 —— 必须识别为「未修改」，否则会把
          // `sk-se…2345` 这种掩码当成真 Key 存进去（设置当场坏掉）。
          const savedBefore = normalizeRelayConfig(readVideoRelayConfigRaw(home))
          if (typeof parsed.apiKey === 'string' && parsed.apiKey.trim() !== '' && parsed.apiKey === maskSecret(savedBefore.apiKey)) {
            parsed.apiKey = '' // 归入「空串=不修改」的既有语义
          }
          const patch = {}
          for (const key of ['protocol', 'baseURL', 'apiKey', 'model', 'size', 'ratio', 'referenceStyle', 'assetUploadPath', 'submitMethod', 'submitPath', 'queryMethod', 'queryPath', 'videoUrlPath', 'taskIdPath', 'statusPath', 'authHeader', 'authPrefix', 'extraQuery', 'extraBody']) {
            if (typeof parsed[key] === 'string') patch[key] = parsed[key]
          }
          if (typeof parsed.enabled === 'boolean') patch.enabled = parsed.enabled
          if (parsed.clear === true) patch.clear = true
          if (typeof parsed.idInBody === 'boolean') patch.idInBody = parsed.idInBody
          if (typeof parsed.seconds === 'number') patch.seconds = parsed.seconds
          for (const key of ['doneValues', 'failedValues', 'pendingValues']) {
            if (typeof parsed[key] === 'string') patch[key] = parsed[key].split(',').map((s) => s.trim()).filter(Boolean)
            else if (Array.isArray(parsed[key])) patch[key] = parsed[key]
          }
          const merged = writeVideoRelayConfigPatch(home, patch)
          const cfg = normalizeRelayConfig(merged)
          // 这里的 minimax 必须按**真实** Key 算，不能写死 true：设置页的绿点
          // 是「现在能不能走」，写死就变成了「看起来能走」。
          const mmxKey = (readMinimaxConfigRaw(home).apiKey || (process.env.MINIMAX_API_KEY ?? '')).trim()
          return sendJson(res, 200, {
            ok: true,
            relay: { ...cfg, apiKey: maskSecret(cfg.apiKey) }, // POST 响应同样不回显明文
            backends: {
              relay: Boolean(cfg.enabled && cfg.baseURL && cfg.apiKey && cfg.model),
              minimax: Boolean(mmxKey),
              local: true,
            },
            hasApiKey: Boolean(cfg.apiKey),
            file: videoRelayConfigFile(home),
          })
        }
        if (req.method === 'POST' && sub === 'video-relay/models') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const saved = normalizeRelayConfig(readVideoRelayConfigRaw(home))
          // 用表单里当前填的值试，没填的退回已保存的 —— 用户可以「先试再存」。
          const probe = normalizeRelayConfig({
            ...saved,
            baseURL: (typeof parsed.baseURL === 'string' && parsed.baseURL.trim()) || saved.baseURL,
            apiKey: (typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) || saved.apiKey,
          })
          try {
            const models = await relayListModels(probe)
            return sendJson(res, 200, { ok: true, models })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        // ── 版本检查 ──
        // GET   /version          → 当前版本 + 缓存的检查结果（设置页「关于」卡）
        // POST  /version/check    → 立即检查一次（绕过冷却，结果落盘）
        if (req.method === 'GET' && sub === 'version') {
          const cached = readCachedCheck(home)
          return sendJson(res, 200, {
            ok: true,
            current: currentVersion(),
            cached: cached ?? null,
            needsCheck: shouldCheck(home),
          })
        }
        if (req.method === 'POST' && sub === 'version/check') {
          try {
            const r = await checkForUpdates(home)
            return sendJson(res, 200, { ok: !r.error, ...r })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        // ── 通道优先级 + 各通道开关（三条链路共用一套语义）──
        // GET  /lanes → 顺序 / 开关 / 每条通道「现在能不能用」
        // POST /lanes → 改顺序、改开关、改自动回退总开关
        // 这里回 ready 是为了让界面能画「已配置 / 未配置」状态点 —— 别让用户
        // 排完队才发现第一条其实没配 Key，那才是真的浪费时间。
        if (req.method === 'GET' && sub === 'lanes') {
          const mmxKey = (readMinimaxConfigRaw(home).apiKey || (process.env.MINIMAX_API_KEY ?? '')).trim()
          const relayCfg = normalizeRelayConfig(readVideoRelayConfigRaw(home))
          const imageCfg = readImageConfigRaw(home)
          // 顺带把三类素材的真实落点一起返回：设置页一次请求就能画全，
          // 用户不用去三个地方猜东西存在哪。
          const dirFallbacks = { image: 'gpt-images', video: 'video-jobs', bgm: 'bgm-downloads' }
          const dirConfigured = { image: readGptDownloadDir(home), video: '', bgm: '' }
          const dirs = {}
          for (const [kind, fallback] of Object.entries(dirFallbacks)) {
            const r = resolveAssetDirForApi(home, kind, { configured: dirConfigured[kind], fallback })
            dirs[kind] = { dir: r.dir, source: r.source, insideProject: r.insideProject }
          }
          const readiness = {
            gptWeb: () => readGptLaneEnabled(home),
            relayImage: () => Boolean(imageCfg.baseURL && imageCfg.apiKey && imageCfg.model),
            relay: () => relayReadyForApi(relayCfg),
            minimax: () => Boolean(mmxKey),
            local: () => true,
            bgmWeb: () => true,
          }
          const cfg = readLanesForApi(home)
          const groups = {}
          for (const [group, def] of Object.entries(LANE_GROUPS_FOR_API)) {
            const saved = cfg.groups[group]
            groups[group] = {
              label: def.label,
              lanes: saved.order.map((id) => {
                const lane = def.lanes.find((l) => l.id === id)
                let ready = false
                try { ready = Boolean(readiness[id]?.()) } catch { ready = false }
                return {
                  id,
                  label: lane?.label ?? id,
                  kind: lane?.kind ?? 'api',
                  note: lane?.note ?? '',
                  zeroCost: lane?.zeroCost === true,
                  enabled: saved.enabled[id] !== false,
                  ready,
                  // 「关着」和「开着但没配」是两件事，界面要能分开说。
                  reason: !ready ? LANE_UNREADY_REASON[id] ?? '尚未配置' : undefined,
                }
              }),
            }
          }
          return sendJson(res, 200, {
            ok: true,
            autoFallback: cfg.autoFallback,
            groups,
            dirs,
            file: lanesConfigPathForApi(home),
          })
        }
        if (req.method === 'POST' && sub === 'lanes') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const patch = {}
          if (typeof parsed.autoFallback === 'boolean') patch.autoFallback = parsed.autoFallback
          if (parsed.groups && typeof parsed.groups === 'object') patch.groups = parsed.groups
          // 归一化在 writeLanes 里做：脏 id / 全关 / 重复项都被挡住。
          const saved = writeLanesForApi(home, patch)
          // 回**与 GET 同形状**的数据：设置页保存后直接吃这份响应刷新界面，
          // 不用再发一次 GET（也避免两端形状不一致导致界面显示错乱）。
          const relayCfg = normalizeRelayConfig(readVideoRelayConfigRaw(home))
          const imageCfg2 = readImageConfigRaw(home)
          const mmxKey2 = (readMinimaxConfigRaw(home).apiKey || (process.env.MINIMAX_API_KEY ?? '')).trim()
          const fb2 = { image: 'gpt-images', video: 'video-jobs', bgm: 'bgm-downloads' }
          const cf2 = { image: readGptDownloadDir(home), video: '', bgm: '' }
          const dirs2 = {}
          for (const [kind, fallback] of Object.entries(fb2)) {
            const r = resolveAssetDirForApi(home, kind, { configured: cf2[kind], fallback })
            dirs2[kind] = { dir: r.dir, source: r.source, insideProject: r.insideProject }
          }
          const readiness2 = {
            gptWeb: () => readGptLaneEnabled(home),
            // ⚠️ 必须用 imageCfg2（POST 分支里刚读的那份）：这里曾误引用 GET 分支的
            // imageCfg，而 POST 分支从未定义它 → 保存即 ReferenceError → 500。
            // 用户看到的就是「点了保存没反应」，属于最典型的「设置不生效」。
            relayImage: () => Boolean(imageCfg2.baseURL && imageCfg2.apiKey && imageCfg2.model),
            relay: () => relayReadyForApi(relayCfg),
            minimax: () => Boolean(mmxKey2),
            local: () => true,
            bgmWeb: () => true,
          }
          const groupsOut = {}
          for (const [group, def] of Object.entries(LANE_GROUPS_FOR_API)) {
            const s2 = saved.groups[group]
            groupsOut[group] = {
              label: def.label,
              lanes: s2.order.map((id) => {
                const lane = def.lanes.find((l) => l.id === id)
                let ready = false
                try { ready = Boolean(readiness2[id]?.()) } catch { ready = false }
                return {
                  id,
                  label: lane?.label ?? id,
                  kind: lane?.kind ?? 'api',
                  note: lane?.note ?? '',
                  zeroCost: lane?.zeroCost === true,
                  enabled: s2.enabled[id] !== false,
                  ready,
                  reason: !ready ? LANE_UNREADY_REASON[id] ?? '尚未配置' : undefined,
                }
              }),
            }
          }
          return sendJson(res, 200, { ok: true, autoFallback: saved.autoFallback, groups: groupsOut, dirs: dirs2, file: lanesConfigPathForApi(home) })
        }
        // GET/POST /video-minimax —— 设置页管 MiniMax 共用配置（站点 + 模型 + Key）。
        // Key 只回「有没有」与「是什么类型」，绝不回显明文。
        if (req.method === 'GET' && sub === 'video-minimax') {
          const cfg = readMinimaxConfigRaw(home)
          const key = cfg.apiKey || (process.env.MINIMAX_API_KEY ?? '').trim()
          // Key 来源要亮出来：文件里没有、靠 env 撑着时，设置页必须说实话，
          // 否则用户以为保存过（曾经保存过后来被清掉 / 升级丢了都看不出来）。
          const src = readMinimaxConfigWithSource(home).source
          return sendJson(res, 200, {
            ok: true,
            baseURL: cfg.baseURL,
            model: cfg.model,
            hasApiKey: Boolean(key),
            keyKind: detectKeyKind(key),
            keyKindText: describeKey(key),
            keySource: src.apiKey,
            envKeyPresent: src.envKeyPresent,
            models: listVideoModels().map((m) => ({ id: m.id, note: m.note, supportsLastFrame: m.supportsLastFrame })),
          })
        }
        if (req.method === 'POST' && sub === 'video-minimax') {
          const body = await readBody(req)
          let parsed
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          // 空 Key = 「不修改」（与生图卡同一惯例）；要清空得显式传 clear: true。
          const file = minimaxConfigFileOf(home)
          let patch = {}
          if (typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) patch.apiKey = parsed.apiKey.trim()
          if (typeof parsed.baseURL === 'string' && parsed.baseURL.trim()) patch.baseURL = parsed.baseURL.trim()
          if (typeof parsed.model === 'string' && parsed.model.trim()) patch.model = parsed.model.trim()
          if (parsed.clear === true) {
            // 清空 Key：直接从文件里删掉这一项。
            // 不能走 writeMinimaxConfigPatch —— 它会忽略空串，结果是「界面上清空了、
            // 文件里还留着旧 Key」。这个分支单独处理并写盘，再把 patch 清掉。
            const raw = readJson(file) ?? {}
            delete raw.apiKey
            writeJson(file, raw)
          }
          patch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== ''))
          const merged = Object.keys(patch).length > 0
            ? writeMinimaxConfigPatch(home, patch)
            : (readJson(file) ?? {})
          const key = (merged.apiKey || (process.env.MINIMAX_API_KEY ?? '')).trim()
          const src = readMinimaxConfigWithSource(home).source
          return sendJson(res, 200, {
            ok: true,
            baseURL: merged.baseURL || 'https://api.minimaxi.com',
            model: merged.model || 'MiniMax-H3',
            hasApiKey: Boolean(key),
            keyKind: detectKeyKind(key),
            keyKindText: describeKey(key),
            keySource: src.apiKey,
            envKeyPresent: src.envKeyPresent,
          })
        }
        // BGM ACCOUNT routes: which account is logged in, logging in, logging
        // out (to switch accounts), and checking remaining credits. Account
        // management is configuration, so the settings page is the right home
        // for it; BGM *generation* is usage and stays in the chat.
        if (req.method === 'GET' && sub === 'bgm') {
          const st = bgmStatus(home)
          const site = st.site ?? (await bgmDetectSite())
          if (!st.site) bgmSaveSite(home, site)
          return sendJson(res, 200, { ok: true, ...st, site })
        }
        if (req.method === 'POST' && sub === 'bgm-login') {
          // Launch detached and return immediately; the UI polls /bgm.
          // Optional { account } logs in a NAMED pool account (rotation).
          const body = await readBody(req)
          let account
          try { account = JSON.parse(body || '{}')?.account } catch { account = undefined }
          const cli = path.join(PKG_DIR, 'src', 'taptap-bgm-web.mjs')
          try {
            const site = (bgmStatus(home).site) ?? (await bgmDetectSite())
            bgmSaveSite(home, site)
            const argv = [cli, 'login', '--waitMs', '300000']
            if (typeof account === 'string' && account.length > 0) argv.push('--account', account)
            const child = spawn(process.execPath, argv, { detached: true, stdio: 'ignore' })
            child.unref()
            return sendJson(res, 200, { ok: true, started: true, site, ...bgmStatus(home) })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        // BGM account pool: add / remove / ban / unban / rotate.
        if (req.method === 'POST' && sub === 'bgm-pool') {
          const body = await readBody(req)
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const action = parsed.action
          const id = typeof parsed.id === 'string' ? parsed.id : undefined
          try {
            if (action === 'add') {
              if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
              const pool = readBgmPool(home)
              if (pool.accounts.some((a) => a.id === id)) {
                return sendJson(res, 200, { ok: true, ...bgmStatus(home), warn: `账号 ${id} 已存在` })
              }
              writeBgmPool(home, {
                accounts: [...pool.accounts,
                  { id, label: typeof parsed.label === 'string' && parsed.label ? parsed.label : id, status: 'unknown', lastUsedAt: null, note: '' }],
              })
            } else if (action === 'remove') {
              if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
              writeBgmPool(home, { accounts: readBgmPool(home).accounts.filter((a) => a.id !== id) })
              try {
                bgmReleaseProfile(profileDir(home, id))
                fs.rmSync(profileDir(home, id), { recursive: true, force: true })
              } catch { /* best effort */ }
            } else if (action === 'ban') {
              if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
              bgmTouchAccount(home, id, { status: 'banned' })
            } else if (action === 'unban') {
              if (!id) {
                for (const a of readBgmPool(home).accounts) bgmTouchAccount(home, a.id, { status: 'ok', note: '' })
              } else {
                bgmTouchAccount(home, id, { status: 'ok', note: '' })
              }
            } else if (action === 'rotate') {
              writeBgmPool(home, { autoRotate: parsed.on !== false })
            } else {
              return sendJson(res, 400, { ok: false, error: `unknown action: ${action}` })
            }
            return sendJson(res, 200, { ok: true, ...bgmStatus(home) })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        // ChatGPT account routes (mirror the BGM account lane): login once, then
        // reuse the saved session. The relay-station image API stays primary.
        if (req.method === 'GET' && sub === 'gpt') {
          const st = gptStatus(home)
          return sendJson(res, 200, { ok: true, ...st })
        }
        if (req.method === 'POST' && sub === 'gpt-login') {
          // Optional --account <id>: log in a NAMED pool account (multi-account
          // rotation). Launched detached so the UI can keep polling /gpt.
          const body = await readBody(req)
          let account
          try { account = JSON.parse(body || '{}')?.account } catch { account = undefined }
          const cli = path.join(PKG_DIR, 'src', 'taptap-gpt.mjs')
          try {
            const argv = [cli, 'login', '--waitMs', '300000']
            if (typeof account === 'string' && account.length > 0) argv.push('--account', account)
            const child = spawn(process.execPath, argv, { detached: true, stdio: 'ignore' })
            child.unref()
            return sendJson(res, 200, { ok: true, started: true, ...gptStatus(home) })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        if (req.method === 'POST' && sub === 'gpt-logout') {
          const body = await readBody(req)
          let account
          try { account = JSON.parse(body || '{}')?.account } catch { account = undefined }
          try {
            const r = gptLogout(home, account)
            return sendJson(res, 200, { ok: r.ok, ...r })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        // Master switch for the ChatGPT web image lane (on/off). Persisted in
        // imageLane.json and mirrored into the injected policy text.
        if (req.method === 'POST' && sub === 'gpt-lane') {
          const body = await readBody(req)
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          try {
            const on = setGptLane(parsed?.enabled !== false)
            return sendJson(res, 200, { ok: true, laneEnabled: on, ...gptStatus(home) })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        // Download dir for generated images: '' follows the project, a path
        // pins it. Merge-writes imageLane.json so the lane switch survives.
        if (req.method === 'POST' && sub === 'gpt-dir') {
          const body = await readBody(req)
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          try {
            const value = typeof parsed?.dir === 'string' ? parsed.dir : ''
            writeGptDownloadDir(home, value)
            return sendJson(res, 200, { ok: true, ...gptStatus(home) })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        // Account pool management (add / remove / ban / unban / rotate).
        if (req.method === 'POST' && sub === 'gpt-pool') {
          const body = await readBody(req)
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const action = parsed.action
          const id = typeof parsed.id === 'string' ? parsed.id : undefined
          try {
            if (action === 'add') {
              if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
              const pool = readGptPool(home)
              if (pool.accounts.some((a) => a.id === id)) {
                return sendJson(res, 200, { ok: true, ...gptStatus(home), warn: `账号 ${id} 已存在` })
              }
              writeGptPool(home, {
                accounts: [...pool.accounts,
                  { id, label: typeof parsed.label === 'string' && parsed.label ? parsed.label : id, status: 'unknown', lastUsedAt: null, note: '' }],
              })
              // 「添加并登录」是一步动作：光建条目不算完成，用户还得自己再点一次
              // 「登录」才弹浏览器 —— 那正是「点了没反应」的另一半原因。
              // 这里直接把它启动起来（失败不影响账号已建好，warn 里如实说明）。
              if (parsed.login !== false) {
                try {
                  const cli = path.join(PKG_DIR, 'src', 'taptap-gpt.mjs')
                  const argv = [cli, 'login', '--waitMs', '300000', '--account', id]
                  const child = spawn(process.execPath, argv, { detached: true, stdio: 'ignore' })
                  child.unref()
                } catch (e) {
                  return sendJson(res, 200, {
                    ok: true, ...gptStatus(home),
                    warn: `账号 ${id} 已添加，但登录窗口没能自动打开：${e?.message ?? e}（请点该账号的「登录」）`,
                  })
                }
              }
            } else if (action === 'remove') {
              if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
              writeGptPool(home, { accounts: readGptPool(home).accounts.filter((a) => a.id !== id) })
              try {
                // Use the SAME sanitized path builder as the runtime: an inline
                // `browser-profile-gpt-${id}` missed ids containing spaces/
                // Chinese, so "remove account" silently left the stale session
                // dir behind. Release the lock first or rmSync no-ops on Windows.
                const prof = gptAccountProfileDir(home, id)
                gptReleaseProfile(prof)
                fs.rmSync(prof, { recursive: true, force: true })
              } catch { /* best effort */ }
            } else if (action === 'ban') {
              if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' })
              gptTouchAccount(home, id, { status: 'banned' })
            } else if (action === 'unban') {
              if (!id) {
                for (const a of readGptPool(home).accounts) gptTouchAccount(home, a.id, { status: 'ok', note: '' })
              } else {
                gptTouchAccount(home, id, { status: 'ok', note: '' })
              }
            } else if (action === 'rotate') {
              writeGptPool(home, { autoRotate: parsed.on !== false })
            } else {
              return sendJson(res, 400, { ok: false, error: `unknown action: ${action}` })
            }
            return sendJson(res, 200, { ok: true, ...gptStatus(home) })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        if (req.method === 'GET' && sub === 'bgm-config') {
          return sendJson(res, 200, { ok: true, ...readBgmConfig(home) })
        }
        if (req.method === 'POST' && sub === 'bgm-config') {
          const body = await readBody(req)
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const merged = writeBgmConfig(home, {
            instrumental: typeof parsed.instrumental === 'boolean' ? parsed.instrumental : undefined,
            count: typeof parsed.count === 'number' ? parsed.count : undefined,
          })
          return sendJson(res, 200, { ok: true, ...merged })
        }
        if (req.method === 'POST' && sub === 'bgm-logout') {
          const body = await readBody(req)
          let account
          try { account = JSON.parse(body || '{}')?.account } catch { account = undefined }
          try {
            const r = bgmLogout(home, account)
            return sendJson(res, 200, { ok: r.ok, ...r })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        if (req.method === 'POST' && sub === 'bgm-credits') {
          // Optional { account } checks a specific pool account's credits.
          const body = await readBody(req)
          let account
          try { account = JSON.parse(body || '{}')?.account } catch { account = undefined }
          try {
            const r = await bgmCredits(home, { accountId: account })
            return sendJson(res, 200, { ok: r.ok, credits: r, error: r.error ?? null })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        // --- BGM workbench: preview / trim / import (main-interface widget) --
        // GET bgm-library — everything in bgm-downloads + which names are
        // already imported into the current project's assets/audio/bgm.
        if (req.method === 'GET' && sub === 'bgm-library') {
          const dir = downloadDir(home)
          fs.mkdirSync(dir, { recursive: true })
          const entries = []
          for (const f of fs.readdirSync(dir)) {
            if (!BGM_AUDIO_EXTS.has(path.extname(f).toLowerCase())) continue
            const abs = path.join(dir, f)
            let st
            try { st = fs.statSync(abs) } catch { continue }
            if (!st.isFile()) continue
            entries.push({ name: f, abs, bytes: st.size, mtimeMs: st.mtimeMs })
          }
          // Probe durations CONCURRENTLY: serial spawnSync made the first
          // library load take ~150ms × file count (13 files ≈ 2s of ffprobe).
          const durations = await Promise.all(entries.map((e) => {
            const hit = bgmDurationCache.get(e.abs)
            if (hit && hit.mtimeMs === e.mtimeMs) return hit.duration
            return ffprobeDurationAsync(e.abs).then((duration) => {
              if (duration !== null) bgmDurationCache.set(e.abs, { mtimeMs: e.mtimeMs, duration })
              return duration
            })
          }))
          const files = entries.map((e, i) => ({ name: e.name, bytes: e.bytes, mtimeMs: e.mtimeMs, duration: durations[i] }))
          files.sort((a, b) => b.mtimeMs - a.mtimeMs)
          const project = detectMakerProject()
          let importedNames = []
          if (project !== null) {
            try {
              importedNames = fs.readdirSync(path.join(project, 'assets', 'audio', 'bgm'))
                .filter((f) => BGM_AUDIO_EXTS.has(path.extname(f).toLowerCase()))
            } catch { importedNames = [] }
          }
          // 「已导入」matching: installs are always .wav (often with a
          // 「 裁剪」/「 裁剪 N」 suffix from the workbench) while downloads are
          // usually .mp3, so exact-name matching NEVER marked anything imported
          // — the pill stayed off forever after a successful import. Compare
          // stems instead, stripping the trim marker the workbench appends.
          const importedStem = (name) => path.basename(name, path.extname(name))
            .replace(/ 裁剪(?: \d+)?$/, '')
            .toLowerCase()
          const importedSet = new Set(importedNames.map(importedStem))
          for (const f of files) f.imported = importedSet.has(importedStem(f.name))
          return sendJson(res, 200, { ok: true, dir, project, files })
        }
        // GET bgm-file?name=… — stream one file (Range-aware so <audio> can seek).
        if (req.method === 'GET' && sub === 'bgm-file') {
          const abs = safeBgmFile(url.searchParams.get('name') ?? '')
          if (abs === null) return sendJson(res, 404, { ok: false, error: '文件不存在' })
          const stat = fs.statSync(abs)
          const type = BGM_MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
          const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
          if (range !== null && (range[1] !== '' || range[2] !== '')) {
            const from = range[1] === '' ? 0 : Number(range[1])
            const to = range[2] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1)
            if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || from >= stat.size) {
              res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
              return res.end()
            }
            res.writeHead(206, {
              'Content-Type': type,
              'Content-Length': to - from + 1,
              'Content-Range': `bytes ${from}-${to}/${stat.size}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-store',
            })
            return fs.createReadStream(abs, { start: from, end: to }).pipe(res)
          }
          res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          })
          return fs.createReadStream(abs).pipe(res)
        }
        // POST bgm-trim { name, start, end, fade } — cut [start,end) seconds,
        // convert to wav, install into the project with a .meta. fade (default
        // on) adds a 0.3s fade-in + 0.5s fade-out so the cut points don't click.
        // POST bgm-import { name } — same pipeline without cutting (原样导入).
        if (req.method === 'POST' && (sub === 'bgm-trim' || sub === 'bgm-import')) {
          const body = await readBody(req)
          let p = {}
          try { p = JSON.parse(body || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
          const abs = safeBgmFile(p.name ?? '')
          if (abs === null) return sendJson(res, 404, { ok: false, error: '文件不存在或不是音频' })
          const project = detectMakerProject(p.project)
          if (project === null) {
            return sendJson(res, 400, {
              ok: false,
              error: '没找到 Maker 项目：请先在 DSH 里打开含 assets/ 的项目工作区再导入',
            })
          }
          const isTrim = sub === 'bgm-trim'
          let start = 0
          let end = null
          if (isTrim) {
            start = Number(p.start ?? 0)
            end = Number(p.end ?? 0)
            if (!Number.isFinite(start) || start < 0) start = 0
            if (!Number.isFinite(end) || end <= start) {
              return sendJson(res, 400, { ok: false, error: '裁剪区间无效（终点必须大于起点）' })
            }
            const full = probeBgmDuration(abs)
            if (full !== null && end > full) end = full
            if (end - start < 1) return sendJson(res, 400, { ok: false, error: '裁剪区间太短（至少 1 秒）' })
          }
          // 「淡入淡出」开关只对**裁剪**有意义（避免裁剪点爆音）；「原样导入」
          // 的承诺是不动内容 —— 之前 import 分支也无条件加 fade，文件被悄悄改了
          // 首尾 0.3/0.5 秒的音量，与「原样」二字矛盾。
          const wantFade = isTrim && p.fade !== false
          const base = path.basename(abs, path.extname(abs))
          try {
            // 1) cut + convert into a temp wav (no Maker credits; pure ffmpeg)
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taptap-bgm-'))
            const tmpOut = path.join(tmpDir, 'out.wav')
            const conv = ffmpegConvert(abs, tmpOut, {
              to: 'wav',
              ...(isTrim && start > 0 ? { start } : {}),
              ...(isTrim ? { end } : {}),
              ...(wantFade ? { 'fade-in': 0.3, 'fade-out': 0.5 } : {}),
            })
            // 2) install into assets/audio/bgm/ with a unique name + .meta
            const outName = dedupeAssetName(
              path.join(project, 'assets', 'audio', 'bgm'),
              `${base}${isTrim ? ' 裁剪' : ''}.wav`,
            )
            const inst = installAudioAsset(tmpOut, project, 'bgm', outName)
            try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
            return sendJson(res, 200, {
              ok: true,
              file: inst.target,
              meta: inst.meta,
              uuid: inst.uuid,
              kb: Math.round(inst.bytes / 1024),
              duration: conv.duration,
              project,
            })
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
        }
        // NOTE: audio-search / audio-sources were removed — the settings page no
        // longer offers audio search (that is usage, and lives in the chat).
        if (req.method === 'GET' && sub === 'audio') {
          const ready = fs.existsSync(path.join(audioCacheDir, 'index.json'))
          return sendJson(res, 200, {
            ok: true,
            cacheDir: audioCacheDir,
            ready,
            count: ready ? (readJson(path.join(audioCacheDir, 'index.json'))?.items?.length ?? 0) : 0,
            // autoEnsure=false 时如实告诉界面：不是坏了，是用户关了自动下载。
            autoEnsureDisabled: audioCfg.autoEnsure === false,
          })
        }
        if (req.method === 'POST' && sub === 'audio-sync') {
          try {
            // force: 这是用户在设置页亲手点的「更新素材库」，绕过 autoEnsure 闸。
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
      name: 'taptap-audio',
      description: 'CC0 音效 / BGM：搜索、安装、导入本地音频到项目（不消耗 Maker 额度）',
      input: { hint: 'search/add "<描述>"；import --in <文件/目录> --project <dir>；sync 更新库' },
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
              `  node "${cli}" add "金币音效" --project <项目目录> --out coin.wav`,
              `  node "${cli}" import --in <下载目录> --project <项目目录> --kind bgm --to wav --latest`,
              `  node "${cli}" sync     # 下载/更新音频库`,
              '',
              `音频库缓存：${audioCacheDir}`,
              '首次使用会自动下载（约 7MB，九个包、七百多个音频），之后走本地缓存。',
              '注意：音乐包只有 1~3 秒短 jingle，没有可无缝循环的完整 BGM。',
              '完整 BGM：MiniMax API 对新用户返回 410，可从 MiniMax Audio 网页下载后用 import 导入。',
            ].join('\n'),
          }
        }

        // `import --in <file|dir> --project dir [--kind bgm|sfx] [--to wav] [--latest]`
        const im = /^(import|导入)\s+(.+)$/.exec(raw)
        if (im !== null) {
          const rest = im[2]
          const pm = /--project\s+("[^"]+"|\S+)/.exec(rest)
          const inm = /--in\s+("[^"]+"|\S+)/.exec(rest)
          if (pm === null || inm === null) {
            return { kind: 'error', text: '用法：/taptap-audio import --in <文件或目录> --project <Maker项目目录> [--kind bgm|sfx] [--to wav] [--latest]' }
          }
          const project = path.resolve(pm[1].replace(/^["']|["']$/g, ''))
          const inPath = path.resolve(inm[1].replace(/^["']|["']$/g, ''))
          if (!fs.existsSync(path.join(project, 'assets'))) {
            return { kind: 'error', text: `${project} 看起来不是 Maker 项目（没有 assets/ 目录）` }
          }
          if (!fs.existsSync(inPath)) {
            return { kind: 'error', text: `找不到：${inPath}` }
          }
          const argv = [
            cli, 'import', '--in', inPath, '--project', project,
          ]
          const kindM = /--kind\s+(bgm|sfx)/.exec(rest)
          if (kindM !== null) argv.push('--kind', kindM[1])
          const toM = /--to\s+(\w+)/.exec(rest)
          if (toM !== null) argv.push('--to', toM[1])
          const outM = /--out\s+(\S+)/.exec(rest)
          if (outM !== null) argv.push('--out', outM[1])
          if (/--latest/.test(rest)) argv.push('--latest')
          if (/--mono/.test(rest)) argv.push('--mono')
          const rateM = /--rate\s+(\d+)/.exec(rest)
          if (rateM !== null) argv.push('--rate', rateM[1])
          const out = spawnSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
          if (out.status !== 0 && !out.stdout) {
            return { kind: 'error', text: `导入失败：${(out.stderr || '').trim().split('\n').slice(-1)[0] ?? 'unknown'}` }
          }
          let parsed
          try { parsed = JSON.parse(out.stdout) } catch {
            return { kind: 'error', text: `导入失败（输出无法解析）：${(out.stdout || '').slice(0, 300)}` }
          }
          if (parsed.ok === false || parsed.imported === 0) {
            const errs = (parsed.files ?? []).filter((f) => f.error).map((f) => `  ${f.file}: ${f.error}`)
            return { kind: 'error', text: ['导入未完成：', ...errs].join('\n') }
          }
          return {
            kind: 'success',
            text: [
              `已导入 ${parsed.imported} 个音频 → assets/audio/${parsed.kind}/`,
              '',
              ...(parsed.files ?? []).map((f) => f.error
                ? `  ✗ ${f.file}: ${f.error}`
                : `  ✓ ${path.basename(f.file)}  ${f.kb}KB${f.converted ? `（已转 ${f.converted}）` : ''}  uuid=${f.uuid}`),
              '',
              '已生成同名 .meta（22 位 uuid），Maker 可直接识别。',
            ].join('\n'),
          }
        }
        // `add 描述 --project dir [--out x.wav]`
        const m = /^(add|install|添加|安装)\s+(.+)$/.exec(raw)
        if (m !== null) {
          const rest = m[2]
          // Accept quoted values so paths containing spaces work (the import
          // branch already did; this one silently truncated them).
          const pm = /--project\s+("[^"]+"|'[^']+'|\S+)/.exec(rest)
          const om = /--out\s+("[^"]+"|'[^']+'|\S+)/.exec(rest)
          const desc = rest
            .replace(/--project\s+("[^"]+"|'[^']+'|\S+)/, '')
            .replace(/--out\s+("[^"]+"|'[^']+'|\S+)/, '')
            .trim()
          if (pm === null) {
            return { kind: 'error', text: '用法：/taptap-audio add "<描述>" --project <Maker项目目录> [--out 名字.wav]' }
          }
          const project = path.resolve(pm[1].replace(/^["']|["']$/g, ''))
          if (!fs.existsSync(path.join(project, 'assets'))) {
            return { kind: 'error', text: `${project} 看起来不是 Maker 项目（没有 assets/ 目录）` }
          }
          // ensureLibrary's manifest/index writes can throw (locked or
          // read-only cache dir); without this the whole command dies as an
          // unhandled rejection instead of a readable message.
          try { await ensureAudio() } catch (error) {
            return { kind: 'error', text: `音频库初始化失败：${error?.message ?? error}（可重试；持续失败请检查磁盘权限）` }
          }
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
        try { await ensureAudio() } catch (error) {
          return { kind: 'error', text: `音频库初始化失败：${error?.message ?? error}（可重试；持续失败请检查磁盘权限）` }
        }
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
      input: { hint: '--in <文件或目录> --out <目标> [--to wav|mp3|ogg] [--start 12.5 --end 48] [--mono] [--rate 44100] [--normalize] [--trim] [--fade-in 0.3] [--fade-out 0.5] [--loop N] | --probe <文件>' },
      handler: async (invocation) => {
        const cli = path.join(PKG_DIR, 'src', 'taptap-audio-convert.mjs')
        const raw = (invocation?.rawInput ?? '').trim()
        const fm = /--in\s+("[^"]+"|\S+)/.exec(raw)
        const to = /--to\s+(\w+)/.exec(raw)
        const usage = [
          '音频转换（ffmpeg，本地离线，不消耗任何额度）：',
          '',
          '  · CC0 下载来的 ogg/mp3 转成 Maker 项目习惯的 wav：',
          `    /taptap-audio-convert --in D:\\tmp\\sfx --out <项目>\\assets\\audio\\sfx --to wav --mono --rate 44100`,
          '  · 压缩体积（适合小游戏）：',
          `    /taptap-audio-convert --in big.wav --out small.mp3 --to mp3 --bitrate 64k --mono`,
          '  · 统一响度 + 去首尾静音 + 淡出：',
          `    /taptap-audio-convert --in sfx --out out --to wav --normalize --trim --fade-out 0.05`,
          '  · 精确截一段（秒；裁完自动带淡入淡出，不会在切点爆音）：',
          `    /taptap-audio-convert --in bgm.mp3 --out bgm_16s.wav --start 12.5 --end 48 --fade-in 0.3 --fade-out 0.5`,
          '  · 短音拼成一段可循环 BGM：',
          `    /taptap-audio-convert --in one_shot.ogg --out bgm_loop.mp3 --loop 8`,
          '  · 查看时长：',
          `    /taptap-audio-convert --probe some.ogg`,
          '',
          '支持格式：wav / mp3 / ogg / opus / m4a / flac。需要 ffmpeg（winget install Gyan.FFmpeg）。',
        ].join('\n')

        // --probe <file> → report duration + size. (The usage text has always
        // advertised this, but the handler only ever looked for --in, so the
        // documented example silently printed the usage block instead of
        // probing. Fixed 2026-10-18.)
        const probeM = /--probe\s+("[^"]+"|\S+)/.exec(raw)
        if (probeM !== null) {
          const target = path.resolve(probeM[1].replace(/^["']|["']$/g, ''))
          if (!fs.existsSync(target)) {
            return { kind: 'error', text: `找不到：${target}` }
          }
          const out = spawnSync(process.execPath, [cli, '--probe', target], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
          if (out.status !== 0 && !out.stdout) {
            return { kind: 'error', text: `探测失败：${(out.stderr || '').trim().split('\n').slice(-1)[0] ?? 'unknown'}` }
          }
          let info
          try { info = JSON.parse(out.stdout) } catch {
            return { kind: 'error', text: `探测失败（输出无法解析）：${(out.stdout || '').slice(0, 300)}` }
          }
          const secs = typeof info.durationSec === 'number' ? info.durationSec : null
          return {
            kind: 'success',
            text: [
              `${path.basename(target)}`,
              `  时长：${secs === null ? '读不到（ffprobe 缺失或文件损坏）' : `${secs.toFixed(2)}s`}`,
              `  体积：${Math.round((info.bytes ?? 0) / 1024)}KB`,
              '',
              '要截取片段：/taptap-audio-convert --in <文件> --out <输出> --start <秒> --end <秒>',
            ].join('\n'),
          }
        }

        // --in given → actually run it, not just echo the command back.
        if (fm !== null) {
          const inPath = path.resolve(fm[1].replace(/^["']|["']$/g, ''))
          if (!fs.existsSync(inPath)) {
            return { kind: 'error', text: `找不到输入：${inPath}\n\n${usage}` }
          }
          const om = /--out\s+("[^"]+"|\S+)/.exec(raw)
          if (om === null) {
            return { kind: 'error', text: `缺少 --out <目标文件/目录>\n\n${usage}` }
          }
          const outPath = path.resolve(om[1].replace(/^["']|["']$/g, ''))
          try {
            // Flag matching must not require a leading space: "--mono" may be the
            // first flag the user types (an earlier /\s--mono/ pattern silently
            // dropped it in that case).
            const hasFlag = (name) => new RegExp(`(^|\\s)--${name}(\\s|$)`).test(raw)
            const flagVal = (name) => {
              const m = new RegExp(`(?:^|\\s)--${name}\\s+("[^"]+"|\\S+)`).exec(raw)
              return m === null ? null : m[1].replace(/^["']|["']$/g, '')
            }
            const spawnArgs = [cli, '--in', inPath, '--out', outPath]
            if (to !== null) spawnArgs.push('--to', to[1])
            if (hasFlag('mono')) spawnArgs.push('--mono')
            const rate = flagVal('rate')
            if (rate !== null) spawnArgs.push('--rate', rate)
            if (hasFlag('normalize')) spawnArgs.push('--normalize')
            if (hasFlag('trim')) spawnArgs.push('--trim')
            const bitrate = flagVal('bitrate')
            if (bitrate !== null) spawnArgs.push('--bitrate', bitrate)
            const loop = flagVal('loop')
            if (loop !== null) spawnArgs.push('--loop', loop)
            const fadeOut = flagVal('fade-out')
            if (fadeOut !== null) spawnArgs.push('--fade-out', fadeOut)
            const fadeIn = flagVal('fade-in')
            if (fadeIn !== null) spawnArgs.push('--fade-in', fadeIn)
            // Precise cut (seconds). These were added to the CLI but never
            // forwarded here, so a cut request silently produced the WHOLE file
            // — the worst kind of bug (looks like success, wrong audio).
            const startSec = flagVal('start')
            if (startSec !== null) spawnArgs.push('--start', startSec)
            const endSec = flagVal('end')
            if (endSec !== null) spawnArgs.push('--end', endSec)
            const out = spawnSync(process.execPath, spawnArgs, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
            if (out.status !== 0 && !out.stdout) {
              return { kind: 'error', text: `转换失败：${(out.stderr || '').trim().split('\n').slice(-1)[0] ?? 'unknown'}\n\n${usage}` }
            }
            const parsed = JSON.parse(out.stdout)
            if (parsed.ok === false) {
              return { kind: 'error', text: `转换有失败项：\n${(parsed.files ?? []).filter((f) => f.error).map((f) => `  ${f.file}: ${f.error}`).join('\n')}` }
            }
            // Say what was actually cut: without this the user cannot tell a
            // real cut from a silently full-length copy.
            const first = (parsed.files ?? [])[0] ?? {}
            const cutLine = first.start != null || first.end != null
              ? `裁剪：${first.start ?? 0}s → ${first.end ?? '结尾'}s（实际 ${first.duration ?? '?'}s）`
              : ''
            return {
              kind: 'success',
              text: [
                `已转换 ${parsed.converted} 个文件 → ${parsed.to}`,
                cutLine,
                `体积：${Math.round(parsed.bytesBefore / 1024)}KB → ${Math.round(parsed.bytesAfter / 1024)}KB`,
                '',
                ...(parsed.files ?? []).slice(0, 10).map((f) => `  ${f.file}  (${f.from}→${f.to}, ${f.kbBefore}KB→${f.kbAfter}KB${f.duration != null ? `, ${f.duration}s` : ''})`),
                (parsed.files ?? []).length > 10 ? `  …还有 ${(parsed.files ?? []).length - 10} 个` : '',
              ].filter(Boolean).join('\n'),
            }
          } catch (error) {
            return { kind: 'error', text: `转换失败：${error?.message ?? error}\n\n${usage}` }
          }
        }
        return { kind: 'success', text: usage }
      },
    })

    scoped.commands.register({
      name: 'taptap-gpt',
      description: 'ChatGPT 网页生图：<描述> 生成 / lane on|off 总开关 / login 登录 / pool 账号池 / status',
      input: { hint: '<图片描述> | lane on|off | login [--account <名>] | pool list | logout | status' },
      handler: async (invocation) => {
        const raw = (invocation?.rawInput ?? '').trim()
        const low = raw.toLowerCase()
        const cli = path.join(PKG_DIR, 'src', 'taptap-gpt.mjs')

        // login [--account <id>]
        if (low === 'login' || low.startsWith('login ') || raw === '登录') {
          const acct = (/(?:--account|-a)\s+(\S+)/.exec(raw) ?? [])[1]
          const res = await gptLogin(home, { waitMs: 300000, accountId: acct })
          const poolHint = acct ? `账号「${acct}」已登录。加更多账号：/taptap-gpt pool add --id <名> 再 login --account <名>。`
            : '登录态保存在本机，只需登录一次。加第二个账号：/taptap-gpt pool add --id <名>，然后 login --account <名>。'
          return {
            kind: res?.logged === true ? 'success' : 'error',
            text: res?.logged === true
              ? `已登录 ChatGPT，之后网页生图都用它。\n${poolHint}`
              : '未完成登录（或超时）。请在打开的浏览器里完成登录（Google/Apple/手机号/邮箱均可），登录态会保存。',
          }
        }
        if (low === 'logout' || raw === '退出' || raw === '换号') {
          const acct = (/(?:--account|-a)\s+(\S+)/.exec(raw) ?? [])[1]
          const r = gptLogout(home, acct)
          return {
            kind: r.ok ? 'success' : 'error',
            text: r.ok
              ? `已退出${acct ? `账号「${acct}」` : ''}登录态。可用另一个账号 /taptap-gpt login。`
              : `退出失败：可能有浏览器正在占用，请先关闭再试。（${r.profile ?? ''}）`,
          }
        }
        // Download dir: /taptap-gpt dir | dir --set <路径> | dir --reset
        if (low === 'dir' || low.startsWith('dir ') || raw === '目录') {          const setArg = (/--set\s+("[^"]+"|'[^']+'|\S+)/.exec(raw) ?? [])[1]
          if (/--reset/.test(raw)) {
            writeGptDownloadDir(home, '')
            return { kind: 'success', text: '已恢复默认：图片存到当前项目下的 sucai/images/（不在项目里时存到 $DSH_HOME）。' }
          }
          if (setArg) {
            const value = setArg.replace(/^["']|["']$/g, '')
            writeGptDownloadDir(home, value)
            const st = gptStatus(home)
            return {
              kind: 'success',
              text: [
                `图片下载目录已设为：${value}`,
                `当前生效：${st.downloadDir}`,
                '',
                '支持占位符 {project}（当前项目目录）、{home}（$DSH_HOME）。恢复默认：/taptap-gpt dir --reset',
              ].join('\n'),
            }
          }
          const st = gptStatus(home)
          return {
            kind: 'success',
            text: [
              `图片下载目录：${st.downloadDir}`,
              `来源：${st.downloadDirSource === 'project' ? '跟随当前项目（默认）' : st.downloadDirSource === 'config' ? '自定义' : '默认（$DSH_HOME）'}`,
              st.downloadDirConfigured ? `自定义值：${st.downloadDirConfigured}` : '自定义值：未设置（跟随项目）',
              '',
              '设置：/taptap-gpt dir --set "D:\\my-images" 或 --set "{project}/imgs"',
              '恢复默认：/taptap-gpt dir --reset',
            ].join('\n'),
          }
        }
        // 抓图：把「已经生成但没下到」的图取回来，不重新生成（省额度）。
        //   /taptap-gpt grab                  抓 pending 记录里的那个对话
        //   /taptap-gpt grab <对话url>         抓指定对话
        if (low === 'grab' || low.startsWith('grab ') || raw === '抓图' || low === 'pending') {
          const urlArg = (/https?:\/\/\S+/.exec(raw) ?? [])[1]
          if (low === 'pending') {
            const p = readGptPending(home)
            return {
              kind: 'success',
              text: p
                ? [`待抓取对话：${p.url}`, `提示词：${p.prompt || '(未知)'}`, `提交于：${new Date(p.at).toLocaleString('zh-CN')}`,
                  '', '抓取：/taptap-gpt grab'].join('\n')
                : '没有待抓取的图（上次生成要么已下载，要么还没开始过）。',
            }
          }
          const r = await gptGrab(home, { url: urlArg })
          if (!r.ok) {
            return {
              kind: 'error',
              text: [
                `抓图失败：${r.error}`,
                r.stillGenerating ? '图可能还在生成，过 1-2 分钟再试一次（不用重新生成）。' : '',
                r.hint ?? '',
                r.url ? `对话：${r.url}` : '',
              ].filter(Boolean).join('\n'),
            }
          }
          return { kind: 'success', text: [`已抓取：${r.saved}`, '', '这是中间产物，裁好后再搬进 assets/ 并补同名 .meta。'].join('\n') }
        }
        // Master switch: /taptap-gpt lane on|off|status
        if (low === 'lane' || low.startsWith('lane ') || raw === '开关') {
          const wantsOn = /(?:^|\s)(on|开|true)$/i.test(raw)
          const wantsOff = /(?:^|\s)(off|关|false)$/i.test(raw)
          if (!wantsOn && !wantsOff) {
            return {
              kind: 'success',
              text: [
                `网页生图总开关：${readGptLaneEnabled(home) ? '开' : '关'}`,
                '',
                '打开：/taptap-gpt lane on',
                '关闭：/taptap-gpt lane off（关闭后模型改走中转站）',
              ].join('\n'),
            }
          }
          const on = setGptLane(wantsOn)
          return {
            kind: 'success',
            text: on
              ? '已打开网页生图：模型会默认走 ChatGPT 网页通道。'
              : '已关闭网页生图：模型不会尝试网页通道，图片改走中转站 /taptap-image。随时可以 /taptap-gpt lane on 打开。',
          }
        }
        // 账号池：list / add / remove / ban / unban / rotate
        if (low === 'pool' || low.startsWith('pool ')) {
          const r = await gptPoolCommand(home, raw)
          return { kind: r.ok ? 'success' : 'error', text: r.text }
        }
        if (low === 'add' || low.startsWith('add ')) {
          const r = await gptPoolCommand(home, `pool ${raw}`)
          return { kind: r.ok ? 'success' : 'error', text: r.text }
        }
        if (low === 'status' || raw === '状态') {
          const st = gptStatus(home)
          const p = st.pool
          // Pool stats only make sense when the pool is actually in use.
          // Showing 「共 0 个（已登录 0）」 next to a logged-in main account read
          // as a contradiction to the user (2026-10-17), so say it plainly.
          const poolLines = p.total === 0
            ? ['账号池：未启用（单账号模式，用主账号生成）。要加附加账号：pool add --id <名>']
            : [
              `账号池：附加账号 ${p.total} 个（已登录 ${p.loggedIn}，冷却 ${p.cooling}，封禁 ${p.banned}），轮换 ${p.autoRotate ? '开' : '关'}`,
              ...p.accounts.map((a) => `  - ${a.id}${a.label !== a.id ? `（${a.label}）` : ''} ${a.loggedIn ? '已登录' : '未登录'}`
                + `${a.status === 'banned' ? ' 〔已封禁〕' : a.status === 'cooling' ? ' 〔冷却中〕' : ''}`),
            ]
          const lines = [
            `ChatGPT 登录状态：${st.loggedIn ? '已登录' : '未登录'}`,
            `  profile: ${st.profile}`,
            `  下载目录: ${st.downloadDir}`,
            '',
            ...poolLines,
            '',
            st.laneEnabled === false
              ? '总开关已关闭：不会走网页生图（/taptap-gpt lane on 可打开）。'
              : (st.loggedIn || p.loggedIn > 0
                ? '可以直接说「生成一个蓝色盾牌图标」，默认走这条网页通道。'
                : '先登录：/taptap-gpt login（只需一次）'),
          ]
          return { kind: 'success', text: lines.join('\n') }
        }

        // Anything else IS the image description — this lane is the default.
        const desc = raw.replace(/^(图片|生图|生成图片|画一张|生成一张)\s*/i, '').trim()
        if (desc.length === 0) {
          const st = gptStatus(home)
          return {
            kind: 'success',
            text: [
              'ChatGPT 网页生图是首选通道。直接说：/taptap-gpt 一只橙色小猫，扁平矢量风格',
              '',
              `当前：${st.loggedIn || st.pool.loggedIn > 0 ? '已登录，可直接生成' : '未登录'}`,
              st.loggedIn || st.pool.loggedIn > 0 ? '' : '先登录：/taptap-gpt login（只需一次）',
              '',
              '账号池：pool list 看状态 / pool add --id <名> 添加账号 / pool unban --id <名> 恢复冷却账号',
            ].filter(Boolean).join('\n'),
          }
        }

        const st = gptStatus(home)
        if (st.laneEnabled === false) {
          return {
            kind: 'error',
            text: [
              'ChatGPT 网页生图已在设置里关闭（总开关 OFF），所以不会走这条通道。',
              '',
              '要用图片就走中转站：/taptap-image <描述>',
              '想重新启用网页生图：设置页「ChatGPT 网页生图」卡打开开关，或 /taptap-gpt 里说一声让我帮你打开。',
            ].join('\n'),
          }
        }
        if (!st.loggedIn && st.pool.loggedIn === 0) {
          return {
            kind: 'error',
            text: [
              '还没登录 ChatGPT 网页账号，生图需要用它（走你自己的账号/免费额度，不消耗 Maker 内置额度）。',
              '',
              '登录：/taptap-gpt login',
              '（或先回退到中转站：/taptap-image）',
            ].join('\n'),
          }
        }
        const downscale = (/(?:--downscale|-d)\s+(\d+x\d+)/.exec(raw) ?? [])[1]
        const acct = (/(?:--account|-a)\s+(\S+)/.exec(raw) ?? [])[1]
        // 参考图（图生图）：`--ref <图>` 可重复、也可逗号分隔。
        // ⚠️ 这些参数必须从 prompt 里剥掉：以前只剥 downscale/account，
        //    用户写 `/taptap-gpt 改成水彩风 --ref a.png` 时，"--ref a.png"
        //    会原样混进提示词发给 ChatGPT（模型会把它当成文字要求）。
        const refs = []
        for (const m of raw.matchAll(/(?:--ref(?:erence)?s?|-r)\s+(?:"([^"]+)"|(\S+))/g)) {
          const value = m[1] ?? m[2] ?? ''
          for (const part of value.split(',')) {
            const p = part.trim()
            if (p.length > 0) refs.push(p)
          }
        }
        const prompt = desc
          .replace(/(?:--downscale|-d)\s+\d+x\d+/g, '')
          .replace(/(?:--account|-a)\s+\S+/g, '')
          .replace(/(?:--ref(?:erence)?s?|-r)\s+(?:"[^"]+"|\S+)/g, '')
          .trim()
        if (prompt.length === 0) {
          return {
            kind: 'error',
            text: '请给一句图片描述。图生图：/taptap-gpt 把这个角色改成水彩风 --ref 角色.png',
          }
        }
        // 走统一入口 generateImage：它按「生成通道」卡的顺序/开关/autoFallback
        // 决定先走谁、额度不足要不要换下一条。旧写法直接调 generateWithRotation，
        // 用户打开「额度不足自动换通道」后生图也永远不会切到中转站（入口没人接）。
        const imageCfgNow = readImageConfigRaw(home)
        const relayOut = path.join(resolveDownloadDir(home, {}).dir, `relay-${Date.now()}.png`)
        const r = await gptGenerateImage(home, prompt, {
          gptOpts: {
            accountId: acct,
            downscale,
            ...(refs.length > 0 ? { references: refs } : {}),
          },
          relayOpts: {
            dshHome: home,
            prompt,
            out: relayOut,
            ...(downscale ? { downscale } : {}),
            // 中转站回退也接受参考图：单图用 in，多图交给 editImage 的 image[]。
            ...(refs.length === 1 ? { in: refs[0] } : {}),
            ...(refs.length > 1 ? { in: refs } : {}),
          },
          relayReady: () => Boolean(imageCfgNow.baseURL && imageCfgNow.apiKey && imageCfgNow.model) && relayImageLaneEnabled(home),
        })
        if (!r.ok) {
          const triedList = Array.isArray(r.failures) ? r.failures.map((f) => `  ${f.account ?? '(默认)'}: ${f.error}`).join('\n') : ''
          const isQuota = String(r.error ?? '').startsWith('quota:')
          const isChallenge = r.error === 'cloudflare_challenge'
          return {
            kind: 'error',
            text: [
              `网页生图失败：${r.error}`,
              r.rotated ? `已自动轮换过账号：${(r.tried ?? []).join(' → ')}` : '',
              triedList,
              '',
              isChallenge
                ? '这是 **Cloudflare 人机验证**（页面显示「请验证您是真人」），不是选择器失效。'
                  + '再跑一次时，在弹出的浏览器窗口里手动勾选那个验证框，勾完它会自动继续。'
                : isQuota
                  ? '所有可用账号都触到配额了。可以：登录/恢复更多账号（/taptap-gpt pool list、pool unban），或回退到中转站 /taptap-image。'
                    + '（若想以后额度用完时自动切到中转站：设置页「生成通道」→ 打开「额度不足时自动换下一条通道」，默认是关的。）'
                  : r.pendingUrl
                    ? `图可能还在生成（网页出图常要 1-3 分钟）。**不要重新生成**——过 1-2 分钟用 /taptap-gpt grab 抓同一个对话即可：${r.pendingUrl}`
                    : (r.hint ?? '可能是 ChatGPT 界面改版导致选择器失效（如实报告，不假装成功）。可回退到中转站：/taptap-image。'),
            ].filter(Boolean).join('\n'),
          }
        }
        return {
          kind: 'success',
          text: [
            r.resumed ? `已取回上一次生成好的图（没有重新生成）：${r.saved}` : `已生成：${r.saved}`,
            r.lane === 'relayImage' ? '（网页通道额度不足，已自动切换到中转站出图）' : '',
            r.rotated ? `（自动轮换账号：${(r.tried ?? []).join(' → ')}）` : '',
            ...(r.notes ?? []),
            '',
            '这是中间产物，裁好后再搬进 assets/ 并补同名 .meta。',
          ].filter(Boolean).join('\n'),
        }
      },
    })

    // /taptap-gpt 作为首选后，/taptap-image 变成显式回退入口。
    scoped.commands.register({
      name: 'taptap-image',
      description: '中转站生图（回退通道）：文生图 / 图生图（--ref）/ --config 查看配置',
      input: { hint: '<图片描述> [--ref <参考图>]（可重复）/ --config' },
      handler: async (invocation) => {
        const raw = (invocation?.rawInput ?? '').trim()
        const cli = path.join(PKG_DIR, 'src', 'taptap-image.mjs')
        const low = raw.toLowerCase()

        if (low === '--config' || low === '-c' || raw === '配置') {
          try {
            const out = spawnSync(process.execPath, [cli, '--config'], { encoding: 'utf8', timeout: 30000 })
            return { kind: 'success', text: `中转站（回退）配置：\n${(out.stdout ?? '').trim()}` }
          } catch (error) {
            return { kind: 'error', text: `读取配置失败：${error?.message ?? error}` }
          }
        }

        // 「生成通道」卡里的逐条开关必须算数：关掉 relayImage 后本命令直接拒绝，
        // 不再往下走配置检查/生图（开关与行为脱节就是「设置不生效」）。
        if (!relayImageLaneEnabled(home)) {
          return {
            kind: 'error',
            text: [
              '「中转站生图」通道已在设置页「生成通道」卡里关闭，不会走这条通道。',
              '',
              '要用图片就打开它，或走网页通道 /taptap-gpt <描述>。',
            ].join('\n'),
          }
        }

        const cfg = readJson(imageFile) ?? {}
        const configured = Boolean(cfg.baseURL && cfg.apiKey && cfg.model)
        if (!configured) {
          return {
            kind: 'error',
            text: [
              '中转站（回退通道）还没配置，且它已不是首选——图片默认走 ChatGPT 网页生图。',
              '',
              `配置文件：${imageFile}（或设置页「中转站生图」卡）`,
              '',
              '网页通道：/taptap-gpt login 登录一次即可用（默认走这条）。',
              '确实要用中转站：填好 baseURL / apiKey / model 再回来。',
            ].join('\n'),
          }
        }

        const descRaw = raw.replace(/^(图片|生图|生成图片|画一张|生成一张)\s*/i, '').trim()
        // 参考图（图生图）：与 /taptap-gpt 同一套解析，并且必须从提示词里剥掉 ——
        // 否则 `--ref a.png` 会被当成描述的一部分发给模型。
        const relayRefs = []
        for (const m of raw.matchAll(/(?:--ref(?:erence)?s?|-r)\s+(?:"([^"]+)"|(\S+))/g)) {
          const value = m[1] ?? m[2] ?? ''
          for (const part of value.split(',')) {
            const p = part.trim()
            if (p.length > 0) relayRefs.push(p)
          }
        }
        const desc = descRaw
          .replace(/(?:--ref(?:erence)?s?|-r)\s+(?:"[^"]+"|\S+)/g, '')
          .replace(/(?:--size|-s)\s+\d+x\d+/g, '')
          .replace(/(?:--downscale|-d)\s+\d+x\d+/g, '')
          .replace(/(?:--multi-ref|--single-ref)/g, '')
          .trim()
        if (desc.length === 0 && relayRefs.length === 0) {
          return {
            kind: 'success',
            text: [
              '中转站生图（回退通道，首选是 /taptap-gpt）：',
              '',
              `  node "${cli}" --prompt "<描述>" --out D:\\tmp\\out.png --size 1024x1024`,
              `  node "${cli}" --prompt "蓝色盾牌图标，扁平，居中留白" --out D:\\tmp\\icon.png --transparent --downscale 128x128`,
              '',
              '图生图（参考图）：',
              `  node "${cli}" edit --in 原图.png --prompt "<怎么改>" --out D:\\tmp\\out.png`,
              `  node "${cli}" edit --in 角色.png --in 服装.png --prompt "<怎么改>" --out out.png   # 多图参考`,
              '',
              '尺寸按需传 --size；端点只认 1024x1024 / 1024x1536 / 1536x1024 时会自动回退到最接近的一档。',
              '不消耗任何 Maker MCP 内置额度。',
            ].join('\n'),
          }
        }
        if (desc.length === 0) {
          return {
            kind: 'error',
            text: '图生图需要一句「怎么改」的描述。例：/taptap-image 改成赛博朋克风 --ref 角色.png',
          }
        }

        // Follow the same rule as the web lane: default to <project>/sucai/images
        // when the host is running inside a Maker project, else $DSH_HOME/.../gpt-images.
        // (Was previously hardcoded to tmpImageDir, which made the two lanes
        // inconsistent — fixed 2026-10-18.)
        const fallback = resolveDownloadDir(home, {}).dir
        const outFile = path.join(fallback, `relay-${Date.now()}.png`)
        const size = (/(?:--size|-s)\s+(\d+x\d+)/.exec(raw) ?? [])[1]
        const downscale = (/(?:--downscale|-d)\s+(\d+x\d+)/.exec(raw) ?? [])[1]
        // 有参考图 → edit 子命令（/images/edits）；否则 plain 文生图（/images/generations）。
        const argv = relayRefs.length > 0
          ? [cli, 'edit', '--prompt', desc, '--out', outFile]
          : [cli, '--prompt', desc, '--out', outFile]
        for (const ref of relayRefs) argv.push('--in', ref)
        if (size) argv.push('--size', size)
        if (downscale) argv.push('--downscale', downscale)
        // 用户显式声明的多图能力，透传给 CLI（CLI 自己也会按模型名拦单图模型）。
        if (/--multi-ref\b/.test(raw)) argv.push('--multi-ref')
        if (/--single-ref\b/.test(raw)) argv.push('--single-ref')
        try {
          const out = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 300000 })
          const text = (out.stdout ?? '') + (out.stderr ?? '')
          if (out.status !== 0) return { kind: 'error', text: `${relayRefs.length > 0 ? '中转站图生图' : '中转站生图'}失败：\n${text.trim()}` }
          let parsed = {}
          try { parsed = JSON.parse((out.stdout ?? '').trim()) } catch { parsed = {} }
          return {
            kind: 'success',
            text: [
              `${relayRefs.length > 0 ? `已按 ${parsed.inputCount ?? relayRefs.length} 张参考图生成` : '已生成'}：${(parsed.outputs ?? [outFile])[0]}`,
              ...(parsed.notes ?? []),
              '这是中间产物，裁好后再搬进 assets/ 并补同名 .meta。',
            ].join('\n'),
          }
        } catch (error) {
          return { kind: 'error', text: `调用失败：${error?.message ?? error}` }
        }
      },
    })

    scoped.commands.register({
      name: 'taptap-bgm',
      description: 'BGM 账号池：login 登录 / pool 账号池 / logout 换号 / credits 查额度 / "<描述>" 生成（自动轮询）',
      input: { hint: 'login [--account <名>] | pool list|add|remove|ban|unban|rotate | logout | credits | status | <风格描述>' },
      handler: async (invocation) => {
        const raw = (invocation?.rawInput ?? '').trim()
        const cli = path.join(PKG_DIR, 'src', 'taptap-bgm-web.mjs')
        const low = raw.toLowerCase()
        const accountArg = (/(?:--account|-a)\s+(\S+)/.exec(raw) ?? [])[1]

        if (low === 'login' || low.startsWith('login ') || raw === '登录') {
          const site = await bgmDetectSite()
          bgmSaveSite(home, site)
          const res = await bgmLogin(home, { waitMs: 300000, site, accountId: accountArg })
          return {
            kind: res?.logged === true ? 'success' : 'error',
            text: res?.logged === true
              ? [
                `已登录${accountArg ? `账号「${accountArg}」` : ''}，之后生成 BGM 都用它。`,
                `使用：${site.label}`,
                accountArg ? '' : '加更多账号：设置页「BGM 账号」点「+ 添加账号」，或 /taptap-bgm pool add --id <名>',
              ].filter(Boolean).join('\n')
              : [
                '未完成登录（或登录超时）。',
                `使用：${site.label}`,
                '',
                '请打开浏览器完成登录，登录态会保存在本机。',
              ].join('\n'),
          }
        }
        // 账号池：list / add / remove / ban / unban / rotate
        if (low === 'pool' || low.startsWith('pool ')) {
          const r = await bgmPoolCommand(home, raw)
          return { kind: r.ok ? 'success' : 'error', text: r.text }
        }
        if (low === 'add' || low.startsWith('add ')) {
          const r = await bgmPoolCommand(home, `pool ${raw}`)
          return { kind: r.ok ? 'success' : 'error', text: r.text }
        }
        if (low === 'logout' || raw === '退出' || raw === '换号') {
          const r = bgmLogout(home, accountArg)
          return {
            kind: r.ok ? 'success' : 'error',
            text: r.ok
              ? `已退出${accountArg ? `账号「${accountArg}」` : ''}登录。下次可换一个账号登录（/taptap-bgm login）。`
              : `退出失败：可能有浏览器正在使用登录态，请先关闭再试。（${r.profile ?? ''}）`,
          }
        }
        if (low === 'credits' || raw === '额度') {
          const r = await bgmCredits(home, { accountId: accountArg })
          if (!r.ok) return { kind: 'error', text: `查额度失败：${r.error ?? '未知'}` }
          const exp = r.expiresAt ? `，到期 ${new Date(r.expiresAt).toLocaleDateString('zh-CN')}` : ''
          return { kind: 'success', text: `剩余额度：${r.totalCredit}${exp}。额度用完可换号：/taptap-bgm logout 再 login，或多加几个账号自动轮询。` }
        }
        if (low === 'status' || raw === '状态') {
          const st = bgmStatus(home)
          const site = st.site ?? (await bgmDetectSite())
          if (!st.site) bgmSaveSite(home, site)
          const p = st.pool
          const poolLines = p.total === 0
            ? ['账号池：未启用（单账号模式）。加账号：/taptap-bgm pool add --id <名>']
            : [
              `账号池：附加账号 ${p.total} 个（已登录 ${p.loggedIn}，冷却 ${p.cooling}，封禁 ${p.banned}），轮换 ${p.autoRotate ? '开' : '关'}`,
              ...p.accounts.map((a) => `  - ${a.id}${a.label !== a.id ? `（${a.label}）` : ''} ${a.hasCookies ? '已登录' : '未登录'}`
                + `${a.status === 'banned' ? ' 〔已封禁〕' : a.status === 'cooling' ? ' 〔冷却中〕' : ''}`),
            ]
          return {
            kind: 'success',
            text: [
              `登录状态：${st.hasCookies ? '已登录' : '未登录'}`,
              `将使用：${site.label}`,
              '',
              ...poolLines,
              '',
              st.hasCookies || p.loggedIn > 0 ? '可以直接生成 BGM（会自动选可用账号）。' : '请先登录（/taptap-bgm login）。',
            ].join('\n'),
          }
        }

        const desc = raw.replace(/^(bgm|背景音乐|音乐)\s*/i, '').trim()
        if (desc.length === 0) {
          const st = bgmStatus(home)
          // Suggest scenes from the project so the user can pick one in one line.
          let picks = []
          try { picks = suggestBgmForProject(process.cwd()).slice(0, 6) } catch { picks = [] }
          return {
            kind: 'success',
            text: [
              '生成 BGM 需要你的 MiniMax 账号（登录一次，之后自动）。',
              `当前状态：${st.hasCookies ? '已登录，可直接生成' : '未登录'}`,
              st.site ? `将使用：${st.site.label}` : '',
              '',
              st.hasCookies
                ? '直接说「来个战斗 BGM」或 /taptap-bgm 战斗'
                : '先登录：/taptap-bgm login',
              '',
              picks.length > 0
                ? `按你的项目内容，推荐这些场景：${picks.map((p) => p.scene).join('、')}`
                : '常用场景：战斗、BOSS、胜利、失败、主菜单、探索、紧张、悲伤、商店、升级',
            ].filter(Boolean).join('\n'),
          }
        }

        const st = bgmStatus(home)
        if (!st.hasCookies) {
          return {
            kind: 'error',
            text: [
              '需要登录 MiniMax 账号才能生成 BGM（用你的账号在网页生成音乐）。',
              '',
              '登录：/taptap-bgm login',
            ].join('\n'),
          }
        }

        // Build a Chinese prompt; recognised scenarios use a curated template.
        const built = buildBgmPrompt(desc)
        const prompt = built.prompt
        if (built.wasEnglish) {
          // Tell the caller we detected English so it can rephrase in Chinese.
          return {
            kind: 'success',
            text: [
              `你给的是英文描述，我按中文重写成可直接粘贴的提示词：`,
              '',
              `  ${prompt}`,
              '',
              '如果这不是你想要的，请用中文再说一次（例如「紧张激烈的战斗音乐」）。',
              built.scene ? `匹配场景：${built.scene}` : '',
            ].filter(Boolean).join('\n'),
          }
        }
        // Hard cap the whole flow. Without this a stuck generation kept the
        // browser + python + node alive indefinitely and the settings page
        // showed 「登录中…」/nothing forever (we hit exactly that).
        // NOTE: Promise.race alone does NOT stop the loser — on timeout we must
        // actively release the browser profile, or the Chromium tree survives
        // and blocks every later run.
        const BGM_TIMEOUT_MS = 12 * 60 * 1000
        // --lyrics lets a single call override the instrumental setting (the
        // default is ON because game BGM normally has no vocals).
        const wantInstrumental = !/--lyrics/.test(raw)
        const r = await Promise.race([
          // Rotation: if one account has no credits left, try the next one.
          bgmGenerateWithRotation(home, prompt, {
            site: st.site ?? undefined,
            waitMs: 8 * 60 * 1000,
            instrumental: wantInstrumental,
            accountId: accountArg,
          }),
          new Promise((resolve) => setTimeout(() => {
            try {
              const prof = profileDir(home)
              // ⚠️ 必须走 win-proc 的统一实现：这里原先内联拼 `'*${prof}*'`，
              // 路径含单引号时 PowerShell 字符串提前闭合（命令注入，见
              // win-proc.mjs 文件头的分析）。统一模块已做转义 + 通配符防误配。
              killProcessesContaining(prof)
              for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
                try { fs.rmSync(path.join(prof, f), { force: true }) } catch { /* ignore */ }
              }
            } catch { /* best effort */ }
            resolve({ ok: false, error: `生成超时（${BGM_TIMEOUT_MS / 60000} 分钟）。已停止浏览器，可稍后重试或在网页里手动完成。` })
          }, BGM_TIMEOUT_MS)),
        ])
        if (!r.ok || r.error) {
          const isCredit = String(r.error ?? '').startsWith('credit_exhausted')
          const triedList = Array.isArray(r.failures) && r.failures.length > 0
            ? r.failures.map((f) => `  ${f.account ?? '(默认)'}: ${f.error}`).join('\n')
            : ''
          return {
            kind: 'error',
            text: [
              `生成失败：${r.error ?? JSON.stringify(r.steps ?? {})}`,
              r.rotated ? `已自动轮换过账号：${(r.tried ?? []).join(' → ')}` : '',
              triedList,
              '',
              isCredit
                ? '所有可用账号额度都不足了。可以加更多账号（/taptap-bgm pool add --id <名> 再 login --account <名>），或等额度恢复（/taptap-bgm pool unban）。'
                : r.error === 'instrumental_unset'
                  // Deliberate stop: never spend credits on a vocal track that
                  // was not asked for.
                  ? '「纯音乐」开关没能设成期望状态，已中止（没花额度）。'
                    + '这个开关决定有没有人声，写提示词是没用的；重试时会自动再设一次。'
                    + '如果你确实要带人声/歌词：/taptap-bgm <描述> --lyrics；如果你要的是纯音乐却反复失败，'
                    + '可加 --ignore-instrumental 强行按当前状态生成（会带人声）。'
                  : '若是网页结构变化导致选择器失效，会如实报告卡在哪一步；可稍后重试。',
            ].filter(Boolean).join('\n'),
          }
        }
        const saved = r.steps?.saved
        if (!saved) {
          return {
            kind: 'error',
            text: [
              '没能拿到下载文件。',
              '',
              `可手动下载后导入：/taptap-audio import --in ${downloadDir(home)} --project <项目目录> --kind bgm --to wav --latest`,
            ].join('\n'),
          }
        }
        return {
          kind: 'success',
          text: [
            `已生成 BGM：${saved}`,
            `提示词：${prompt}`,
            '',
            '试听 / 裁剪：点输入框旁的 🎵 BGM 挂件（会亮红点），可试听、拖波形选区间、裁剪后一键导入项目。',
            '',
            '或直接命令行导入：',
            `  /taptap-audio import --in ${downloadDir(home)} --project <项目目录> --kind bgm --to wav --latest`,
          ].join('\n'),
        }
      },
    })

    scoped.commands.register({
      name: 'taptap-video',
      description: '视频生成动作帧：首尾帧视频 → 抽帧 → 抠图 → 序列帧素材导入 Maker（本地抠像不花额度）',
      input: { hint: 'new / first <图> / last <图> / prompt <文字> / run / poll / frames / key / sheet / import <工程目录> / doctor / status' },
      handler: async (invocation) => videoCommand(home, invocation?.rawInput ?? ''),
    })

    scoped.commands.register({
      name: 'taptap-skills',
      description: '管理游戏开发 skills：list / disable <名> / enable <名> / restore / reset / update',
      input: { hint: '留空=列表+更新检测；disable <名>…；enable <名>…；restore（恢复误清空的禁用表）；reset（清空，需 --yes）；update' },
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
          // 禁用表是用户维护的清单：AI 觉得「这个 skill 没用了」就把用户的选择改掉，
          // 是越权。要禁用得他明说（带 --yes 或自己点名）。
          // ⚠️ 这里曾误传 { rawInput }（handler 里的变量叫 raw）→ undefined →
          // 守卫永远不放行，连 disable --yes 都被拦死（防呆变成堵死）。
          const gate = guardUserSetting('lanes.enabled', { rawInput: raw, from: '当前禁用表', to: `额外禁用 ${argNames.join('、')}` })
          if (!gate.ok) {
            return { kind: 'error', text: `${gate.text}\n\n（如果确实要禁用这些，请加 --yes 或自己点名要求。）` }
          }
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

        // reset：清空禁用表。
        // ⚠️ 禁用表是用户攒出来的（可能禁用了很多用不上的 skill），清空即丢失。
        //    以前一句 reset 就抹掉，没有确认也没有备份 —— 被误触发时无法挽回。
        //    现在：先备份，再要求用户明确同意。
        if (sub === 'reset' || sub === '清空') {
          const current = readDisabledSkills(home)
          if (current.length === 0) {
            return { kind: 'success', text: '禁用表本来就是空的，无需清空。' }
          }
          // 先备份：即使之后用户后悔，也能一行恢复。
          const backupName = `skills-disabled.backup-${Date.now().toString(36)}.json`
          try {
            writeJson(path.join(dataDir(home), backupName), { disabled: current })
          } catch { /* 备份失败也要继续提示用户，只是没有退路 */ }
          const gate = requireApproval({
            rawInput: raw, // 同上：handler 里变量叫 raw，误传 rawInput 会令 --yes 永远失效
            action: '清空 skill 禁用表',
            consequence: `当前禁用 ${current.length} 个：${current.join('、')}。清空后它们会全部重新出现在 skill 列表里。`,
            undo: `/taptap-skills restore（本次已备份到 ${backupName}）`,
          })
          if (!gate.ok) {
            return {
              kind: 'error',
              text: [
                gate.text,
                '',
                `（已先把当前禁用表备份到 ${backupName}，所以即使清了也能一行恢复。）`,
                '要清空请加 --yes。',
              ].join('\n'),
            }
          }
          writeDisabledSkills(home, [])
          refresh()
          return {
            kind: 'success',
            text: `已清空禁用表（${current.length} 个 skill 恢复可用）。备份：${backupName}，可用 /taptap-skills restore 恢复。`,
          }
        }

        // restore：从最近一次备份恢复禁用表
        if (sub === 'restore' || sub === '恢复禁用') {
          const dir = dataDir(home)
          let files = []
          try {
            files = fs.readdirSync(dir).filter((f) => f.startsWith('skills-disabled.backup-') && f.endsWith('.json')).sort().reverse()
          } catch { files = [] }
          if (files.length === 0) {
            return { kind: 'error', text: '没有可用的禁用表备份（备份只在 reset 时生成）。' }
          }
          const picked = files[0]
          const raw = readJson(path.join(dir, picked)) ?? {}
          const names = Array.isArray(raw.disabled) ? raw.disabled.filter((n) => typeof n === 'string') : []
          if (names.length === 0) return { kind: 'error', text: `备份 ${picked} 里没有内容。` }
          writeDisabledSkills(home, names)
          refresh()
          return { kind: 'success', text: `已从 ${picked} 恢复禁用表：${names.join('、')}` }
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

/* ------------------------------------------------------------------------- *
 * /taptap-video —— 视频动作帧管线
 *
 * 一条链路上每一步都得能单独重跑：视频很贵（按秒计费），但抽帧 / 抠像 /
 * 合成全是本地的，调参数不用重新出片。所以命令按阶段拆开，而 `run` 只是
 * 「把剩下的步骤一次跑完」的糖。
 * ------------------------------------------------------------------------- */

/** 解析 `--flag value` 形式的参数（命令行风格，路径可以带引号）。 */
function parseVideoFlags(raw) {
  const flags = {}
  const pattern = /--([a-zA-Z]+)\s+("[^"]*"|'[^']*'|\S+)/g
  let m
  while ((m = pattern.exec(raw)) !== null) {
    flags[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return flags
}

const VIDEO_HELP = [
  '视频动作帧（视频模型以首尾帧生成序列帧 → 抽帧 → 抠图 → 导入 Maker）：',
  '',
  '  /taptap-video doctor            自检：ffmpeg / Key / 站点 / 套餐有没有视频额度',
  '  /taptap-video new [名字]        新建作业',
  '  /taptap-video first <图片路径>  设首帧（必填；建议绿幕/纯色背景的全身图）',
  '  /taptap-video last <图片路径>   设尾帧（可选；只有 H3 系列和 Hailuo-02 支持）',
  '  /taptap-video prompt <提示词>   写「角色在做什么」',
  '  /taptap-video run               一次跑完：提交视频 → 等 → 抽帧 → 抠像 → 合成',
  '  /taptap-video poll              只查视频进度（可反复调；重启后也能接着查）',
  '  /taptap-video frames [--count 12] [--arrange uniform|first-last|loop]',
  '  /taptap-video key [--chroma auto|green|blue|magenta] [--tol 40]',
  '  /taptap-video sheet [--cell 256] [--layout auto|row|grid]',
  '  /taptap-video import <Maker工程目录> [--name 文件名] [--fps 12]',
  '  /taptap-video status           看当前作业进度与逐帧抠像报告',
  '  /taptap-video models           列出视频模型、是否支持尾帧、大致单价',
  '  /taptap-video lanes            查看/调整视频通道顺序与开关',
  '    /taptap-video lanes --order minimax,relay --off local --fallback on',
  '',
  '计费：只有 `run` / 提交视频那一步花钱（H3 768P 约 ¥0.5/秒，4 秒 ≈ ¥2）。',
  '抽帧 / 抠像 / 合成 / 导入全是本地计算，反复调参数不产生费用。',
  'M Plan Go 档不含视频模型，需要 Explore/Build 档或按量计费 Key。',
].join('\n')

/** 把一个作业渲染成一段人话（状态 + 逐帧报告）。 */
function renderVideoJob(job, home) {
  const lines = [`作业 ${job.id} · ${job.name}`]
  const vs = job.video?.status ?? 'empty'
  // 「结果未知」用醒目的说法：它是唯一一种**不能再跑一次**的状态。
  lines.push(vs === 'uncertain'
    ? `  视频：⚠ 提交结果未知（${job.video.remoteStatus ?? ''}）— 可能已扣费，别重复提交`
    : `  视频：${vs}${job.video?.remoteStatus ? `（${job.video.remoteStatus}）` : ''}${job.video?.error ? ` — ${job.video.error}` : ''}`)
  if (job.video?.hint) lines.push(`  ↳ ${job.video.hint}`)

  // 提交台账：让「上次到底提交了没有」有一处可查的地方，
  // 而不是只能靠猜（这正是白烧额度的根源）。
  const ledger = readSubmitLedger(home)
  if (ledger) {
    const when = ledger.at ? new Date(ledger.at).toLocaleString('zh-CN') : '未知时间'
    const stateText = {
      inflight: '⚠ 结果未知（服务端可能已收下，额度可能已扣）',
      confirmed: '已确认提交成功',
      failed: '服务端明确拒收（未扣费）',
    }[ledger.state] ?? ledger.state
    lines.push(`  台账：${stateText}`)
    lines.push(`    提交号 ${ledger.submitId}${ledger.backend ? ` · ${ledger.backend === 'relay' ? '中转站' : 'MiniMax'}` : ''}${ledger.model ? ` · ${ledger.model}` : ''}`)
    lines.push(`    时间 ${when}${ledger.taskId ? ` · task ${ledger.taskId}` : ''}`)
    if (ledger.error) lines.push(`    错误 ${ledger.error}`)
    if (ledger.state === 'inflight') {
      lines.push('    → 先 /taptap-video poll 查进度；确认服务端确实没有该任务后，再用 --yes 重提。')
    }
  }
  if (job.frames?.status === 'ready') {
    lines.push(`  帧：${job.frames.count} 张 · ${job.frames.width}×${job.frames.height} · ${job.frames.duration?.toFixed(2)}s · ${job.frames.arrange}`)
    const report = job.frames.report ?? []
    if (report.length > 0) {
      const bad = report.filter((r) => r.confident === false)
      lines.push(`  抠像：${job.frames.keyed.length} 帧已完成，${report.length - bad.length}/${report.length} 帧背景占比可信`)
      if (bad.length > 0) {
        lines.push(`  ⚠ ${bad.length} 帧背景占比异常（${bad.slice(0, 5).map((r) => `${r.index + 1}→${(r.backgroundFraction * 100).toFixed(0)}%`).join(', ')}${bad.length > 5 ? '…' : ''}）`)
        lines.push('    多数是主体太贴边或整屏被抠光；调 --tol（背景容差）或换一段主体更居中的视频。')
      }
    }
  } else if (job.frames?.status === 'error') {
    lines.push(`  帧：失败 — ${job.frames.error}`)
  }
  if (job.sheet?.status === 'ready') {
    lines.push(`  整图：${job.sheet.width}×${job.sheet.height}（${job.sheet.columns} 列 × ${job.sheet.rows} 行 × ${job.sheet.cellWidth}px）`)
  }
  if (job.import) lines.push(`  已导入：${job.import.asset}（${job.import.fps} fps）`)
  lines.push(`  下一步：${nextStepOf(job)}`)
  return lines.join('\n')
}

/** 解析「当前作业」：`--job <id>` 显式指定，否则取最近更新的那个。 */
function pickVideoJob(home, raw) {
  const flags = parseVideoFlags(raw)
  if (flags.job) return getVideoJob(home, flags.job)
  const all = listVideoJobs(home)
  return all.length > 0 ? all[0] : undefined
}

/** 视频中转站配置文件的绝对路径（设置页显示「存在哪」，不把内容回给前端）。 */
function videoRelayConfigFile(home) {
  return path.join(dataDir(home), 'video-relay.json')
}

/** 视频配置：文件优先于 env（设置页保存后要能立刻看到自己写的值）。 */
function videoConfigOf(home) {
  const raw = readMinimaxConfigRaw(home)
  const key = raw.apiKey || (process.env.MINIMAX_API_KEY ?? '').trim()
  return {
    apiKey: key,
    baseURL: raw.baseURL,
    model: raw.model,
    relay: normalizeRelayConfig(readVideoRelayConfigRaw(home)),
  }
}

async function videoCommand(home, rawInput) {
  const raw = String(rawInput ?? '').trim()
  const sub = (raw.split(/\s+/)[0] ?? '').toLowerCase()
  const rest = raw.slice(sub.length).trim()
  const config = videoConfigOf(home)

  try {
    if (raw === '' || sub === 'help' || sub === '帮助') {
      return { kind: 'success', text: VIDEO_HELP }
    }

    if (sub === 'models' || sub === '模型') {
      if (parseVideoFlags(raw).relay) {
        // 中转站的模型列表由它自己给，跟官方能力表无关。
        try {
          const models = await relayListModels(config.relay)
          return {
            kind: 'success',
            text: models.length === 0
              ? '中转站 /models 没返回任何模型（有些中转站禁用了这个接口，直接手填模型名即可）。'
              : [`中转站可用模型 ${models.length} 个：`, ...models.map((m) => `  - ${m}`)].join('\n'),
          }
        } catch (error) {
          return { kind: 'error', text: `获取中转站模型失败：${error?.message ?? error}` }
        }
      }
      const models = listVideoModels()
      const lines = ['MiniMax 官方模型（★ = 支持首尾帧，是做动作帧的关键）：']
      for (const m of models) {
        const cost = estimateCostCny({ model: m.id, duration: m.protocol === 'v2' ? 4 : 6, resolution: m.resolutions[0] })
        lines.push(`  ${m.supportsLastFrame ? '★' : ' '} ${m.id.padEnd(24)} ${m.note}${cost ? ` · 约 ¥${cost}/${m.protocol === 'v2' ? '4秒' : '条'}` : ''}`)
      }
      lines.push('', '中转站：/taptap-video models --relay（列出你中转站的模型）')
      lines.push('自选本地视频：/taptap-video use <mp4 路径>（零额度）')
      lines.push('')
      lines.push('🚫 换模型必须由用户决定：视频按秒计费，插件不会自动替换模型。')
      lines.push('   要换请让用户明确说，再用：/taptap-video set --model <模型名>')
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === 'lanes' || sub === '通道') {
      // 命令行改顺序/开关 —— 设置页之外的第二条路（比如给同事写文档时）。
      const cfg = readLanes(home)
      const flags = parseVideoFlags(raw)
      if (!flags.order && !flags.off && !flags.on && !('fallback' in flags)) {
        const labelOf = { relay: '视频中转站', minimax: 'MiniMax 官方', local: '自选本地视频' }
        const lines = ['视频通道（设置页同样可改）：']
        for (const id of cfg.groups.video.order) {
          const on = cfg.groups.video.enabled[id]
          lines.push(`  ${on ? '✓' : '·'} ${labelOf[id] ?? id}${on ? '' : '（已关闭）'}`)
        }
        lines.push(`  额度不足自动换通道：${cfg.autoFallback ? '开' : '关'}`)
        lines.push('', '改法：/taptap-video lanes --order minimax,relay --on local --off relay --fallback on')
        return { kind: 'success', text: lines.join('\n') }
      }
      const patch = { groups: { video: {} } }
      if (flags.order) patch.groups.video.order = String(flags.order).split(',').map((s) => s.trim()).filter(Boolean)
      if (flags.off) patch.groups.video.enabled = { [String(flags.off)]: false }
      if (flags.on) patch.groups.video.enabled = { ...(patch.groups.video.enabled ?? {}), [String(flags.on)]: true }
      if ('fallback' in flags) patch.autoFallback = String(flags.fallback) !== 'false' && String(flags.fallback) !== 'off'
      const before = readLanes(home)
      // 通道顺序与开关是用户亲手排的：换通道 = 可能走到另一条要花钱的通道。
      // 必须用户自己点头，AI 不得自行调整。
      const gate = guardUserSetting('lanes.order', {
        rawInput: raw,
        from: before.groups.video.order.filter((id) => before.groups.video.enabled[id]).join(' → '),
        to: patch.groups.video.order
          ? patch.groups.video.order.join(' → ')
          : Object.entries(patch.groups.video.enabled ?? {}).map(([k, v]) => `${k} ${v ? '开' : '关'}`).join('、') || '（不变）',
      })
      if (!gate.ok) return { kind: 'error', text: gate.text }
      const saved = writeLanes(home, patch)
      const v = saved.groups.video
      const labelOf = { relay: '视频中转站', minimax: 'MiniMax 官方', local: '自选本地视频' }
      return {
        kind: 'success',
        text: [
          `已更新视频通道：${v.order.filter((id) => v.enabled[id]).map((id) => labelOf[id] ?? id).join(' → ') || '（没有启用的通道）'}`,
          `额度不足自动换通道：${saved.autoFallback ? '开' : '关'}`,
        ].join('\n'),
      }
    }

    if (sub === 'doctor' || sub === '自检') {
      const d = await videoDoctor(home, config)
      // Key 来源：文件（设置页保存的）还是环境变量（机器上残留的）。
      // 排查「保存了却不生效」时，这里是第一眼该看的地方。
      const keySource = readMinimaxConfigWithSource(home)
      const sourceText = keySource.source.apiKey === 'file'
        ? '设置页保存的 minimax.json'
        : keySource.source.apiKey === 'env'
          ? `环境变量 MINIMAX_API_KEY（设置页文件里没有 Key！）`
          : '（无）'
      const lines = ['视频动作帧 · 自检结果：', '']
      lines.push(`  ffmpeg：${d.ffmpeg.ok ? '✓ ' + (d.ffmpeg.version ?? '') : '✗ ' + d.ffmpeg.error}`)
      lines.push('', '  三个后端：')
      lines.push(`    ${d.backends.relay ? '✓' : '·'} 中转站${d.relay.configured ? `（${d.relay.protocol} · ${d.relay.model}）` : '（未配置）'}`)
      lines.push(`    ${d.backends.minimax ? '✓' : '·'} MiniMax ${d.baseURL}${d.hasKey ? `（${describeKey(config.apiKey)}，来自${sourceText}）` : '（无 Key）'}`)
      lines.push('    ✓ 自选本地视频（零额度，随便用）')
      // 按设置页里排的顺序报一次「实际会走哪条」，别让用户自己推。
      const laneCfg = readLanes(home)
      const labelOf = { relay: '中转站', minimax: 'MiniMax', local: '自选本地视频' }
      const active = laneCfg.groups.video.order.filter((id) => laneCfg.groups.video.enabled[id])
      if (active.length) {
        const usable = active.filter((id) => (id === 'relay' ? d.backends.relay : id === 'minimax' ? d.backends.minimax : true))
        lines.push('', `  通道顺序（设置页）：${active.map((id) => labelOf[id] ?? id).join(' → ')}`)
        lines.push(`  auto 会走：${usable.length ? (labelOf[usable[0]] ?? usable[0]) : '（没有可提交的通道）'}`)
        lines.push(`  额度不足自动换通道：${laneCfg.autoFallback ? '开' : '关（只在设置页改）'}`)
      }
      lines.push('', `  当前默认模型：${d.model}`)
      // 环境变量里有 Key 但文件里没有 → 明确警告：这个 Key 不在设置页里，
      // 换 Key 只能改环境变量或回设置页保存；这正是「保存了却不生效」最常见的现场。
      if (keySource.source.apiKey === 'env') {
        lines.push('', '  ⚠ 当前生效的 Key 来自环境变量 MINIMAX_API_KEY，不是设置页保存的那份。')
        lines.push('    在设置页「MiniMax」里保存 Key 后，文件里的值优先生效（否则环境变量说了算）。')
      }
      if (d.estimate !== null) lines.push(`  参考单价：H3 768P 4 秒约 ¥${d.estimate}`)
      if (d.probe) {
        lines.push('', '  MiniMax 远端探测（免费）：')
        lines.push(`    鉴权：${d.probe.auth}`)
        lines.push(`    Key 类型：${d.probe.keyKindText ?? d.probe.keyKind}`)
        lines.push(`    套餐：${d.probe.planMessage || d.probe.plan}`)
        if (d.probe.planQuota) lines.push(`    剩余额度：${d.probe.planQuota}`)
        for (const note of d.probe.notes ?? []) lines.push(`    · ${note}`)
        if (d.probe.hint) lines.push('', `  ⚠ ${d.probe.hint}`)
      }
      if (d.backends.relay) lines.push('', `  想验证中转站：/taptap-video models --relay`)
      if (!d.hasKey) {
        const found = discoverMinimaxKey(home)
        if (found.found) {
          lines.push('', `  发现可用登录态：${found.source}（${found.keyPrefix}），站点 ${found.baseURL}。`)
          lines.push('  在设置页「视频生成」里点保存即可采用，或直接依赖它（不填 Key 时自动用）。')
        }
      }
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === 'new' || sub === '新建') {
      // 模型继承设置页里用户选的那个 —— 不传的话 createJob 会退回内置默认
      // （MiniMax-H3），等于静默替用户换模型，而视频是按秒计费的。
      const job = createVideoJob(home, rest || undefined, { model: config.model })
      return {
        kind: 'success',
        text: [
          `已建作业 ${job.id}（${job.name}）`,
          '',
          '接下来：',
          `  /taptap-video first <首帧图片路径>`,
          `  /taptap-video prompt <角色在做什么>`,
          `  /taptap-video run`,
        ].join('\n'),
      }
    }

    if (sub === 'first' || sub === 'last' || sub === '首帧' || sub === '尾帧') {
      const kind = (sub === 'last' || sub === '尾帧') ? 'lastFrame' : 'firstFrame'
      if (rest === '') return { kind: 'error', text: `用法：/taptap-video ${sub} <图片路径>` }
      let job = pickVideoJob(home, raw)
      // 自动建作业必须继承设置页模型（createJob 的红线注释：不传就退回内置
      // 默认 H3，等于替用户换了计费模型）。
      if (!job) job = createVideoJob(home, undefined, { model: config.model })
      const updated = await setVideoReference(home, job.id, kind, rest)
      const ref = updated.refs[kind]
      const lines = [`已设${kind === 'firstFrame' ? '首帧' : '尾帧'}：${ref.name}（${ref.width}×${ref.height}）→ 作业 ${updated.id}`]
      for (const w of ref.warnings ?? []) lines.push(`  ⚠ ${w}`)
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === 'prompt' || sub === '提示词') {
      if (rest === '') return { kind: 'error', text: '用法：/taptap-video prompt <提示词>' }
      let job = pickVideoJob(home, raw)
      // 同上：自动建作业继承设置页模型，不退回内置默认（视频按秒计费）。
      if (!job) job = createVideoJob(home, undefined, { model: config.model })
      const updated = saveVideoJob(home, job.id, { prompt: rest })
      return { kind: 'success', text: `已写提示词 → 作业 ${updated.id}:\n  ${rest}\n\n下一步：/taptap-video run` }
    }

    if (sub === 'status' || sub === '状态') {
      const job = pickVideoJob(home, raw)
      if (!job) return { kind: 'success', text: `还没有作业。开始：/taptap-video new\n\n${VIDEO_HELP}` }
      return { kind: 'success', text: renderVideoJob(job, home) }
    }

    if (sub === 'poll' || sub === '查') {
      const job = pickVideoJob(home, raw)
      if (!job) return { kind: 'error', text: '没有作业。先 /taptap-video new' }
      const updated = await pollJobVideo(home, job.id, config)
      return { kind: 'success', text: renderVideoJob(updated, home) }
    }

    if (sub === 'use' || sub === '用') {
      if (rest === '') return { kind: 'error', text: '用法：/taptap-video use <mp4 路径>（挂本地视频，零额度）' }
      let job = pickVideoJob(home, raw)
      if (!job) job = createVideoJob(home, undefined, { model: config.model })
      const forced = hasApproval(raw)
      const updated = await useLocalVideo(home, job.id, rest.replace(/--\S+\s+\S+/g, '').trim(), { force: forced })
      // 拒绝覆盖（作业里已有花钱生成的视频）→ 如实回报，不当作失败也不当作成功。
      if (updated.overwritten === false) {
        return { kind: 'error', text: `${updated.message}\n\n我没有覆盖它。确认要换请加 --yes。` }
      }
      return {
        kind: 'success',
        text: [
          updated.overwritten
            ? `⚠️ 已用本地视频**覆盖**掉原来的 ${updated.overwritten}（那段生成结果已不可用）。`
            : `已挂上本地视频 → 作业 ${updated.id}（${updated.video.width}×${updated.video.height}，${(updated.video.duration ?? 0).toFixed(2)}s）`,
          '',
          '这一步不花钱。接下来：',
          '  /taptap-video frames → /taptap-video key → /taptap-video sheet',
        ].join('\n'),
      }
    }

    if (sub === 'backend' || sub === '后端') {
      const job = pickVideoJob(home, raw)
      if (!job) return { kind: 'error', text: '没有作业。先 /taptap-video new' }
      const which = (rest.split(/\s+/)[0] ?? '').trim()
      if (!['auto', 'minimax', 'relay', 'local'].includes(which)) {
        return {
          kind: 'error',
          text: [
            '用法：/taptap-video backend auto|minimax|relay|local',
            '',
            '  auto     按可用性自动挑（配了中转站优先，其次 MiniMax Key）',
            '  minimax  MiniMax 官方（订阅 Key 或按量 Key）',
            '  relay    视频中转站（OpenAI 兼容 / 自定义端点）',
            '  local    自选本地视频（配合 /taptap-video use <mp4>）',
          ].join('\n'),
        }
      }
      const updated = saveVideoJob(home, job.id, { settings: { backend: which } })
      return { kind: 'success', text: `作业 ${updated.id} 的后端已设为：${which}` }
    }

    if (sub === 'frames' || sub === '抽帧') {
      const job = pickVideoJob(home, raw)
      if (!job) return { kind: 'error', text: '没有作业。先 /taptap-video new' }
      const flags = parseVideoFlags(raw)
      const overrides = {}
      if (flags.count) overrides.frameCount = Number(flags.count)
      if (flags.arrange) overrides.arrange = flags.arrange
      if (flags.edge) overrides.longEdge = Number(flags.edge)
      const updated = await extractJobFrames(home, job.id, overrides)
      return { kind: 'success', text: renderVideoJob(updated, home) }
    }

    if (sub === 'key' || sub === '抠图') {
      const job = pickVideoJob(home, raw)
      if (!job) return { kind: 'error', text: '没有作业。先 /taptap-video new' }
      const flags = parseVideoFlags(raw)
      const overrides = {}
      if (flags.chroma) overrides.chroma = flags.chroma
      if (flags.tol) overrides.bgTolerance = Number(flags.tol)
      if (flags.low) overrides.keyLow = Number(flags.low)
      if (flags.high) overrides.keyHigh = Number(flags.high)
      if (flags.despill) overrides.despill = Number(flags.despill)
      const updated = await keyJobFrames(home, job.id, overrides)
      return { kind: 'success', text: renderVideoJob(updated, home) }
    }

    if (sub === 'sheet' || sub === '合成') {
      const job = pickVideoJob(home, raw)
      if (!job) return { kind: 'error', text: '没有作业。先 /taptap-video new' }
      const flags = parseVideoFlags(raw)
      const overrides = {}
      if (flags.cell) {
        overrides.cellWidth = Number(flags.cell)
        overrides.cellHeight = Number(flags.cell)
      }
      if (flags.layout) overrides.layout = flags.layout
      if (flags.columns) overrides.columns = Number(flags.columns)
      const updated = await composeJobSheet(home, job.id, overrides)
      return { kind: 'success', text: renderVideoJob(updated, home) }
    }

    if (sub === 'import' || sub === '导入') {
      const job = pickVideoJob(home, raw)
      if (!job) return { kind: 'error', text: '没有作业。先 /taptap-video new' }
      const flags = parseVideoFlags(raw)
      const target = flags.project ?? rest.replace(/--\S+\s+\S+/g, '').trim()
      if (!target) return { kind: 'error', text: '用法：/taptap-video import <Maker工程目录> [--name 文件名] [--fps 12]' }
      const result = await importToMaker(home, job.id, {
        projectDir: target,
        assetName: flags.name,
        fps: flags.fps ? Number(flags.fps) : undefined,
      })
      return {
        kind: 'success',
        text: [
          `已导入 Maker 工程：${path.relative(process.cwd(), result.file) || result.file}`,
          `  .meta：${path.basename(result.meta)}（uuid ${result.manifest.uuid}）`,
          // importToMaker 返回的 job 是导入后的新快照；旧写法读导入前旧 job 的
          // job.import.manifest（当时还是 undefined）→ TypeError，导入明明成功
          // 却报错，用户看到报错再导一次 = 项目里出现重复素材。
          `  清单：${path.basename(result.job.import?.manifest ?? '')}`,
          '',
          '游戏里按格子切图（直接贴进 Lua）：',
          '',
          result.lua,
        ].join('\n'),
      }
    }

    if (sub === 'set' || sub === '设置') {
      const job = pickVideoJob(home, raw)
      if (!job) return { kind: 'error', text: '没有作业。先 /taptap-video new' }
      const flags = parseVideoFlags(raw)
      const settings = {}
      if (flags.model) settings.model = flags.model
      if (flags.resolution) settings.resolution = flags.resolution
      if (flags.duration) settings.duration = Number(flags.duration)
      if (flags.count) settings.frameCount = Number(flags.count)
      // 换模型 = 替用户决定花多少钱。必须用户自己说，不能由 AI「顺手优化」。
      if (settings.model) {
        const gate = guardUserSetting('model', { rawInput: raw, from: job.settings.model, to: settings.model })
        if (!gate.ok) {
          return {
            kind: 'error',
            text: `${gate.text}\n\n（视频按秒计费，换模型就是换价。要换请加 --yes，或你自己下指令。）`,
          }
        }
      }
      const updated = saveVideoJob(home, job.id, { settings })
      const lines = [`已更新作业 ${updated.id} 的设置：`]
      for (const [k, v] of Object.entries(settings)) lines.push(`  ${k} = ${v}`)
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === 'run' || sub === '跑') {
      let job = pickVideoJob(home, raw)
      // 同上：自动建作业继承设置页模型（红线：模型不允许被静默替换）。
      if (!job) job = createVideoJob(home, undefined, { model: config.model })
      // ⚠️ 旧逻辑在这里硬性要求 MiniMax Key（config.apiKey），哪怕用户把视频通道
      // 排成「中转站优先」甚至只开中转站 —— 设置页的排序形同虚设，run 直接报
      // 「没有可用的 MiniMax Key」。正确做法：中转站就绪就不拦；只有轮到
      // MiniMax 提交时才会由 submitJobVideo/resolveBackend 如实报错。
      const relayReady = relayReadyForApi(config.relay)
      if (!config.apiKey && !relayReady) {
        const found = discoverMinimaxKey(home)
        return {
          kind: 'error',
          text: [
            '没有可用的视频提交通道：MiniMax 无 Key，中转站也未配置。',
            found.found ? `发现 ${found.source} 的登录态（${found.keyPrefix}），但插件配置里是空的 —— 在设置页「视频生成」点保存采用，或设环境变量 MINIMAX_API_KEY。` : '',
            '配好任意一条即可：设置页「视频中转站」或「MiniMax」。',
            '先跑 /taptap-video doctor 看看还缺什么。',
          ].filter(Boolean).join('\n'),
        }
      }
      // 旧的 estimateCostCny(config.model) 传参错误已修：价格现在按实际提交的
      // 模型（下方 usedModel）计算，中转站后端不套官方单价表。
      const submitted = await submitJobVideo(home, job.id, config, { rawInput: raw })
      // 回显**实际提交**的模型（submitted.job.video.model）：中转站后端会用自己的
      // 模型名覆盖，旧写法回显 job.settings.model 会让用户以为走的是另一个模型
      // —— 视频按秒计费，「显示的模型」必须与「实际扣费的模型」一致。
      const usedModel = submitted?.job?.video?.model ?? job.settings.model
      const usedBackend = submitted?.backend === 'relay' ? '中转站' : submitted?.backend === 'minimax' ? 'MiniMax' : ''
      const costFor = (m) => estimateCostCny({ model: m, duration: job.settings.duration, resolution: job.settings.resolution })
      const cost = usedBackend === '中转站' ? null : costFor(usedModel)
      return {
        kind: 'success',
        text: [
          `已提交视频任务 ${submitted.taskId}（${usedBackend ? `${usedBackend} · ` : ''}${usedModel} · ${job.settings.resolution} · ${job.settings.duration}s${cost ? ` · 约 ¥${cost}` : ''}）`,
          ...(usedBackend === '中转站' ? ['（中转站按它自己的计费口径结算，官方单价表不适用）'] : []),
          '',
          '生成通常要 1~6 分钟。接下来：',
          '  /taptap-video poll    查进度（可以反复调，进程重启也能接着查）',
          '  出片后：/taptap-video frames → /taptap-video key → /taptap-video sheet',
        ].join('\n'),
      }
    }

    return { kind: 'error', text: `未知子命令：${sub}\n\n${VIDEO_HELP}` }
  } catch (error) {
    return {
      kind: 'error',
      text: [
        `${error?.message ?? error}`,
        error?.hint ? `\n提示：${error.hint}` : '',
      ].filter(Boolean).join('\n'),
    }
  }
}


