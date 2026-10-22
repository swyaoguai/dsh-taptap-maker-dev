/**
 * CC0 game-audio library: fetch, index, and search Kenney audio packs.
 *
 * Why Kenney only: every pack ships a License.txt that states Creative Commons
 * Zero (CC0) — free for personal, educational AND commercial projects, with no
 * attribution requirement. That is the safest possible license for a game that
 * may later be sold, so it is the only source wired in here. OpenGameArt mixes
 * many licenses (CC-BY-NC forbids commercial use) and Freesound's API needs a
 * per-user key, so neither is enabled by default.
 *
 * The pack zip URLs embed a per-build hash (e.g.
 * /media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip)
 * so they CANNOT be guessed — the pack page is fetched and parsed at runtime.
 *
 * Honest limitation: Kenney's music pack is short jingles (roughly 1-3s
 * stings), not seamless looping background music. A `bgm` query therefore
 * returns jingles and says so, rather than pretending a full loop exists.
 *
 * @module src/audio-library.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { ensureSourceIndex, searchSourceIndex, downloadSourceFile, SOURCES } from './audio-sources.mjs'
import { psSingleQuote } from './win-proc.mjs'

/** Kenney packs, all CC0. Verified reachable + zip-resolvable. */
export const PACKS = [
  { id: 'interface-sounds', title: 'Interface Sounds', kind: 'sfx', tags: 'ui 界面 按钮 菜单' },
  { id: 'ui-audio', title: 'UI Audio', kind: 'sfx', tags: 'ui 点击 悬停 开关' },
  { id: 'impact-sounds', title: 'Impact Sounds', kind: 'sfx', tags: '打击 碰撞 脚步 材质' },
  { id: 'digital-audio', title: 'Digital Audio', kind: 'sfx', tags: '电子 激光 科幻 提示' },
  { id: 'sci-fi-sounds', title: 'Sci-Fi Sounds', kind: 'sfx', tags: '科幻 引擎 爆炸 力场' },
  { id: 'rpg-audio', title: 'RPG Audio', kind: 'sfx', tags: 'rpg 门 布料 书 刀' },
  { id: 'casino-audio', title: 'Casino Audio', kind: 'sfx', tags: '卡牌 筹码 骰子 棋牌' },
  { id: 'music-jingles', title: 'Music Jingles', kind: 'bgm', tags: '音乐 短曲 过场 胜负' },
  { id: 'voiceover-pack', title: 'Voiceover Pack', kind: 'voice', tags: '人声 语音 升级 胜负' },
]

const AUDIO_EXT = new Set(['.ogg', '.wav', '.mp3'])
const UA = 'Mozilla/5.0 (dsh-taptap-maker-dev; CC0 audio fetcher)'

/** Resolve the real (hash-bearing) zip URL for a pack by parsing its page. */
export async function resolveZipUrl(slug, { timeoutMs = 30000, retries = 2 } = {}) {
  const page = `https://kenney.nl/assets/${slug}`
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(page, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const html = await response.text()
      const match = new RegExp(
        `https://kenney\\.nl/media/pages/assets/${slug}/[a-f0-9]+-\\d+/[^"'\\s]*\\.zip`,
      ).exec(html)
      if (match !== null) return match[0]
      throw new Error('no zip link found on pack page')
    } catch (error) {
      if (attempt === retries) throw new Error(`${slug}: ${error?.message ?? error}`)
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  return null
}

/** Download a zip to a temp file and extract it. Uses only Node builtins. */
async function downloadAndExtract(url, destDir, { timeoutMs = 120000 } = {}) {
  const tmpZip = path.join(os.tmpdir(), `kenney-${crypto.randomBytes(6).toString('hex')}.zip`)
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    fs.writeFileSync(tmpZip, Buffer.from(await response.arrayBuffer()))
    // no unzip binary guaranteed on Windows; use PowerShell's Expand-Archive
    fs.mkdirSync(destDir, { recursive: true })
    await new Promise((resolve, reject) => {
      const r = spawnSync('powershell', [
        '-NoProfile', '-Command',
        // ⚠️ 路径必须转义：`-LiteralPath '${tmpZip}'` 遇单引号会提前闭合字符串。
        `Expand-Archive -LiteralPath ${psSingleQuote(tmpZip)} -DestinationPath ${psSingleQuote(destDir)} -Force`,
      ], { stdio: 'ignore', timeout: timeoutMs })
      if (r.status === 0) resolve()
      else reject(new Error('Expand-Archive failed'))
    })
  } finally {
    fs.rmSync(tmpZip, { force: true })
  }
}

