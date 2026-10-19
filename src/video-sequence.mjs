/**
 * 视频序列帧作业编排（模型无关）。
 *
 * 整条链路：
 *
 *   ① 首帧 / 尾帧（用户上传，或复用已生成的帧 / 八方向图）
 *   → ② 提交视频任务（首尾帧模式最有约束：动作的起点与终点都是你定的）
 *   → ③ 抽帧（精确时间点，可选 uniform / first-last / loop 三种排法）
 *   → ④ 抠像（四边洪水填充，绿/蓝/品红幕都行）
 *   → ⑤ 对齐合成（所有帧共用同一个 alpha 包围盒与基线）
 *   → ⑥ 导入 Maker 工程（只写最后那一张整图 + 同名 .meta + manifest）
 *
 * 与「游戏素材大师」插件的序列帧模块相比，多出来的都是**验收前能救一次**
 * 的东西：
 *   - 只给首帧也能跑（尾帧是可选的）；
 *   - 抽帧排法可选，默认避开第 0 帧（那通常是还没动的静帧）；
 *   - 抠像有逐帧自检报告，一眼看出这批视频能不能抠；
 *   - 合成时多帧共用包围盒，脚底落在同一基线，不会上下飘；
 *   - 帧数多时自动折成 grid，不撞纹理上限；
 *   - 一键导入 Maker（补 .meta、写序列帧 manifest、给 Lua 用法片段）。
 *
 * 这个模块**不依赖**游戏素材大师插件：那个插件是 optional 的，用户可能没装。
 *
 * @module src/video-sequence.mjs
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  clearMinimaxPending, readVideoJob, writeVideoJob, dataDir,
} from './paths.js'
import {
  MiniMaxError, capabilityOf, detectKeyKind, downloadVideo, estimateCostCny,
  modelsSupportingLastFrame, normalizeDuration, normalizeResolution,
  protocolOf, queryVideo, retrieveFile, submitVideo,
} from './minimax-video.mjs'
import { relayDownload, relayQuery, relaySubmit, relayReady, normalizeRatio } from './video-relay.mjs'
import {
  MediaError, checkFfmpeg, encodePng, extractFramesAt, mimeOf,
  planSampleTimes, probeDuration, probeFps, probeSize, runFfmpeg, toJpegDataUri,
} from './video-media.mjs'
import { composeSheet, DEFAULT_KEY_OPTIONS, keyFrame } from './video-chroma.mjs'

/* ─────────────────────────────── 作业模型 ──────────────────────────────── */

const JOB_ID = /^v[a-z0-9]{4,40}$/

export const DEFAULT_SETTINGS = {
  // 后端：'auto' 按可用性自动挑（订阅/按量 Key → 中转站），也可显式指定。
  backend: 'auto',      // auto | minimax | relay | local
  model: 'MiniMax-H3',
  resolution: '768P',
  duration: 4,
  promptOptimizer: true,
  // 抽帧
  frameCount: 12,
  // 中转站专用的画幅设置（默认 16:9，自动纠正全角冒号 / 像素分辨率）。
  // 不再内置 mode/能力表 —— 那些由各家协议自己定义。
  relayRatio: '16:9',    // 16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 21:9 | auto
  arrange: 'uniform',   // uniform | first-last | loop
  longEdge: 768,        // 抽帧后长边；抠像在 JS 里跑，768 已经足够给 256 的格子
  cropInset: 0,
  // 抠像
  chroma: 'auto',       // auto | green | blue | magenta
  keyLow: DEFAULT_KEY_OPTIONS.keyLow,
  keyHigh: DEFAULT_KEY_OPTIONS.keyHigh,
  despill: DEFAULT_KEY_OPTIONS.despill,
  bgTolerance: DEFAULT_KEY_OPTIONS.bgTolerance,
  edgeShrink: DEFAULT_KEY_OPTIONS.edgeShrink,
  // 合成
  cellWidth: 256,
  cellHeight: 256,
  fillRatio: 0.94,
  bottomMargin: 2,
  pixelSize: 0,
  layout: 'auto',       // auto | row | grid
  columns: 0,           // 0 = 自动
}

export function newJobId() {
  return `v${Date.now().toString(36)}${randomUUID().slice(0, 6)}`
}

function ensureJobDirs(home, id) {
  const root = path.join(dataDir(home), 'video-jobs', id)
  for (const sub of ['refs', 'videos', 'frames', 'keyed', 'out']) {
    mkdirSync(path.join(root, sub), { recursive: true })
  }
  return root
}

export function createJob(home, name) {
  const id = newJobId()
  ensureJobDirs(home, id)
  const now = Date.now()
  const job = {
    id,
    name: String(name ?? '').trim().slice(0, 80) || '未命名视频作业',
    createdAt: now,
    updatedAt: now,
    mode: 'frames',       // frames（首尾帧）| reference（多模态参考，H3 支持）
    prompt: '',
    suffix: '',
    refs: { firstFrame: null, lastFrame: null },
    settings: { ...DEFAULT_SETTINGS },
    video: { status: 'empty' },
    frames: { status: 'empty', count: 0, files: [], keyed: [], report: [] },
    sheet: { status: 'empty' },
    import: undefined,
    log: [],
  }
  return writeVideoJob(home, job)
}

