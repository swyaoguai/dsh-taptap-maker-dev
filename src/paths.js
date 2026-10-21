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

/**
 * Merge a {baseURL,apiKey,model,size,credentialsFile} patch into image.json.
 *
 * ⚠️ **空字符串 = 不修改**（不是「清空」）。设置页因为不回显明文 Key，
 * 表单里的 apiKey 永远是空的；以前这里把空串直接写进去，于是用户**只改了个
 * model** 点保存，Key 就被静默抹掉了，生图通道当场失效。MiniMax 那张卡早就
 * 用了这个约定，这里补齐。
 *
 * 真要清空请显式传 `clear: true`（或用设置页的「清除」入口）。
 */
export function writeImageConfigPatch(dshHome, patch = {}) {
  const file = imageConfigPath(dshHome)
  const merged = { ...(readJson(file) ?? {}) }
  const clearing = patch.clear === true
  for (const key of ['baseURL', 'apiKey', 'model', 'size', 'credentialsFile']) {
    if (typeof patch[key] !== 'string') continue
    if (patch[key].trim() === '' && !clearing) continue // 空 = 不改
    merged[key] = clearing ? '' : patch[key]
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
 *                  (…<project>/sucai/images), otherwise $DSH_HOME/…/gpt-images.
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

/**
 * 读一个 JSON 文件；不存在或损坏时返回 undefined。
 *
 * 损坏时会把原文件**另存为 .corrupt-<时间戳>**再返回 —— 以前是静默吞掉，
 * 于是「配置文件写坏了」会表现成「配置莫名其妙全丢了」，用户根本无从查起。
 * 留一份现场才能事后找回。
 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    // 读得到但解析失败 = 文件坏了，值得留证据。
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8')
        fs.writeFileSync(`${file}.corrupt-${Date.now().toString(36)}`, raw, 'utf8')
      }
    } catch { /* 留证据失败也不能让读取本身抛错 */ }
    return undefined
  }
}

/**
 * 写一个 JSON 文件（原子替换）。
 *
 * ⚠️ 必须是原子的：所有配置（API Key、通道顺序、提交台账…）都走这里，而插件
 * 会被对话里的命令**并发**调用。先写临时文件再 rename 的好处：
 *   - 进程在写到一半被杀 → 旧文件完好无损，不会留下半截 JSON；
 *   - 另一个进程同时读 → 永远读到完整的旧版或完整的新版，不会读到半个文件。
 * 直接 writeFileSync 的话，崩溃或并发都可能导致配置彻底读不出来。
 */
export function writeJson(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    // 清理临时文件，别把垃圾留在配置目录里。
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw error
  }
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

/* ------------------------------------------------------------------------- *
 * MINIMAX VIDEO — config + pending-task recovery for the H3 video lane
 * (taptap-video.mjs). Same privacy rule as image.json: the API key lives
 * under $DSH_HOME, never inside a Maker workspace.
 *
 * - 国际站 api.minimax.io（美元计价，按量付费）
 * - 国内站 api.minimaxi.com（人民币计价，注意域名多一个 i）
 * - M Plan 订阅（MiniMax Code）不覆盖视频生成 API——视频走标准 API Key +
 *   平台余额按量扣费，两套体系独立。
 * ------------------------------------------------------------------------- */

/** Path to the MiniMax video config file (minimax.json). */
export function minimaxConfigPath(dshHome) {
  return path.join(dataDir(dshHome), 'minimax.json')
}

/**
 * Resolve effective MiniMax video config with precedence:
 *   env vars (MINIMAX_API_KEY / MINIMAX_BASE_URL / MINIMAX_VIDEO_MODEL)
 *   > minimax.json  > defaults.
 */
export function resolveMinimaxConfig(dshHome) {
  const fromFile = readJson(minimaxConfigPath(dshHome)) ?? {}
  const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim().length > 0)
  const model = pick(
    process.env.MINIMAX_VIDEO_MODEL,
    fromFile.model,
  ) ?? 'MiniMax-H3'
  // 国际站 v2 与国内站 v2 的路径相同，只有域名不同。
  let baseURL = pick(
    process.env.MINIMAX_BASE_URL,
    fromFile.baseURL,
  ) ?? 'https://api.minimax.io'
  baseURL = baseURL.replace(/\/+$/, '').replace(/\/v2$/, '') // 统一存根域名
  return {
    apiKey: pick(process.env.MINIMAX_API_KEY, fromFile.apiKey) ?? '',
    baseURL,
    model,
  }
}

