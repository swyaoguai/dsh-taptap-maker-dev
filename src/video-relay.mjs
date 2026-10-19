/**
 * 视频中转站（OpenAI 兼容 / 自定义视频端点）。
 *
 * 和生图中转站（`/images/generations`）是同一套思路：**用你自己的中转站
 * 地址 / Key / 模型**，不花 Maker 内置额度，也不绑定 MiniMax 官方。
 * 区别只有协议形状 —— 视频是异步任务，必须「提交 → 轮询 → 下载」。
 *
 * 市面上常见的三种形状，本模块按配置显式选择（不猜）：
 *
 *   1. `openai`（默认）—— OpenAI 兼容视频接口：
 *        POST {base}/videos             { model, prompt, seconds, size, input_reference }
 *        GET  {base}/videos/{id}        → { status, progress, error }
 *        GET  {base}/videos/{id}/content → 视频字节
 *      `input_reference` 同时接受 data URI 或公网 URL。
 *      首帧 = 1 张参考图；**首尾帧 = 2 张参考图**（第二张是尾帧）。
 *      这是 OpenAI 兼容层里最常见的约定，也是很多中转站直接支持的做法。
 *
 *   2. `generic` —— 万能 HTTP 模板：用户自己写
 *        `submitPath` / `queryPath`（含 `{taskId}`）/ `videoUrlPath`
 *        + `taskIdPath`（JSON 里取 task id 的点路径，默认 `id`）
 *        + `statusPath`（默认 `status`）+ `doneValues` / `failedValues`
 *        + `urlPath`（响应里取视频地址的点路径）+ `idInBody`。
 *      这不是偷懒，而是没法穷举每一家中转站的协议；给一套**看得懂的模板**，
 *      用户照着文档填两行就能接进来，报错时也能自己看出卡在哪。
 *
 *   3. `minimax` —— 中转站代理了 MiniMax 协议（`/v1/video_generation` 等）：
 *        baseUrl 指向中转站根，协议与官方一致。很多中转站就是这么转的。
 *
 * 共同遵守的东西（与生图中转站一致）：
 *   - 凭据落在 `$DSH_HOME/taptap-maker-dev/video-relay.json`，绝不进工作区；
 *   - 报错原文回到界面/对话里，不吞；
 *   - 「获取模型」走 `GET {base}/models`，中转站给什么列什么。
 *
 * @module src/video-relay.mjs
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

export class RelayError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'RelayError'
    this.status = status
    this.body = body
  }
}

/** 中转站协议形状。 */
export const RELAY_PROTOCOLS = ['openai', 'minimax', 'generic']

/**
 * `openai` 协议 = **星盘AI 式 /videos 协议**（也是目前最通用的一种）。
 *
 * 与 OpenAI 官方视频接口的差别（以星盘接入指南为准）：
 *   - 型号自带清晰度档位，**不能**再用 `resolution` / `size` 升降档；
 *     所以默认不再发送 size，改由型号决定。
 *   - 一张图 / 首尾帧走 `metadata.mode` + `first_frame_url` / `last_frame_url`
 *     （或 `image_urls`），不是 `input_reference`。
 *   - 画幅在 `metadata.ratio`（`16:9` / `9:16` / …），且**首尾帧模式下画幅
 *     由素材决定**，填了 ratio 也可能不按它裁。
 *   - 素材必须有**公网可访问地址**：本机图片要先 `POST /reference-assets`
 *     上传换 `url`。data URI 这条路在该协议下不保证可用。
 *   - 生产环境要带 `Idempotency-Key`（24 小时内防重复扣费）。
 */
export const RELAY_DEFAULTS = {
  enabled: false,
  protocol: 'openai',
  baseURL: '',
  apiKey: '',
  model: '',
  // openai 协议
  size: '',
  seconds: 4,
  ratio: '16:9',
  // 参考素材上传路径：每个中转站都不一样，**不预设默认值**。
  // 没填时直接拒收本地图片、要求用公网 URL —— 让用户主动去查自家文档。
  assetUploadPath: '',
  // generic 协议
  submitMethod: 'POST',
  submitPath: '/videos',
  queryMethod: 'GET',
  queryPath: '/videos/{taskId}',
  videoUrlPath: '',
  taskIdPath: 'id',
  statusPath: 'status',
  doneValues: 'completed,succeeded,success',
  failedValues: 'failed,error,cancelled,canceled',
  pendingValues: 'queued,pending,running,in_progress,processing,delivering',
  idInBody: true,
  authHeader: 'Authorization',
  authPrefix: 'Bearer ',
  extraQuery: '',
  extraBody: '',
}

