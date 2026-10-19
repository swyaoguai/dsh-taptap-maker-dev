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

export const RELAY_DEFAULTS = {
  enabled: false,
  protocol: 'openai',
  baseURL: '',
  apiKey: '',
  model: '',
  // openai 协议
  size: '1280x720',
  seconds: 4,
  // generic 协议
  submitMethod: 'POST',
  submitPath: '/videos',
  queryMethod: 'GET',
  queryPath: '/videos/{taskId}',
  videoUrlPath: '',
  taskIdPath: 'id',
  statusPath: 'status',
  doneValues: 'succeeded,completed,success',
  failedValues: 'failed,error,cancelled,canceled',
  pendingValues: 'queued,pending,running,in_progress,processing',
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

/** 把磁盘上的原始配置规整成一份可用的配置（缺字段全部有默认值）。 */
export function normalizeRelayConfig(raw = {}) {
  const protocol = RELAY_PROTOCOLS.includes(raw.protocol) ? raw.protocol : RELAY_DEFAULTS.protocol
  let baseURL = str(raw.baseURL, RELAY_DEFAULTS.baseURL)
  // 允许用户把整条路径粘进来（`.../v1/videos`），统一收敛到根。
  baseURL = baseURL.replace(/\/+$/, '').replace(/\/(v1|v2)\/(videos?|video_generation).*$/i, '').replace(/\/(videos?)$/i, '')
  return {
    enabled: bool(raw.enabled, RELAY_DEFAULTS.enabled),
    protocol,
    baseURL,
    apiKey: str(raw.apiKey),
    model: str(raw.model),
    size: str(raw.size, RELAY_DEFAULTS.size),
    seconds: Math.max(1, Math.min(60, Math.round(num(raw.seconds, RELAY_DEFAULTS.seconds)))),
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

/** 中转站是否「配好了」：要不要启用 + 四要素齐不齐。 */
export function relayReady(cfg) {
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

/* ───────────────────────── openai 协议 ─────────────────────────────────── */

async function submitOpenAI(cfg, input) {
  const url = withExtras(joinUrl(cfg.baseURL, '/videos'), cfg.extraQuery)
  const body = {
    model: cfg.model,
    prompt: input.prompt,
    seconds: String(input.seconds ?? cfg.seconds),
    size: input.size ?? cfg.size,
  }
  // 首帧 / 尾帧：1 张 = 首帧，2 张 = 首尾帧。
  const refs = [input.firstFrameImage, input.lastFrameImage].filter(Boolean)
  if (refs.length > 0) body.input_reference = refs
  if (cfg.extraBody) {
    try { Object.assign(body, JSON.parse(cfg.extraBody)) } catch { throw new RelayError(`中转站「额外请求字段」不是合法 JSON：${cfg.extraBody}`) }
  }
  const json = await request(url, { method: 'POST', headers: headersFor(cfg), body: JSON.stringify(body) }, 120_000, '中转站提交视频')
  const taskId = pickPath(json, 'id') ?? pickPath(json, 'task_id') ?? pickPath(json, 'data.id') ?? pickPath(json, 'task.id')
  if (typeof taskId !== 'string' || taskId === '') {
    throw new RelayError(`中转站没有返回任务 id：${JSON.stringify(json).slice(0, 400)}`)
  }
  return { taskId }
}

async function queryOpenAI(cfg, taskId) {
  const json = await request(joinUrl(cfg.baseURL, `/videos/${encodeURIComponent(taskId)}`), { method: 'GET', headers: headersFor(cfg) }, 60_000, '中转站查询视频')
  const raw = String(json?.status ?? '')
  const mapped = /^(succeeded|completed|success|done)$/i.test(raw) ? 'succeeded'
    : /^(failed|error|cancelled|canceled|canceled)$/i.test(raw) ? 'failed'
      : /^(queued|pending|running|in_progress|processing|starting)$/i.test(raw) ? 'running' : 'pending'
  return {
    status: mapped,
    remoteStatus: raw || mapped,
    progress: typeof json?.progress === 'number' ? json.progress : undefined,
    error: mapped === 'failed' ? errorMessage(json?.error ?? json, '', 200) : undefined,
    contentUrl: `${joinUrl(cfg.baseURL, `/videos/${encodeURIComponent(taskId)}/content`)}`,
    directUrl: typeof json?.url === 'string' && json.url ? json.url : undefined,
  }
}

/**
 * 下载视频。很多中转站的内容端点要鉴权头，所以不能把地址直接交给播放器，
 * 必须由插件自己带着 Key 下回来。
 */
async function downloadOpenAI(cfg, taskId, query, timeoutMs) {
  const headers = headersFor(cfg)
  delete headers['Content-Type']
  const candidates = [query.directUrl, query.contentUrl].filter(Boolean)
  let lastError
  for (const url of candidates) {
    try {
      const timeout = AbortSignal.timeout(Math.max(60_000, timeoutMs || 300_000))
      const response = await fetch(url, { headers, signal: timeout })
      if (!response.ok) {
        // 内容端点在有些实现里不需要鉴权，401 时去掉头部再试一次。
        const retry = response.status === 401 || response.status === 403
          ? await fetch(url, { signal: timeout })
          : undefined
        if (!retry || !retry.ok) {
          lastError = new RelayError(`下载视频失败（HTTP ${response.status}）`, response.status)
          continue
        }
        const buffer = Buffer.from(await retry.arrayBuffer())
        if (buffer.length > 0) return buffer
        lastError = new RelayError('下载到的视频是空文件')
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0) { lastError = new RelayError('下载到的视频是空文件'); continue }
      return buffer
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof RelayError ? lastError : new RelayError(`下载视频失败：${lastError?.message ?? lastError}`)
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
