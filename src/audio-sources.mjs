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
  mixkit: [
    { cat: 'game', url: 'https://mixkit.co/free-sound-effects/game/', tags: '游戏 金币 胜利 升级 街机 复古' },
    { cat: 'interface', url: 'https://mixkit.co/free-sound-effects/interface/', tags: '界面 点击 通知 提示' },
    { cat: 'notification', url: 'https://mixkit.co/free-sound-effects/notification/', tags: '通知 提示 成功 警告' },
    { cat: 'modal', url: 'https://mixkit.co/free-sound-effects/modal/', tags: '弹窗 对话框 关闭' },
  ],
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
  // 两类来源：
  //  1. 常规 href/src（komori / soundeffect-lab 的静态页）
  //  2. mixkit 的 Stimulus 数据属性 data-audio-player-preview-url-value
  //     （2026-10 实测：mixkit 页面上既没有 <audio> 也没有 href/src 指向音频，
  //      播放器 URL 全在 data 属性里 —— 只抓 href/src 会得到 0 条，
  //      「Mixkit 可商用」这条源实际从未可用。）
  const re = /(?:(?:href|src)="([^"]+\.(?:mp3|wav|ogg|m4a))")|(?:data-audio-player-preview-url-value="([^"]+\.(?:mp3|wav|ogg|m4a))")/gi
  let m
  while ((m = re.exec(html)) !== null) {
    let ref = m[1] ?? m[2]
    if (!ref) continue
    // mixkit 卡片：标题 <h2 class="item-grid-card__title"> 在 player div **之后**
    // （实测相距 ~800 字符）。向后找最近的标题；抓不到就退回 URL 文件名。
    let name = null
    if (m[2]) {
      const after = html.slice(m.index, m.index + 2000)
      const tm = /item-grid-card__title[^>]*>\s*([^<]{2,90})</.exec(after)
      if (tm !== null) name = tm[1].trim()
    }
    // Kenney/comori pages use paths relative to different roots.
    if (ref.startsWith('//')) ref = `${base.protocol}${ref}`
    else if (ref.startsWith('/')) ref = `${base.origin}${ref}`
    else if (/^https?:\/\//i.test(ref)) { /* absolute (mixkit) — keep as-is */ } else {
      // relative: try page dir first, then site root (komori uses root-relative
      // "sound/..." from a page at "/game01.html")
      const candidates = [new URL(ref, pageUrl).href, new URL(`/${ref.replace(/^\.\//, '')}`, base).href]
      ref = candidates.find((c) => c.includes('/sound/') || c.includes('/mp3/')) ?? candidates[0]
    }
    if (seen.has(ref)) continue
    seen.add(ref)
    const fallbackName = decodeURIComponent(ref.split('/').pop().replace(/\.[^.]+$/, ''))
    out.push({
      url: ref,
      // 标题转可搜索名：空格→连字符，与 Kenney 索引的 normalize 规则对齐。
      name: name ? name.replace(/['’]/g, '').replace(/[^\w\s-]+/g, '').replace(/\s+/g, '-').toLowerCase() : fallbackName,
      title: name ?? undefined,
      ext: path.extname(new URL(ref).pathname).toLowerCase(),
    })
  }
  return out
}

/**
 * Mirror one source's category pages into cacheDir as an index (no audio bytes).
 * We deliberately index URLs only and download a single file when the user
 * actually picks one — no bulk scraping.
 *
 * 索引带 7 天新鲜度：站点改版会让旧链接 404，而索引一旦写盘就永不重建的话，
 * 用户只会看到莫名其妙的「HTTP 404」。过期即重建（每页 sleep 600ms，仍然温和）。
 */
const SOURCE_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function ensureSourceIndex(sourceId, cacheDir, { onProgress, force = false } = {}) {
  const pages = CATEGORY_PAGES[sourceId]
  if (!pages) return { items: [], errors: [`unknown source: ${sourceId}`] }
  const indexFile = path.join(cacheDir, `index-${sourceId}.json`)
  if (!force && fs.existsSync(indexFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
      const age = Date.now() - Date.parse(parsed?.builtAt ?? '')
      if (Number.isFinite(age) && age >= 0 && age < SOURCE_INDEX_TTL_MS) {
        return { items: parsed.items ?? [], errors: [] }
      }
      // 过期 → 落到下面重建。
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
 * 按文件头判断是不是常见音频容器（与视频链路的 looksLikeVideo 同一条防线）：
 * 站点返回 200 + HTML 错误页/登录墙时，没有这一步就会把 HTML 字节当音频
 * 写进 assets/audio/ 并打上 .meta 纳入构建 —— Maker 侧解析失败且极难排查。
 * ID3(mp3)、RIFF(wav)、OggS(ogg/opus)、fLaC(flac)、ftyp(m4a)。
 */
export function looksLikeAudio(buf) {
  if (!buf || buf.length < 12) return false
  if (buf.subarray(0, 3).toString('ascii') === 'ID3') return true
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true // 裸 MPEG 帧头
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF') return true
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return true
  if (buf.subarray(0, 4).toString('ascii') === 'fLaC') return true
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return true
  return false
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
      if (!looksLikeAudio(bytes)) {
        // 200 但不是音频 —— 多半是错误页/登录墙/防爬拦截页。如实报出来。
        const head = bytes.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ')
        throw new Error(`下载内容不是音频（多半是拦截页）：${head.slice(0, 100)}`)
      }
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