const str = (v, fb = '') => (typeof v === 'string' ? v.trim() : fb)
const bool = (v, fb = false) => (typeof v === 'boolean' ? v : fb)
const num = (v, fb) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : fb
}
const list = (v, fb) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : str(v) ? str(v).split(',').map((s) => s.trim()).filter(Boolean) : fb)

/**
 * 把 Base URL 规整成「协议根」。
 *
 * ★ 必须**保留** `/v1`。星盘这类中转站的接口就是 `https://host/v1/videos`，
 * 早期版本把 `/v1` 剥掉当根，结果请求打到 `https://host/videos` → 404，
 * 而报错只说「not found」，很难看出是这里少了一层。
 * 只剥「用户粘贴时多带的整条视频路径」，不动 `/v1`。
 */
export function normalizeBaseURL(raw) {
  let base = str(raw)
  if (base === '') return ''
  base = base.replace(/\/+$/, '')
  // .../v1/videos → .../v1 ；.../v1/videos/xxx → .../v1
  base = base.replace(/\/(videos?)(\/[^/]*)?$/i, '')
  // 多粘了一个 /video_generation（MiniMax 协议）也一并去掉
  base = base.replace(/\/(v1|v2)\/video_generation.*$/i, '/$1')
  return base
}

/** 把磁盘上的原始配置规整成一份可用的配置（缺字段全部有默认值）。 */
export function normalizeRelayConfig(raw = {}) {
  const protocol = RELAY_PROTOCOLS.includes(raw.protocol) ? raw.protocol : RELAY_DEFAULTS.protocol
  const baseURL = normalizeBaseURL(raw.baseURL)
  const ratio = str(raw.ratio, RELAY_DEFAULTS.ratio)
  return {
    enabled: bool(raw.enabled, RELAY_DEFAULTS.enabled),
    protocol,
    baseURL,
    apiKey: str(raw.apiKey),
    model: str(raw.model),
    size: str(raw.size, RELAY_DEFAULTS.size),
    seconds: Math.max(1, Math.min(60, Math.round(num(raw.seconds, RELAY_DEFAULTS.seconds)))),
    // 画幅：只接受 16:9 这类「数字:数字」，用户写成全角冒号 / 1920x1080 时纠正，
    // 因为平台会直接 400（指南第 3 节明确要求英文冒号）。
    ratio: normalizeRatio(ratio),
    assetUploadPath: str(raw.assetUploadPath, RELAY_DEFAULTS.assetUploadPath),
    submitMethod: str(raw.submitMethod, RELAY_DEFAULTS.submitMethod).toUpperCase(),
    submitPath: str(raw.submitPath, RELAY_DEFAULTS.submitPath),
    queryMethod: str(raw.queryMethod, RELAY_DEFAULTS.queryMethod).toUpperCase(),
    queryPath: str(raw.queryPath, RELAY_DEFAULTS.queryPath),
    videoUrlPath: str(raw.videoUrlPath),
    taskIdPath: str(raw.taskIdPath, RELAY_DEFAULTS.taskIdPath),
    statusPath: str(raw.statusPath, RELAY_DEFAULTS.statusPath),
    doneValues: list(raw.doneValues, RELAY_DEFAULTS.doneValues.split(',')),
    failedValues: list(raw.failedValues, RELAY_DEFAULTS.failedValues.split(',')),
    pendingValues: list(raw.pendingValues, RELAY_DEFAULTS.pendingValues.split(',')),
    idInBody: bool(raw.idInBody, RELAY_DEFAULTS.idInBody),
    authHeader: str(raw.authHeader, RELAY_DEFAULTS.authHeader),
    authPrefix: typeof raw.authPrefix === 'string' ? raw.authPrefix : RELAY_DEFAULTS.authPrefix,
    extraQuery: str(raw.extraQuery),
    extraBody: str(raw.extraBody),
  }
}

