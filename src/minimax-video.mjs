/**
 * MiniMax 视频生成客户端（图生视频 / 首尾帧）。
 *
 * 三套协议并存，按模型名**自动**选择，用户只需要选模型：
 *
 * **v2（MiniMax-H3 / H3-Max）** —— 新的统一入口，多模态 content 数组：
 *   POST {root}/v2/video_generation            → task_id
 *   GET  {root}/v2/query/video_generation/{id} → status + task.content.url
 *   查询接口**直接给视频地址**，不用再取件。首尾帧就是两条
 *   `role: first_frame` / `role: last_frame` 的 image_url。
 *
 * **v1 首尾帧（Hailuo-02 系列）** —— 老接口，扁平字段：
 *   POST {root}/v1/video_generation  { model, prompt, first_frame_image, last_frame_image, duration, resolution }
 *   注意：**v1 的首尾帧只有 MiniMax-Hailuo-02 支持**，Hailuo-2.3 走这个接口
 *   带 last_frame 会被判参数错误。这里按模型能力表拦，不让用户去猜。
 *   GET {root}/v1/query/video_generation?task_id=…  → file_id
 *   GET {root}/v1/files/retrieve?file_id=…          → download_url
 *
 * 提交与轮询分开：一次生成通常 1~6 分钟，不能同步阻塞。
 *
 * ## 「能不能用 M Plan 的积分」
 *
 * 实测（本机订阅 Key `sk-cp-…`，国内站）：
 *   - `api.minimaxi.com` 上 v1 / v2 的**视频接口接受订阅 Key**，鉴权通过；
 *   - 真正挡住的是**额度**：`{"status_code":1008,"insufficient balance"}` /
 *     `insufficient_balance_error`（HTTP 402）；
 *   - 调用 `www.minimax.cn/v1/token_plan/remains` 返回
 *     `2062 no active token plan subscription` —— M Plan **Go 档不含视频模型**，
 *     所以这个 Key 上没有任何视频额度（`mmx quota` 也是同样的报错）。
 *
 * 结论：不是「必须换一个档位的 API」，而是「Go 档本身没有视频额度」。
 * 订阅 Key 在 Explore/Build 档、或补了积分包之后，**同一个 Key、同一个接口**
 * 就能直接出视频。本模块把这句话写进错误提示里（见 capabilityReport），
 * 不让人对着 1008 干猜。
 *
 * @module src/minimax-video.mjs
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

export class MiniMaxError extends Error {
  constructor(message, status, code, hint) {
    super(message)
    this.name = 'MiniMaxError'
    this.status = status
    this.code = code
    this.hint = hint
  }
}

/**
 * 模型能力表。`supportsLastFrame` 决定「首尾帧模式」能选哪些模型 ——
 * 这是把「平台限制」提前变成界面限制，而不是让用户提交后才收到参数错误。
 */
export const MODEL_CAPABILITIES = {
  'MiniMax-H3': {
    protocol: 'v2',
    resolutions: ['768P', '2K'],
    durationMin: 4,
    durationMax: 15,
    supportsLastFrame: true,
    supportsReference: true,
    pricePerSecondCny: { '768P': 0.5, '2K': 0.8 },
    note: 'v2 · 768P/2K · 4~15 秒 · 首尾帧 + 多模态参考',
  },
  'MiniMax-H3-Max': {
    protocol: 'v2',
    resolutions: ['768P', '480P'],
    durationMin: 5,
    durationMax: 15,
    supportsLastFrame: true,
    supportsReference: true,
    pricePerSecondCny: { '480P': 0.33, '768P': 0.5 },
    note: 'v2 极速 · 480P/768P · 5~15 秒',
  },
  'MiniMax-Hailuo-02': {
    protocol: 'v1',
    resolutions: ['768P', '1080P'],
    durations: [6, 10],
    durationMin: 6,
    durationMax: 10,
    supportsLastFrame: true,
    supportsReference: false,
    pricePerVideoCny: { '768P': 2, '1080P': 3.5 },
    note: 'v1 · 768P/1080P · 6/10 秒 · 首尾帧',
  },
  'MiniMax-Hailuo-2.3': {
    protocol: 'v1',
    resolutions: ['768P', '1080P'],
    durations: [6, 10],
    durationMin: 6,
    durationMax: 10,
    supportsLastFrame: false,
    supportsReference: false,
    pricePerVideoCny: { '768P': 2, '1080P': 3.5 },
    note: 'v1 · 768P/1080P · 6/10 秒 · 只支持首帧',
  },
  'MiniMax-Hailuo-2.3-Fast': {
    protocol: 'v1',
    resolutions: ['768P', '1080P'],
    durations: [6, 10],
    durationMin: 6,
    durationMax: 10,
    supportsLastFrame: false,
    supportsReference: false,
    pricePerVideoCny: { '768P': 1.35, '1080P': 2.31 },
    note: 'v1 快速 · 768P/1080P · 6/10 秒 · 只支持首帧',
  },
}