export function getJob(home, id) {
  if (!JOB_ID.test(String(id ?? ''))) return undefined
  return readVideoJob(home, id)
}

export function saveJob(home, id, patch = {}) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  if (typeof patch.name === 'string' && patch.name.trim()) job.name = patch.name.trim().slice(0, 80)
  if (typeof patch.prompt === 'string') job.prompt = patch.prompt
  if (typeof patch.suffix === 'string') job.suffix = patch.suffix
  if (patch.mode === 'frames' || patch.mode === 'reference') job.mode = patch.mode
  if (patch.settings && typeof patch.settings === 'object') {
    job.settings = normalizeSettings({ ...job.settings, ...patch.settings }, job.settings.model)
  }
  // 提示词 / 首尾帧 / 视频设置变了 → 已有的视频与帧都过期，但**不删**，
  // 只是打上 stale，让人能对比「改之前的效果」。
  if (typeof patch.prompt === 'string' || patch.settings !== undefined) {
    if (job.frames.status === 'ready') job.frames.stale = true
  }
  job.updatedAt = Date.now()
  return writeVideoJob(home, job)
}

function normalizeSettings(raw, fallbackModel) {
  const s = { ...DEFAULT_SETTINGS }
  const num = (v, d) => {
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : d
  }
  const clamp = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Math.round(num(v, d))))
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : (fallbackModel ?? s.model)
  s.backend = ['auto', 'minimax', 'relay', 'local'].includes(raw.backend) ? raw.backend : 'auto'
  s.model = model
  s.resolution = normalizeResolution(model, raw.resolution ?? s.resolution)
  s.duration = normalizeDuration(model, raw.duration ?? s.duration)
  s.promptOptimizer = raw.promptOptimizer !== false
  s.frameCount = clamp(raw.frameCount, s.frameCount, 1, 64)
  s.arrange = ['uniform', 'first-last', 'loop'].includes(raw.arrange) ? raw.arrange : s.arrange
  s.relayRatio = normalizeRatio(raw.relayRatio ?? s.relayRatio)
  s.longEdge = clamp(raw.longEdge, s.longEdge, 128, 2048)
  s.cropInset = Math.min(0.2, Math.max(0, num(raw.cropInset, 0)))
  s.chroma = ['auto', 'green', 'blue', 'magenta'].includes(raw.chroma) ? raw.chroma : 'auto'
  s.keyLow = clamp(raw.keyLow, s.keyLow, 0, 255)
  s.keyHigh = clamp(raw.keyHigh, s.keyHigh, 1, 255)
  s.despill = Math.min(1, Math.max(0, num(raw.despill, s.despill)))
  s.bgTolerance = clamp(raw.bgTolerance, s.bgTolerance, 0, 160)
  s.edgeShrink = clamp(raw.edgeShrink, s.edgeShrink, 0, 8)
  s.cellWidth = clamp(raw.cellWidth, s.cellWidth, 16, 2048)
  s.cellHeight = clamp(raw.cellHeight, s.cellHeight, 16, 2048)
  s.fillRatio = Math.min(1, Math.max(0.1, num(raw.fillRatio, s.fillRatio)))
  s.bottomMargin = clamp(raw.bottomMargin, s.bottomMargin, 0, 64)
  s.pixelSize = clamp(raw.pixelSize, s.pixelSize, 0, 32)
  s.layout = ['auto', 'row', 'grid'].includes(raw.layout) ? raw.layout : 'auto'
  s.columns = clamp(raw.columns, 0, 0, 64)
  return s
}

function log(job, level, message) {
  job.log = Array.isArray(job.log) ? job.log : []
  job.log.push({ at: Date.now(), level, message: String(message).slice(0, 2000) })
  if (job.log.length > 200) job.log = job.log.slice(-200)
}

function jobRoot(home, id) {
  return path.join(dataDir(home), 'video-jobs', id)
}

function rel(id, sub, file) {
  return `${sub}/${file}`
}

export function absPath(home, id, relative) {
  const root = jobRoot(home, id)
  const target = path.resolve(root, relative)
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error(`非法的作业内路径：${relative}`)
  return target
}

/* ─────────────────────────────── 参考图 ────────────────────────────────── */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

