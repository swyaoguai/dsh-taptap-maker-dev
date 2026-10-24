/**
 * ffmpeg / ffprobe 媒体层（本地、零计费）。
 *
 * 只做三件「必须要 ffmpeg」的事：
 *   1. 解码成 rawvideo rgba —— 抽帧结果交给 JS 抠像，不需要任何图像库，
 *      也不需要中间 PNG 往返；
 *   2. 探测时长 / 尺寸 / 帧率 —— 决定抽帧采样位置；
 *   3. PNG / JPEG 编码 —— 落盘透明 PNG、首帧压成平台能收的 JPEG。
 *
 * 刻意**不**依赖 game-material-master 插件的任何文件：那个插件是 optional 的，
 * 用户可能没装、可能装完被隐藏，本插件必须自己跑得动。
 *
 * ffmpeg 的定位顺序（Windows 上「装了但没进 PATH」很常见）：
 *   `FFMPEG_PATH` 环境变量 → Windows 注册表同名变量 → WinGet / Scoop /
 *   Chocolatey / Program Files 常见落点 → 裸名字（交给 PATH）。
 *
 * @module src/video-media.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export class MediaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MediaError'
  }
}

/* ─────────────────────────────── 可执行文件定位 ─────────────────────────── */

const resolvedBins = new Map()
const MISS_TTL_MS = 10_000

const expandWindowsEnv = (value) =>
  value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)

/**
 * 读 Windows 注册表里的环境变量。`setx` 只写注册表、不改已经跑起来的进程
 * 环境，所以「设了变量也重启了程序，还是找不到 ffmpeg」在 Windows 上很常见。
 */
function windowsRegistryValue(name) {
  if (process.platform !== 'win32') return undefined
  const keys = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  ]
  for (const key of keys) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', name], {
        encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      })
      const matched = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out)
      const value = matched?.[1]?.trim()
      if (value) return expandWindowsEnv(value)
    } catch { /* 键不存在 / reg 不可用 */ }
  }
  return undefined
}

function windowsBinCandidates(name) {
  const exe = `${name}.exe`
  const local = process.env.LOCALAPPDATA ?? ''
  const profile = process.env.USERPROFILE ?? ''
  const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? ''
  const programData = process.env.ProgramData ?? 'C:\\ProgramData'
  const list = []
  if (local) list.push(path.join(local, 'Microsoft', 'WinGet', 'Links', exe))
  if (profile) list.push(path.join(profile, 'scoop', 'shims', exe))
  if (programData) list.push(path.join(programData, 'chocolatey', 'bin', exe))
  if (programFiles) list.push(path.join(programFiles, 'ffmpeg', 'bin', exe))
  list.push(`C:\\ffmpeg\\bin\\${exe}`, `D:\\ffmpeg\\bin\\${exe}`)
  return list
}

/** WinGet 装出来的包目录（`...\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin`）。 */
function wingetPackageCandidates(name) {
  if (process.platform !== 'win32') return []
  const local = process.env.LOCALAPPDATA ?? ''
  if (!local) return []
  const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages')
  if (!existsSync(packages)) return []
  const out = []
  try {
    for (const pkg of readdirSync(packages)) {
      if (!/^Gyan\.FFmpeg/i.test(pkg)) continue
      const base = path.join(packages, pkg)
      for (const inner of readdirSync(base)) {
        const bin = path.join(base, inner, 'bin', `${name}.exe`)
        if (existsSync(bin)) out.push(bin)
      }
    }
  } catch { /* ignore */ }
  return out
}