export const DEFAULT_MODEL = 'MiniMax-H3'

/**
 * Key 的种类 —— 决定额度从哪扣。
 *
 *   - `subscription`：M Plan 订阅 Key，扣套餐额度 + 积分包。
 *     视频能否用取决于**档位**：Go 档不含视频模型，Explore/Build 才有。
 *   - `api`：按量计费 Key，扣账户余额。任何档位都能出视频，只是要充值。
 *   - `unknown`：无法判断。
 *
 * ⚠️ 前缀**不是**可靠的判据（2026-10-21 实测）。MiniMax 至少存在三种 Key 形态：
 *
 *   - `sk-cp-…`   经典订阅 Key
 *   - `sk-api-…`  按量 Key
 *   - `eyJ…`（JWT）**官网 / 控制台签发的登录态 Key，payload 里带 TokenType**。
 *     本机用户的 M Plan 订阅 Key 就是这种，之前被这里无条件判成 `api`，
 *     导致界面明明有订阅额度却提示「按量计费 Key，不走 M Plan 套餐额度」。
 *
 * 所以现在只做两件事：认得出 `sk-` 系列的按前缀判；JWT 解出 payload 看
 * `TokenType`（4 = 订阅，见下），解不出就交回 `unknown` —— **宁可说
 * 「不确定」，也不要武断地说「你不是订阅」**，因为这个提示会直接误导用户
 * 去充值。
 *
 * 最终判定仍然以远端 `/v1/token_plan/remains` 为准（见 testMiniMax）：
 * 那是唯一权威信号，本函数只负责给出界面上的**初步**说法。
 */
export function detectKeyKind(apiKey) {
  const key = String(apiKey ?? '').trim()
  if (key === '') return 'none'
  if (key.startsWith('sk-cp-')) return 'subscription'
  if (key.startsWith('sk-api-')) return 'api'
  if (/^ey[A-Za-z0-9_-]+\./.test(key)) return jwtKeyKind(key)
  return 'unknown'
}

/**
 * JWT Key 的类型判断。
 *
 * payload 是 base64url，解出来是一段 JSON。实测 MiniMax 控制台签发的 Key：
 *   { "GroupName":…, "TokenType":4, "iss":"minimax", … }
 * `TokenType: 4` = 订阅态。只看得到 TokenType 判定；看不到（被裁剪 / 格式变了）
 * 就返回 unknown，而不是默认按量。
 */
function jwtKeyKind(key) {
  const payload = decodeJwtPayload(key)
  if (!payload) return 'unknown'
  const t = Number(payload.TokenType ?? payload.token_type)
  // 4 = 订阅；1/2/3 这类按量形态不硬编码含义（没见过就当 unknown 更安全）。
  if (t === 4) return 'subscription'
  if (Number.isFinite(t) && t !== 4) return 'api'
  return 'unknown'
}

