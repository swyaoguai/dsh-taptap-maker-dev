/**
 * Shared path + config helpers for dsh-taptap-maker-dev.
 *
 * Everything the plugin persists lives UNDER $DSH_HOME (outside any TapTap
 * Maker project workspace) on purpose: the Maker runtime auto-commits and
 * pushes the whole project workspace, so a plaintext image API key must never
 * sit inside the game repo. See README "安全" section.
 *
 * @module src/paths.js
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** Resolve $DSH_HOME, falling back to ~/.dsh. */
export function resolveDshHome(explicit) {
  const value = explicit || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.resolve(value)
}

/** The plugin's private data directory, created on demand. */
export function dataDir(dshHome) {
  const dir = path.join(resolveDshHome(dshHome), 'taptap-maker-dev')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Path to the OpenAI-compatible image generation config file. */
export function imageConfigPath(dshHome) {
  return path.join(dataDir(dshHome), 'image.json')
}

/** Read the raw image.json (what the settings form edits), or {}. */
export function readImageConfigRaw(dshHome) {
  return readJson(imageConfigPath(dshHome)) ?? {}
}

/** Merge a {baseURL,apiKey,model,size,credentialsFile} patch into image.json. */
export function writeImageConfigPatch(dshHome, patch = {}) {
  const file = imageConfigPath(dshHome)
  const merged = { ...(readJson(file) ?? {}) }
  for (const key of ['baseURL', 'apiKey', 'model', 'size', 'credentialsFile']) {
    if (typeof patch[key] === 'string') merged[key] = patch[key]
  }
  if (typeof merged._comment !== 'string') {
    merged._comment = '自定义生图（OpenAI 兼容 /images/generations）。此文件在 $DSH_HOME 下，不在任何 Maker 工作区内。'
  }
  writeJson(file, merged)
  return merged
}

/** Default skills cache directory (where the updater writes fetched skills). */
export function defaultCacheDir(dshHome) {
  return path.join(dataDir(dshHome), 'skills-cache')
}

/** Path to the user's disabled-skills list ({ disabled: [name, ...] }). */
export function skillsDisabledPath(dshHome) {
  return path.join(dataDir(dshHome), 'skills-disabled.json')
}

/** Read the disabled-skill name list, tolerant of a missing/invalid file. */
export function readDisabledSkills(dshHome) {
  const data = readJson(skillsDisabledPath(dshHome))
  const list = Array.isArray(data?.disabled) ? data.disabled : []
  return list.filter((n) => typeof n === 'string' && n.length > 0)
}

/** Persist the disabled-skill name list (deduped, sorted). */
export function writeDisabledSkills(dshHome, names) {
  const unique = Array.from(new Set(names.filter((n) => typeof n === 'string' && n.length > 0))).sort()
  writeJson(skillsDisabledPath(dshHome), { disabled: unique })
  return unique
}

/** Path to the live policy toggle file ({ blockCreditTools: boolean }). */
export function policyConfigPath(dshHome) {
  return path.join(dataDir(dshHome), 'policy.json')
}

/**
 * Resolve whether the credit-tool red-line is engaged. The live file wins; when
 * absent, fall back to the supplied default (plugin config; default true).
 */
export function readPolicyBlock(dshHome, fallback = true) {
  const data = readJson(policyConfigPath(dshHome))
  if (typeof data?.blockCreditTools === 'boolean') return data.blockCreditTools
  return fallback !== false
}

/** Persist the policy toggle; returns the stored boolean. */
export function writePolicyBlock(dshHome, enabled) {
  const value = enabled !== false
  writeJson(policyConfigPath(dshHome), { blockCreditTools: value })
  return value
}

/**
 * Image-lane settings — stored in ONE file (imageLane.json):
 *   { gptWebEnabled: boolean, downloadDir: string }
 *
 * - gptWebEnabled: master switch for the ChatGPT web lane (default true).
 * - downloadDir:   where generated images land. Empty means "auto": the
 *                  project directory when the caller is inside a Maker project
 *                  (…<project>/.taptap-images), otherwise $DSH_HOME/…/gpt-images.
 *                  Supports {project} and {home} placeholders.
 *
 * Writing MERGES: flipping one setting must never wipe the other.
 */
export function imageLaneConfigPath(dshHome) {
  return path.join(dataDir(dshHome), 'imageLane.json')
}

/** Read the master switch; live file wins, default ON. */
export function readGptLaneEnabled(dshHome, fallback = true) {
  const data = readJson(imageLaneConfigPath(dshHome))
  if (typeof data?.gptWebEnabled === 'boolean') return data.gptWebEnabled
  return fallback !== false
}

/** Persist the master switch (merge — keeps downloadDir); returns the value. */
export function writeGptLaneEnabled(dshHome, enabled) {
  const value = enabled !== false
  const merged = { ...(readJson(imageLaneConfigPath(dshHome)) ?? {}), gptWebEnabled: value }
  writeJson(imageLaneConfigPath(dshHome), merged)
  return value
}

/** Raw configured download dir ('' = follow the project / auto). */
export function readGptDownloadDir(dshHome) {
  const data = readJson(imageLaneConfigPath(dshHome))
  return typeof data?.downloadDir === 'string' ? data.downloadDir.trim() : ''
}
/** Persist the download dir (merge — keeps the switch); returns the value. */
export function writeGptDownloadDir(dshHome, dir) {
  const value = typeof dir === 'string' ? dir.trim() : ''
  const merged = { ...(readJson(imageLaneConfigPath(dshHome)) ?? {}), downloadDir: value }
  writeJson(imageLaneConfigPath(dshHome), merged)
  return value
}

/* ------------------------------------------------------------------------- *
 * PENDING WEB GENERATION — remember an in-flight ChatGPT image so a later run
 * can FIND AND DOWNLOAD it instead of generating a second one.
 *
 * Why: gpt-image generation takes 1-3 minutes. If our wait expires (or the
 * process is interrupted) the image often finishes seconds later. Without a
 * record of WHICH conversation it belongs to, the only recovery was to
 * generate again — burning quota for an image that already exists
 * (user-reported 2026-10-17).
 *
 * Shape: { url, prompt, accountId, at, state: 'generating'|'done' }
 * ------------------------------------------------------------------------- */

export function gptPendingPath(dshHome) {
  return path.join(dataDir(dshHome), 'gpt-pending.json')
}

/** Read the pending record, or undefined when there is none. */
export function readGptPending(dshHome) {
  const data = readJson(gptPendingPath(dshHome))
  if (typeof data?.url !== 'string' || data.url.length === 0) return undefined
  return {
    url: data.url,
    prompt: typeof data.prompt === 'string' ? data.prompt : '',
    accountId: typeof data.accountId === 'string' ? data.accountId : '',
    at: typeof data.at === 'number' ? data.at : 0,
    state: data.state === 'done' ? 'done' : 'generating',
  }
}

/** Persist the pending record (merge). */
export function writeGptPending(dshHome, patch = {}) {
  const merged = { ...(readJson(gptPendingPath(dshHome)) ?? {}), ...patch }
  writeJson(gptPendingPath(dshHome), merged)
  return merged
}

/** Forget the pending record. */
export function clearGptPending(dshHome) {
  try { fs.rmSync(gptPendingPath(dshHome), { force: true }) } catch { /* ignore */ }
}

/** Where BGM generation preferences are stored. */
export function bgmConfigPath(dshHome) {
  return path.join(dataDir(dshHome), 'bgm-config.json')
}

/**
 * Read BGM generation settings. Most game BGM should have no vocals, so
 * `instrumental` defaults to true; `count` defaults to 1 (the site's own
 * default is 2, which silently burns double the credits).
 */
export function readBgmConfig(dshHome) {
  const data = readJson(bgmConfigPath(dshHome)) ?? {}
  return {
    instrumental: data.instrumental !== false, // default ON
    count: typeof data.count === 'number' && data.count >= 1 ? Math.floor(data.count) : 1,
  }
}

/** Persist BGM settings (partial patch); returns the merged record. */
export function writeBgmConfig(dshHome, patch = {}) {
  const merged = { ...readBgmConfig(dshHome) }
  if (typeof patch.instrumental === 'boolean') merged.instrumental = patch.instrumental
  if (typeof patch.count === 'number' && patch.count >= 1) merged.count = Math.floor(patch.count)
  writeJson(bgmConfigPath(dshHome), merged)
  return merged
}

/**
 * Slug an account id EXACTLY like the runtime profile-dir builders do
 * (taptap-gpt.mjs gptAccountProfileDir / taptap-bgm-web.mjs profileDir).
 * Without this, a pool record for an id containing spaces/Chinese stored a
 * `profile` path the runtime would never touch — a landmine for any code that
 * trusts the stored field.
 */
const slugId = (id) => String(id ?? '').replace(/[^\w.-]/g, '_')

/* ------------------------------------------------------------------------- *
 * MINIMAX (BGM) ACCOUNT POOL — multi-account rotation for the BGM web lane.
 *
 * Same shape and semantics as the ChatGPT pool: each account gets its OWN
 * browser profile (so one broken/banned session cannot corrupt the others),
 * a `status` of ok | cooling | banned, and least-recently-used picking.
 *
 * ⚠️ Rotating accounts to get around per-account credit limits may breach the
 * site's terms. The user asked for it explicitly (2026-10-17) and owns the risk.
 * ------------------------------------------------------------------------- */

export function bgmPoolPath(dshHome) {
  return path.join(dataDir(dshHome), 'bgm-pool.json')
}

/** Read the BGM account pool (normalised shape). */
export function readBgmPool(dshHome) {
  const data = readJson(bgmPoolPath(dshHome)) ?? {}
  const accounts = Array.isArray(data.accounts) ? data.accounts : []
  return {
    accounts: accounts
      .filter((a) => typeof a?.id === 'string' && a.id.length > 0)
      .map((a) => ({
        id: a.id,
        label: typeof a.label === 'string' && a.label.length > 0 ? a.label : a.id,
        profile: typeof a.profile === 'string' && a.profile.length > 0
          ? a.profile
          : path.join(dataDir(dshHome), `browser-profile-bgm-${slugId(a.id)}`),
        status: typeof a.status === 'string' ? a.status : 'unknown',
        lastUsedAt: typeof a.lastUsedAt === 'number' ? a.lastUsedAt : null,
        note: typeof a.note === 'string' ? a.note : '',
      })),
    autoRotate: data.autoRotate !== false, // default ON
  }
}

/** Persist the BGM pool (partial patch); returns the merged record. */
export function writeBgmPool(dshHome, patch = {}) {
  const merged = { ...readBgmPool(dshHome) }
  if (Array.isArray(patch.accounts)) {
    merged.accounts = patch.accounts
      .filter((a) => typeof a?.id === 'string' && a.id.length > 0)
      .map((a) => ({
        id: a.id,
        label: typeof a.label === 'string' && a.label.length > 0 ? a.label : a.id,
        profile: typeof a.profile === 'string' && a.profile.length > 0
          ? a.profile
          : path.join(dataDir(dshHome), `browser-profile-bgm-${slugId(a.id)}`),
        status: typeof a.status === 'string' ? a.status : 'unknown',
        lastUsedAt: typeof a.lastUsedAt === 'number' ? a.lastUsedAt : null,
        note: typeof a.note === 'string' ? a.note : '',
      }))
  }
  if (typeof patch.autoRotate === 'boolean') merged.autoRotate = patch.autoRotate
  writeJson(bgmPoolPath(dshHome), merged)
  return merged
}

/**
 * Pick the next usable BGM account: prefer `activeId`, else least-recently-used
 * that is neither banned nor still cooling down.
 */
export function pickBgmAccount(dshHome, { activeId, exclude = [], cooldownMs = 6 * 3600 * 1000 } = {}) {
  const pool = readBgmPool(dshHome)
  if (pool.accounts.length === 0) return null
  const skip = new Set(exclude)
  const now = Date.now()
  const usable = pool.accounts.filter((a) => {
    if (skip.has(a.id)) return false
    if (a.status === 'banned') return false
    if (a.status === 'cooling' && typeof a.lastUsedAt === 'number'
      && now - a.lastUsedAt < cooldownMs) return false
    return true
  })
  if (usable.length === 0) return null
  if (activeId) {
    const cur = usable.find((a) => a.id === activeId)
    if (cur) return cur
  }
  usable.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
  return usable[0]
}

/** Mark a BGM account used / cooling / banned / restored. */
export function touchBgmAccount(dshHome, id, patch = {}) {
  const pool = readBgmPool(dshHome)
  let found = false
  pool.accounts = pool.accounts.map((a) => {
    if (a.id !== id) return a
    found = true
    if (patch.status !== undefined) a.status = patch.status
    if (patch.lastUsedAt !== undefined) a.lastUsedAt = patch.lastUsedAt
    if (patch.note !== undefined) a.note = patch.note
    if (patch.label !== undefined) a.label = patch.label
    return a
  })
  if (!found) return readBgmPool(dshHome)
  writeBgmPool(dshHome, pool)
  return readBgmPool(dshHome)
}

/* ------------------------------------------------------------------------- *
 * ChatGPT ACCOUNT POOL — multi-account rotation for the web image lane.
 *
 * ⚠️ TO BE CLEAR: rotating multiple accounts to bypass per-account quotas
 * violates OpenAI's Terms of Service and carries a real ban risk (OpenAI's
 * Cloudflare already blocks automation). This is implemented because the user
 * explicitly asked for it; the risk is theirs, not ours. Each account gets its
 * OWN browser profile so one banned account cannot corrupt the others.
 * ------------------------------------------------------------------------- */

/** Where the account pool list is stored. */
export function gptPoolPath(dshHome) {
  return path.join(dataDir(dshHome), 'gpt-pool.json')
}

/**
 * Read the ChatGPT account pool.
 * Shape: { accounts: [{ id, label, profile, status, lastUsedAt, note }],
 *          autoRotate: boolean }
 * `id` is a short slug; `profile` is the dedicated browser-profile dir.
 */
export function readGptPool(dshHome) {
  const data = readJson(gptPoolPath(dshHome)) ?? {}
  const accounts = Array.isArray(data.accounts) ? data.accounts : []
  // Normalise so callers can trust the shape.
  return {
    accounts: accounts
      .filter((a) => typeof a?.id === 'string' && a.id.length > 0)
      .map((a) => ({
        id: a.id,
        label: typeof a.label === 'string' && a.label.length > 0 ? a.label : a.id,
        profile: typeof a.profile === 'string' && a.profile.length > 0
          ? a.profile
          : path.join(dataDir(dshHome), `browser-profile-gpt-${slugId(a.id)}`),
        status: typeof a.status === 'string' ? a.status : 'unknown',
        lastUsedAt: typeof a.lastUsedAt === 'number' ? a.lastUsedAt : null,
        note: typeof a.note === 'string' ? a.note : '',
      })),
    autoRotate: data.autoRotate !== false, // default ON
  }
}

/** Persist the account pool (partial patch); returns the merged record. */
export function writeGptPool(dshHome, patch = {}) {
  const merged = { ...readGptPool(dshHome) }
  if (Array.isArray(patch.accounts)) {
    merged.accounts = patch.accounts
      .filter((a) => typeof a?.id === 'string' && a.id.length > 0)
      .map((a) => ({
        id: a.id,
        label: typeof a.label === 'string' && a.label.length > 0 ? a.label : a.id,
        profile: typeof a.profile === 'string' && a.profile.length > 0
          ? a.profile
          : path.join(dataDir(dshHome), `browser-profile-gpt-${slugId(a.id)}`),
        status: typeof a.status === 'string' ? a.status : 'unknown',
        lastUsedAt: typeof a.lastUsedAt === 'number' ? a.lastUsedAt : null,
        note: typeof a.note === 'string' ? a.note : '',
      }))
  }
  if (typeof patch.autoRotate === 'boolean') merged.autoRotate = patch.autoRotate
  writeJson(gptPoolPath(dshHome), merged)
  return merged
}

/**
 * Choose the next usable account: prefer `activeId` if it is still usable,
 * otherwise pick the least-recently-used account that is not banned and not
 * cooling. Returns the account object, or null when the pool is
 * empty/exhausted.
 *
 * Statuses: 'ok' (default/unknown), 'cooling' (hit a quota this run — usable
 * again after a cooldown), 'banned' (user marked it dead — never auto-picked).
 */
export function pickGptAccount(dshHome, { activeId, exclude = [], cooldownMs = 6 * 3600 * 1000 } = {}) {
  const pool = readGptPool(dshHome)
  if (pool.accounts.length === 0) return null
  const skip = new Set(exclude)
  const now = Date.now()
  const usable = pool.accounts.filter((a) => {
    if (skip.has(a.id)) return false
    if (a.status === 'banned') return false
    // A cooling account becomes usable again once the cooldown has passed.
    if (a.status === 'cooling' && typeof a.lastUsedAt === 'number'
      && now - a.lastUsedAt < cooldownMs) return false
    return true
  })
  if (usable.length === 0) return null
  if (activeId) {
    const cur = usable.find((a) => a.id === activeId)
    if (cur) return cur
  }
  // Least-recently-used first (accounts never used get lastUsedAt null → first).
  usable.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
  return usable[0]
}

/** Mark an account as used now (or banned). */
export function touchGptAccount(dshHome, id, patch = {}) {
  const pool = readGptPool(dshHome)
  let found = false
  pool.accounts = pool.accounts.map((a) => {
    if (a.id !== id) return a
    found = true
    if (patch.status !== undefined) a.status = patch.status
    if (patch.lastUsedAt !== undefined) a.lastUsedAt = patch.lastUsedAt
    if (patch.note !== undefined) a.note = patch.note
    if (patch.label !== undefined) a.label = patch.label
    return a
  })
  if (!found) return readGptPool(dshHome)
  writeGptPool(dshHome, pool)
  return readGptPool(dshHome)
}

/** Read a JSON file, returning undefined when absent or invalid. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write a JSON file (pretty), creating parent dirs. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Chinese BGM prompt library, keyed by common game scenarios. Each entry is a
 * ready-to-paste Chinese prompt for the MiniMax Audio web page (the API rejects
 * new users with HTTP 410, so the web page is the practical path).
 *
 * Why Chinese: the user generates on a zh-CN site and reads Chinese; English
 * prompts also made it hard to tell what would come out.
 */
export const BGM_SCENES = [
  {
    id: 'battle',
    zh: ['战斗', '打斗', '交战', '战斗音乐', 'combat', 'battle'],
    name: '战斗',
    prompt: '紧张激烈的战斗背景音乐，快节奏鼓点与低音贝斯推进，弦乐紧张上行，铜管强调重音，'
      + '情绪压迫感强、不中断，适合持续战斗循环',
  },
  {
    id: 'boss',
    zh: ['boss', '首领', '最终boss', '终极', '决战'],
    name: 'BOSS 战',
    prompt: '史诗级 BOSS 决战音乐，沉重的低音轰鸣与金属撞击声，管弦与电子合成器混合，'
      + '压迫感极强、庄严而不祥，情绪层层递进，适合循环播放',
  },
  {
    id: 'victory',
    zh: ['胜利', '获胜', '通关', '凯旋', 'win', 'victory'],
    name: '胜利',
    prompt: '胜利庆祝音乐，明亮的大调铜管号角，上扬的旋律线条，鼓点铿锵有力，'
      + '情绪振奋、有成就感，时长较短用于结算画面',
  },
  {
    id: 'defeat',
    zh: ['失败', '战败', '游戏结束', 'lose', 'defeat', 'gameover'],
    name: '失败',
    prompt: '失败与挫败感的背景音乐，低沉缓慢的小调弦乐，稀疏的钢琴单音，'
      + '情绪压抑、沉重但不刺耳，适合失败结算画面',
  },
  {
    id: 'menu',
    zh: ['主菜单', '菜单', '首页', '大厅', 'lobby', 'menu'],
    name: '主菜单',
    prompt: '主菜单背景音乐，舒缓大气的氛围音乐，温暖的合成器铺底与轻柔的钢琴琶音，'
      + '情绪平静、耐听、可长时间无缝循环，不抢注意力',
  },
  {
    id: 'explore',
    zh: ['探索', '冒险', '地图', '闲逛', 'explore', 'adventure'],
    name: '探索',
    prompt: '探索冒险背景音乐，中速节奏，明快的木管与拨弦乐器，旋律悠扬有期待感，'
      + '情绪轻松好奇，可长时间循环不疲劳',
  },
  {
    id: 'tense',
    zh: ['紧张', '悬疑', '危机', '危险', 'tense', 'suspense'],
    name: '紧张悬疑',
    prompt: '紧张悬疑的氛围音乐，持续的低频嗡鸣与不规则的心跳般鼓点，'
      + '稀疏的高音点缀，情绪不安、悬念感强，无人声',
  },
  {
    id: 'sad',
    zh: ['悲伤', '伤感', '剧情', '离别', 'sad', 'emotional'],
    name: '悲伤剧情',
    prompt: '悲伤抒情的剧情音乐，缓慢的小调钢琴与弦乐，旋律温柔克制，'
      + '情绪细腻动人，适合剧情演出，无人声',
  },
  {
    id: 'shop',
    zh: ['商店', '商城', '商店音乐', 'shop', 'store'],
    name: '商店',
    prompt: '轻松愉快的商店界面音乐，轻快的爵士风格钢琴与拨弦贝斯，节奏摇摆，'
      + '情绪轻松愉悦、不吵闹，适合长时间循环',
  },
  {
    id: 'upgrade',
    zh: ['升级', '养成', '强化', '装备', 'upgrade'],
    name: '升级养成',
    prompt: '升级强化界面音乐，明亮上升的合成器琶音，节奏稳定有推进感，'
      + '情绪积极向上、有成长感，适合循环播放',
  },
]

/** Pick the best-matching scene for a Chinese/English description. */
export function matchBgmScene(desc) {
  const q = String(desc ?? '').toLowerCase()
  if (q.length === 0) return null
  for (const scene of BGM_SCENES) {
    if (scene.zh.some((k) => q.includes(k.toLowerCase()))) return scene
  }
  return null
}

/**
 * Build a Chinese, ready-to-paste BGM prompt.
 *
 * - A recognised scenario uses its curated Chinese template.
 * - A free-form Chinese description is used as-is plus Chinese constraints.
 * - An English description is wrapped with a Chinese instruction so the model
 *   still returns something usable on the zh-CN site, and we tell the caller
 *   that we detected English input.
 *
 * Returns { prompt, scene, wasEnglish }.
 */
export function buildBgmPrompt(desc) {
  const d = String(desc ?? '').trim()
  if (d.length === 0) return { prompt: '', scene: null, wasEnglish: false }
  const scene = matchBgmScene(d)
  // Scene templates already say 无人声 themselves, so avoid saying it twice.
  const TAIL = scene === null
    ? ['纯音乐，无人声', '结构完整可无缝循环', '时长 60-120 秒', '高音质']
    : ['结构完整可无缝循环', '时长 60-120 秒', '高音质']
  // Detect a mostly-ASCII description (i.e. the caller wrote English).
  const ascii = (d.match(/[\x20-\x7e]/g) ?? []).length
  const wasEnglish = d.length > 0 && ascii / d.length > 0.7

  if (scene !== null) {
    return { prompt: [scene.prompt, ...TAIL].join('，'), scene: scene.name, wasEnglish }
  }
  if (wasEnglish) {
    // Keep the user's intent but force a Chinese-framed request.
    return {
      prompt: `游戏背景音乐。风格与情绪参考：${d}。${TAIL.join('，')}`,
      scene: null,
      wasEnglish,
    }
  }
  return { prompt: [d, ...TAIL].join('，'), scene: null, wasEnglish }
}

/** Backwards-compatible one-liner used by the CLI/commands. */
export function bgmPromptFor(desc) {
  return buildBgmPrompt(desc).prompt
}

/**
 * Suggest BGM prompts for a project by scanning its text files for scenario
 * keywords (e.g. a GAME_RULES.md mentioning 战斗/BOSS/商店). Returns an array of
 * { scene, prompt, hits } ordered by how often the keyword appeared.
 */
export function suggestBgmForProject(projectDir) {
  const out = []
  let corpus = ''
  try {
    const names = fs.readdirSync(projectDir).filter((f) => /\.(md|txt|json|lua)$/i.test(f))
    for (const n of names.slice(0, 40)) {
      try {
        const p = path.join(projectDir, n)
        const stat = fs.statSync(p)
        if (stat.size > 512 * 1024) continue
        corpus += `\n${fs.readFileSync(p, 'utf8')}`
      } catch { /* skip unreadable */ }
    }
  } catch { /* not a readable dir */ }
  const lower = corpus.toLowerCase()
  for (const scene of BGM_SCENES) {
    let hits = 0
    for (const k of scene.zh) {
      const key = k.toLowerCase()
      let idx = lower.indexOf(key)
      while (idx !== -1) { hits += 1; idx = lower.indexOf(key, idx + key.length) }
    }
    if (hits > 0) {
      out.push({ scene: scene.name, id: scene.id, hits, prompt: [scene.prompt, '纯音乐，无人声', '结构完整可无缝循环'].join('，') })
    }
  }
  out.sort((a, b) => b.hits - a.hits)
  return out
}

/**
 * Resolve effective image config with precedence:
 *   explicit credentialsFile JSON  >  env vars  >  image.json  >  inline fields.
 * Returns { baseURL, apiKey, model, size, n } with best-effort fields.
 */
export function resolveImageConfig(options = {}) {
  const dshHome = options.dshHome
  const fromFile = readJson(imageConfigPath(dshHome)) ?? {}
  const credFile = options.credentialsFile || fromFile.credentialsFile
  const fromCred = credFile ? readJson(path.resolve(credFile)) ?? {} : {}
  const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.length > 0)
  const num = (...vals) => vals.find((v) => typeof v === 'number' && Number.isFinite(v))
  return {
    baseURL: pick(
      fromCred.base_url, fromCred.baseURL,
      process.env.TAPTAP_IMAGE_BASE_URL,
      fromFile.baseURL, options.baseURL,
    ) ?? '',
    apiKey: pick(
      fromCred.api_key, fromCred.apiKey,
      process.env.TAPTAP_IMAGE_API_KEY,
      fromFile.apiKey, options.apiKey,
    ) ?? '',
    model: pick(
      fromCred.model,
      process.env.TAPTAP_IMAGE_MODEL,
      fromFile.model, options.model,
    ) ?? '',
    size: pick(process.env.TAPTAP_IMAGE_SIZE, fromFile.size, options.size) ?? '1024x1024',
    n: num(options.n, fromFile.n) ?? 1,
  }
}

/** Mask a secret for safe logging: keep head/tail only. */
export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return '(unset)'
  if (value.length <= 10) return `${value.slice(0, 2)}…`
  return `${value.slice(0, 5)}…${value.slice(-4)}`
}