/** Index entry: normalize a filename into searchable tokens. */
function normalize(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
    .replace(/-\d+$/, '')
}

/** Walk an extracted pack dir for audio files. */
function collectAudio(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
        const stat = fs.statSync(p)
        out.push({
          name: entry.name,
          base: path.basename(entry.name, path.extname(entry.name)),
          norm: normalize(entry.name),
          ext: path.extname(entry.name).toLowerCase(),
          rel: path.relative(dir, p).replace(/\\/g, '/'),
          abs: p,
          kb: Math.round(stat.size / 1024),
        })
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

/**
 * Ensure every pack is downloaded + extracted under cacheDir, then write an
 * index file. Returns { cacheDir, index, packs, errors }.
 * Cached packs are skipped unless `force`.
 */
export async function ensureLibrary(cacheDir, { force = false, packs = PACKS, onProgress } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const indexFile = path.join(cacheDir, 'index.json')
  const manifestFile = path.join(cacheDir, '.download-manifest.json')
  // A half-written / hand-edited manifest must not brick the whole library:
  // fall back to "nothing downloaded yet" and rebuild it.
  let manifest = { packs: {} }
  if (fs.existsSync(manifestFile) && !force) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.packs && typeof parsed.packs === 'object') {
        manifest = parsed
      }
    } catch { /* rebuild below */ }
  }
  const errors = []
  const index = []

  for (const pack of packs) {
    const destDir = path.join(cacheDir, pack.id)
    const done = manifest.packs?.[pack.id]?.ok === true
      && fs.existsSync(destDir)
      && !force
    if (!done) {
      try {
        onProgress?.(`downloading ${pack.title}…`)
        const url = await resolveZipUrl(pack.id)
        await downloadAndExtract(url, destDir)
        manifest.packs[pack.id] = { ok: true, url, at: new Date().toISOString() }
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
      } catch (error) {
        errors.push(`${pack.id}: ${error?.message ?? error}`)
        manifest.packs[pack.id] = { ok: false, error: String(error?.message ?? error) }
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
        continue
      }
    }
    for (const item of collectAudio(destDir)) {
      index.push({ ...item, pack: pack.id, kind: pack.kind })
    }
  }

  fs.writeFileSync(indexFile, JSON.stringify({ builtAt: new Date().toISOString(), count: index.length, items: index }, null, 2))
  return { cacheDir, index, errors, indexFile }
}

/** Load the index, ensuring the library exists first when missing. */
export async function loadIndex(cacheDir, opts = {}) {
  const indexFile = path.join(cacheDir, 'index.json')
  if (!fs.existsSync(indexFile)) return ensureLibrary(cacheDir, opts)
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    return { cacheDir, index: parsed.items ?? [], errors: [], indexFile }
  } catch {
    return ensureLibrary(cacheDir, { ...opts, force: true })
  }
}

/**
 * Chinese/English intent → candidate name tokens.
 * Every token below was derived from the REAL filenames in these packs; nothing
 * here is guessed. `bgm` maps to the jingle families because that is all the
 * CC0 Kenney music pack contains.
 */
/**
 * Chinese/English intent → candidate name tokens, ordered most-specific first.
 * The FIRST intent whose keyword appears wins, so longer/more specific phrases
 * must come before shorter overlapping ones (e.g. 开门 before 打开, 金币 before 金).
 *
 * Voiceover is its own kind: Kenney's voiceover pack is human speech ("you_win",
 * "level_up"), which is a different thing from a UI sting, so it is only used
 * when the query asks for 语音/人声 — and it is demoted otherwise.
 *
 * Every token below was derived from the REAL filenames in these packs.
 */
