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
import fs, { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { resolveAssetDir, ensureAssetDir } from './assets.mjs'

import {
  dataDir, readSubmitLedger, writeSubmitLedger, clearSubmitLedger,
} from './paths.js'
import {
  MiniMaxError, capabilityOf, detectKeyKind, downloadVideo, estimateCostCny,
  modelsSupportingLastFrame, normalizeDuration, normalizeResolution,
  protocolOf, queryVideo, retrieveFile, submitVideo,
} from './minimax-video.mjs'
import { relayDownload, relayQuery, relaySubmit, relayReady, normalizeRatio } from './video-relay.mjs'
import { fallbackCandidates, laneOrder, quotaSignal } from './lanes.mjs'
import { requireApproval } from './guards.mjs'
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

function ensureJobDirs(home, id, name) {
  // 目录名要用**作业名**，所以这里先按名字算根；建作业时名字已经定了。
  const root = name
    ? path.join(resolveAssetDir(home, 'video', { fallback: 'video-jobs' }).dir, `${slugFor(name)}-${id}`)
    : jobRoot(home, id)
  for (const sub of ['refs', 'videos', 'frames', 'keyed', 'out']) {
    mkdirSync(path.join(root, sub), { recursive: true })
  }
  return root
}

export function createJob(home, name, { model } = {}) {
  const id = newJobId()
  const jobName = String(name ?? '').trim().slice(0, 80) || '未命名视频作业'
  ensureJobDirs(home, id, jobName)
  const now = Date.now()
  // ⚠️ 模型必须**继承用户在设置页里选的那个**，不能退回内置默认值。
  //    以前这里硬写 `...DEFAULT_SETTINGS`（model: 'MiniMax-H3'），于是用户在
  //    设置里选了 Hailuo-2.3-Fast、新建作业却照样用 H3 —— 视频按秒计费，
  //    静默换模型等于替用户改了要买的东西。调用方负责把设置里的模型传进来。
  const chosen = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_SETTINGS.model
  const job = {
    id,
    name: jobName,
    createdAt: now,
    updatedAt: now,
    mode: 'frames',       // frames（首尾帧）| reference（多模态参考，H3 支持）
    prompt: '',
    suffix: '',
    refs: { firstFrame: null, lastFrame: null },
    settings: { ...DEFAULT_SETTINGS, model: chosen },
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

/**
 * 列出全部作业（按更新时间倒序）。
 *
 * 扫三处：位置索引（能找到别的项目 / 别的 cwd 建的作业）→ 当前 cwd 的
 * `sucai/video/` → 改造前的旧位置。旧位置的作业会在读取时顺手搬迁，
 * 所以用户升级后第一次执行命令，老作业就自动出现在列表里。
 */
export function listJobs(home) {
  const jobs = []
  const seen = new Set()
  const add = (id) => {
    if (!id || seen.has(id)) return
    const job = readJobFile(home, id)
    if (!job || job.id !== id) return
    seen.add(id)
    jobs.push(job)
  }
  for (const id of Object.keys(readIndex(home))) add(id)
  const roots = [
    resolveAssetDir(home, 'video', { fallback: 'video-jobs' }).dir,
    path.join(dataDir(home), 'video-jobs'),
  ]
  for (const root of roots) {
    let names = []
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { continue }
    for (const name of names) {
      // 新目录名是 `<slug>-<id>`，旧的直接是 `<id>`；两种都要认。
      const m = /(?:^|-)(v[a-z0-9]{4,40})$/.exec(name)
      add(m ? m[1] : (/^v[a-z0-9]{4,40}$/.test(name) ? name : undefined))
    }
  }
  jobs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return jobs
}

/** 删掉一个作业（含视频与全部中间产物）。 */
export function deleteJob(home, id) {
  if (!JOB_ID.test(String(id ?? ''))) throw new Error(`非法的视频作业 id：${id}`)
  const dirs = new Set([jobRoot(home, id, safeReadJob(home, id)), legacyJobRoot(home, id)])
  const known = readIndex(home)[id]
  if (typeof known === 'string' && known) dirs.add(known)
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  // 索引也要清：留着会指向一个已经不存在的目录。
  const idx = readIndex(home)
  delete idx[id]
  try { fs.writeFileSync(indexFile(home), JSON.stringify(idx, null, 2), 'utf8') } catch { /* ignore */ }
}

export function saveJob(home, id, patch = {}) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  if (typeof patch.name === 'string' && patch.name.trim()) job.name = patch.name.trim().slice(0, 80)
  if (typeof patch.prompt === 'string') job.prompt = patch.prompt
  if (typeof patch.suffix === 'string') job.suffix = patch.suffix
  if (patch.mode === 'frames' || patch.mode === 'reference') job.mode = patch.mode
  if (patch.settings && typeof patch.settings === 'object') {
    job.settings = normalizeSettings({ ...job.settings, ...patch.settings })
  }
  // 提示词 / 首尾帧 / 视频设置变了 → 已有的视频与帧都过期，但**不删**，
  // 只是打上 stale，让人能对比「改之前的效果」。
  if (typeof patch.prompt === 'string' || patch.settings !== undefined) {
    if (job.frames.status === 'ready') job.frames.stale = true
  }
  job.updatedAt = Date.now()
  return writeVideoJob(home, job)
}

function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS }
  const num = (v, d) => {
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : d
  }
  const clamp = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Math.round(num(v, d))))
  // 模型**原样保留**。以前这里在 model 为空/空白时会退回内置默认
  // （`fallbackModel ?? DEFAULT_SETTINGS.model`），等于把用户清空的模型
  // 悄悄换成一个默认模型 —— 视频按秒计费，静默换模型就是替用户决定花多少钱。
  // 现在空就留空，由 submitJobVideo 明确报错要求用户指定。
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
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