/** 解 JWT 的 payload 段；解不出来返回 undefined（不抛）。 */
function decodeJwtPayload(jwt) {
  try {
    const seg = String(jwt).split('.')[1]
    if (!seg) return undefined
    let b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const json = Buffer.from(b64, 'base64').toString('utf8')
    const out = JSON.parse(json)
    return out && typeof out === 'object' ? out : undefined
  } catch {
    return undefined
  }
}

/** 给界面 / 对话用的一句话，说明这个 Key 走什么额度。 */
export function describeKey(apiKey) {
  switch (detectKeyKind(apiKey)) {
    case 'subscription':
      // 注意：这类 Key 有 sk-cp- 和 JWT（TokenType=4）两种形态，别在文案里
      // 把「订阅」和某个前缀绑死 —— 之前就因为文案写死 sk-cp-，让用 JWT 的
      // 订阅用户以为自己填错了。
      return 'M Plan 订阅 Key：扣套餐额度。视频模型只有 Explore/Build 档才有，Go 档会收到额度不足。'
    case 'api':
      return '按量计费 Key：扣账户余额，任何档位都能出视频（H3 768P 约 ¥0.5/秒）。'
    case 'unknown':
      // 说「不确定」而不是断言「按量」：这是本文件修掉的那个 bug 的教训 ——
      // 猜错的代价是让用户以为自己没订阅而去重复充值。
      return '无法从 Key 本身判断类型（控制台签发的 Key 都是这种形态）。跑一次自检就能确认走的是套餐额度还是账户余额。'
    default:
      return '未填 Key：插件会用环境变量 MINIMAX_API_KEY 或本机 mmx 登录态。'
  }
}

export const protocolOf = (model) => (/^MiniMax-H3/i.test(String(model).trim()) ? 'v2' : 'v1')

/** 用户能选的模型（设置页下拉 / 首尾帧模式的过滤都用它）。 */
export const listModels = () =>
  Object.entries(MODEL_CAPABILITIES).map(([id, cap]) => ({ id, ...cap }))

export const modelsSupportingLastFrame = () =>
  Object.entries(MODEL_CAPABILITIES)
    .filter(([, cap]) => cap.supportsLastFrame)
    .map(([id]) => id)

/** 某个模型的能力；未知模型按协议给一套宽松区间（用户自定义模型）。 */
export function capabilityOf(model) {
  const trimmed = String(model ?? '').trim()
  const known = MODEL_CAPABILITIES[trimmed]
  if (known) return known
  return protocolOf(trimmed) === 'v2'
    ? {
      protocol: 'v2', resolutions: ['768P', '2K'], durationMin: 4, durationMax: 15,
      supportsLastFrame: true, supportsReference: true, note: 'v2（自定义模型）',
    }
    : {
      protocol: 'v1', resolutions: ['1080P', '768P'], durationMin: 6, durationMax: 10,
      supportsLastFrame: false, supportsReference: false, note: 'v1（自定义模型）',
    }
}

/** 把 baseUrl 收敛成主机根：历史配置里可能存了 `.../v1`，路径一律由本模块拼。 */
export const rootOf = (baseUrl) =>
  String(baseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/(v1|v2)$/i, '')

/** 按模型能力把时长收敛到合法值。 */
export function normalizeDuration(model, value) {
  const cap = capabilityOf(model)
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  const wanted = Number.isFinite(n) ? Math.round(n) : cap.durationMin
  if (Array.isArray(cap.durations) && cap.durations.length > 0) {
    // 定值档位取最接近的一档；距离相同时取更长的那档 —— 片段越长，
    // 「走完一步」越容易完整落进画面，而这正是要抽的东西。
    let best = cap.durations[0]
    for (const c of cap.durations) {
      const gap = Math.abs(c - wanted)
      const bestGap = Math.abs(best - wanted)
      if (gap < bestGap || (gap === bestGap && c > best)) best = c
    }
    return best
  }
  return Math.min(cap.durationMax, Math.max(cap.durationMin, wanted))
}