const INTENTS = [
  { zh: ['开门', '门开', '推门'], tokens: ['door-open'], kind: 'sfx' },
  { zh: ['关门', '门关'], tokens: ['door-close'], kind: 'sfx' },
  { zh: ['门', 'door'], tokens: ['door-open', 'door-close'], kind: 'sfx' },
  { zh: ['金币', '金钱', 'coin', '货币', '拿到金币', '金币声'], tokens: ['handle-coins'], kind: 'sfx' },
  { zh: ['筹码', '下注', 'chips'], tokens: ['chips', 'chip'], kind: 'sfx' },
  { zh: ['卡牌', '卡片', '抽卡', '发牌', 'card'], tokens: ['card', 'cards'], kind: 'sfx' },
  { zh: ['骰子', '掷骰', 'dice'], tokens: ['die', 'dice'], kind: 'sfx' },
  { zh: ['胜利', '赢', '通关', 'you_win', 'win'], tokens: ['you-win'], kind: 'voice', alt: ['jingles-hit', 'confirmation'] },
  { zh: ['失败', '输', '战败', 'you_lose', 'lose'], tokens: ['you-lose', 'mission-failed'], kind: 'voice', alt: ['error'] },
  { zh: ['升级', '升段', '变强', 'level_up'], tokens: ['level-up', 'level'], kind: 'voice', alt: ['power-up'] },
  { zh: ['任务完成', '目标达成'], tokens: ['objective-achieved'], kind: 'voice', alt: ['confirmation'] },
  { zh: ['人声', '语音', '配音', 'voice', '说话'], tokens: ['you-win', 'you-lose', 'level-up', 'power-up', 'objective-achieved', 'mission-failed', 'congratulations', 'correct', 'final-round'], kind: 'voice' },
  { zh: ['悬停', '划过', 'hover', '移入'], tokens: ['rollover'], kind: 'sfx' },
  { zh: ['点击', '按键', '按钮', '单击', '点按', 'click', 'ui', '界面', '菜单'], tokens: ['click', 'mouseclick'], kind: 'sfx' },
  { zh: ['返回', '后退', 'back'], tokens: ['back'], kind: 'sfx' },
  { zh: ['关闭', 'close'], tokens: ['close'], kind: 'sfx' },
  { zh: ['打开', '展开', 'open', 'maximize'], tokens: ['maximize', 'open'], kind: 'sfx' },
  { zh: ['错误', '报错', '错误提示', 'error'], tokens: ['error'], kind: 'sfx' },
  { zh: ['确认', '成功', '完成', 'confirmation'], tokens: ['confirmation'], kind: 'sfx' },
  { zh: ['击败', '打败', '击杀', '战胜', '击倒'], tokens: ['impact-punch-heavy', 'impact-plate-heavy', 'impact-metal-heavy', 'impact-generic-heavy', 'impact'], kind: 'sfx' },
  { zh: ['怪物', '怪兽', '敌人', 'monster'], tokens: ['impact-punch', 'impact-soft', 'impact-metal'], kind: 'sfx' },
  { zh: ['打击', '攻击', '命中', '碰撞', '撞击', 'impact', 'hit', '被拍扁', '怪物死亡', '受伤', '挨打'], tokens: ['impact-punch', 'impact-plate', 'impact-metal', 'impact-wood', 'impact-soft', 'impact-generic', 'impact'], kind: 'sfx' },
  { zh: ['爆炸', 'explosion'], tokens: ['explosion-crunch'], kind: 'sfx' },
  { zh: ['脚步', '走路', 'footstep'], tokens: ['footstep'], kind: 'sfx' },
  { zh: ['激光', '射击', '光束', 'laser'], tokens: ['laser', 'laser-small', 'laser-large', 'laser-retro'], kind: 'sfx' },
  { zh: ['掉落', '落下', 'drop'], tokens: ['drop'], kind: 'sfx' },
  { zh: ['滚动', '滑动', 'scroll'], tokens: ['scroll'], kind: 'sfx' },
  { zh: ['切换', '开关', 'toggle', 'switch'], tokens: ['switch', 'toggle'], kind: 'sfx' },
  { zh: ['倒计时', '滴答', 'tick'], tokens: ['tick'], kind: 'sfx' },
  { zh: ['引擎', '飞船', '太空', 'space'], tokens: ['space-engine', 'space-engine-large', 'thruster-fire', 'engine-circular'], kind: 'sfx' },
  { zh: ['科幻', '电子', '未来'], tokens: ['computer-noise', 'force-field', 'phaser', 'pep-sound'], kind: 'sfx' },
  { zh: ['布料', '衣服', 'cloth'], tokens: ['cloth'], kind: 'sfx' },
  { zh: ['翻书', '书', 'book'], tokens: ['book-flip', 'book-place'], kind: 'sfx' },
  { zh: ['刀', '砍', '切', 'knife'], tokens: ['draw-knife', 'chop'], kind: 'sfx' },
  { zh: ['玻璃', '碎', 'glass'], tokens: ['impact-glass'], kind: 'sfx' },
  { zh: ['背景音乐', 'bgm', '音乐', '配乐', '主题曲'], tokens: ['jingles'], kind: 'bgm', note: 'Kenney CC0 音乐包只有 1~3 秒短 jingle（HIT/NES/PIZZI/SAX/STEEL 五组），没有可无缝循环的完整 BGM。要完整循环 BGM 需要另找 CC0 曲目或授权素材。' },
]