/**
 * 作业根目录。
 *
 * 在 Maker 项目里跑 → `<项目>/sucai/video/<作业名>-<id>/`（跟随项目，三类素材
 * 统一收在 sucai 下）；否则退回 `$DSH_HOME/taptap-maker-dev/video-jobs/<id>/`。
 *
 * ⚠️ 目录名带**作业名**而不是只用 id：用户在资源管理器里看到 `奔跑-j7k2p`
 * 比看到 `j7k2p` 有用得多。但作业名会变，而目录名一旦定下就不能跟着变（否则
 * 已经下载好的视频/帧就找不到了），所以固定用**建作业那一刻**的名字，之后改名
 * 不搬目录 —— 宁可名字旧一点，也不能让 `job.frames.files` 里的相对路径全断。
 */
function jobRoot(home, id, knownJob) {
  const job = knownJob ?? safeReadJob(home, id)
  const label = job?.name ? `${slugFor(job.name)}-${id}` : id
  const base = resolveAssetDir(home, 'video', {
    projectDir: job?.projectDir,
    fallback: 'video-jobs',
  })
  // resolveAssetDir 已经建好了 <video>/，这里只需要拼作业那一层。
  return path.join(base.dir, label)
}

/** 作业名 → 安全的目录名片段（保留中文，去掉路径分隔与 Windows 非法字符）。 */
function slugFor(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>"|]/g, '_').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()
  // Windows 保留名（CON / PRN / AUX…）不能直接做目录名。
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? '_' + cleaned : cleaned
  return (safe || 'job').slice(0, 40)
}

/* ── 作业位置索引 ────────────────────────────────────────────────────────
 *
 * 作业目录跟着项目走（cwd 决定），但**作业本身属于用户，不属于某次命令**。
 * 所以需要一份「id → 绝对目录」的稳定索引存在 $DSH_HOME：否则换个 cwd
 * （或者项目被移动/改名）就再也找不到自己的作业了，而用户会以为作业丢了。
 */
function indexFile(home) {
  return path.join(dataDir(home), 'video-index.json')
}

function readIndex(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(home), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function rememberJobDir(home, id, dir) {
  const idx = readIndex(home)
  if (idx[id] === dir) return
  idx[id] = dir
  try {
    fs.mkdirSync(path.dirname(indexFile(home)), { recursive: true })
    fs.writeFileSync(indexFile(home), JSON.stringify(idx, null, 2), 'utf8')
  } catch { /* 索引写不进去也不影响主流程，只是换 cwd 后要靠扫目录 */ }
}

/**
 * 读作业，**不经过 jobRoot**（否则「算目录要读作业、读作业要算目录」成环）。
 *
 * 顺序：索引记录的目录 → 当前 cwd 下的 sucai/video → 改造前的旧位置。
 * 索引让作业与 cwd 解耦；后两级保证索引丢了之后仍能找回作业，而不是直接
 * 「作业不存在」。
 */
function safeReadJob(home, id) {
  const readAt = (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')) } catch { return undefined }
  }
  const known = readIndex(home)[id]
  if (typeof known === 'string' && known) {
    const job = readAt(known)
    if (job?.id === id) return job
  }
  const base = resolveAssetDir(home, 'video', { fallback: 'video-jobs' }).dir
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === id || entry.name.endsWith(`-${id}`)) {
        const dir = path.join(base, entry.name)
        const job = readAt(dir)
        if (job?.id === id) {
          rememberJobDir(home, id, dir)
          return job
        }
      }
    }
  } catch { /* 目录还不存在 */ }
  return readAt(legacyJobRoot(home, id))
}

/** 改造前的固定位置（只用于找旧作业 / 迁移）。 */
function legacyJobRoot(home, id) {
  return path.join(dataDir(home), 'video-jobs', id)
}

/**
 * 把改造前的作业目录**一次性搬到**新位置。
 *
 * 为什么必须搬而不是只读新位置：作业的 `job.json` 记着 `frames/xxx.png` 这种
 * **相对路径**，抽帧、抠像、拼图全靠 `absPath()` 拼根目录。只改根目录的话，
 * 老作业里已经生成好的视频和帧会集体「找不到文件」，用户会以为文件被删了。
 *
 * 搬迁是**幂等**的：新位置已经有 job.json 就直接用，不重复搬；跨盘失败时
 * 保留原目录并照常报错，绝不做出「搬一半」的半成品状态。
 */