/** 判断文件头是不是一张图（不看扩展名：聊天工具/手机经常改名）。 */
function sniffImageFile(file) {
  const head = readFileSync(file).subarray(0, 16)
  if (head.length >= 8 && head.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (head.length >= 2 && head.toString('ascii', 0, 2) === 'BM') return 'bmp'
  if (head.length >= 6 && head.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return undefined
}

/**
 * 把一张本地图收进作业的 refs/（首帧或尾帧）。
 *
 * 顺手做一道平台限制的预检：宽高 [256, 5760]、长宽比 [0.4, 2.5]。
 * 在提交**之前**说清楚比在拿到 2013 之后猜强得多。
 */
export async function setReference(home, id, kind, sourcePath) {
  if (kind !== 'firstFrame' && kind !== 'lastFrame') throw new Error(`未知的参考类型：${kind}`)
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  const source = path.resolve(String(sourcePath ?? ''))
  if (!existsSync(source)) throw new Error(`读不到文件：${source}`)
  const ext = sniffImageFile(source)
  if (!ext) throw new Error(`无法识别的图片格式（支持 PNG / JPEG / WebP / BMP / GIF）：${source}`)
  const { width, height } = await probeSize(source)
  const ratio = width / height
  const warnings = []
  if (width < 256 || height < 256) warnings.push(`最短边 ${Math.min(width, height)}px < 256，平台会拒收`)
  if (width > 5760 || height > 5760) warnings.push(`最长边 ${Math.max(width, height)}px > 5760，平台会拒收`)
  if (ratio < 0.4 || ratio > 2.5) warnings.push(`长宽比 ${ratio.toFixed(2)} 超出 [0.4, 2.5]（提交时会自动补边）`)
  const target = `refs/${kind}-${Date.now()}.${ext}`
  const dest = absPath(home, id, target)
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(source))
  job.refs = { ...job.refs, [kind]: { file: target, name: path.basename(source), width, height, warnings } }
  if (job.mode === 'frames' && kind === 'lastFrame') {
    const cap = capabilityOf(job.settings.model)
    if (!cap.supportsLastFrame) {
      warnings.push(`当前模型 ${job.settings.model} 不支持尾帧；首尾帧请改用 ${modelsSupportingLastFrame().join(' / ')}`)
    }
  }
  log(job, 'info', `已设置${kind === 'firstFrame' ? '首帧' : '尾帧'}：${path.basename(source)}（${width}×${height}）`)
  job.updatedAt = Date.now()
  return writeVideoJob(home, job)
}

export function clearReference(home, id, kind) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  job.refs = { ...job.refs, [kind]: null }
  job.updatedAt = Date.now()
  return writeVideoJob(home, job)
}

/* ─────────────────────────────── 提交视频 ──────────────────────────────── */

/**
 * 提交视频任务。返回 { taskId, submitId, estimate }。
 *
 * `submitId` 是本地记账键：同一个作业里**一次提交只扣一次钱**，而轮询可能
 * 在本进程重启后继续（pending 记录里带着它）。没有这个键的话，重启一次就会
 * 把同一个 taskId 当新任务再轮询一遍 —— 那不会重复扣费，但会让人以为
 * 「又提交了一次」，也不知道哪次是活的。
 */
export async function submitJobVideo(home, id, config) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  if (job.video?.status === 'running') {
    throw new Error(`视频任务已在跑（${job.video.taskId ?? '提交中'}），等它跑完再提交，避免重复扣费`)
  }
  const prompt = `${job.prompt.trim()}${job.suffix.trim() ? `\n${job.suffix.trim()}` : ''}`
  if (prompt.trim() === '') throw new Error('提示词为空：先写一句「角色在做什么」')
  if (job.mode === 'frames' && !job.refs.firstFrame) {
    throw new Error('首尾帧模式至少要一张首帧图（可用 /taptap-video first <图片路径> 指定）')
  }
  const backend = resolveBackend(job, config)
  if (backend === 'local') {
    throw new Error('当前是「自选视频」后端：没有可提交的远程任务。直接用 /taptap-video use <mp4 路径> 挂上本地视频')
  }
  // 模型能力只在官方 MiniMax 后端下有意义：中转站的模型名由中转站自己定义。
  if (backend === 'minimax') {
    const cap = capabilityOf(job.settings.model)
    if (job.refs.lastFrame && !cap.supportsLastFrame) {
      throw new Error(`${job.settings.model} 不支持尾帧，请换 ${modelsSupportingLastFrame().join(' / ')} 或清掉尾帧`)
    }
  }
  // 不在中转站提交前做型号校验：每家中转站可以有自己的能力表，
  // 写死一家反而误导其他家。超时 / 超画幅 / 不支持尾帧 → 平台 400 时如实回显。

  const effectiveModel = backend === 'relay' ? (config.relay?.model || job.settings.model) : job.settings.model
  const submitId = `s${Date.now().toString(36)}`
  job.video = {
    status: 'running', submitId, remoteStatus: '提交中', taskId: undefined,
    backend, model: effectiveModel, updatedAt: Date.now(),
  }
  log(job, 'info', `提交视频（${backend === 'relay' ? '中转站' : 'MiniMax'} · ${effectiveModel} · ${job.settings.resolution} · ${job.settings.duration}s）`)
  writeVideoJob(home, job)

  let firstFrameImage
  let lastFrameImage
  try {
    if (job.refs.firstFrame) {
      const tmp = absPath(home, id, `refs/.first-${Date.now()}.jpg`)
      const made = await toJpegDataUri(absPath(home, id, job.refs.firstFrame.file), tmp)
      firstFrameImage = made.dataUri
      rmSync(tmp, { force: true })
    }
    if (job.refs.lastFrame) {
      const tmp = absPath(home, id, `refs/.last-${Date.now()}.jpg`)
      const made = await toJpegDataUri(absPath(home, id, job.refs.lastFrame.file), tmp)
      lastFrameImage = made.dataUri
      rmSync(tmp, { force: true })
    }
  } catch (error) {
    job.video = { status: 'error', remoteStatus: '首帧编码失败', error: error?.message ?? String(error), updatedAt: Date.now() }
    log(job, 'error', `首帧编码失败：${error?.message ?? error}`)
    writeVideoJob(home, job)
    throw error
  }

  try {
    let taskId
    let relayTaskId
    if (backend === 'relay') {
      const submitted = await relaySubmit(config.relay, {
        prompt,
        firstFrameImage,
        lastFrameImage,
        seconds: job.settings.duration,
        size: relaySizeFor(job.settings),
        // 中转站协议要求素材是公网 url：把本地文件路径一并给它，
        // 由 relay 自己上传换 url（不缓存，各家过期时间不同）。
        assetFiles: {
          firstFrame: job.refs.firstFrame
            ? { path: absPath(home, id, job.refs.firstFrame.file), mime: mimeOf(job.refs.firstFrame.file) }
            : undefined,
          lastFrame: job.refs.lastFrame
            ? { path: absPath(home, id, job.refs.lastFrame.file), mime: mimeOf(job.refs.lastFrame.file) }
            : undefined,
        },
        ratio: job.settings.relayRatio,
      })
      // directUrl：少数中转站在提交响应里就把成品地址给了，跳过轮询。
      relayTaskId = submitted.taskId
      taskId = submitted.taskId
      if (submitted.directUrl) relayTaskId = submitted.taskId
    } else {
      taskId = await submitVideo({
        baseUrl: config.baseURL,
        apiKey: config.apiKey,
        model: job.settings.model,
        timeoutMs: 120_000,
        prompt,
        firstFrameImage,
        lastFrameImage,
        duration: job.settings.duration,
        resolution: job.settings.resolution,
        promptOptimizer: job.settings.promptOptimizer,
      })
    }
    const fresh = getJob(home, id)
    fresh.video = { ...fresh.video, status: 'running', taskId, remoteStatus: '已提交', updatedAt: Date.now() }
    log(fresh, 'info', `视频任务已提交：${taskId}`)
    return { taskId, submitId, backend, job: writeVideoJob(home, fresh) }
  } catch (error) {
    const fresh = getJob(home, id)
    fresh.video = {
      status: 'error', submitId, remoteStatus: '提交失败',
      error: error?.message ?? String(error), hint: error?.hint, updatedAt: Date.now(),
    }
    log(fresh, 'error', `视频提交失败：${error?.message ?? error}`)
    writeVideoJob(home, fresh)
    throw error
  }
}

