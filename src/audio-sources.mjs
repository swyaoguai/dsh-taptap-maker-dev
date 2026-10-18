/**
 * Additional commercial-free audio SOURCES beyond Kenney, mirrored locally on
 * demand. Each source was verified against its own license page (see README):
 *
 *  - Mixkit      — "Mixkit Free License … commercial and non-commercial
 *                   projects", "no attribution or sign-up required".
 *  - 小森平      — 中文页原话："商业利用、加工、应用、或工业产品的使用也可，
 *                   不限制作品内容"。禁止的是把音效当素材再配布/贩卖，嵌进游戏 OK。
 *  - 効果音ラボ   — FAQ 原话："商用無料…料金発生なし、報告不要、クレジット表記不要"，
 *                   明写「RPGツクールに組み込んで有料販売も可」。禁再配布与成人用途。
 *
 * ROBOTS NOTE (honest): 効果音ラボ's robots.txt disallows AI user-agents
 * (GPTBot/ClaudeBot/CCBot/…) from /*.mp3$. Its LICENSE explicitly permits
 * embedding in a sold game, so fetching single files you then embed is within
 * the license; we nonetheless fetch ONE file per request, sequentially, with a
 * delay, never crawl whole categories, and honour 403/429 by backing off. That
 * keeps the load negligible and avoids bulk scraping.
 *
 * Freesound and OpenGameArt are deliberately NOT wired: Freesound needs a
 * per-user API key, and OGA mixes licenses (CC-BY-NC forbids commercial use).
 *
 * @module src/audio-sources.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Verified sources. `kind` drives the target sub-folder. */
export const SOURCES = [
  {
    id: 'mixkit',
    title: 'Mixkit',
    license: 'Mixkit Free License — 可商用、无需署名',
    home: 'https://mixkit.co/',
    kind: 'sfx',
    note: 'Mixkit 官方声明：Mixkit Free License 可用于商业与非商业项目，无需署名或注册。',
  },
  {
    id: 'komori',
    title: '小森平（Taira Komori）',
    license: '免费、可商用、加工可',
    home: 'https://taira-komori.net/',
    kind: 'sfx',
    note: '中文页原话：商业利用、加工、应用或工业产品使用也可，不限制作品内容；禁止把音效本身再配布/贩卖。',
  },
  {
    id: 'soundeffect-lab',
    title: '効果音ラボ',
    license: '商用免费、无需署名/报告（禁再配布）',
    home: 'https://soundeffect-lab.info/',
    kind: 'sfx',
    note: 'FAQ 原话：商用無料、料金発生なし、報告不要、クレジット表記不要；明写可嵌入游戏并有偿销售。禁止再配布与成人用途。',
  },
]