/** 按模型能力把分辨率收敛到合法档位。 */
export function normalizeResolution(model, value) {
  const cap = capabilityOf(model)
  const wanted = String(value ?? '').trim()
  if (cap.resolutions.includes(wanted)) return wanted
  if (cap.protocol === 'v2' && wanted === '480P' && cap.resolutions.includes('768P')) return '768P'
  return cap.resolutions[0]
}

/** 估算一次生成要花多少钱（人民币，按官方刊例价），用于提交前提示。 */
export function estimateCostCny({ model, duration, resolution }) {
  const cap = capabilityOf(model)
  const res = normalizeResolution(model, resolution)
  const secs = normalizeDuration(model, duration)
  if (cap.pricePerSecondCny && cap.pricePerSecondCny[res] !== undefined) {
    return Number((cap.pricePerSecondCny[res] * secs).toFixed(2))
  }
  if (cap.pricePerVideoCny && cap.pricePerVideoCny[res] !== undefined) {
    return cap.pricePerVideoCny[res]
  }
  return null
}

/* ─────────────────────────────── HTTP ──────────────────────────────────── */

const headers = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
})

function assertKey(apiKey) {
  if (String(apiKey ?? '').trim() === '') {
    throw new MiniMaxError('尚未配置 MiniMax Key（设置 → TapTap Maker 开发 → 视频生成）')
  }
}

/**
 * 把远端的两种错误风格读成一条人话。
 *  - v2：`{ type:"error", error:{ type, message, http_code } }`（并带 HTTP 402 等真实状态码）
 *  - v1：HTTP 200 但 `base_resp.status_code !== 0`
 */
async function readError(response) {
  const text = await response.text().catch(() => '')
  if (text.trim() === '') return { message: `HTTP ${response.status} ${response.statusText}` }
  try {
    const parsed = JSON.parse(text)
    const base = parsed?.base_resp
    if (base && base.status_code !== undefined && base.status_code !== 0) {
      return { message: `[${base.status_code}] ${base.status_msg}`, code: String(base.status_code) }
    }
    const err = parsed?.error ?? parsed
    const message = typeof err?.message === 'string'
      ? err.message
      : typeof parsed?.message === 'string'
        ? parsed.message
        : text.slice(0, 500)
    const code = typeof err?.code === 'string' ? err.code : typeof err?.type === 'string' ? err.type : undefined
    return { message, code }
  } catch {
    return { message: text.slice(0, 500) }
  }
}

/** 余额 / 额度类错误 → 给出可执行的下一步（而不是让用户对着 1008 干猜）。 */
function hintFor(status, message) {
  const text = String(message)
  if (status === 402 || /insufficient_balance|insufficient balance|1008/i.test(text)) {
    return '额度不足：视频模型不占文本额度。M Plan Go 档不含视频模型，请升级到 Explore/Build 档、补积分包，'
      + '或换普通按量计费 API Key（视频按秒计费，H3 768P 约 ¥0.5/秒）。'
  }
  if (status === 401 || /1004|2049|invalid api key|authorized_error/i.test(text)) {
    return '鉴权失败：核对 Key 与站点是否匹配（国内站 api.minimaxi.com ↔ 国内 Key，'
      + '国际站 api.minimax.io ↔ 国际 Key）。订阅与按量 Key 都可能长得像 JWT，'
      + '光看字符串分不出来 —— 确认 Key 是在对应站点的控制台里复制的即可。'
  }
  if (status === 429 || /1002|rate limit/i.test(text)) {
    return '触发限流，等约 1 分钟再试（M Plan 档位的 RPM 限制比按量付费更紧）。'
  }
  if (status === 422 || /1026|sensitive/i.test(text)) {
    return '提示词或输入图被判为敏感内容，改描述后重试。'
  }
  return undefined
}