/**
 * 决定这次走哪个后端。
 *
 * `auto` 的优先级：显式配好的中转站 > MiniMax（Key 或订阅）。中转站排在前面
 * 是因为**用户主动配了它**多半就是想用它（比如官方额度用完了）；而 MiniMax
 * 是「发现登录态就自动用」的兜底，不该抢用户的显式选择。
 */
export function resolveBackend(job, config) {
  const wanted = job?.settings?.backend ?? 'auto'
  if (wanted === 'relay') {
    if (!relayReady(config?.relay)) throw new Error('作业选择的是「中转站」后端，但中转站没配好（设置页 → 视频生成 → 中转站）')
    return 'relay'
  }
  if (wanted === 'minimax') {
    if (!config?.apiKey) throw new Error('作业选择的是「MiniMax」后端，但没有可用的 Key')
    return 'minimax'
  }
  if (wanted === 'local') return 'local'
  if (relayReady(config?.relay)) return 'relay'
  if (config?.apiKey) return 'minimax'
  return 'relay' // 都没配 → 交给 relaySubmit 报出「没配好」，比含糊的「没有 Key」有用
}

/** 中转站的 size 参数：官方后端用 768P/2K 档位，中转站普遍要 WxH。 */
function relaySizeFor(settings) {
  if (/^\d+x\d+$/.test(settings.resolution)) return settings.resolution
  if (settings.resolution === '2K') return '1920x1080'
  if (settings.resolution === '1080P') return '1920x1080'
  if (settings.resolution === '480P') return '854x480'
  return '1280x720'
}

/**
 * 查询一次任务状态；成功则把视频下载进 videos/ 并返回作业。
 *
 * 设计成「可用任意进程调用、幂等」：只要 job.video.status 还是 running，
 * 就能接着查；已经 ready 的直接返回，不发请求。
 *
 * 后端按**作业上记的那个值**分派，不按当前配置：用户完全可能在任务跑的
 * 中间改设置，那时按配置去查就会拿 MiniMax 的协议去查一个中转站的 taskId。
 */