/**
 * 画幅收敛。平台只认 `16:9` 这种英文冒号的「数字:数字」：
 * 全角 `16：9`、`16/9`、`1920x1080` 都会 400。这里统一纠正成 `W:H`。
 */
export function normalizeRatio(value) {
  const v = String(value ?? '').trim()
  if (v === '') return RELAY_DEFAULTS.ratio
  const m = /^(\d+(?:\.\d+)?)\s*[:：/x×]\s*(\d+(?:\.\d+)?)$/i.exec(v)
  if (m !== null) {
    const a = Number(m[1])
    const b = Number(m[2])
    // 先按「已知画幅」匹配（精确到 3%）：平台只认这几个值，
    // 自己约分会把 21:9 变成 7:3，平台不认。
    const known = [[16, 9], [9, 16], [4, 3], [3, 4], [1, 1], [21, 9]]
    const target = a / b
    let best = null
    for (const [x, y] of known) {
      const diff = Math.abs(x / y - target)
      if (best === null || diff < best.diff) best = { diff, x, y }
    }
    if (best !== null && best.diff < 0.03) return `${best.x}:${best.y}`
    // 不在已知集合里：原样返回（可能是某个型号的自定义比例）。
    return `${a}:${b}`
  }
  if (v.toLowerCase() === 'auto') return 'auto'
  return RELAY_DEFAULTS.ratio
}

/**
 * 星盘AI 已知型号的能力表（照抄接入指南第 2、3 节）。
 *
 * 有了它，「时长超范围」「不支持首尾帧」「该型号没有 21:9」这类事能在
 * 提交**之前**用一句人话说清，而不是让用户拿一个 400 自己猜。
 * 不在表里的型号按最宽松处理（不拦），因为中转站可以自己加型号。
 */