function migrateLegacyJob(home, id) {
  const legacy = legacyJobRoot(home, id)
  if (!existsSync(legacy)) return undefined // 压根没有旧作业
  const target = jobRoot(home, id, safeReadJob(home, id))
  if (path.resolve(legacy) === path.resolve(target)) return target
  try {
    if (existsSync(target)) return target // 搬过了
    ensureAssetDir(path.dirname(target), { insideProject: path.dirname(target).includes('sucai') })
    renameSync(legacy, target)
  } catch {
    // 跨设备 rename 会 EXDEV；退回复制，失败就留着旧目录（功能不受影响，
    // 只是素材没跟着项目走）。
    try { fs.cpSync(legacy, target, { recursive: true }) } catch { /* ignore */ }
  }
  return target
}

/* ── 作业读写（本地覆盖 paths.js 的版本）──────────────────────────────
 *
 * paths.js 里的 readVideoJob/writeVideoJob 用的是**固定的** $DSH_HOME 路径；
 * 目录改到 sucai/ 之后必须跟着改，否则读写的会是另一个位置的 job.json。
 * 这里用同一套路径解析覆盖一遍，避免两处各写一份、以后改一处漏一处。
 */
const readJobFile = (home, id) => {
  const job = safeReadJob(home, id)
  if (!job) return undefined
  // 旧作业（改造前建的）没有 `dir` 字段，也还躺在老位置 → 顺手搬到项目里。
  if (typeof job.dir !== 'string' || !existsSync(job.dir)) {
    const target = migrateLegacyJob(home, id)
    if (target && existsSync(target)) {
      try {
        const moved = JSON.parse(fs.readFileSync(path.join(target, 'job.json'), 'utf8'))
        moved.dir = target
        return writeJobFile(home, moved)
      } catch { /* 搬不动就用原样 */ }
    }
    // 搬不动（跨盘失败等）：仍然可用，只是素材没跟着项目走。
    return job
  }
  rememberJobDir(home, id, job.dir)
  return job
}

function writeJobFile(home, job) {
  if (!job || typeof job.id !== 'string') throw new Error('writeVideoJob 需要一个带 id 的作业对象')
  // 目录**记进 job.json**（`dir`）。这一条是整个改动能成立的关键：
  // 目录名含作业名，而读作业又需要知道目录 —— 不把结果落盘的话，
  // 「算目录 → 读作业 → 算目录」就成环了。落盘之后每次都直接用记录值，
  // 作业改名、cwd 变化都不会让已生成的帧和视频突然找不到。
  const dir = typeof job.dir === 'string' && job.dir.length > 0 ? job.dir : jobRoot(home, job.id, job)
  job.dir = dir
  ensureAssetDir(dir, { insideProject: dir.includes(`${path.sep}sucai${path.sep}`) })
  // 原子替换：作业可能被另一个进程（对话里的命令）同时读到。
  const target = path.join(dir, 'job.json')
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8')
  fs.renameSync(tmp, target)
  rememberJobDir(home, job.id, dir)
  return job
}

// 与 paths.js 同名同签名，但走 sucai/ 的新位置。
const readVideoJob = readJobFile
const writeVideoJob = writeJobFile

function rel(id, sub, file) {
  return `${sub}/${file}`
}