export async function pollJobVideo(home, id, config) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  if (job.video?.status !== 'running') return job
  const taskId = job.video.taskId
  if (!taskId) return job // 还在提交阶段

  const backend = job.video.backend === 'relay' ? 'relay' : 'minimax'
  const model = job.video.model || job.settings.model
  let query
  try {
    query = backend === 'relay'
      ? await relayQuery(config.relay, taskId)
      : await queryVideo({ baseUrl: config.baseURL, apiKey: config.apiKey, model, taskId, timeoutMs: 60_000 })
  } catch (error) {
    // 单次查询失败 ≠ 任务失败，保留 running 让下一轮重试。
    const fresh = getJob(home, id)
    fresh.video = { ...fresh.video, remoteStatus: `查询异常：${error?.message ?? error}`, updatedAt: Date.now() }
    return writeVideoJob(home, fresh)
  }
  const fresh = getJob(home, id)
  if (query.status === 'failed') {
    fresh.video = { ...fresh.video, status: 'error', remoteStatus: query.remoteStatus || 'failed', error: query.error || '平台报告任务失败', updatedAt: Date.now() }
    log(fresh, 'error', `视频生成失败：${fresh.video.error}`)
    clearMinimaxPending(home)
    return writeVideoJob(home, fresh)
  }
  if (query.status !== 'succeeded') {
    fresh.video = { ...fresh.video, remoteStatus: query.remoteStatus || query.status, progress: query.progress, updatedAt: Date.now() }
    return writeVideoJob(home, fresh)
  }
  let bytes
  if (backend === 'relay') {
    bytes = await relayDownload(config.relay, taskId, query, 300_000)
  } else {
    // 成功：v2 直接有地址；v1 要先拿 file_id 换一次下载地址。
    const url = query.videoUrl
      ?? (query.fileId ? await retrieveFile({ baseUrl: config.baseURL, apiKey: config.apiKey, model, fileId: query.fileId, timeoutMs: 60_000 }) : undefined)
    if (!url) {
      fresh.video = { ...fresh.video, status: 'error', error: '任务已成功，但响应里没有视频地址', updatedAt: Date.now() }
      return writeVideoJob(home, fresh)
    }
    bytes = await downloadVideo(url, 300_000)
  }
  const target = 'videos/output.mp4'
  writeFileSync(absPath(home, id, target), bytes)
  fresh.video = {
    ...fresh.video, status: 'ready', file: target, remoteStatus: query.remoteStatus || 'succeeded',
    bytes: bytes.length, error: undefined, hint: undefined, progress: undefined, updatedAt: Date.now(),
  }
  fresh.frames = { status: 'empty', count: 0, files: [], keyed: [], report: [] }
  fresh.sheet = { status: 'empty' }
  log(fresh, 'info', `视频已下载（${(bytes.length / 1024 / 1024).toFixed(1)} MB，后端 ${backend}）`)
  clearMinimaxPending(home)
  return writeVideoJob(home, fresh)
}

/**
 * 挂一段**本地视频**：不花任何额度，直接把文件收进作业目录并标记就绪。
 *
 * 用途：MiniMax Code 用签到积分生成的、录屏、别人给的参考视频 —— 都能走
 * 后面的抽帧 / 抠像 / 合成 / 导入。这让整条链路在**零额度**下也能完整跑通。
 */
export async function useLocalVideo(home, id, sourcePath) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  const source = path.resolve(String(sourcePath ?? ''))
  if (!existsSync(source)) throw new Error(`读不到文件：${source}`)
  // 用 ffprobe 而不是扩展名判断「是不是视频」：从聊天工具下来的文件常被改名。
  let size
  try {
    size = await probeSize(source)
  } catch {
    throw new Error(`这不是一段能解码的视频：${source}`)
  }
  const ext = path.extname(source).toLowerCase() || '.mp4'
  const target = `videos/output${ext === '.mov' ? '.mov' : '.mp4'}`
  const dest = absPath(home, id, target)
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(source))
  const duration = await probeDuration(dest).catch(() => 0)
  job.video = {
    status: 'ready', backend: 'local', file: target, remoteStatus: '本地视频',
    model: 'local', width: size.width, height: size.height, duration, updatedAt: Date.now(),
  }
  job.frames = { status: 'empty', count: 0, files: [], keyed: [], report: [] }
  job.sheet = { status: 'empty' }
  job.import = undefined
  log(job, 'info', `挂上本地视频：${path.basename(source)}（${size.width}×${size.height}，${duration.toFixed(2)}s）`)
  return writeVideoJob(home, job)
}

/* ─────────────────────────────── 抽帧 ──────────────────────────────────── */

/** 按当前设置抽帧（不抠像）。返回 { files, times, duration, fps, width, height }。 */
export async function extractJobFrames(home, id, overrides = {}) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  if (job.video?.status !== 'ready' || !job.video.file) throw new Error('还没有可用视频，先提交并等它生成完')
  const settings = overrides.frameCount || overrides.arrange
    ? normalizeSettings({ ...job.settings, ...overrides }, job.settings.model)
    : job.settings
  const video = absPath(home, id, job.video.file)
  const duration = await probeDuration(video)
  const fps = await probeFps(video)
  const times = planSampleTimes({
    duration, fps, count: settings.frameCount, arrange: settings.arrange,
  })
  job.frames = { ...job.frames, status: 'running', error: undefined }
  job.updatedAt = Date.now()
  writeVideoJob(home, job)

  try {
    const { frames, width, height } = await extractFramesAt({
      video,
      times,
      longEdge: settings.longEdge,
      cropInset: settings.cropInset,
    })
    rmSync(path.join(jobRoot(home, id), 'frames'), { recursive: true, force: true })
    mkdirSync(path.join(jobRoot(home, id), 'frames'), { recursive: true })
    const files = []
    for (let i = 0; i < frames.length; i += 1) {
      const name = `f${String(i).padStart(2, '0')}.png`
      writeFileSync(absPath(home, id, `frames/${name}`), encodePng(frames[i], width, height))
      files.push(name)
    }
    const fresh = getJob(home, id)
    fresh.settings = { ...fresh.settings, ...settings }
    fresh.frames = {
      status: 'ready', count: files.length, files, keyed: [], report: [],
      width, height, duration, fps, times, arrange: settings.arrange, stale: false, updatedAt: Date.now(),
    }
    fresh.sheet = { status: 'empty' }
    fresh.import = undefined
    log(fresh, 'info', `抽帧完成：${files.length} 张 / ${width}×${height} / 时长 ${duration.toFixed(2)}s / ${settings.arrange}`)
    return writeVideoJob(home, fresh)
  } catch (error) {
    const fresh = getJob(home, id)
    fresh.frames = { ...fresh.frames, status: 'error', error: error?.message ?? String(error), updatedAt: Date.now() }
    log(fresh, 'error', `抽帧失败：${error?.message ?? error}`)
    writeVideoJob(home, fresh)
    throw error
  }
}