/** Merge a {apiKey, baseURL, model} patch into minimax.json. */
export function writeMinimaxConfigPatch(dshHome, patch = {}) {
  const file = minimaxConfigPath(dshHome)
  const merged = { ...(readJson(file) ?? {}) }
  for (const key of ['apiKey', 'baseURL', 'model']) {
    if (typeof patch[key] === 'string' && patch[key].trim().length > 0) merged[key] = patch[key].trim()
  }
  if (typeof patch.measurements === 'object' && patch.measurements !== null) {
    merged.measurements = { ...(merged.measurements ?? {}), ...patch.measurements }
  }
  if (typeof merged._comment !== 'string') {
    merged._comment = 'MiniMax 视频生成（H3，/v2/video_generation，按量计费）。此文件在 $DSH_HOME 下，不在任何 Maker 工作区内。'
  }
  writeJson(file, merged)
  return merged
}

/**
 * 同一份 minimax.json 的「无 env 覆盖」读取。
 *
 * resolveMinimaxConfig 让环境变量优先（CI 里方便）；但设置页保存后必须立刻
 * 回读到自己刚写进去的值 —— 若那时恰好有 MINIMAX_API_KEY 环境变量，界面会
 * 显示成另一个 Key，看起来像「保存没生效」。设置页用这个。
 */
export function readMinimaxConfigRaw(dshHome) {
  const fromFile = readJson(minimaxConfigPath(dshHome)) ?? {}
  const str = (v, fb) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : fb)
  return {
    apiKey: str(fromFile.apiKey, ''),
    baseURL: str(fromFile.baseURL, 'https://api.minimaxi.com').replace(/\/+$/, '').replace(/\/(v1|v2)$/i, ''),
    model: str(fromFile.model, 'MiniMax-H3'),
    measurements: typeof fromFile.measurements === 'object' && fromFile.measurements !== null ? fromFile.measurements : {},
  }
}

/**
 * 自动发现一个已经登录好的 MiniMax Key（设置页「自动发现」按钮与首次使用）。
 *
 * 用户机器上常见三种登录痕迹，按可信度排序：
 *   1. MiniMax 官方 CLI（`mmx auth login`）→ `~/.mmx/config.json` 的 `api_key`，
 *      前缀 `sk-cp-…` 是 **M Plan 订阅 Key**（用套餐额度，不是账户余额）；
 *   2. 环境变量 `MINIMAX_API_KEY`；
 *   3. `~/.mmx/config.json` 里 `base_url` 用来猜站点（国内套餐配国内站）。
 *
 * 只读已存在的配置、**不写入**任何东西 —— 是否采用由用户点保存决定。
 * 返回 `{ found, source, keyPrefix, baseURL, region }`，绝不把完整 Key 回给界面。
 */