async function requestJson(url, init, timeoutMs, what) {
  const timeout = AbortSignal.timeout(Math.max(10_000, Number(timeoutMs) || 120_000))
  let response
  try {
    response = await fetch(url, { ...init, signal: timeout })
  } catch (error) {
    if (timeout.aborted) {
      throw new MiniMaxError(`${what}超时（${Math.round(timeoutMs / 1000)} 秒）`, undefined, 'timeout')
    }
    throw new MiniMaxError(`无法连接 MiniMax：${error?.message ?? error}`, undefined, 'network')
  }
  if (!response.ok) {
    const { message, code } = await readError(response)
    throw new MiniMaxError(`${what}失败（HTTP ${response.status}）：${message}`, response.status, code, hintFor(response.status, message))
  }
  const payload = await response.json().catch(() => undefined)
  const base = payload?.base_resp
  if (base && base.status_code !== 0) {
    const message = `[${base.status_code}] ${base.status_msg}`
    throw new MiniMaxError(`${what}失败：${message}`, response.status, String(base.status_code), hintFor(response.status, message))
  }
  return payload
}

/* ─────────────────────────────── 请求体 ────────────────────────────────── */

/** 判断这次请求是首尾帧 / 参考 / 纯文本哪种场景（首尾帧与参考模式互斥）。 */
export function mediaModeOf({ firstFrameImage, lastFrameImage, referenceImages, referenceVideos }) {
  const hasFrame = Boolean(firstFrameImage) || Boolean(lastFrameImage)
  const hasRef = (referenceImages?.length ?? 0) > 0 || (referenceVideos?.length ?? 0) > 0
  if (hasFrame && hasRef) throw new MiniMaxError('首帧/尾帧模式与多模态参考模式不能混用：请二选一')
  if (hasFrame) return 'frames'
  if (hasRef) return 'reference'
  return 'text'
}

/** v2：多模态 content 数组。 */
export function buildV2Body(input) {
  const mode = mediaModeOf(input)
  const content = [{ type: 'text', text: input.prompt }]
  if (mode === 'frames') {
    if (input.firstFrameImage) content.push({ type: 'image_url', image_url: { url: input.firstFrameImage }, role: 'first_frame' })
    if (input.lastFrameImage) content.push({ type: 'image_url', image_url: { url: input.lastFrameImage }, role: 'last_frame' })
  } else if (mode === 'reference') {
    for (const url of input.referenceImages ?? []) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of input.referenceVideos ?? []) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
  }
  const body = {
    model: input.model,
    content,
    resolution: normalizeResolution(input.model, input.resolution),
    duration: normalizeDuration(input.model, input.duration),
    // 首尾帧模式的宽高比由首帧图决定，官方规定恒为 adaptive；
    // 参考模式可选；纯文生视频必须给具体比例。
    ratio: input.ratio ?? (mode === 'text' ? '16:9' : 'adaptive'),
  }
  // extra 只有 H3-Max 认；别的模型传了会被判为未声明字段。
  if (/H3-Max/i.test(input.model) && input.promptOptimizer !== undefined) {
    body.extra = { prompt_expansion_mode: input.promptOptimizer ? 'balanced' : 'disabled' }
  }
  return body
}

/** v1：扁平参数。首尾帧**只有 Hailuo-02 认**，其余模型带尾帧会被判参数错误。 */
export function buildV1Body(input) {
  const mode = mediaModeOf(input)
  const cap = capabilityOf(input.model)
  if (mode === 'reference') {
    throw new MiniMaxError('参考图 / 参考视频模式需要 MiniMax-H3 系列（v2 协议），当前模型不支持')
  }
  if (mode === 'text') throw new MiniMaxError('v1 协议只支持图生视频，请提供一张首帧图')
  if (input.lastFrameImage && !cap.supportsLastFrame) {
    throw new MiniMaxError(
      `${input.model} 不支持尾帧：首尾帧模式请改用 ${modelsSupportingLastFrame().join(' / ')}，`
      + '或去掉尾帧按「只给首帧」生成',
    )
  }
  const body = {
    model: input.model,
    prompt: input.prompt,
    first_frame_image: input.firstFrameImage,
  }
  if (input.lastFrameImage) body.last_frame_image = input.lastFrameImage
  // duration / resolution 是 Hailuo 系列的参数；I2V-01 这类老模型传了会报错。
  if (/hailuo/i.test(input.model)) {
    if (input.duration !== undefined) body.duration = normalizeDuration(input.model, input.duration)
    if (input.resolution !== undefined) body.resolution = normalizeResolution(input.model, input.resolution)
  }
  if (input.promptOptimizer !== undefined) body.prompt_optimizer = input.promptOptimizer
  return body
}