export function absPath(home, id, relative) {
  // 优先用 job.json 里记下的目录：它是建作业时算出来并落盘的，之后 cwd 变了
  // 也不会漂 —— 否则一条在项目 A 里建的作业，切到项目 B 就会读不到自己的帧。
  const job = safeReadJob(home, id)
  const root = (job?.dir && typeof job.dir === 'string') ? job.dir : jobRoot(home, id, job)
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
export async function submitJobVideo(home, id, config, { rawInput } = {}) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  if (job.video?.status === 'running') {
    throw new Error(`视频任务已在跑（${job.video.taskId ?? '提交中'}），等它跑完再提交，避免重复扣费`)
  }
  // 🚫 上一次提交「结果未知」时**不许再提交**。
  //    这是白烧额度最典型的路径：网络抖一下 → 作业标成失败 → 用户（尤其 AI）
  //    很自然地再跑一次 → 服务端其实早就收下了 → 两次都扣钱。
  //    只有用户明确确认「服务端确实没有这个任务」才放行。
  if (job.video?.status === 'uncertain') {
    const gate = requireApproval({
      rawInput,
      action: '在「上一次提交结果未知」的情况下**再提交一次**',
      consequence: `上一次提交（${job.video.submitId ?? '未知'}）没有收到服务端回应，`
        + '但服务端很可能已经收下并在生成、额度也可能已经扣了。再提交就是**多花一份钱**。',
      undo: '没有撤销 —— 钱已经花出去了。先用 /taptap-video status 与 /taptap-video poll 确认。',
    })
    if (!gate.ok) {
      throw new Error(`${gate.text}\n\n${UNCERTAIN_HINT}`)
    }
  }
  const prompt = `${job.prompt.trim()}${job.suffix.trim() ? `\n${job.suffix.trim()}` : ''}`
  if (prompt.trim() === '') throw new Error('提示词为空：先写一句「角色在做什么」')
  if (job.mode === 'frames' && !job.refs.firstFrame) {
    throw new Error('首尾帧模式至少要一张首帧图（可用 /taptap-video first <图片路径> 指定）')
  }
  const backend = resolveBackend(job, config, home)
  if (backend === 'local') {
    throw new Error('当前是「自选视频」后端：没有可提交的远程任务。直接用 /taptap-video use <mp4 路径> 挂上本地视频')
  }
  // 模型能力只在官方 MiniMax 后端下有意义：中转站的模型名由中转站自己定义。
  if (backend === 'minimax') {
    // ⚠️ 模型不允许被自动替换。这里**只报错、绝不换模型**：视频按秒计费，
    //    静默换一个「差不多」的模型等于替用户改了要买的东西。
    //    需要换必须用户自己下指令（/taptap-video set --model … 或设置页）。
    const wanted = String(job.settings.model ?? '').trim()
    if (wanted === '') {
      throw new Error('作业没有指定模型：先 /taptap-video set --model <模型名>，或在设置页「MiniMax」里选一个。'
        + '（插件不会替你猜模型）')
    }
    const cap = capabilityOf(wanted)
    if (job.refs.lastFrame && !cap.supportsLastFrame) {
      throw new Error(`${wanted} 不支持尾帧。`
        + `可选：换成 ${modelsSupportingLastFrame().join(' / ')}（/taptap-video set --model <模型名>），或用 /taptap-video last --clear 清掉尾帧。`
        + '（插件不会自动替你换模型）')
    }
  }
  // 不在中转站提交前做型号校验：每家中转站可以有自己的能力表，
  // 写死一家反而误导其他家。超时 / 超画幅 / 不支持尾帧 → 平台 400 时如实回显。

  // 中转站的模型名来自它自己的配置；这里只用它**覆盖提交参数**，
  // 并把实际用的名字记进 job.video.model，界面上如实显示「到底用的哪个」。
  const effectiveModel = backend === 'relay'
    ? (config.relay?.model || job.settings.model)
    : job.settings.model
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

  /**
   * 试一条通道提交。抽出来是因为回退要**整体重试**：帧编码、首帧校验这些
   * 准备工作与后端无关，在所有重试之间复用，不重复上传素材。
   *
   * `idemKey` 在**整个重试链里固定不变** —— 这样即使某次请求其实成功、
   * 只是响应丢了（我们判成「可能已提交」并停下），用户之后用同一个 key
   * 重试也不会生成第二段视频、不会扣两次钱。
   */
  const attempt = async (useBackend, idemKey) => {
    if (useBackend === 'relay') {
      const submitted = await relaySubmit(config.relay, {
        prompt,
        firstFrameImage,
        lastFrameImage,
        seconds: job.settings.duration,
        size: relaySizeFor(job.settings),
        assetFiles: {
          firstFrame: job.refs.firstFrame
            ? { path: absPath(home, id, job.refs.firstFrame.file), mime: mimeOf(job.refs.firstFrame.file) }
            : undefined,
          lastFrame: job.refs.lastFrame
            ? { path: absPath(home, id, job.refs.lastFrame.file), mime: mimeOf(job.refs.lastFrame.file) }
            : undefined,
        },
        ratio: job.settings.relayRatio,
        idempotencyKey: idemKey,
      })
      return submitted.taskId
    }
    return submitVideo({
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
      idempotencyKey: idemKey,
    })
  }

  /** 这条通道此刻能不能跑（设置页排序后仍要复查一次配置）。 */
  const usable = (laneId) => (laneId === 'relay' ? relayReady(config?.relay) : Boolean(config?.apiKey))

  const candidates = (job.settings.backend ?? 'auto') === 'auto'
    ? fallbackCandidates(home, 'video', usable)
    : []

  const chain = []
  if (usable(backend) && !chain.includes(backend)) chain.push(backend)
  for (const id of candidates) if (!chain.includes(id)) chain.push(id)

  // 同一次提交共用一个幂等键（跨通道重试也不换）。
  const idemKey = randomUUID()
  let lastError = null
  let uncertain = null // 「可能已提交、结果未知」的失败
  for (let i = 0; i < chain.length; i += 1) {
    const useBackend = chain[i]
    // ⚠️ 在**发请求之前**落盘台账：万一请求发出后本地断网 / 进程被杀，
    //    下次进来能知道「上次可能已经扣费了」，而不是傻乎乎再提交一次。
    writeSubmitLedger(home, {
      submitId, state: 'inflight', jobId: id, backend: useBackend,
      model: job.settings.model, idempotencyKey: idemKey,
    })
    try {
      const taskId = await attempt(useBackend, idemKey)
      const usedModel = useBackend === 'relay' ? (config.relay?.model || job.settings.model) : job.settings.model
      const fresh = getJob(home, id)
      fresh.video = {
        ...fresh.video, status: 'running', taskId, remoteStatus: '已提交',
        backend: useBackend, model: usedModel, submitId, updatedAt: Date.now(),
      }
      log(fresh, 'info', `视频任务已提交：${taskId}`)
      if (i > 0) log(fresh, 'info', `（已从其他通道回退到 ${useBackend === 'relay' ? '中转站' : 'MiniMax'}）`)
      return { taskId, submitId, backend: useBackend, job: writeVideoJob(home, fresh) }
    } catch (error) {
      lastError = error
      // ★ 关键分类：这次失败是「服务端明确拒收」（没扣费，可换通道重试）
      //   还是「请求发出去了但结果未知」（**很可能已扣费，绝不能重投**）。
      //   网络异常（fetch failed / 超时 / ECONNRESET）属于后者 ——
      //   这正是「白烧额度」最常见的来源：看到报错就再跑一次。
      if (isUncertainSubmit(error)) {
        uncertain = error
        break // 立刻停：换通道重试 = 再花一份钱
      }
      writeSubmitLedger(home, {
        submitId, state: 'failed', jobId: id, backend: useBackend,
        model: job.settings.model, idempotencyKey: idemKey,
        error: error?.message ?? String(error),
      })
      const canRetry = i < chain.length - 1 && (quotaSignal(error) !== null || error?.status === 429 || error?.status === 503)
      if (!canRetry) break
      const fresh = getJob(home, id)
      log(fresh, 'warn', `${useBackend === 'relay' ? '中转站' : 'MiniMax'} 提交失败（${quotaSignal(error) ?? error?.message ?? error}），换下一条通道重试`)
    }
  }

  const fresh = getJob(home, id)
  // 「可能已提交」用**独立的 status**，绝不能标成 error ——
  // error 会让用户/AI 以为失败了就再来一次，那才是真正烧钱的地方。
  fresh.video = uncertain
    ? {
      status: 'uncertain', submitId, remoteStatus: '提交结果未知',
      error: uncertain?.message ?? String(uncertain),
      hint: UNCERTAIN_HINT,
      uncertainSince: Date.now(), updatedAt: Date.now(),
    }
    : {
      status: 'error', submitId, remoteStatus: '提交失败',
      error: lastError?.message ?? String(lastError), hint: lastError?.hint, updatedAt: Date.now(),
    }
  log(fresh, uncertain ? 'warn' : 'error', uncertain
    ? `提交结果未知（可能已扣费，已阻止自动重试）：${uncertain?.message ?? uncertain}`
    : `视频提交失败：${lastError?.message ?? lastError}`)
  writeVideoJob(home, fresh)
  throw uncertain ?? lastError
}