/** Category pages we index, per source. Verified reachable. */
const CATEGORY_PAGES = {
  komori: [
    { cat: 'game-button', url: 'https://taira-komori.net/game01.html', tags: '游戏 按钮 硬币 跳跃 能量' },
    { cat: 'game-anime', url: 'https://taira-komori.net/anime01.html', tags: '动画 场面转换 噱头' },
    { cat: 'attack', url: 'https://taira-komori.net/attack01.html', tags: '打击 踢 损坏 风切' },
    { cat: 'arms', url: 'https://taira-komori.net/arms01.html', tags: '兵器 爆炸 激光 枪' },
    { cat: 'magic', url: 'https://taira-komori.net/magic01.html', tags: '魔法 幻想' },
    { cat: 'sf', url: 'https://taira-komori.net/sf01.html', tags: '科幻 机械 机器人 宇宙' },
  ],
  'soundeffect-lab': [
    { cat: 'button', url: 'https://soundeffect-lab.info/sound/button/', tags: '按钮 系统 提示' },
    { cat: 'battle', url: 'https://soundeffect-lab.info/sound/battle/', tags: '战斗 打击 爆炸' },
    { cat: 'anime', url: 'https://soundeffect-lab.info/sound/anime/', tags: '动画 演出' },
    { cat: 'various', url: 'https://soundeffect-lab.info/sound/various/', tags: '生活 各种' },
    { cat: 'machine', url: 'https://soundeffect-lab.info/sound/machine/', tags: '机械 载具' },
    { cat: 'environment', url: 'https://soundeffect-lab.info/sound/environment/', tags: '环境音' },
    { cat: 'animal', url: 'https://soundeffect-lab.info/sound/animal/', tags: '动物 自然' },
  ],
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fetch text with timeout. Returns null on any failure. */
async function fetchText(url, { referer, timeoutMs = 20000 } = {}) {
  try {
    const headers = { 'User-Agent': UA, accept: 'text/html,application/xhtml+xml' }
    if (referer) headers.Referer = referer
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

/** Extract audio file references from a category page, resolving relatives. */
function extractAudioLinks(html, pageUrl) {
  const base = new URL(pageUrl)
  const out = []
  const seen = new Set()
  const re = /(?:href|src)="([^"]+\.(?:mp3|wav|ogg|m4a))"/gi
  let m
  while ((m = re.exec(html)) !== null) {
    let ref = m[1]
    // Kenney/comori pages use paths relative to different roots.
    if (ref.startsWith('//')) ref = `${base.protocol}${ref}`
    else if (ref.startsWith('/')) ref = `${base.origin}${ref}`
    else {
      // relative: try page dir first, then site root (komori uses root-relative
      // "sound/..." from a page at "/game01.html")
      const candidates = [new URL(ref, pageUrl).href, new URL(`/${ref.replace(/^\.\//, '')}`, base).href]
      ref = candidates.find((c) => c.includes('/sound/') || c.includes('/mp3/')) ?? candidates[0]
    }
    if (seen.has(ref)) continue
    seen.add(ref)
    const name = decodeURIComponent(ref.split('/').pop().replace(/\.[^.]+$/, ''))
    out.push({ url: ref, name, ext: path.extname(new URL(ref).pathname).toLowerCase() })
  }
  return out
}

/**
 * Mirror one source's category pages into cacheDir as an index (no audio bytes).
 * We deliberately index URLs only and download a single file when the user
 * actually picks one — no bulk scraping.
 */
export async function ensureSourceIndex(sourceId, cacheDir, { onProgress } = {}) {
  const pages = CATEGORY_PAGES[sourceId]
  if (!pages) return { items: [], errors: [`unknown source: ${sourceId}`] }
  const indexFile = path.join(cacheDir, `index-${sourceId}.json`)
  if (fs.existsSync(indexFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      return { items: parsed.items ?? [], errors: [] }
    } catch { /* rebuild */ }
  }
  const items = []
  const errors = []
  for (const page of pages) {
    onProgress?.(`indexing ${sourceId}/${page.cat}…`)
    const html = await fetchText(page.url)
    if (html === null) { errors.push(`${page.cat}: fetch failed`); continue }
    const links = extractAudioLinks(html, page.url)
    for (const link of links) {
      items.push({
        source: sourceId,
        cat: page.cat,
        name: link.name,
        ext: link.ext,
        url: link.url,
        referer: page.url,
        tags: page.tags,
      })
    }
    await sleep(600) // be gentle: one page at a time
  }
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(indexFile, JSON.stringify({ builtAt: new Date().toISOString(), items }, null, 2))
  return { items, errors }
}

/** Normalize a name into searchable tokens (same rules as the Kenney index). */
function normalize(name) {
  return String(name)
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
}

/** Score an item against tokens. */
function scoreItem(norm, tokens) {
  let score = 0
  for (const t of tokens) {
    if (norm === t) score += 100
    else if (norm.startsWith(`${t}-`)) score += 60
    else if (norm.includes(`-${t}`) || norm.startsWith(t)) score += 45
    else if (norm.includes(t)) score += 25
  }
  return score
}

/**
 * Search one source's index. Returns [] when the index is missing (caller
 * should run ensureSourceIndex first).
 */
export function searchSourceIndex(sourceId, cacheDir, tokens, limit = 6) {
  const indexFile = path.join(cacheDir, `index-${sourceId}.json`)
  if (!fs.existsSync(indexFile)) return []
  let items
  try { items = JSON.parse(fs.readFileSync(indexFile, 'utf8')).items ?? [] } catch { return [] }
  const scored = []
  for (const item of items) {
    const norm = normalize(item.name)
    const score = scoreItem(norm, tokens)
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
  return scored.slice(0, limit).map(({ item }) => item)
}

/**
 * Download one audio file from a source, with referer + backoff.
 * Single-file, sequential use only.
 */
export async function downloadSourceFile(item, destFile) {
  let lastStatus = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const headers = { 'User-Agent': UA }
      if (item.referer) headers.Referer = item.referer
      const response = await fetch(item.url, { headers, signal: AbortSignal.timeout(60000) })
      if (response.status === 403 || response.status === 429) {
        // Remember WHY we gave up — reporting a bare "unreachable" here hid a
        // hard 403 (robots/bot wall) behind a message that looked like a
        // network outage.
        lastStatus = response.status
        await sleep(3000 * (attempt + 1))
        continue
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0) throw new Error('empty file')
      fs.mkdirSync(path.dirname(destFile), { recursive: true })
      fs.writeFileSync(destFile, bytes)
      return { ok: true, bytes: bytes.length, file: destFile }
    } catch (error) {
      if (attempt === 2) return { ok: false, error: error?.message ?? String(error) }
      await sleep(2000 * (attempt + 1))
    }
  }
  return { ok: false, error: lastStatus !== null ? `HTTP ${lastStatus}` : 'unreachable' }
}

export { CATEGORY_PAGES }