/* ─────────────────────────────── 四个动作 ──────────────────────────────── */

/** 提交一个视频任务，返回 task_id。 */
export async function submitVideo(input) {
  assertKey(input.apiKey)
  if (String(input.prompt ?? '').trim() === '') throw new MiniMaxError('提示词不能为空')
  const root = rootOf(input.baseUrl)
  const isV2 = protocolOf(input.model) === 'v2'
  const url = isV2 ? `${root}/v2/video_generation` : `${root}/v1/video_generation`
  const body = isV2 ? buildV2Body(input) : buildV1Body(input)
  // 幂等键：**同一次提交的所有重试必须复用同一个值**。视频按秒计费，
  // 如果「请求其实成功了、只是响应丢了」之后又重投一次，没有幂等键就会
  // 生成两段视频、扣两次钱。有键则服务端会去重。
  const idem = input.idempotencyKey || randomUUID()
  const payload = await requestJson(
    url,
    {
      method: 'POST',
      headers: { ...headers(input.apiKey), 'Idempotency-Key': idem },
      body: JSON.stringify(body),
    },
    input.timeoutMs,
    '提交视频任务',
  )
  const taskId = payload?.task_id ?? payload?.task?.id
  if (typeof taskId !== 'string' || taskId === '') {
    throw new MiniMaxError(`MiniMax 未返回 task_id：${JSON.stringify(payload).slice(0, 400)}`, undefined, 'no_task_id')
  }
  return taskId
}

const mapV2Status = (raw) => {
  switch (raw) {
    case 'succeeded': return 'succeeded'
    case 'failed':
    case 'cancelled': return 'failed'
    case 'running': return 'running'
    case 'queued': return 'pending'
    default: return 'pending'
  }
}

const mapV1Status = (raw) => {
  switch (raw) {
    case 'Success': return 'succeeded'
    case 'Fail': return 'failed'
    case 'Processing':
    case 'Preparing':
    case 'Queueing': return 'running'
    default: return 'pending'
  }
}

/** 查询一个任务。v2 直接给地址；v1 只给 file_id，需要再换一次下载地址。 */
export async function queryVideo(input) {
  assertKey(input.apiKey)
  const root = rootOf(input.baseUrl)
  if (protocolOf(input.model) === 'v2') {
    const payload = await requestJson(
      `${root}/v2/query/video_generation/${encodeURIComponent(input.taskId)}`,
      { method: 'GET', headers: headers(input.apiKey) },
      input.timeoutMs,
      '查询视频任务',
    )
    const task = payload?.task ?? payload
    const remoteStatus = String(task?.status ?? '')
    const videoUrl = typeof task?.content?.url === 'string' && task.content.url !== '' ? task.content.url : undefined
    const errorMessage = task?.error !== undefined
      ? [task.error.code, task.error.message].filter((v) => typeof v === 'string' && v !== '').join('：')
      : undefined
    return { status: mapV2Status(remoteStatus), remoteStatus, videoUrl, error: errorMessage, raw: payload }
  }
  const payload = await requestJson(
    `${root}/v1/query/video_generation?task_id=${encodeURIComponent(input.taskId)}`,
    { method: 'GET', headers: headers(input.apiKey) },
    input.timeoutMs,
    '查询视频任务',
  )
  const remoteStatus = String(payload?.status ?? '')
  const fileId = typeof payload?.file_id === 'string' && payload.file_id !== '' ? payload.file_id : undefined
  return { status: mapV1Status(remoteStatus), remoteStatus, fileId, raw: payload }
}