export function discoverMinimaxKey(dshHome) {
  const out = { found: false, source: '', keyPrefix: '', baseURL: '', region: '', note: '' }
  const envKey = (process.env.MINIMAX_API_KEY ?? '').trim()
  let fileKey = ''
  let fileBase = ''
  try {
    const cfgPath = path.join(os.homedir(), '.mmx', 'config.json')
    const cfg = readJson(cfgPath)
    if (cfg && typeof cfg.api_key === 'string') fileKey = cfg.api_key.trim()
    if (cfg && typeof cfg.base_url === 'string') fileBase = cfg.base_url.trim()
    if (cfg && typeof cfg.region === 'string') out.region = cfg.region
  } catch { /* 没装 mmx */ }

  const key = fileKey || envKey
  if (key === '') {
    out.note = '没有找到登录痕迹：MiniMax CLI（mmx）未登录，环境变量 MINIMAX_API_KEY 也没设。'
    return out
  }
  out.found = true
  out.source = fileKey ? 'mmx-cli' : 'env'
  out.keyPrefix = key.startsWith('sk-cp-') ? 'sk-cp-'
    : key.startsWith('sk-api-') ? 'sk-api-'
      : /^ey[A-Za-z0-9_-]+\./.test(key) ? 'eyJ…（控制台 Key，订阅/按量形状一样）'
        : `${key.slice(0, 5)}…`
  out.baseURL = fileBase || (out.region === 'global' ? 'https://api.minimax.io' : 'https://api.minimaxi.com')
  out.note = fileKey
    ? '来自 MiniMax CLI（mmx）的登录态。跑一次 /taptap-video doctor 可确认走的是 M Plan 套餐额度还是账户余额。'
    : '来自环境变量 MINIMAX_API_KEY。'
  return out
}
/**
 * 视频**提交台账**：在发出请求**之前**就落盘，用来回答一个问题 ——
 * 「这次提交到底有没有被服务端收下？」
 *
 * 为什么必须提前写：视频按秒计费。如果提交请求发出后本地网络异常（fetch failed /
 * 超时 / 进程被杀），服务端**很可能已经收下并在跑了**，只是我们没拿到 task_id。
 * 这种情况下最危险的动作就是「再跑一次」—— 那是白花一份钱。所以这里在发请求前
 * 先写一条 {submitId, 状态: uncertain}；拿到 task_id 后改成 confirmed。
 *
 * 状态含义：
 *   - `inflight`  请求已发出、还没拿到 task_id（**结果未知，可能已扣费**）
 *   - `confirmed` 拿到 task_id，任务在服务端跑着
 *   - `failed`    服务端明确拒绝（4xx 且带业务错误码），确定没扣费
 */
export function videoSubmitLedgerPath(dshHome) {
  return path.join(dataDir(dshHome), 'video-submit-ledger.json')
}

/** 读台账（没有则返回 undefined）。 */
export function readSubmitLedger(dshHome) {
  const data = readJson(videoSubmitLedgerPath(dshHome))
  if (!data || typeof data !== 'object' || typeof data.submitId !== 'string') return undefined
  return {
    submitId: data.submitId,
    state: ['inflight', 'confirmed', 'failed'].includes(data.state) ? data.state : 'inflight',
    jobId: typeof data.jobId === 'string' ? data.jobId : '',
    backend: typeof data.backend === 'string' ? data.backend : '',
    model: typeof data.model === 'string' ? data.model : '',
    taskId: typeof data.taskId === 'string' ? data.taskId : '',
    idempotencyKey: typeof data.idempotencyKey === 'string' ? data.idempotencyKey : '',
    error: typeof data.error === 'string' ? data.error : '',
    at: typeof data.at === 'number' ? data.at : 0,
  }
}

/** 写台账（整体替换，不是 merge —— 台账只关心「最近一次提交」）。 */
export function writeSubmitLedger(dshHome, record) {
  const payload = {
    submitId: String(record?.submitId ?? ''),
    state: record?.state ?? 'inflight',
    jobId: String(record?.jobId ?? ''),
    backend: String(record?.backend ?? ''),
    model: String(record?.model ?? ''),
    taskId: String(record?.taskId ?? ''),
    idempotencyKey: String(record?.idempotencyKey ?? ''),
    error: String(record?.error ?? '').slice(0, 500),
    at: Date.now(),
  }
  writeJson(videoSubmitLedgerPath(dshHome), payload)
  return payload
}

/** 清掉台账（确认拿到结果之后）。 */
export function clearSubmitLedger(dshHome) {
  try { fs.rmSync(videoSubmitLedgerPath(dshHome), { force: true }) } catch { /* ignore */ }
}

/* ------------------------------------------------------------------------- *
 * 视频序列帧 —— 项目目录（模型无关：Minimax 只是后端之一）
 * ------------------------------------------------------------------------- */

/** Path to the video relay config (OpenAI-compatible / custom video endpoint). */
export function videoRelayConfigPath(dshHome) {
  return path.join(dataDir(dshHome), 'video-relay.json')
}

/** Read the raw video-relay config, or {} when missing / unreadable. */
export function readVideoRelayConfigRaw(dshHome) {
  return readJson(videoRelayConfigPath(dshHome)) ?? {}
}