/** Score one index item against a set of tokens. */
function scoreItem(item, tokens, weight = 1) {
  let score = 0
  for (const t of tokens) {
    let hit = 0
    if (item.norm === t) hit = 100
    else if (item.norm.startsWith(`${t}-`)) hit = 60
    else if (item.norm.includes(`-${t}`) || item.norm.startsWith(t)) hit = 45
    else if (item.norm.includes(t)) hit = 25
    score += hit * weight
  }
  return score
}

/**
 * Search the library for a Chinese or English description.
 * Returns { matches, intent, note, kind }.
 */
export async function searchAudio(cacheDir, query, { limit = 8, ...opts } = {}) {
  const { index, errors } = await loadIndex(cacheDir, opts)
  const q = String(query ?? '').toLowerCase().trim()
  let primary = []
  let alt = []
  let kind = null
  let note = null

  for (const intent of INTENTS) {
    for (const zh of intent.zh) {
      if (q.includes(zh.toLowerCase())) {
        primary = intent.tokens
        alt = intent.alt ?? []
        kind = intent.kind
        note = intent.note ?? null
        break
      }
    }
    if (primary.length > 0) break
  }
  // No Chinese intent → treat the query itself as an English token list.
  if (primary.length === 0) {
    primary = q.split(/[\s,，、]+/).filter((t) => t.length > 1).map((t) => normalize(t))
  }

  const scored = []
  for (const item of index) {
    let score = scoreItem(item, primary)
    score += scoreItem(item, alt, 0.4) // fallback family, clearly weaker
    if (score === 0) continue
    if (kind && item.kind === kind) score += 15
    if (kind === 'bgm' && item.kind !== 'bgm') score -= 40
    // Human voiceover is a different beast from a UI sting: unless the query
    // asked for voice, demote it so SFX wins ties.
    if (kind !== 'voice' && item.kind === 'voice') score -= 55
    scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || a.item.kb - b.item.kb)
  const localMatches = scored.slice(0, limit).map(({ item, score }) => ({
    pack: item.pack, file: item.rel, name: item.base, ext: item.ext,
    kb: item.kb, score, abs: item.abs, kind: item.kind, source: 'kenney', local: true,
  }))

  // Fall through to external commercial-free sources when the local CC0 library
  // has nothing (or the caller explicitly asks). Results are remote: they carry
  // a url + referer and get downloaded only when actually installed.
  let external = []
  const wantExternal = opts.sources !== false && localMatches.length === 0
  if (wantExternal) {
    for (const src of SOURCES) {
      if (src.kind === 'sfx' && kind === 'bgm') continue
      try {
        const res = await ensureSourceIndex(src.id, cacheDir, opts)
        if (res.items.length === 0) continue
        const hits = searchSourceIndex(src.id, cacheDir, [...primary, ...alt], 4)
        for (const hit of hits) {
          external.push({
            pack: `${src.id}/${hit.cat}`, file: `${hit.name}${hit.ext}`,
            name: hit.name, ext: hit.ext, kb: null, score: 1, abs: null,
            kind: src.kind, source: src.id, local: false,
            url: hit.url, referer: hit.referer, license: src.license,
          })
        }
      } catch { /* source unavailable → skip silently */ }
    }
  }

  const matches = localMatches.length > 0 ? localMatches : external.slice(0, limit)
  return {
    matches,
    tokens: primary, alt, kind, note, errors, total: index.length,
    externalCount: external.length,
  }
}

/** Install a remote (non-Kenney) match: download then place it. */
export async function installRemoteMatch(match, project, kind, outName) {
  const ext = match.ext || '.mp3'
  const safe = String(outName && outName.length > 0
    ? outName
    : `${match.name}${ext}`).replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_')
  const dir = path.join(project, 'assets', 'audio', kind === 'bgm' ? 'bgm' : 'sfx')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, safe)
  const result = await downloadSourceFile(
    { url: match.url, referer: match.referer },
    target,
  )
  if (!result.ok) return { ok: false, error: result.error }
  const meta = `${target}.meta`
  if (!fs.existsSync(meta)) {
    // 原子写：Maker 会监听 assets/ 并在构建时解析 .meta，
    // 直接 writeFileSync 留下的半截 JSON 会让构建报「meta 损坏」。
    fs.writeFileSync(`${meta}.partial`, `${JSON.stringify({ uuid: newAssetUuid() }, null, 2)}\n`)
    fs.renameSync(`${meta}.partial`, meta)
  }
  return { ok: true, target, meta, uuid: JSON.parse(fs.readFileSync(meta, 'utf8')).uuid, license: match.license }
}

/** Generate a Maker-style asset uuid (22-char base64url, matches observed .meta). */
export function newAssetUuid() {
  return crypto.randomBytes(16).toString('base64url')
}