/** v1 专用：用 file_id 换下载地址。v2 的 content.url 不需要这一步。 */
export async function retrieveFile(input) {
  assertKey(input.apiKey)
  const payload = await requestJson(
    `${rootOf(input.baseUrl)}/v1/files/retrieve?file_id=${encodeURIComponent(input.fileId)}`,
    { method: 'GET', headers: headers(input.apiKey) },
    input.timeoutMs,
    '获取视频下载地址',
  )
  const url = payload?.file?.download_url
  if (typeof url !== 'string' || url === '') {
    throw new MiniMaxError(`MiniMax 未返回下载地址：${JSON.stringify(payload).slice(0, 400)}`)
  }
  return url
}

/** 下载成品视频到内存。 */
export async function downloadVideo(url, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(60_000, Number(timeoutMs) || 300_000))
  const response = await fetch(url, { signal: timeout })
  if (!response.ok) throw new MiniMaxError(`下载视频失败（HTTP ${response.status}）`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new MiniMaxError('下载到的视频是空文件')
  return buffer
}

/* ─────────────────────────── 能力自检（免费） ──────────────────────────── */

/**
 * 一次免费的自检：分辨「哪个站点 / Key 对不对 / 视频额度有没有」。
 *
 * 两件事都不花钱：
 *   1. 查一个不存在的 task_id → 403/401 说明 Key 或站点不对，500 «record not found»
 *      说明鉴权已经过了；
 *   2. 打 `token_plan/remains` → 能读出 M Plan 套餐状态（有没有订阅、哪个档位）。
 *
 * 返回结构化结论，设置页直接显示，聊天里也能一句话说清。
 */