function resolveBin(name) {
  const now = Date.now()
  const cached = resolvedBins.get(name)
  if (cached && (cached.hit || now - cached.at < MISS_TTL_MS)) return cached.value
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'
  const envShort = name === 'ffmpeg' ? 'FFMPEG' : 'FFPROBE'
  const candidates = []
  // 双命名：本模块历史上只认 FFMPEG_PATH，音频转换模块只认 FFMPEG ——
  // 用户为一边设的变量对另一边无效。现在两种都接受（_PATH 优先）。
  const fromEnv = process.env[envKey]?.trim() ?? ''
  if (fromEnv) candidates.push(fromEnv)
  const fromEnvShort = process.env[envShort]?.trim() ?? ''
  if (fromEnvShort) candidates.push(fromEnvShort)
  if (process.platform === 'win32') {
    const fromRegistry = windowsRegistryValue(envKey)?.trim() ?? ''
    if (fromRegistry) candidates.push(fromRegistry)
    candidates.push(...wingetPackageCandidates(name))
    candidates.push(...windowsBinCandidates(name))
  }
  const found = candidates.find((c) => path.isAbsolute(c) && existsSync(c))
  const value = found ?? name
  resolvedBins.set(name, { value, hit: found !== undefined, at: now })
  return value
}

export const ffmpegPath = () => resolveBin('ffmpeg')
export const ffprobePath = () => resolveBin('ffprobe')

function missingBinMessage(bin) {
  const extra = process.platform === 'win32'
    ? '插件也会去读注册表里的同名变量，以及 WinGet / Scoop / Chocolatey 的常见安装位置。'
    : '（macOS: brew install ffmpeg）'
  return `找不到 ${bin}。请先安装 ffmpeg，或用 FFMPEG_PATH / FFPROBE_PATH 环境变量指定绝对路径。${extra}`
}

/* ─────────────────────────────── 进程调用 ──────────────────────────────── */

/** 跑一次 ffmpeg/ffprobe；stdout 收成 Buffer，stderr 只留尾部用于报错。 */
function run(bin, args, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new MediaError(`无法启动 ${bin}：${error?.message ?? error}`))
      return
    }
    const out = []
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new MediaError(`${bin} 执行超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8')
      if (err.length > 20_000) err = err.slice(-20_000)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error.code === 'ENOENT') {
        reject(new MediaError(missingBinMessage(bin)))
        return
      }
      reject(new MediaError(`${bin} 启动失败：${error.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new MediaError(`${bin} 退出码 ${code}：${err.trim().split('\n').slice(-6).join(' | ') || '无输出'}`))
        return
      }
      resolve({ stdout: Buffer.concat(out), stderr: err })
    })
  })
}

export const runFfmpeg = (args, timeoutMs) => run(ffmpegPath(), args, timeoutMs)
export const runFfprobe = (args, timeoutMs) => run(ffprobePath(), args, timeoutMs)

/* ─────────────────────────────── 探测 ──────────────────────────────────── */

/** 探测媒体时长（秒）。 */
export async function probeDuration(file) {
  const { stdout } = await runFfprobe([
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], 60_000)
  const seconds = Number.parseFloat(stdout.toString('utf8').trim())
  if (!Number.isFinite(seconds) || seconds <= 0) throw new MediaError(`无法读取媒体时长：${file}`)
  return seconds
}

/** 探测第一路视频流的宽高。 */
export async function probeSize(file) {
  const { stdout } = await runFfprobe([
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x', file,
  ], 60_000)
  const [w, h] = stdout.toString('utf8').trim().split('x').map((v) => Number.parseInt(v, 10))
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new MediaError(`无法读取视频尺寸：${file}`)
  }
  return { width: w, height: h }
}

/** 探测基础帧率（缺失时回退 24）。 */
export async function probeFps(file) {
  const { stdout } = await runFfprobe([
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate,avg_frame_rate',
    '-of', 'default=noprint_wrappers=1', file,
  ], 60_000)
  const text = stdout.toString('utf8')
  const nums = []
  for (const line of text.split('\n')) {
    const m = /^(\w+)=(\d+)\/(\d+)$/.exec(line.trim())
    if (m) {
      const n = Number(m[2])
      const d = Number(m[3])
      if (d > 0 && n > 0 && Number.isFinite(n / d)) nums.push(n / d)
    }
  }
  const fps = nums.find((v) => v > 0 && v < 240) ?? 24
  return Math.max(1, Math.min(240, fps))
}