/** 提交「结果未知」时给用户的话 —— 核心是劝阻重投。 */
const UNCERTAIN_HINT = [
  '提交请求已经发出，但**没有收到服务端的回应**（网络中断 / 超时 / 进程被打断）。',
  '这不代表失败：服务端很可能**已经收下并在生成**，额度也可能已经扣了。',
  '',
  '🚫 请不要直接再跑一次 run —— 那会再提交一个新任务，等于多花一份钱。',
  '先做这两件事：',
  '  1) /taptap-video status  看这个作业的台账记录',
  '  2) /taptap-video poll    继续查（如果 task_id 已记下，就能把片子拿回来）',
  '确认服务端那边**确实没有**这个任务之后，再重新提交。',
].join('\n')

/**
 * 判断一次提交失败是否属于「结果未知（可能已扣费）」。
 *
 * 只认**传输层**故障：这些错误发生在「请求已经发出去」之后，服务端是否收到
 * 我们无从得知。业务层错误（4xx + 错误码、明确的 402/1008）属于服务端明确
 * 拒收，没有扣费，可以放心换通道。
 */
function isUncertainSubmit(error) {
  if (!error) return false
  // 有明确 HTTP 状态码 = 服务端给了答复 = 不是未知。
  const status = Number(error.status ?? 0)
  if (status >= 400 && status < 600) return false
  const text = String(error?.message ?? error?.raw ?? '')
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|网络|超时|timeout|aborted/i.test(text)
}

/**
 * 决定这次走哪个后端。
 *
 * 顺序与开关来自设置页的「视频通道优先级」（`lanes.json`），用户排的顺序
 * 就是权威 —— 早于本功能时这里是写死的「中转站 > MiniMax」，理由是
 * 「用户主动配了中转站多半就是想用它」；现在这个理由由界面上的排序承担了，
 * 底层不再替用户猜。
 *
 * 显式选择（relay / minimax / local）仍然压过排序：那是用户在**这一个作业**
 * 上的一次性决定，不该被全局顺序覆盖。
 */