/**
 * Merge a patch into video-relay.json.
 *
 * 与 writeMinimaxConfigPatch 不同，这里**允许写空字符串**：用户清空 Key
 * 或关掉中转站必须真的生效，否则会出现「界面上关掉了、后台还在用旧 Key」。
 */
export function writeVideoRelayConfigPatch(dshHome, patch = {}) {
  const file = videoRelayConfigPath(dshHome)
  const merged = { ...(readJson(file) ?? {}) }
  const stringKeys = [
    'protocol', 'baseURL', 'apiKey', 'model', 'size', 'submitMethod', 'submitPath',
    'queryMethod', 'queryPath', 'videoUrlPath', 'taskIdPath', 'statusPath', 'authHeader',
    'authPrefix', 'extraQuery', 'extraBody',
  ]
  // 空串 = 不修改。设置页不回显 apiKey，表单里那项永远是空的；
  // 不做这个保护的话，用户只改个 model 点保存，Key / 路径就被静默抹掉了。
  // 真要清空请用 `clear: true`（与 minimax.json 的约定一致）。
  for (const key of stringKeys) {
    if (typeof patch[key] !== 'string') continue
    if (patch[key].trim() === '' && patch.clear !== true) continue
    merged[key] = patch.clear === true ? '' : patch[key]
  }
  if (typeof patch.enabled === 'boolean') merged.enabled = patch.enabled
  if (typeof patch.idInBody === 'boolean') merged.idInBody = patch.idInBody
  if (typeof patch.seconds === 'number') merged.seconds = patch.seconds
  for (const key of ['doneValues', 'failedValues', 'pendingValues']) {
    if (Array.isArray(patch[key])) merged[key] = patch[key]
  }
  if (typeof merged._comment !== 'string') {
    merged._comment = '视频中转站（OpenAI 兼容 / 自定义视频端点）。此文件在 $DSH_HOME 下，不在任何 Maker 工作区内。'
  }
  writeJson(file, merged)
  return merged
}

/**
 * 一次「抽帧 → 抠图 → 合成 → 导入」作业的根目录。
 *
 * 放在 $DSH_HOME 而不是 Maker 工程的 assets/ 下：Maker 运行时会自动给
 * assets/ 里的每个新文件补 .meta 并纳入构建，中间产物（整段视频、未裁的
 * 原始帧）落在那里会变成资源表里的脏条目。只有**最后那一张**裁好的整图
 * 才被复制进项目。
 */
export function videoJobsRoot(dshHome) {
  const dir = path.join(dataDir(dshHome), 'video-jobs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 单个作业目录（id 必须以 v 开头且只含小写字母数字，防目录穿越）。 */
export function videoJobDir(dshHome, id) {
  const safe = String(id ?? '')
  if (!/^v[a-z0-9]{4,40}$/.test(safe)) throw new Error(`非法的视频作业 id：${id}`)
  const dir = path.join(videoJobsRoot(dshHome), safe)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 作业清单文件。 */
export function videoJobFile(dshHome, id) {
  return path.join(videoJobDir(dshHome, id), 'job.json')
}

/** 读一个作业；不存在返回 undefined。 */
export function readVideoJob(dshHome, id) {
  try { return readJson(videoJobFile(dshHome, id)) ?? undefined } catch { return undefined }
}

/** 写一个作业（原子替换）。 */
export function writeVideoJob(dshHome, job) {
  if (!job || typeof job.id !== 'string') throw new Error('writeVideoJob 需要一个带 id 的作业对象')
  writeJson(videoJobFile(dshHome, job.id), job)
  return job
}

/** 列出全部作业的摘要，按更新时间倒序。 */
export function listVideoJobs(dshHome) {
  const root = videoJobsRoot(dshHome)
  let names = []
  try { names = fs.readdirSync(root) } catch { return [] }
  const jobs = []
  for (const name of names) {
    if (!/^v[a-z0-9]{4,40}$/.test(name)) continue
    const job = readJson(path.join(root, name, 'job.json'))
    if (!job) continue
    jobs.push(job)
  }
  jobs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return jobs
}

/** 删掉一个作业（含视频与全部中间产物）。 */
export function deleteVideoJob(dshHome, id) {
  const dir = videoJobDir(dshHome, id)
  fs.rmSync(dir, { recursive: true, force: true })
}