/** ffmpeg 是否可用；不可用时给出可读原因（设置页 / 自检用）。 */
export async function checkFfmpeg() {
  try {
    const { stdout } = await run(ffmpegPath(), ['-hide_banner', '-version'], 20_000)
    return { ok: true, version: stdout.toString('utf8').split('\n')[0]?.trim() ?? '', path: ffmpegPath() }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), path: ffmpegPath() }
  }
}

/* ─────────────────────────────── PNG 编码 ──────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/**
 * RGBA → PNG（每行用 PNG filter 1 即 «Sub»，比裸 RGBA 小、解码端全支持）。
 * 自己写而不是调 ffmpeg：抠像在 V8 里出像素，再喂给 ffmpeg 走一次 stdin
 * 反而多一层编码器抖动，而且 alpha 会被「yuv 全范围/有限范围」搅一次。
 */
export function encodePng(rgba, width, height) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    const dst = y * (stride + 1)
    raw[dst] = 1 // filter: Sub
    for (let x = 0; x < stride; x += 1) {
      const cur = rgba[rowStart + x]
      const left = x >= 4 ? rgba[rowStart + x - 4] : 0
      raw[dst + 1 + x] = (cur - left) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type RGBA
  ihdr[10] = 0  // compression
  ihdr[11] = 0  // filter
  ihdr[12] = 0  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ─────────────────────────────── 抽帧 ──────────────────────────────────── */

/** 按长边上限与原始比例算工作尺寸；宽高取偶数，规避编码器对奇数尺寸的抱怨。 */
export function workingSize(sourceWidth, sourceHeight, longEdge) {
  const longest = Math.max(sourceWidth, sourceHeight)
  const scale = longest > longEdge ? longEdge / longest : 1
  const even = (v) => Math.max(2, Math.round((v * scale) / 2) * 2)
  return { width: even(sourceWidth), height: even(sourceHeight) }
}

/**
 * 采样时间点。
 *
 * 三种排法，全部**默认避开首尾**：
 *   - `uniform`：按时长等分，取每段的**中点**（`(i+0.5)/n`）。
 *     为什么不是 `i/n`：i=0 正好落在第 0 帧，而那通常是「还没动」的静帧；
 *     `i/(n-1)` 那套又会同时吃到第 0 帧和最后一帧。中点法两头都不碰。
 *   - `first-last`：i=0 取 0，i=n-1 取 (duration - 1/fps)，中间等分。
 *     这是首尾帧模式的自然读法（你给的首帧 / 尾帧都算数），代价是最保守。
 *   - `loop`：前 n-1 帧等分（中点法），最后一帧取「逼近结尾」但在循环里
 *     不重复首帧的位置 —— 用于行走 / 跑步 / 待机这类要无缝循环的动作。
 */
export function planSampleTimes({ duration, fps, count, arrange = 'uniform' }) {
  const n = Math.max(1, Math.round(count))
  const frameDur = 1 / Math.max(1, fps)
  const last = Math.max(0, duration - frameDur)
  const times = []
  if (arrange === 'first-last') {
    for (let i = 0; i < n; i += 1) times.push(n === 1 ? 0 : (last * i) / (n - 1))
  } else if (arrange === 'loop') {
    // 循环：n 个不同帧覆盖一个周期，第 n 个采样点 = 周期末尾但 < duration。
    for (let i = 0; i < n; i += 1) times.push(Math.min(last, (duration * i) / n))
  } else {
    for (let i = 0; i < n; i += 1) times.push(Math.min(last, (duration * (i + 0.5)) / n))
  }
  return times.map((t) => Math.max(0, Number(t.toFixed(4))))
}

/**
 * 按给定时间点精确抽帧（seek + 单帧解码），输出 rawvideo RGBA。
 *
 * 为什么用 `-ss <t> -i ... -frames:v 1` 对每个点各起一次：要的是「第 i 个
 * 采样点就是画面上的这一张」，而不是 fps 滤镜按平均重建出来的近似帧。
 * 每一路只解一帧，代价可忽略；换来的是可以按任意排法重抽（loop / first-last）。
 */
export async function extractFramesAt({
  video, times, longEdge = 768, cropInset = 0, timeoutMs = 300_000,
}) {
  const source = await probeSize(video)
  const size = workingSize(source.width, source.height, Math.max(64, longEdge))
  const inset = Math.max(0, Math.min(0.2, cropInset))
  const chain = []
  if (inset > 0) {
    chain.push(`crop=iw*${(1 - 2 * inset).toFixed(4)}:ih*${(1 - 2 * inset).toFixed(4)}`)
  }
  chain.push(`scale=${size.width}:${size.height}:flags=lanczos`)
  chain.push('format=rgba')
  const vf = chain.join(',')
  const expected = size.width * size.height * 4
  const frames = []
  for (const t of times) {
    const { stdout } = await run(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(t), '-i', video,
      '-vf', vf,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ], timeoutMs)
    if (stdout.length < expected) {
      throw new MediaError(
        `第 ${frames.length + 1} 帧（t=${t}s）解码失败：期望 ${expected} 字节，实际 ${stdout.length}`,
      )
    }
    frames.push(Buffer.from(stdout.subarray(0, expected)))
  }
  if (frames.length === 0) throw new MediaError(`没有抽到任何帧：${video}`)
  return { frames, width: size.width, height: size.height }
}