export function resolveBackend(job, config, home) {
  const wanted = job?.settings?.backend ?? 'auto'
  if (wanted !== 'auto') {
    if (wanted === 'relay' && !relayReady(config?.relay)) {
      throw new Error('作业选择的是「中转站」后端，但中转站没配好（设置页 → 视频生成 → 中转站）')
    }
    if (wanted === 'minimax' && !config?.apiKey) {
      throw new Error('作业选择的是「MiniMax」后端，但没有可用的 Key')
    }
    return wanted
  }
  // auto：按设置页排好的顺序，取第一条「开着 + 配好了 + 不是本地文件」的。
  // 没有 home（极少数直接调本函数的测试）时退回内置默认序 relay > minimax。
  const order = home ? laneOrder(home, 'video') : ['relay', 'minimax']
  for (const id of order) {
    if (id === 'local') continue // 本地视频不参与自动提交（见下方 hint）
    if (id === 'relay' && relayReady(config?.relay)) return 'relay'
    if (id === 'minimax' && config?.apiKey) return 'minimax'
  }
  // 都没配 → 交给 relaySubmit 报出「没配好」，比含糊的「没有 Key」有用
  return 'relay'
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
    // ⚠️ 轮询本身**不会**再花钱（只是查状态），所以这里可以放心重试；
    //    但要提醒别查太密：限流（RPM）下高频轮询容易把自己搞得更慢。
    const fresh = getJob(home, id)
    const status = Number(error?.status ?? 0)
    const rateLimited = status === 429 || /1002|rate limit|too many requests/i.test(String(error?.message ?? ''))
    fresh.video = {
      ...fresh.video,
      remoteStatus: rateLimited ? '查询被限流，等一会儿再查（不会额外扣费）' : `查询异常：${error?.message ?? error}`,
      pollHint: rateLimited ? 'M Plan 档的 RPM 限制比按量付费紧。建议隔 30~60 秒再 poll 一次。' : undefined,
      updatedAt: Date.now(),
    }
    return writeVideoJob(home, fresh)
  }
  const fresh = getJob(home, id)
  if (query.status === 'failed') {
    fresh.video = { ...fresh.video, status: 'error', remoteStatus: query.remoteStatus || 'failed', error: query.error || '平台报告任务失败', updatedAt: Date.now() }
    log(fresh, 'error', `视频生成失败：${fresh.video.error}`)
    clearSubmitLedger(home)
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
  clearSubmitLedger(home)
  return writeVideoJob(home, fresh)
}

/**
 * 挂一段**本地视频**：不花任何额度，直接把文件收进作业目录并标记就绪。
 *
 * 用途：MiniMax Code 用签到积分生成的、录屏、别人给的参考视频 —— 都能走
 * 后面的抽帧 / 抠像 / 合成 / 导入。这让整条链路在**零额度**下也能完整跑通。
 *
 * ⚠️ 覆盖保护：作业里已经有一段**花过钱生成的**视频时，这里不会默默把它覆盖掉 ——
 * 那等于把用户已经付过钱的产物扔了，而且没法再生成一次（同样的 prompt 也不保证
 * 一样）。没有 `force` 就返回 { overwritten: false }，由调用方转成一句询问。
 */