/* ─────────────────────────────── 抠像 ──────────────────────────────────── */

/** 用 ffmpeg 把一张 PNG 解回 RGBA（抠像是像素级计算，需要原始像素）。 */
async function decodePngToRgba(file, width, height) {
  const { stdout } = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', 'format=rgba', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], 120_000)
  const expected = width * height * 4
  if (stdout.length < expected) throw new MediaError(`解码 ${path.basename(file)} 失败（${stdout.length}/${expected} 字节）`)
  return Buffer.from(stdout.subarray(0, expected))
}

/**
 * 对已抽的帧跑一遍抠像。返回逐帧诊断报告。
 *
 * 报告里 `confident=false` 的帧是「这批视频可能抠不干净」的预警：背景占比
 * 太低（主体贴边/满屏）或太高（几乎空镜）。与其等合成后才发现透明区域
 * 一大片，不如在这一步停下来调参数或换视频。
 */
export async function keyJobFrames(home, id, overrides = {}) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  if (job.frames?.status !== 'ready' || job.frames.files.length === 0) throw new Error('还没有抽帧，先抽帧再抠')
  const settings = normalizeSettings({ ...job.settings, ...overrides }, job.settings.model)
  const { width, height } = job.frames
  const keyedDir = path.join(jobRoot(home, id), 'keyed')
  mkdirSync(keyedDir, { recursive: true })
  const keyed = []
  const report = []
  let totals = 0
  for (let i = 0; i < job.frames.files.length; i += 1) {
    const source = absPath(home, id, `frames/${job.frames.files[i]}`)
    const rgba = await decodePngToRgba(source, width, height)
    const result = keyFrame(rgba, width, height, {
      chroma: settings.chroma,
      keyLow: settings.keyLow,
      keyHigh: settings.keyHigh,
      despill: settings.despill,
      bgTolerance: settings.bgTolerance,
      edgeShrink: settings.edgeShrink,
    })
    const name = `k${String(i).padStart(2, '0')}.png`
    writeFileSync(path.join(keyedDir, name), encodePng(result.rgba, width, height))
    keyed.push(name)
    report.push({
      index: i,
      time: job.frames.times?.[i],
      backgroundFraction: Number(result.backgroundFraction.toFixed(4)),
      usedSegmentation: result.usedSegmentation,
      confident: result.confident,
      chroma: result.chroma,
      borderSamplesDropped: result.borderSamplesDropped,
    })
    if (result.confident) totals += 1
  }
  const fresh = getJob(home, id)
  fresh.settings = { ...fresh.settings, ...settings }
  fresh.frames = { ...fresh.frames, keyed, report, keyedAt: Date.now() }
  fresh.sheet = { status: 'empty' }
  const warn = report.length - totals
  log(fresh, 'info', `抠像完成：${keyed.length} 帧${warn > 0 ? `，${warn} 帧背景占比异常（看 report）` : '，全部可信'}`)
  return writeVideoJob(home, fresh)
}

/* ─────────────────────────────── 合成 ──────────────────────────────────── */

/** 帧数多时自动折行，避免一张图宽到撞纹理上限（默认上限 8192）。 */
export function chooseLayout({ count, cellWidth, maxWidth = 8192 }) {
  const perRow = Math.max(1, Math.floor(maxWidth / Math.max(1, cellWidth)))
  if (count <= perRow) return { layout: 'row', columns: count }
  const columns = Math.max(1, perRow)
  return { layout: 'grid', columns }
}

/** 把抠好的帧对齐合成一张透明整图。 */
export async function composeJobSheet(home, id, overrides = {}) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  const keyed = job.frames?.keyed ?? []
  if (keyed.length === 0) throw new Error('还没有抠好的帧：先抠像再合成')
  const settings = normalizeSettings({ ...job.settings, ...overrides }, job.settings.model)
  const { width, height } = job.frames
  const frames = []
  for (const name of keyed) frames.push(await decodePngToRgba(absPath(home, id, `keyed/${name}`), width, height))

  let layout = settings.layout
  let columns = settings.columns
  if (layout === 'auto' || columns <= 0) {
    const chosen = chooseLayout({ count: frames.length, cellWidth: settings.cellWidth })
    if (layout === 'auto') layout = chosen.layout
    if (columns <= 0) columns = chosen.columns
  }
  // ★ 行对象必须用**本帧自己的 width/height**。这里如果图省事写成整图的宽高，
  // 每帧的 `frame.length < row.width*row.height*4` 判断就永远成立，合成出来
  // 是一张全透明图 —— 而且不报错。所有帧同尺寸，所以两者数值相同，但含义
  // 必须是「这一帧」而不是「整张图」。
  const sheet = composeSheet([{ key: 'sequence', frames, width, height }], {
    frameCount: frames.length,
    cellWidth: settings.cellWidth,
    cellHeight: settings.cellHeight,
    autoCrop: true,
    fillRatio: settings.fillRatio,
    bottomMargin: settings.bottomMargin,
    pixelSize: settings.pixelSize,
    fitMode: 'contain',
    layout,
    columns,
  })
  const target = 'out/sequence.png'
  writeFileSync(absPath(home, id, target), encodePng(sheet.rgba, sheet.width, sheet.height))
  const fresh = getJob(home, id)
  fresh.settings = { ...fresh.settings, ...settings, layout, columns }
  // 空结果必须是**错误**而不是一张全透明图：透明图看上去像「工具坏了」，
  // 实际原因通常是这批帧抠完什么都不剩（背景色与主体色太近 / 整帧被抠光）。
  if (sheet.bbox.empty) {
    throw new Error('抠完的帧里没有任何不透明像素：检查抠像参数（keyLow / bgTolerance）或换视频')
  }
  fresh.sheet = {
    status: 'ready', file: target, width: sheet.width, height: sheet.height,
    columns: sheet.columns, rows: sheet.rows, layout: sheet.layout,
    frameCount: frames.length, cellWidth: settings.cellWidth, cellHeight: settings.cellHeight,
    content: sheet.content, updatedAt: Date.now(),
  }
  fresh.import = undefined
  log(fresh, 'info', `合成完成：${sheet.width}×${sheet.height}（${sheet.columns}×${sheet.rows} 格）`)
  return writeVideoJob(home, fresh)
}