export async function testMiniMax(input) {
  assertKey(input.apiKey)
  const root = rootOf(input.baseUrl)
  const kind = detectKeyKind(input.apiKey)
  const result = {
    ok: false,
    baseUrl: root,
    model: input.model ?? DEFAULT_MODEL,
    keyKind: kind,
    keyKindText: describeKey(input.apiKey),
    auth: 'unknown',
    plan: 'unknown',
    planMessage: '',
    planQuota: undefined, // 「本周剩 85% · 本周期剩 95%」这类给人看的数字
    videoQuota: 'unknown',
    notes: [],
  }

  // 1) 鉴权：查一个必然不存在的任务。
  try {
    await queryVideo({ ...input, taskId: '00000000000000000000000000000000' })
    result.auth = 'ok'
  } catch (error) {
    const status = error instanceof MiniMaxError ? error.status : undefined
    const message = error?.message ?? String(error)
    if (status === 401 || /1004|2049|invalid api key|authorized_error/i.test(message)) {
      result.auth = 'failed'
      result.notes.push(`Key 不被 ${root} 接受：${message}`)
      result.hint = hintFor(401, message)
      return result
    }
    // «task_id 不存在» 类响应说明鉴权已经通过，只是这个任务不存在。
    // 实测 MiniMax 对全 0 的 task_id 回的是 HTTP 400 + code 2013
    // （`This task_id does not exist`），原来只认 500 / `record not found`，
    // 于是每次自检都报「鉴权未给出明确结论」——明明 Key 是好的。
    if (/record not found|1000|2013|task_id does not exist|does not exist/i.test(message)
      || status === 500 || status === 400) {
      result.auth = 'ok'
    } else {
      result.notes.push(`鉴权查询未给出明确结论：${message}`)
    }
  }

  // 2) M Plan 套餐状态（免费，且是**唯一权威**的判据）。
  //    这里不再按 detectKeyKind 的结果跳过 —— 那个判断只认 sk-cp- 前缀，
  //    而控制台签发的 JWT 订阅 Key（TokenType=4）会被误判成按量而被跳过，
  //    于是明明有订阅额度却报「不走 M Plan」。查询本身免费，
  //    2062 之类的「没有订阅」也正是我们要区分的正常结果。
  if (/minimaxi?\.com|minimaxi?\.cn/i.test(root)) {
    try {
      const response = await fetch('https://www.minimax.cn/v1/token_plan/remains', {
        headers: { Authorization: `Bearer ${input.apiKey}` },
        signal: AbortSignal.timeout(20_000),
      })
      const payload = await response.json().catch(() => undefined)
      const code = payload?.base_resp?.status_code
      const msg = String(payload?.base_resp?.status_msg ?? '')
      if (code === 0) {
        result.plan = 'active'
        result.planMessage = 'M Plan 套餐在用'
        const remains = Array.isArray(payload?.model_remains) ? payload.model_remains : []
        const video = remains.find((m) => /video|h3|hailuo/i.test(String(m?.model_name ?? '')))
        // `general` 是套餐额度条目，不是模型名 —— 实测控制台签发的订阅 Key
        // 只返回一个 general 条目。之前按「有没有叫 video/h3 的条目」判断，
        // 会把这种正常订阅报成「未见视频模型」，属于把好消息说成坏消息。
        const general = remains.find((m) => /general/i.test(String(m?.model_name ?? '')))
        const quotaOf = (m) => {
          const wk = Number(m?.current_weekly_remaining_percent)
          const iv = Number(m?.current_interval_remaining_percent)
          if (Number.isFinite(wk) && Number.isFinite(iv)) return `本周剩 ${wk}% · 本周期剩 ${iv}%`
          if (Number.isFinite(wk)) return `本周剩 ${wk}%`
          return undefined
        }
        result.planQuota = general ? quotaOf(general) : undefined
        // 只有在**确实存在条目但都不含视频模型**时才叫 not_listed；
        // general 额度是通用的，不要据此断言「没有视频额度」。
        result.videoQuota = video ? 'listed' : (general ? 'general' : 'not_listed')
        result.notes.push(
          `M Plan 额度条目 ${remains.length} 个`
          + (video ? '，含视频模型条目' : '')
          + (general ? `（通用额度${result.planQuota ? '：' + result.planQuota : ''}）` : '')
          + (video || general ? '' : '，未见视频模型')
        )
      } else if (code === 2062) {
        result.plan = 'none'
        result.planMessage = '这个 Key 上没有有效的 M Plan 订阅'
      } else if (code === 2049) {
        result.plan = 'wrong_region'
        result.planMessage = 'Key 与站点不匹配（国内 Key 要用 api.minimaxi.com）'
      } else {
        result.planMessage = `${code ?? '?'} ${msg}`.trim()
      }
    } catch (error) {
      result.notes.push(`M Plan 状态查询失败：${error?.message ?? error}`)
    }
  } else {
    result.planMessage = '国际站不提供该套餐查询接口，跳过'
  }

  result.ok = result.auth === 'ok'
  if (result.ok && result.plan === 'none') {
    result.videoQuota = 'none'
    result.hint = '鉴权通过，但 Key 上没有 M Plan 额度 —— M Plan Go 档不含视频模型。'
      + '升级到 Explore/Build 档、补积分包，或换普通按量计费 API Key 后才能出片。'
  } else if (result.ok && result.plan === 'active') {
    // 远端说有订阅 → 以远端为准，把 keyKind 纠正过来。JWT 订阅 Key 的
    // 前缀判断本来只是猜测，这里用权威结果覆盖，界面才不会继续说「按量」。
    result.keyKind = 'subscription'
    result.keyKindText = 'M Plan 订阅 Key：套餐额度在用（按远端查询确认）。'
  }
  return result
}

/** 把一张本地图读成 data URI（提交首 / 尾帧用；平台同时接受公网 URL）。 */
export function fileToDataUri(file) {
  const bytes = readFileSync(file)
  const lower = file.toLowerCase()
  const mime = lower.endsWith('.png') ? 'image/png'
    : lower.endsWith('.webp') ? 'image/webp'
      : 'image/jpeg'
  return `data:${mime};base64,${bytes.toString('base64')}`
}