/**
 * 把一张图转成 JPEG Data URI（给视频平台当首 / 尾帧）。
 * 同时落一份 JPEG 到 `jpegOut`，出问题时能看见「模型到底收到了什么」。
 *
 * 平台对首尾帧的要求（官方文档）：短边 > 300px、长宽比在 2:5 ~ 5:2 之间、
 * 小于 20MB。这里先把长边压到 maxEdge，再按平台比例边界**补边而不是裁切**
 * （裁切会切掉角色的手脚，补边上色反而无害）。
 */
export async function toJpegDataUri(source, jpegOut, { maxEdge = 1280, quality = 3 } = {}) {
  const { width, height } = await probeSize(source)
  const ratio = width / height
  // 2:5 = 0.4，5:2 = 2.5。超出就按极限比例补边到居中的黑底。
  let targetW = width
  let targetH = height
  if (ratio < 0.4) targetW = Math.round(height * 0.4)
  else if (ratio > 2.5) targetH = Math.round(width / 2.5)
  const pad = targetW !== width || targetH !== height
  const vf = [
    pad ? `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black` : null,
    `scale='min(${maxEdge},iw)':-2:flags=lanczos`,
  ].filter(Boolean).join(',')
  await run(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-vf', vf,
    '-q:v', String(quality),
    '-frames:v', '1',
    '-f', 'image2', '-update', '1',
    jpegOut,
  ], 120_000)
  const bytes = readFileSync(jpegOut)
  return {
    dataUri: `data:image/jpeg;base64,${bytes.toString('base64')}`,
    bytes: bytes.length,
    width: targetW,
    height: targetH,
    padded: pad,
  }
}

/** 生成一张等比缩放 / 水印用的缩略图（透明背景保持透明）。 */
export async function makeThumbnail(source, dest, maxEdge = 512) {
  await run(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-vf', `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
    '-pix_fmt', 'rgba', dest,
  ], 120_000)
}

/** 把一串透明 PNG 编成 GIF（预览用；GIF 只有二值 alpha，只作草稿看）。 */
export async function encodePreviewGif(pngFiles, dest, { fps = 12, maxEdge = 512 } = {}) {
  // ffmpeg 的 image2 需要连续文件名，所以走 concat demuxer 吃一份列表文件。
  const listFile = path.join(path.dirname(dest), `__preview_${Date.now()}.txt`)
  writeFileSync(listFile, pngFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
  try {
    await run(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `scale='min(${maxEdge},iw)':-2:flags=lanczos,fps=${fps}`,
      '-loop', '0', dest,
    ], 180_000)
  } finally {
    try { rmSync(listFile, { force: true }) } catch { /* ignore */ }
  }
  return dest
}

/** 按扩展名猜 mime（首帧 / 参考图上传用）。 */
export function mimeOf(file) {
  const lower = String(file).toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.webm')) return 'video/webm'
  return 'application/octet-stream'
}