export const RELAY_MODEL_CAPS = {
  'minimax-h3-768p-per-second': { label: 'H3 768P 按秒', seconds: [4, 15], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', 'auto'], frames: true, pricePerSecond: 0.15 },
  'minimax-h3-2k-per-second': { label: 'H3 2K 按秒', seconds: [4, 15], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', 'auto'], frames: true, pricePerSecond: 0.2 },
  'seedance-2.5-vip-480p': { label: 'SD 2.5 稳定 480P', seconds: [4, 30], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], frames: true, pricePerSecond: 0.55 },
  'seedance-2.5-vip-720p': { label: 'SD 2.5 稳定 720P', seconds: [4, 30], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], frames: true, pricePerSecond: 1.18 },
  'seedance-2.5-vip-1080p': { label: 'SD 2.5 稳定 1080P', seconds: [4, 30], ratios: ['16:9', '9:16', '1:1'], frames: true, pricePerSecond: 4.38 },
  'seedance-2.5-discount-480p': { label: 'SD 2.5 折扣 480P', seconds: [4, 30], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], frames: true, pricePerSecond: 0.44 },
  'seedance-2.5-discount-720p': { label: 'SD 2.5 折扣 720P', seconds: [4, 30], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], frames: true, pricePerSecond: 0.66 },
  'seedance-2.5-special-480p': { label: 'SD 2.5 特殊 480P', seconds: [4, 30], ratios: ['16:9', '9:16'], frames: true, pricePerSecond: 0.63 },
  'seedance-2.5-special-720p': { label: 'SD 2.5 特殊 720P', seconds: [4, 30], ratios: ['16:9', '9:16'], frames: true, pricePerSecond: 0.88 },
  'wan-3.0': { label: 'Wan 3.0', seconds: [5, 30], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'], frames: false, pricePerSecond: 0.45 },
  'wan-3.0-prime': { label: 'Wan 3.0 Prime', seconds: [5, 30], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'], frames: false, pricePerSecond: 0.45 },
}

export const relayModelCaps = (model) => RELAY_MODEL_CAPS[String(model ?? '').trim()] ?? null

/** 提交前把「已知型号的限制」变成一条人能读的提示；没问题返回 undefined。 */
export function relayModelWarning(model, { seconds, ratio, hasLastFrame } = {}) {
  const caps = relayModelCaps(model)
  if (caps === null) return undefined
  const problems = []
  if (Number.isFinite(seconds)) {
    const [lo, hi] = caps.seconds
    if (seconds < lo || seconds > hi) problems.push(`时长 ${seconds}s 超出 ${lo}–${hi}s`)
  }
  if (ratio && ratio !== 'auto' && !caps.ratios.includes(ratio)) {
    problems.push(`画幅 ${ratio} 不在该型号支持的 ${caps.ratios.join(' / ')} 里`)
  }
  if (hasLastFrame && caps.frames === false) problems.push(`${caps.label} 不支持首尾帧`)
  return problems.length > 0 ? problems.join('；') : undefined
}

/** 转发一个 GET /models 之外的能力查询：给设置页「型号」下拉用。 */
export const relayKnownModels = () =>
  Object.entries(RELAY_MODEL_CAPS).map(([id, caps]) => ({
    id,
    label: caps.label,
    seconds: caps.seconds,
    ratios: caps.ratios,
    frames: caps.frames,
    pricePerSecond: caps.pricePerSecond,
  }))

/** 中转站是否「配好了」：要不要启用 + 四要素齐不齐。 */export function relayReady(cfg) {
  if (!cfg || cfg.enabled !== true) return false
  if (!cfg.baseURL || !cfg.apiKey) return false
  if (cfg.protocol === 'generic') return Boolean(cfg.submitPath && cfg.model)
  return Boolean(cfg.model)
}

/**
 * 点路径取值：`data.output.url`、`result.0.url`（数字下标）、`a.b[0]` 都支持。
 * 取不到返回 undefined —— 调用方据此给出「哪个字段没取到」的明确报错。
 */
export function pickPath(obj, dotted) {
  if (!dotted) return undefined
  const parts = []
  for (const seg of String(dotted).replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (seg !== '') parts.push(seg)
  }
  let cur = obj
  for (const seg of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[seg]
  }
  return cur
}

const headersFor = (cfg) => {
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers[cfg.authHeader || 'Authorization'] = `${cfg.authPrefix ?? 'Bearer '}${cfg.apiKey}`
  return headers
}

/** 取 host:port 部分（素材上传这类挂在根路径的接口用）。 */
function originOf(baseURL) {
  try { return new URL(String(baseURL)).origin } catch { return String(baseURL).replace(/\/+$/, '') }
}

/** 把相对路径拼到 baseURL 上；已经带域名的路径原样使用（方便临时换图床）。 */
function joinUrl(base, pathOrUrl) {
  const p = str(pathOrUrl)
  if (/^https?:\/\//i.test(p)) return p
  const baseClean = String(base).replace(/\/+$/, '')
  const pathClean = p.startsWith('/') ? p : `/${p}`
  return `${baseClean}${pathClean}`
}

function withExtras(url, extraQuery) {
  if (!extraQuery) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}${extraQuery.replace(/^[?&]/, '')}`
}

async function readJsonOrText(response) {
  const text = await response.text().catch(() => '')
  try { return { json: text ? JSON.parse(text) : undefined, text } } catch { return { json: undefined, text } }
}

function errorMessage(json, text, status) {
  const m = json?.error?.message ?? json?.error ?? json?.message ?? json?.msg ?? text
  const s = typeof m === 'string' ? m : JSON.stringify(m ?? '')
  return s.slice(0, 600) || `HTTP ${status}`
}

/** 一次带超时的 JSON 请求，错误原文保留。 */
async function request(url, init, timeoutMs, what) {
  const timeout = AbortSignal.timeout(Math.max(10_000, timeoutMs || 120_000))
  let response
  try {
    response = await fetch(url, { ...init, signal: timeout })
  } catch (error) {
    if (timeout.aborted) throw new RelayError(`${what}超时（${Math.round((timeoutMs || 120_000) / 1000)} 秒）`)
    throw new RelayError(`${what}连接失败：${error?.message ?? error}`)
  }
  const { json, text } = await readJsonOrText(response)
  if (!response.ok) throw new RelayError(`${what}失败（HTTP ${response.status}）：${errorMessage(json, text, response.status)}`, response.status, text.slice(0, 2000))
  if (json === undefined) throw new RelayError(`${what}返回的不是 JSON：${text.slice(0, 300)}`, response.status, text.slice(0, 2000))
  return json
}

/* ───────────────────────── openai 协议（星盘式 /videos） ────────────────── */

/**
 * 把本地图片上传成**公网可访问的 url**。
 *
 * 为什么必须上传：星盘协议要求素材是 URL，且明确不接受本机路径 / Base64。
 * 上传方式是「文件原始内容 + Content-Type」，不是 JSON、不是 multipart。
 * 返回的 `url` 24 小时后过期，所以每一步都现传，不缓存。
 */
export async function relayUploadAsset(cfg, filePath, mime) {
  // ★ 星盘的 reference-assets 挂在**主机根**上，不在 /v1 下面。
  // 所以这里从 baseURL 里取 origin 再拼，不能直接 joinUrl(baseURL, path)。
  const uploadPath = cfg.assetUploadPath
  // 空路径 = 不上传：要求用户传公网 URL，或者在设置页填一个自己的上传端点。
  if (uploadPath === '') throw new RelayError('没有设置素材上传路径：本地图片必须先上传换 url。在「中转站」卡的「高级选项」里填一个上传端点（如 /reference-assets），或者直接传公网 URL。')
  const url = /^https?:\/\//i.test(uploadPath)
    ? uploadPath
    : `${originOf(cfg.baseURL)}${uploadPath.startsWith('/') ? '' : '/'}${uploadPath}`
  const headers = headersFor(cfg)
  // 上传是「文件原始字节 + 真实 Content-Type」，不是 JSON 也不是 multipart。
  headers['Content-Type'] = mime || 'application/octet-stream'
  const bytes = readFileSync(filePath)
  const timeout = AbortSignal.timeout(180_000)
  let response
  try {
    response = await fetch(url, { method: 'POST', headers, body: bytes, signal: timeout })
  } catch (error) {
    throw new RelayError(`上传参考素材失败：${error?.message ?? error}`)
  }
  const text = await response.text().catch(() => '')
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  if (!response.ok) {
    throw new RelayError(`上传参考素材失败（HTTP ${response.status}）：${errorMessage(json, text, response.status)}`, response.status, text.slice(0, 1200))
  }
  // 少数实现把 url 包在 data / file / asset 里。
  const assetUrl = pickPath(json, 'url') ?? pickPath(json, 'data.url') ?? pickPath(json, 'file.url') ?? pickPath(json, 'asset.url')
  if (typeof assetUrl !== 'string' || assetUrl === '') {
    throw new RelayError(`上传成功但没拿到素材 url：${String(text).slice(0, 400)}`)
  }
  return {
    url: assetUrl,
    expiresAt: pickPath(json, 'expires_at'),
    durationSeconds: pickPath(json, 'duration_seconds'),
  }
}

/**
 * 决定 `metadata.mode` 与素材字段。
 *
 * 指南第 3 节的映射表（H3）：
 *   纯文字     → text_to_video（不带素材）
 *   一张图     → frames + first_frame_url
 *   首尾帧     → frames + first_frame_url + last_frame_url
 *   普通参考   → omni_reference + image_urls
 *
 * 本插件的输入**恰好就这两种**（首帧 / 首尾帧），所以默认走 frames；
 * 用户显式指定 omni_reference 且有两张图时按普通参考处理。
 */
export function buildModeFields({ mode, firstFrameUrl, lastFrameUrl, ratio }) {
  const metadata = { ratio: ratio || '16:9' }
  if (mode === 'omni_reference') {
    const urls = [firstFrameUrl, lastFrameUrl].filter(Boolean)
    if (urls.length === 0) {
      metadata.mode = 'text_to_video'
    } else {
      metadata.mode = 'omni_reference'
      metadata.image_urls = urls
    }
    return metadata
  }
  if (!firstFrameUrl && !lastFrameUrl) {
    metadata.mode = 'text_to_video'
    return metadata
  }
  if (!firstFrameUrl && lastFrameUrl) {
    // H3 不允许「只给尾帧」（指南第 3 节）。在本地就说清楚，不要发给平台换一个 400。
    throw new RelayError('首尾帧模式必须给首帧：H3 不支持只提供尾帧')
  }
  metadata.mode = 'frames'
  metadata.first_frame_url = firstFrameUrl
  if (lastFrameUrl) metadata.last_frame_url = lastFrameUrl
  return metadata
}

/** 生成一个幂等键（同一任务重试必须复用同一个值，否则会重复扣费）。 */
function newIdempotencyKey() {
  // 用 randomUUID：指南要求值不含控制字符、≤200 字符。
  return randomUUID()
}

async function submitOpenAI(cfg, input) {
  // 1) 先把本地首 / 尾帧上传成公网 url。
  //    input 里如果是 data URI（老调用方仍会这么传），这里直接拒掉 —— 
  //    该协议不保证接受 Base64，静默退回会让用户以为「上传成功了其实没有」。
  const upload = async (dataUri, label) => {
    if (!dataUri) return undefined
    if (/^https?:\/\//i.test(dataUri)) return dataUri // 已经是公网 URL
    if (!input.assetFiles?.[label]) {
      throw new RelayError(`${label} 需要先上传成公网 url：传公网 URL，或者设置「参考素材上传路径」让插件自动上传本地文件`)
    }
    const asset = await relayUploadAsset(cfg, input.assetFiles[label].path, input.assetFiles[label].mime)
    return asset.url
  }
  const firstFrameUrl = await upload(input.firstFrameImage, 'firstFrame')
  const lastFrameUrl = await upload(input.lastFrameImage, 'lastFrame')

  const url = withExtras(joinUrl(cfg.baseURL, '/videos'), cfg.extraQuery)
  const seconds = Math.round(Number(input.seconds ?? cfg.seconds) || 4)
  const body = {
    model: cfg.model,
    prompt: input.prompt,
    seconds,
    metadata: buildModeFields({
      mode: input.relayMode ?? 'frames',
      firstFrameUrl,
      lastFrameUrl,
      ratio: input.ratio ?? cfg.ratio,
    }),
  }
  // 型号决定清晰度：只有用户显式填了 size 才发，避免把高档型号降级。
  if (cfg.size) body.size = cfg.size
  if (cfg.extraBody) {
    try {
      const extra = JSON.parse(cfg.extraBody)
      if (extra && typeof extra === 'object') Object.assign(body, extra)
    } catch { throw new RelayError(`中转站「额外请求字段」不是合法 JSON：${cfg.extraBody}`) }
  }

  const headers = { ...headersFor(cfg), 'Idempotency-Key': input.idempotencyKey || newIdempotencyKey() }
  const json = await request(url, { method: 'POST', headers, body: JSON.stringify(body) }, 120_000, '中转站提交视频')
  const taskId = pickPath(json, 'id') ?? pickPath(json, 'task_id') ?? pickPath(json, 'data.id') ?? pickPath(json, 'task.id')
  if (typeof taskId !== 'string' || taskId === '') {
    throw new RelayError(`中转站没有返回任务 id：${JSON.stringify(json).slice(0, 400)}`)
  }
  return { taskId, idempotencyKey: headers['Idempotency-Key'] }
}

async function queryOpenAI(cfg, taskId) {
  const json = await request(joinUrl(cfg.baseURL, `/videos/${encodeURIComponent(taskId)}`), { method: 'GET', headers: headersFor(cfg) }, 60_000, '中转站查询视频')
  const raw = String(json?.status ?? '')
  const delivery = String(json?.delivery_status ?? '')
  const expired = json?.download_expired === true || delivery === 'expired'

  // 状态映射（指南第 6 节）。两处容易错的：
  //   - `delivering` 不是主 status 的取值，而是 delivery_status；主 status 仍是
  //     in_progress / 99%，**必须继续等**，不能当失败。
  //   - `cancelled` 与 `failed` 分开：取消时可能没有 error 字段，不能强读。
  let mapped
  if (expired) mapped = 'failed'
  else if (/^completed$/i.test(raw) || /^(succeeded|success|done)$/i.test(raw)) {
    mapped = delivery && delivery !== 'ready' ? 'running' : 'succeeded'
  } else if (/^(failed|error)$/i.test(raw)) mapped = 'failed'
  else if (/^cancelled$/i.test(raw) || /^canceled$/i.test(raw)) mapped = 'cancelled'
  else mapped = 'running'

  return {
    status: mapped === 'cancelled' ? 'failed' : mapped,
    remoteStatus: delivery ? `${raw}/${delivery}` : raw || mapped,
    progress: typeof json?.progress === 'number' ? json.progress : undefined,
    error: mapped === 'failed'
      ? (expired
        ? '成片下载已过期（download_expired）：中转站只保留 24 小时，需要重新生成'
        : errorMessage(json?.error ?? json, '', 200))
      : undefined,
    contentUrl: joinUrl(cfg.baseURL, `/videos/${encodeURIComponent(taskId)}/content`),
    directUrl: typeof json?.url === 'string' && json.url ? json.url : undefined,
  }
}

/**
 * 下载视频。星盘的内容端点**需要鉴权头**，不能把地址直接交给播放器。
 *
 * 指南第 6 节要求严格校验：只有 HTTP 200 且 Content-Type 是 video/* 才算成片。
 * 这里按字节头再兜一层（有的服务器给 application/octet-stream）。
 */
async function downloadOpenAI(cfg, taskId, query, timeoutMs) {
  const headers = headersFor(cfg)
  delete headers['Content-Type']
  const candidates = [query.contentUrl, query.directUrl].filter(Boolean)
  let lastError
  for (const url of candidates) {
    try {
      const timeout = AbortSignal.timeout(Math.max(60_000, timeoutMs || 300_000))
      const response = await fetch(url, { headers, signal: timeout })
      if (!response.ok) {
        const advice = response.status === 409 ? '（任务还没准备好，继续查询即可）'
          : response.status === 503 ? '（文件正在生成，稍后重试同一个地址，不要重新生成）'
            : response.status === 410 ? '（成片已过期，需要重新生成）' : ''
        lastError = new RelayError(`下载视频失败（HTTP ${response.status}）${advice}`, response.status)
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0) { lastError = new RelayError('下载到的视频是空文件'); continue }
      if (!looksLikeVideo(buffer)) {
        const head = buffer.subarray(0, 120).toString('utf8').replace(/\s+/g, ' ')
        lastError = new RelayError(`下载内容不是视频（Content-Type: ${response.headers.get('content-type') || '缺失'}）：${head}`)
        continue
      }
      return buffer
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof RelayError ? lastError : new RelayError(`下载视频失败：${lastError?.message ?? lastError}`)
}

/** 按文件头判断是不是常见视频容器（MP4/MOV 的 ftyp、WebM/MKV 的 EBML）。 */
export function looksLikeVideo(buffer) {
  if (!buffer || buffer.length < 12) return false
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return true
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return true
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'AVI ') return true
  return false
}

/* ───────────────────────── generic 协议 ────────────────────────────────── */

function fillTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (vars[name] !== undefined ? String(vars[name]) : whole))
}

async function submitGeneric(cfg, input) {
  const url = withExtras(joinUrl(cfg.baseURL, cfg.submitPath), cfg.extraQuery)
  let body
  try {
    body = cfg.extraBody ? JSON.parse(cfg.extraBody) : {}
  } catch {
    throw new RelayError(`中转站「额外请求字段」不是合法 JSON：${cfg.extraBody}`)
  }
  // 模板里的 {prompt} {model} {seconds} {size} 会替换到 body 的字符串值里；
  // 参考图放在 input_reference / image / images 三个常见键里，由用户按需删。
  const vars = { prompt: input.prompt, model: cfg.model, seconds: input.seconds ?? cfg.seconds, size: input.size ?? cfg.size }
  const walk = (value) => {
    if (typeof value === 'string') return fillTemplate(value, vars)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = walk(v)
      return out
    }
    return value
  }
  const built = Object.keys(body).length > 0 ? walk(body) : {
    model: cfg.model, prompt: input.prompt, seconds: input.seconds ?? cfg.seconds, size: input.size ?? cfg.size,
  }
  const refs = [input.firstFrameImage, input.lastFrameImage].filter(Boolean)
  if (refs.length > 0 && built.input_reference === undefined) built.input_reference = refs

  const init = { method: cfg.submitMethod, headers: headersFor(cfg) }
  if (cfg.submitMethod !== 'GET') init.body = JSON.stringify(built)
  const json = await request(url, init, 120_000, '中转站提交视频')
  let taskId
  if (cfg.idInBody) taskId = pickPath(json, cfg.taskIdPath)
  if ((typeof taskId !== 'string' || taskId === '') && typeof json?.id === 'string') taskId = json.id
  if (typeof taskId !== 'string' || taskId === '') {
    throw new RelayError(`中转站没有返回任务 id（在「任务 id 路径」${cfg.taskIdPath} 里没找到）：${JSON.stringify(json).slice(0, 400)}`)
  }
  if (cfg.videoUrlPath) {
    const direct = pickPath(json, cfg.videoUrlPath)
    if (typeof direct === 'string' && direct) return { taskId, directUrl: direct }
  }
  return { taskId }
}

async function queryGeneric(cfg, taskId) {
  const url = withExtras(joinUrl(cfg.baseURL, fillTemplate(cfg.queryPath, { taskId })), cfg.extraQuery)
  const json = await request(url, { method: cfg.queryMethod, headers: headersFor(cfg) }, 60_000, '中转站查询视频')
  const raw = String(pickPath(json, cfg.statusPath) ?? '')
  const lower = raw.toLowerCase()
  const mapped = cfg.doneValues.map((v) => v.toLowerCase()).includes(lower) ? 'succeeded'
    : cfg.failedValues.map((v) => v.toLowerCase()).includes(lower) ? 'failed'
      : cfg.pendingValues.map((v) => v.toLowerCase()).includes(lower) ? 'running' : 'pending'
  const urlPath = cfg.videoUrlPath ? pickPath(json, cfg.videoUrlPath) : undefined
  return {
    status: mapped,
    remoteStatus: raw || mapped,
    error: mapped === 'failed'
      ? String(pickPath(json, 'error.message') ?? pickPath(json, 'error') ?? pickPath(json, 'message') ?? '任务失败').slice(0, 600)
      : undefined,
    directUrl: typeof urlPath === 'string' && urlPath ? urlPath : undefined,
  }
}

async function downloadGeneric(cfg, taskId, query, timeoutMs) {
  if (!query.directUrl) {
    throw new RelayError('任务已完成，但没有拿到视频地址：请在设置里填「视频地址路径」（响应里视频 URL 的字段路径）')
  }
  const url = /^https?:\/\//i.test(query.directUrl) ? query.directUrl : joinUrl(cfg.baseURL, query.directUrl)
  const headers = headersFor(cfg)
  delete headers['Content-Type']
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(Math.max(60_000, timeoutMs || 300_000)) })
  if (!response.ok) throw new RelayError(`下载视频失败（HTTP ${response.status}）`, response.status)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new RelayError('下载到的视频是空文件')
  return buffer
}

/* ───────────────────────── 统一入口 ────────────────────────────────────── */

/**
 * 提交一个中转站视频任务。
 * `protocol: 'minimax'` 由调用方直接转给 minimax-video.mjs（协议完全一致），
 * 这里只处理 openai / generic。
 */
export async function relaySubmit(cfg, input) {
  if (!relayReady(cfg)) throw new RelayError('中转站没有配置好：需要 baseURL、apiKey、model（通用协议还要提交路径）')
  if (cfg.protocol === 'generic') return submitGeneric(cfg, input)
  return submitOpenAI(cfg, input)
}

export async function relayQuery(cfg, taskId) {
  if (cfg.protocol === 'generic') return queryGeneric(cfg, taskId)
  return queryOpenAI(cfg, taskId)
}

export async function relayDownload(cfg, taskId, query, timeoutMs) {
  if (cfg.protocol === 'generic') return downloadGeneric(cfg, taskId, query, timeoutMs)
  return downloadOpenAI(cfg, taskId, query, timeoutMs)
}

/**
 * 免费自检：调 `GET {base}/models` 验证地址与 Key，顺带把可用模型列出来。
 * 与生图中转站的「获取模型」是同一件事，所以两边可以共用一个按钮的心智。
 */
export async function relayListModels(cfg) {
  if (!cfg.baseURL) throw new RelayError('缺少 Base URL')
  if (!cfg.apiKey) throw new RelayError('缺少 API Key')
  const url = joinUrl(cfg.baseURL, '/models')
  const json = await request(url, { method: 'GET', headers: headersFor(cfg) }, 45_000, '获取中转站模型')
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : []
  const models = arr.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter((m) => typeof m === 'string' && m)
  return models
}

/** 本地图片 → data URI（中转站同样接受 data URI 或公网 URL）。 */
export function relayImageDataUri(file) {
  const bytes = readFileSync(file)
  const lower = file.toLowerCase()
  const mime = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${bytes.toString('base64')}`
}