export async function useLocalVideo(home, id, sourcePath, { force = false } = {}) {
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

  // 已经有就绪的视频（尤其 backend=minimax/relay 的，是花钱生成的）→ 不覆盖。
  const prev = job.video
  const hadPaid = prev?.status === 'ready' && prev.file && prev.backend !== 'local'
  if (hadPaid && !force) {
    return {
      overwritten: false,
      job,
      candidate: { source, width: size.width, height: size.height },
      message: [
        `作业 ${job.id} 里已经有一段**生成好的**视频（${prev.backend === 'relay' ? '中转站' : 'MiniMax'}`
        + `${prev.model ? ' · ' + prev.model : ''}，${prev.file}）。`,
        '挂新的本地视频会**覆盖**它 —— 覆盖之后那段就没了，而且不能保证再生成出一模一样的。',
        '',
        '确实要换，请加 `--yes`；或者先复制走：' + path.join(job.dir, prev.file),
      ].join('\n'),
    }
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
  const saved = writeVideoJob(home, job)
  // overwrote 让调用方能如实告诉用户「原来那段被换掉了」，而不是当无事发生。
  return { ...saved, overwritten: hadPaid ? (prev?.file ?? null) : false }
}

/* ─────────────────────────────── 抽帧 ──────────────────────────────────── */

/** 按当前设置抽帧（不抠像）。返回 { files, times, duration, fps, width, height }。 */
/* ─────────────────────── 产物落位（先备后换） ────────────────────────── */

/**
 * 把 staging 里的文件替换进 destDir，失败时用 backup 回滚。
 *
 * 为什么不直接 renameSync(destDir, backup)：
 * Windows 上重命名一个**仍可能被占用**的目录会 EPERM（ffmpeg / 图片解码刚释放
 * 句柄，时序上不稳 —— 实测踩过）。所以改成逐文件搬：先把旧文件移进 backup，
 * 再把新文件就位。
 *
 * ⚠️ 回滚必须**覆盖**已就位的新文件，不能只补「缺失的」：
 *    切换到一半失败时，前几个文件已经是新内容了；如果只把 missing 的搬回来，
 *    结果是「新旧混杂」，比全丢还难判断。
 */
function rollbackSwap(destDir, backupDir) {
  let names = []
  try { names = fs.readdirSync(backupDir) } catch { names = [] }
  for (const name of names) {
    const dest = path.join(destDir, name)
    // 无论 dest 是否存在都要搬回来 —— 存在说明是本轮换上去的新内容。
    if (existsSync(dest)) rmSync(dest, { force: true })
    fs.renameSync(path.join(backupDir, name), dest)
  }
}

/**
 * 用 staging 的内容替换 destDir。
 *
 * - 旧文件先备份，成功后清掉备份与临时目录；
 * - 切换中途失败 → 回滚，destDir 回到本轮开始前的样子；
 * - 张数变少时，多出来的旧文件会被清掉。
 */
function swapDirFromStaging(staging, destDir, backupDir, expectedNames) {
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(backupDir, { recursive: true })
  try {
    for (const name of expectedNames) {
      const dest = path.join(destDir, name)
      if (existsSync(dest)) fs.renameSync(dest, path.join(backupDir, name))
      fs.renameSync(path.join(staging, name), dest)
    }
  } catch (swapError) {
    try { rollbackSwap(destDir, backupDir) } catch { /* 只能靠备份手工恢复 */ }
    rmSync(staging, { recursive: true, force: true })
    throw swapError
  }
  // 张数变少时清掉多余旧文件。
  try {
    for (const name of fs.readdirSync(destDir)) {
      if (!expectedNames.includes(name)) rmSync(path.join(destDir, name), { force: true })
    }
  } catch { /* 清残留失败不影响本轮结果 */ }
  rmSync(staging, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
}

export async function extractJobFrames(home, id, overrides = {}) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  if (job.video?.status !== 'ready' || !job.video.file) throw new Error('还没有可用视频，先提交并等它生成完')
  const settings = overrides.frameCount || overrides.arrange
    ? normalizeSettings({ ...job.settings, ...overrides })
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
    // ⚠️ 写进临时目录，**全部写成功后才落位**。以前是「先 rmSync 整个
    //    frames/ 再逐张写」—— 一旦写到一半失败（磁盘满、权限、Ctrl-C），
    //    上一轮抽出来的帧就被删光了，只剩半截新帧，而作业状态还没更新。
    //
    //    落位用「逐文件 rename」而不是「整目录 rename」：Windows 上重命名一个
    //    仍被打开的目录会 EPERM（ffmpeg/图片解码刚释放句柄，时序上不稳），
    //    单文件 rename 则始终可用。先备份旧文件、逐个替换、失败即回滚。
    const root = jobRoot(home, id)
    const staging = path.join(root, '.frames-staging')
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    const files = []
    try {
      for (let i = 0; i < frames.length; i += 1) {
        const name = `f${String(i).padStart(2, '0')}.png`
        writeFileSync(path.join(staging, name), encodePng(frames[i], width, height))
        files.push(name)
      }
    } catch (writeError) {
      rmSync(staging, { recursive: true, force: true })
      throw writeError
    }
    const framesDir = path.join(root, 'frames')
    mkdirSync(framesDir, { recursive: true })
    swapDirFromStaging(staging, framesDir, path.join(root, '.frames-prev'), files)
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
  const settings = normalizeSettings({ ...job.settings, ...overrides })
  const { width, height } = job.frames
  const keyedDir = path.join(jobRoot(home, id), 'keyed')
  // 同样先写临时目录：抠像途中失败时，上一轮的 keyed/ 仍然完好，
  // 不会出现「一半新参数、一半旧参数」的混合结果。
  const keyedStaging = path.join(jobRoot(home, id), '.keyed-staging')
  const keyedBackup = path.join(jobRoot(home, id), '.keyed-prev')
  rmSync(keyedStaging, { recursive: true, force: true })
  mkdirSync(keyedStaging, { recursive: true })
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
    try {
      writeFileSync(path.join(keyedStaging, name), encodePng(result.rgba, width, height))
    } catch (writeError) {
      rmSync(keyedStaging, { recursive: true, force: true })
      throw writeError
    }
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
  // 全部成功后再落位（与抽帧同一套「先备后换」）。
  swapDirFromStaging(keyedStaging, keyedDir, keyedBackup, keyed)

  const fresh = getJob(home, id)
  fresh.settings = { ...fresh.settings, ...settings }
  fresh.frames = { ...fresh.frames, keyed, report, keyedAt: Date.now() }
  fresh.sheet = { status: 'empty' }
  const warn = report.length - totals
  log(fresh, 'info', `抠像完成：${keyed.length} 帧${warn > 0 ? `，${warn} 帧背景占比异常（看 report）` : '，全部可信'}`)
  return writeVideoJob(home, fresh)
}

/* ─────────────────────────────── 合成 ──────────────────────────────────── */

/**
 * 帧数多时自动折行，避免成品图撞上纹理 / 内存上限。
 *
 * ⚠️ 以前只按**宽度**算（maxWidth 8192），高度完全不管 —— 于是
 * 「64 帧 × 格子 2048」会算出 8192×**32768** 的图：既超过 8192 的纹理上限，
 * 单张 RGBA 还要占 1 GB；格子再大一点就直接爆内存。这里宽度和高度一起卡，
 * 并且给总像素数设一道内存闸门。
 *
 * 返回 { layout, columns }；调用方按这个结果铺格子。
 */
export function chooseLayout({ count, cellWidth, maxWidth = 8192, maxHeight = 8192, maxPixels = 64_000_000 }) {
  const n = Math.max(1, Math.floor(Number(count) || 1))
  const cw = Math.max(1, Math.floor(Number(cellWidth) || 1))
  // 宽度方向最多放几个（保持原来的行为）。
  let perRow = Math.max(1, Math.floor(maxWidth / cw))
  // 高度方向也得卡：行数不能多到让整图超高。
  const maxRows = Math.max(1, Math.floor(maxHeight / cw))
  // 内存闸门：总像素（含格子数）不许超过 maxPixels，否则单张就吃掉几 GB。
  const pixelCap = Math.max(1, Math.floor(maxPixels / (cw * cw)))
  const usable = Math.min(n, pixelCap)
  const columns = Math.max(1, Math.min(perRow, usable))
  const rows = Math.ceil(n / columns)
  if (rows > maxRows) {
    // 无论如何都放不下 —— 交给调用方报错，而不是硬撑出一张爆内存的图。
    return { layout: 'grid', columns, tooLarge: true, rows, perFrameLimit: Math.max(1, Math.floor(pixelCap / Math.max(1, maxRows))) }
  }
  if (n <= perRow && n <= columns) return { layout: 'row', columns: n, tooLarge: false, rows: 1 }
  return { layout: 'grid', columns, tooLarge: false, rows }
}

/** 把抠好的帧对齐合成一张透明整图。 */
export async function composeJobSheet(home, id, overrides = {}) {
  const job = getJob(home, id)
  if (!job) throw new Error(`视频作业不存在：${id}`)
  const keyed = job.frames?.keyed ?? []
  if (keyed.length === 0) throw new Error('还没有抠好的帧：先抠像再合成')
  const settings = normalizeSettings({ ...job.settings, ...overrides })
  const { width, height } = job.frames
  const frames = []
  for (const name of keyed) frames.push(await decodePngToRgba(absPath(home, id, `keyed/${name}`), width, height))

  let layout = settings.layout
  let columns = settings.columns
  if (layout === 'auto' || columns <= 0) {
    const chosen = chooseLayout({ count: frames.length, cellWidth: settings.cellWidth, cellHeight: settings.cellHeight })
    if (layout === 'auto') layout = chosen.layout
    if (columns <= 0) columns = chosen.columns
    if (chosen.tooLarge) {
      throw new Error(
        `合成图会太大：${frames.length} 帧 × ${settings.cellWidth}px 格子，`
        + '超过单张上限 8192×8192。\n'
        + `请调小 --cell（建议不超过 ${chosen.perFrameLimit}），或减少帧数（--count），或分多次合成。`,
      )
    }
  } else {
    // 用户显式指定了 layout/columns —— 同样要拦，否则照样能撑爆内存。
    const cellW = Math.max(1, settings.cellWidth)
    const rows = Math.ceil(frames.length / Math.max(1, columns))
    const outW = cellW * Math.max(1, columns)
    const outH = cellW * rows
    if (outW > 8192 || outH > 8192 || outW * outH > 64_000_000) {
      const maxCols = Math.max(1, Math.floor(8192 / cellW))
      throw new Error(
        `按你指定的排布（layout=${layout}, columns=${columns}）算出来是 ${outW}×${outH}，`
        + '超过单张上限 8192×8192。\n'
        + `请把 columns 调到 ${maxCols} 以内，或调小 --cell。`,
      )
    }
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
  // .meta 也走「先写临时名再改名」：Maker 会监听 assets/ 并在构建时读 .meta，
  // 非原子写留下的半截 JSON 会让构建报「meta 损坏」。PNG 已经就位了，
  // 这个窗口正好是最容易被监听到的时机。
  writeFileSync(`${finalPath}.meta.partial`, `${JSON.stringify({ uuid }, null, 2)}\n`, 'utf8')
  renameSync(`${finalPath}.meta.partial`, `${finalPath}.meta`)

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
  const maniPath = path.join(maniDir, `${finalName.replace(/\.png$/, '')}.seq.json`)
  // 同样原子写：这是 Maker 侧的动画描述文件，构建时会读。
  writeFileSync(`${maniPath}.partial`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(`${maniPath}.partial`, maniPath)

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
  if (job.video?.status === 'uncertain') {
    return '②⚠ 上次提交**结果未知**（可能已扣费）：先 /taptap-video status 看台账、/taptap-video poll 继续查；'
      + '确认服务端确实没有该任务后，才用 --yes 重新提交'
  }
  if (job.video?.status === 'empty') return '① 设置首帧（/taptap-video first <图片>）并写提示词（/taptap-video prompt <文字>）'
  if (job.video?.status === 'running') return '② 视频生成中，等它跑完（/taptap-video poll）'
  if (job.video?.status === 'error') return `② 视频失败：${job.video.error}${job.video.hint ? `（${job.video.hint}）` : ''}`
  if (job.video?.status === 'error' || job.video?.status === 'uncertain') {
    return `② 视频未成功：${job.video.error ?? ''}`
  }
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

// 测试专用导出：落位/回滚是本模块的核心正确性逻辑，出错会丢用户素材，
// 但它依赖真实的文件系统时序，用纯文本断言测不到「切换到一半失败」这条路。
// 这里导出供 scripts/verify-frame-safety.mjs 直接驱动。
export const __testSwapDirFromStaging = swapDirFromStaging
export const __testRollbackSwap = rollbackSwap