/* ─────────────────────────────── 导入 Maker ─────────────────────────────── */

/** Maker 的 .meta 只需要一个 uuid；用内容哈希前 27 位，同图重复导入不会算成两份。 */
function makerUuid(bytes) {
  const hex = createHash('sha256').update(bytes).digest('hex')
  // Maker uuid 是 27 位字符串；十六进制足够唯一且稳定。
  return hex.slice(0, 27)
}

const safeAssetName = (name) => {
  const lower = String(name ?? '').trim().toLowerCase()
    .replace(/[\s]+/g, '_')
    .replace(/[^a-z0-9_\-/]/g, '')
    .replace(/^_+|_+$/g, '')
  return lower.length > 0 ? lower.slice(0, 60) : 'sequence'
}

function dedupeName(dir, name) {
  if (!existsSync(path.join(dir, name))) return name
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}_${i}${ext}`
    if (!existsSync(path.join(dir, candidate))) return candidate
  }
  return `${base}_${Date.now()}${ext}`
}

/**
 * 把合成好的整图**复制**进 Maker 工程的 assets/image/，补同名 .meta，
 * 再写一份 sequence manifest（列数 / 行数 / 每格尺寸 / 帧率建议）。
 *
 * 只复制最后那一张：原始帧、视频都留在 $DSH_HOME 的作业目录里 ——
 * assets/ 下任何一个新文件都会被 Maker 运行时补 .meta 并打进构建。
 *
 * 同时给一段 Lua 用法：Maker 的 2D 精灵用 `Sprite` + `SetTextureRect`
 * 按帧号切格子即可，不依赖 AnimationSet2D 的格式。
 */
export async function importToMaker(home, id, { projectDir, assetName, fps } = {}) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  if (job.sheet?.status !== 'ready' || !job.sheet.file) throw new Error('还没有合成整图：先合成再导入')
  const project = path.resolve(String(projectDir ?? ''))
  if (!existsSync(path.join(project, 'assets'))) {
    throw new Error(`这不是一个 Maker 工程（缺少 assets/ 目录）：${project}`)
  }
  const imageDir = path.join(project, 'assets', 'image')
  mkdirSync(imageDir, { recursive: true })
  const bytes = readFileSync(absPath(home, id, job.sheet.file))
  const wanted = `${safeAssetName(assetName ?? job.name)}.png`
  const finalName = dedupeName(imageDir, wanted)
  const finalPath = path.join(imageDir, finalName)
  // 先写临时名再改名：避免 Maker 的文件监听器读到写了一半的 PNG。
  const tmpPath = `${finalPath}.partial`
  writeFileSync(tmpPath, bytes)
  renameSync(tmpPath, finalPath)
  const uuid = makerUuid(bytes)
  writeFileSync(`${finalPath}.meta`, `${JSON.stringify({ uuid }, null, 2)}\n`, 'utf8')

  const sheet = job.sheet
  const manifest = {
    asset: `assets/image/${finalName}`,
    meta: `assets/image/${finalName}.meta`,
    uuid,
    source: { jobId: job.id, name: job.name, model: job.settings.model, prompt: job.prompt },
    sheet: {
      width: sheet.width, height: sheet.height, columns: sheet.columns, rows: sheet.rows,
      frameCount: sheet.frameCount, cellWidth: sheet.cellWidth, cellHeight: sheet.cellHeight,
    },
    animation: {
      fps: Number(fps) > 0 ? Number(fps) : suggestFps(job),
      loop: job.settings.arrange === 'loop',
      frames: sheet.frameCount,
    },
    chroma: { chroma: job.settings.chroma, bgTolerance: job.settings.bgTolerance, despill: job.settings.despill },
    times: job.frames?.times ?? [],
    createdAt: Date.now(),
  }
  const maniDir = path.join(project, 'assets', 'image')
  writeFileSync(path.join(maniDir, `${finalName.replace(/\.png$/, '')}.seq.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const fresh = getJob(home, id)
  fresh.import = { projectDir: project, asset: `assets/image/${finalName}`, manifest: `assets/image/${finalName.replace(/\.png$/, '')}.seq.json`, uuid, fps: manifest.animation.fps, at: Date.now() }
  log(fresh, 'info', `已导入 Maker：assets/image/${finalName}`)
  const saved = writeVideoJob(home, fresh)
  return { job: saved, file: finalPath, meta: `${finalPath}.meta`, manifest, lua: luaSnippet(finalName, manifest) }
}

/** 按采样间隔推荐回放帧率：帧数是按时长抽的，播放速度要能还原现场节奏。 */
function suggestFps(job) {
  const duration = job.frames?.duration
  const count = job.sheet?.frameCount ?? job.frames?.count
  if (!duration || !count) return 12
  if (job.settings.arrange === 'loop') {
    // 循环动画的时长 = 一个周期；帧数 / 周期 = 原速。
    return Math.max(4, Math.min(30, Math.round(count / duration)))
  }
  // 非循环时用户多半想「慢一点」欣赏，按原速的 2/3 播放。
  return Math.max(4, Math.min(24, Math.round((count / duration) * 0.66)))
}

/** 给一段可以直接贴进 Lua 的用法（Maker 2D Sprite 按格子切图）。 */
function luaSnippet(fileName, manifest) {
  const { columns, frameCount, cellWidth, cellHeight } = manifest.sheet
  const fps = manifest.animation.fps
  return [
    `-- ${fileName}：${frameCount} 帧，${columns} 列 × ${Math.ceil(frameCount / columns)} 行，每格 ${cellWidth}×${cellHeight}`,
    'local sheet = cache:GetResource("Texture2D", "image/' + fileName + '")',
    'local sprite = node:CreateComponent("Sprite2D")',
    'sprite.texture = sheet',
    `sprite.rect = Rect(0, 0, ${cellWidth}, ${cellHeight})  -- 第 0 帧`,
    'local frame, acc = 0, 0',
    `local FPS = ${fps}`,
    'function HandleUpdate(eventType, eventData)',
    '  acc = acc + eventData["TimeStep"]',
    '  if acc >= 1 / FPS then',
    '    acc = acc - 1 / FPS',
    `    frame = (frame + 1) % ${frameCount}`,
    `    local col = frame % ${columns}`,
    `    local row = math.floor(frame / ${columns})`,
    `    sprite.rect = Rect(col * ${cellWidth}, row * ${cellHeight}, ${cellWidth}, ${cellHeight})`,
    '  end',
    'end',
  ].join('\n')
}

/* ─────────────────────────────── 自检 / 提示 ────────────────────────────── */

/** 作业级别的「下一步该做什么」，给 /taptap-video 与聊天用。 */
export function nextStepOf(job) {
  if (job.video?.status === 'empty') return '① 设置首帧（/taptap-video first <图片>）并写提示词（/taptap-video prompt <文字>）'
  if (job.video?.status === 'running') return '② 视频生成中，等它跑完（/taptap-video poll）'
  if (job.video?.status === 'error') return `② 视频失败：${job.video.error}${job.video.hint ? `（${job.video.hint}）` : ''}`
  if (job.frames?.status === 'empty') return '③ 抽帧：/taptap-video frames'
  if (job.frames?.status === 'error') return `③ 抽帧失败：${job.frames.error}`
  if ((job.frames?.keyed ?? []).length === 0) return '④ 抠像：/taptap-video key'
  if (job.sheet?.status !== 'ready') return '⑤ 合成：/taptap-video sheet'
  if (!job.import) return '⑥ 导入 Maker：/taptap-video import <工程目录>'
  return '✓ 已完成，可以进游戏里看效果'
}

/** 环境自检：ffmpeg / Key 类型 / 站点 / 套餐 / 中转站（设置页与 /taptap-video doctor 共用）。 */
export async function doctor(home, config) {
  const ffmpeg = await checkFfmpeg()
  const kind = detectKeyKind(config.apiKey)
  const out = {
    ffmpeg,
    baseURL: config.baseURL,
    model: config.model,
    hasKey: Boolean(config.apiKey && config.apiKey.trim()),
    keyKind: kind,
    estimate: null,
    probe: null,
    relay: {
      configured: relayReady(config.relay),
      protocol: config.relay?.protocol ?? 'openai',
      baseURL: config.relay?.baseURL ?? '',
      model: config.relay?.model ?? '',
      hasKey: Boolean(config.relay?.apiKey),
    },
    // 三个后端的可用性，界面按这个画「现在能走哪条」。
    backends: {
      minimax: Boolean(config.apiKey && config.apiKey.trim()),
      relay: relayReady(config.relay),
      local: true, // 自选本地视频永远可用（零额度）
    },
  }
  if (out.hasKey) {
    out.estimate = estimateCostCny({ model: config.model, duration: 4, resolution: '768P' })
    try {
      const { testMiniMax } = await import('./minimax-video.mjs')
      out.probe = await testMiniMax({ baseUrl: config.baseURL, apiKey: config.apiKey, model: config.model, timeoutMs: 30_000 })
    } catch (error) {
      out.probe = { ok: false, auth: 'error', message: error?.message ?? String(error), hint: error?.hint }
    }
  }
  return out
}

export { MiniMaxError, MediaError, capabilityOf, estimateCostCny }
