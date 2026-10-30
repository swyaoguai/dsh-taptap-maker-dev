import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { dataDir } from './paths.js'

const fsp = fs.promises
const MiB = 1024 * 1024
const CODEC_PATH = fileURLToPath(new URL('./reference-image-codec.py', import.meta.url))
export const REFERENCE_POLICY_VERSION = 'ref-upload-v2'
export const DEFAULT_REFERENCE_POLICY = Object.freeze({
  maxEdge: 2048, maxBytes: MiB, maxTotalBytes: 8 * MiB,
  // Decoding/transposing retains more than one pixel buffer; default to a
  // conservative 32 MP rather than treating a 100 MP decode as only 400 MiB.
  maxInputBytes: 64 * MiB, maxInputPixels: 32_000_000, maxCount: 16,
  minEdge: 384, outputFormat: 'webp',
  acceptedMimes: Object.freeze(['image/png', 'image/jpeg', 'image/webp']),
})
// These are local optimisation targets, NOT claims about upstream request limits.
export const REFERENCE_LANE_POLICIES = Object.freeze({
  gptWeb: Object.freeze({ maxEdge: 2048, maxBytes: MiB, maxTotalBytes: 8 * MiB, outputFormat: 'webp' }),
  // Unknown /images/edits relays may only accept PNG (e.g. DALL·E 2-compatible APIs).
  relayImage: Object.freeze({ maxEdge: 2048, maxBytes: 4 * MiB, maxTotalBytes: 16 * MiB, outputFormat: 'png', acceptedMimes: Object.freeze(['image/png']) }),
  zaiduyu: Object.freeze({ maxEdge: 3072, maxBytes: 2 * MiB, maxTotalBytes: 16 * MiB, outputFormat: 'webp' }),
})
const EXTENSIONS = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' })

function preflightError(code, message) {
  return Object.assign(new Error(message), { code, kind: 'input', phase: 'preflight', submitted: false, requiresLogin: false })
}
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const envValue = (name) => process.env[name]?.trim() || undefined

export function expandReferencePath(raw) {
  const value = String(raw ?? '')
  if (value === '~') return os.homedir()
  return path.resolve(/^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value)
}
function comparisonPath(raw) {
  const absolute = expandReferencePath(raw)
  let resolved = absolute
  try { resolved = fs.realpathSync.native(absolute) }
  catch {
    try { resolved = path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute)) }
    catch { /* unresolved new output: compare normalised absolute path */ }
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
export function assertReferenceOutputIsSeparate(outputPath, references) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) return
  const output = comparisonPath(outputPath)
  let outputStat
  try { outputStat = fs.statSync(output, { bigint: true }) } catch { /* new output */ }
  for (const ref of references ?? []) {
    let refStat
    try { refStat = fs.statSync(expandReferencePath(ref), { bigint: true }) } catch { /* checked by prepare */ }
    const hardlink = outputStat && refStat && outputStat.ino !== 0n
      && outputStat.dev === refStat.dev && outputStat.ino === refStat.ino
    if (output === comparisonPath(ref) || hardlink) {
      throw preflightError('reference_output_alias', `输出路径不能覆盖参考图原文件：${expandReferencePath(ref)}。请换一个 --out；未提交生成。`)
    }
  }
}
export function referenceImageCacheDir(dshHome) {
  return path.join(dataDir(dshHome), 'reference-images', REFERENCE_POLICY_VERSION)
}
function boundedInt(value, fallback, name, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (typeof value === 'boolean' || !Number.isInteger(number) || number < min || number > max) {
    throw preflightError('invalid_reference_policy', `${name} 需要 ${min}~${max} 的整数。`)
  }
  return number
}
function resolvePolicy(options, count) {
  if (options.lane !== undefined && !Object.hasOwn(REFERENCE_LANE_POLICIES, options.lane)) {
    throw preflightError('invalid_reference_policy', `未知参考图通道：${options.lane}`)
  }
  const defaults = { ...DEFAULT_REFERENCE_POLICY, ...REFERENCE_LANE_POLICIES[options.lane] }
  const maxEdge = boundedInt(options.maxEdge ?? envValue('TAPTAP_IMAGE_REF_MAX_EDGE'), defaults.maxEdge, '参考图最长边', 256, 8192)
  const maxBytes = boundedInt(options.maxBytes ?? envValue('TAPTAP_IMAGE_REF_MAX_BYTES'), defaults.maxBytes, '参考图单张体积', 65536, 20 * MiB)
  const maxTotalBytes = boundedInt(options.maxTotalBytes ?? envValue('TAPTAP_IMAGE_REF_MAX_TOTAL_BYTES'), defaults.maxTotalBytes, '参考图总量', 65536, 64 * MiB)
  const maxInputBytes = boundedInt(options.maxInputBytes, defaults.maxInputBytes, '本地输入体积', MiB, 128 * MiB)
  const maxInputPixels = boundedInt(options.maxInputPixels, defaults.maxInputPixels, '本地输入像素', MiB, 256 * MiB)
  const maxCount = boundedInt(options.maxCount, defaults.maxCount, '参考图张数', 1, 32)
  const minEdge = boundedInt(options.minEdge, Math.min(defaults.minEdge, maxEdge), '最小处理长边', 128, maxEdge)
  const outputFormat = options.outputFormat ?? defaults.outputFormat
  const acceptedMimes = options.acceptedMimes ?? defaults.acceptedMimes
  if (!['png', 'webp'].includes(outputFormat) || !Array.isArray(acceptedMimes) || !acceptedMimes.length
      || acceptedMimes.some((mime) => !Object.hasOwn(EXTENSIONS, mime)) || !acceptedMimes.includes(`image/${outputFormat}`)) {
    throw preflightError('invalid_reference_policy', '上传 MIME 仅支持 PNG/JPEG/WebP，且必须包含所选 PNG/WebP 输出格式。')
  }
  if (count > maxCount) throw preflightError('too_many_reference_images', `参考图最多 ${maxCount} 张，当前 ${count} 张；未提交生成。`)
  const perFileTarget = Math.min(maxBytes, Math.floor(maxTotalBytes / Math.max(1, count)))
  if (perFileTarget < 65536) throw preflightError('reference_aggregate_budget_too_small', '总量预算不足以为每张参考图保留 64 KiB；请减少张数或调整预算。')
  const policy = { version: REFERENCE_POLICY_VERSION, maxEdge, maxBytes, maxTotalBytes, maxInputBytes,
    maxInputPixels, maxCount, minEdge, perFileTarget, outputFormat, outputMime: `image/${outputFormat}`,
    acceptedMimes: [...new Set(acceptedMimes)].sort() }
  return { ...policy, policyKey: sha256(JSON.stringify(policy)).slice(0, 20) }
}

/** Bounded header sniff ONLY. Every new source is subsequently fully decoded. */
export function inspectReferenceImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
    let offset = 8, animated = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), name = bytes.toString('ascii', offset + 4, offset + 8)
      if (offset + length + 12 > bytes.length) return null
      if (name === 'acTL') animated = true
      offset += length + 12
    }
    return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), hasAlpha: [4, 6].includes(bytes[25]), animated }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) continue
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      if (offset + 2 > bytes.length) return null
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) return null
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { mime: 'image/jpeg', height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5), hasAlpha: false, animated: false }
      }
      offset += length
    }
    return null
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { mime: 'image/webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), hasAlpha: !!(bytes[20] & 0x10), animated: !!(bytes[20] & 2) }
    if (kind === 'VP8L') {
      const bits = bytes.readUInt32LE(21)
      return { mime: 'image/webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff), hasAlpha: !!(bits & 0x10000000), animated: false }
    }
    if (kind === 'VP8 ') return { mime: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, hasAlpha: false, animated: false }
    return null
  }
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    return { mime: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), hasAlpha: null, animated: null }
  }
  if (bytes.toString('ascii', 0, 2) === 'BM' && bytes.length >= 26) {
    const dib = bytes.readUInt32LE(14)
    return { mime: 'image/bmp', width: dib === 12 ? bytes.readUInt16LE(18) : Math.abs(bytes.readInt32LE(18)),
      height: dib === 12 ? bytes.readUInt16LE(20) : Math.abs(bytes.readInt32LE(22)), hasAlpha: null, animated: false }
  }
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const end = Math.min(bytes.readUInt32BE(0), bytes.length)
    for (let offset = 8; offset + 4 <= end; offset += 4) {
      if (offset === 12) continue // minor version, not a brand
      const brand = bytes.toString('ascii', offset, offset + 4)
      if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', width: null, height: null, hasAlpha: null, animated: brand === 'avis' }
    }
  }
  return null
}
function assertDimensions(info, policy) {
  if (info.width === null || info.height === null) return // decoder must resolve before acceptance
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width <= 0 || info.height <= 0
      || info.width > 32768 || info.height > 32768 || info.width * info.height > policy.maxInputPixels) {
    throw preflightError('reference_image_dimensions_exceeded', '参考图尺寸无效或超过本地安全像素上限；未提交生成。')
  }
}

/** Read a bounded snapshot through one handle; never reopen the user path for processing. */
async function readBounded(file, maxBytes) {
  const handle = await fsp.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('file size/type outside limit')
    const data = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== stat.size) throw new Error('file changed while reading')
    return data.subarray(0, offset)
  } finally { await handle.close() }
}

/** No shell, no output-file arguments. A late worker cannot mutate any cache file. */
function runProcess(bin, args, { input = Buffer.alloc(0), timeoutMs, maxOutputBytes = 65536 } = {}) {
  return new Promise((resolve) => {
    const stdout = [], stderr = []
    let child, timer, grace, done = false, outSize = 0, errSize = 0, stopped = null
    const finish = (status, error = null) => {
      if (done) return
      done = true; clearTimeout(timer); clearTimeout(grace)
      resolve({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), error, stopped })
    }
    const stop = (reason) => {
      if (stopped || done) return
      stopped = reason
      try { child.kill('SIGKILL') } catch { /* close/error handles this */ }
      // Normally wait for close. Bound an unresponsive local OS/child as well.
      grace = setTimeout(() => finish(-1), 3000)
    }
    try { child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch (error) { finish(-1, error); return }
    child.on('error', (error) => finish(-1, error))
    child.on('close', (code) => finish(code ?? -1))
    child.stdout.on('data', (chunk) => {
      outSize += chunk.length
      if (outSize <= maxOutputBytes) stdout.push(Buffer.from(chunk))
      else stop('output_limit')
    })
    child.stderr.on('data', (chunk) => {
      if (errSize < 65536) stderr.push(Buffer.from(chunk).subarray(0, 65536 - errSize))
      errSize += chunk.length
    })
    child.stdin.on('error', () => { /* early worker rejection can close stdin; read its result */ })
    child.stdin.end(input)
    timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs))
  })
}
function remaining(deadline) {
  const ms = deadline - Date.now()
  if (ms <= 0) throw preflightError('reference_preprocess_timeout', '本地参考图处理超时；未提交生成。')
  return ms
}
function assertProcessAllowed(result) {
  if (['EPERM', 'EACCES'].includes(result.error?.code)) {
    throw preflightError('reference_processor_blocked', '本地安全策略阻止图片处理器启动；请检查当前客户端权限。未尝试其它执行方式，未提交生成。')
  }
}
const probeCache = new Map()
async function probe(bin, kind, deadline) {
  const key = `${kind}:${bin}`
  const hit = probeCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  const args = kind === 'pillow'
    ? ['-c', 'import json,PIL; from PIL import Image,features; Image.init(); supported=features.get_supported(); needs={"PNG":"zlib","JPEG":"jpg","WEBP":"webp"}; formats=[name for name in ("PNG","JPEG","WEBP","GIF","BMP","AVIF") if name in Image.OPEN and (name not in needs or needs[name] in supported)]; print(json.dumps({"version":PIL.__version__,"webp":features.check("webp"),"resampling":hasattr(Image,"Resampling"),"formats":formats}))']
    : ['-version']
  const r = await runProcess(bin, args, { timeoutMs: Math.min(4000, remaining(deadline)) })
  assertProcessAllowed(r)
  let value = null
  if (r.status === 0 && !r.stopped) {
    if (kind === 'pillow') {
      try { const detail = JSON.parse(r.stdout.toString('utf8')); if (detail.resampling) value = { bin, kind, ...detail } } catch { /* not Pillow */ }
    } else {
      const version = r.stdout.toString('utf8').split(/\r?\n/).find((line) => /ImageMagick/i.test(line))
      if (version) value = { bin, kind, version }
    }
  }
  // A just-installed/fixed tool is discoverable without restarting the host.
  probeCache.set(key, { value, expires: Date.now() + (value ? 60000 : 2000) })
  return value
}
function candidates(configured, defaults) {
  const values = configured ?? defaults
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
    throw preflightError('invalid_reference_policy', '本地处理器路径必须是非空字符串数组。')
  }
  return [...new Set(values)]
}
async function selectProcessor(options, policy, deadline, inputMime) {
  const inputFormat = inputMime === 'image/jpeg' ? 'JPEG' : inputMime?.slice(6).toUpperCase()
  const python = candidates(options.pythonBins, [envValue('TAPTAP_PY'), envValue('PYTHON'), 'python', 'python3', 'py'].filter(Boolean))
  for (const bin of python) {
    const tool = await probe(bin, 'pillow', deadline)
    if (tool && tool.formats?.includes(inputFormat) && (policy.outputFormat !== 'webp' || tool.webp)) return tool
  }
  // On Windows, convert.exe is a disk utility, not ImageMagick.
  const magick = candidates(options.imageMagickBins, [envValue('TAPTAP_IMAGE_MAGICK'), 'magick', ...(process.platform === 'win32' ? [] : ['convert'])].filter(Boolean))
  for (const bin of magick) { const tool = await probe(bin, 'magick', deadline); if (tool) return tool }
  throw preflightError('reference_preprocess_unavailable', '参考图需要本地解码校验，但未找到可用的 Python Pillow / ImageMagick。请配置现有处理器后重试；未安装依赖、未提交生成。')
}
function assertWorkerResult(result) {
  assertProcessAllowed(result)
  if (result.stopped === 'timeout') throw preflightError('reference_preprocess_timeout', '本地参考图处理超时；未提交生成。')
  if (result.stopped) throw preflightError('reference_preprocess_failed', '本地处理器输出超出安全限制；未提交生成。')
}
async function preparePillow(bytes, policy, tool, deadline) {
  const r = await runProcess(tool.bin, [CODEC_PATH, JSON.stringify(policy)], { input: bytes, timeoutMs: remaining(deadline), maxOutputBytes: Math.ceil(policy.perFileTarget * 4 / 3) + MiB })
  assertWorkerResult(r)
  let result
  try { result = JSON.parse(r.stdout.toString('utf8')) } catch { /* report below */ }
  if (result?.ok === false) {
    const code = typeof result.code === 'string' && /^reference_|^animated_reference_|^unsupported_reference_/.test(result.code)
      ? result.code : 'reference_preprocess_failed'
    throw preflightError(code, `${result.message || '参考图处理失败'}；未提交生成。`)
  }
  if (r.status !== 0 || result?.ok !== true) throw preflightError('reference_preprocess_failed', '本地 Pillow 处理器异常退出；未提交生成。')
  return { ...result, bytes: result.changed ? Buffer.from(result.dataBase64 ?? '', 'base64') : bytes, tool: 'Pillow', toolVersion: tool.version }
}
const IM_MIMES = { PNG: 'image/png', JPEG: 'image/jpeg', JPG: 'image/jpeg', WEBP: 'image/webp', GIF: 'image/gif', BMP: 'image/bmp', AVIF: 'image/avif', HEIC: 'image/avif' }
function imLimits(deadline) {
  return ['-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'disk', '0', '-limit', 'time', String(Math.max(1, Math.ceil(remaining(deadline) / 1000)))]
}
async function imMetadata(bytes, policy, tool, deadline) {
  const r = await runProcess(tool.bin, [...imLimits(deadline), '-', '-format', '%m|%w|%h|%[opaque]|%[orientation]\n', 'info:'], { input: bytes, timeoutMs: remaining(deadline) })
  assertWorkerResult(r)
  if (r.status !== 0) throw preflightError('reference_decode_failed', 'ImageMagick 无法完整解码参考图；未提交生成。')
  const lines = r.stdout.toString('utf8').trim().split(/\r?\n/)
  if (lines.length !== 1) throw preflightError('animated_reference_unsupported', '动画参考图需先导出静态帧；未提交生成。')
  const [format, width, height, opaque, orientation] = lines[0].split('|')
  if (!IM_MIMES[format] || !['true', 'false'].includes(opaque?.toLowerCase())) throw preflightError('reference_decode_failed', 'ImageMagick 图片元数据无效；未提交生成。')
  const info = { mime: IM_MIMES[format], width: Number(width), height: Number(height), hasAlpha: opaque.toLowerCase() === 'false', animated: false, orientation }
  assertDimensions(info, policy)
  return info
}
async function prepareMagick(bytes, policy, tool, deadline) {
  const source = await imMetadata(bytes, policy, tool, deadline)
  const reasons = []
  if (bytes.length > policy.perFileTarget) reasons.push('bytes')
  if (Math.max(source.width, source.height) > policy.maxEdge) reasons.push('dimensions')
  if (!policy.acceptedMimes.includes(source.mime)) reasons.push('format')
  if (!['Undefined', 'TopLeft', '1', '0'].includes(source.orientation)) reasons.push('orientation')
  if (!reasons.length) return { bytes, source, output: source, changed: false, reason: 'passthrough', tool: 'ImageMagick', toolVersion: tool.version }
  let edge = Math.min(policy.maxEdge, Math.max(source.width, source.height))
  const floor = Math.min(edge, policy.minEdge)
  while (true) {
    for (const quality of policy.outputFormat === 'webp' ? [86, 80, 74, 68, 62, 56, 50] : [0]) {
      const formatArgs = policy.outputFormat === 'webp'
        ? ['-quality', String(quality), '-define', 'webp:method=4', 'webp:-']
        : ['-define', 'png:compression-level=9', 'png:-']
      const r = await runProcess(tool.bin, [...imLimits(deadline), '-', '-auto-orient', '-strip', '-resize', `${edge}x${edge}>`, ...formatArgs],
        { input: bytes, timeoutMs: remaining(deadline), maxOutputBytes: Math.min(128 * MiB, edge * edge * 8 + MiB) })
      assertWorkerResult(r)
      if (r.status !== 0) throw preflightError('reference_preprocess_failed', 'ImageMagick 转码失败；未提交生成。')
      if (r.stdout.length > policy.perFileTarget) continue
      const output = await imMetadata(r.stdout, policy, tool, deadline)
      return { bytes: r.stdout, source, output, changed: true, reason: reasons.join('+'), quality: quality || null, tool: 'ImageMagick', toolVersion: tool.version }
    }
    if (edge <= floor) break
    edge = Math.max(floor, Math.floor(edge * 0.82))
  }
  throw preflightError('reference_budget_exceeded', '已达到最小处理尺寸，仍无法满足参考图上传体积限制；未提交生成。')
}
function validatePrepared(record, bytes, policy) {
  const info = inspectReferenceImage(bytes)
  const { source, output } = record
  if (!source || !output || !info || !policy.acceptedMimes.includes(info.mime) || info.mime !== output.mime
      || !bytes.length || bytes.length > policy.perFileTarget || info.animated || output.animated
      || !Number.isInteger(output.width) || !Number.isInteger(output.height)
      || info.width !== output.width || info.height !== output.height
      || Math.max(output.width, output.height) > policy.maxEdge || output.width <= 0 || output.height <= 0
      || typeof source.hasAlpha !== 'boolean' || typeof output.hasAlpha !== 'boolean'
      || (source.hasAlpha && !output.hasAlpha)) {
    throw preflightError('reference_preprocess_failed', '参考图结果未通过格式、尺寸、体积或透明度校验；未提交生成。')
  }
  assertDimensions(source, policy)
  assertDimensions(output, policy)
}

// Each file is fsynced then atomically linked into place without replacement.
// Work files are deliberately retained: winners share a hardlink, while a
// concurrent loser may retain an independent payload. No automatic deletion.
async function publishExclusive(target, bytes) {
  const pending = path.join(path.dirname(target), `.pending-${crypto.randomUUID()}`)
  const handle = await fsp.open(pending, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  try { await fsp.link(pending, target) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
async function cachedEntry(cacheDir, key, sourceDigest, policy) {
  const manifest = path.join(cacheDir, 'entries', `${key}.json`)
  try { await fsp.lstat(manifest) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  try {
    if ((await fsp.lstat(manifest)).isSymbolicLink()) throw new Error('manifest symlink')
    const record = JSON.parse((await readBounded(manifest, 64 * 1024)).toString('utf8'))
    const expectedName = `${record.uploadSha256}${EXTENSIONS[record.output?.mime]}`
    if (record.version !== REFERENCE_POLICY_VERSION || record.policyKey !== policy.policyKey || record.sourceSha256 !== sourceDigest
        || !/^[a-f0-9]{64}$/.test(record.uploadSha256) || record.file !== expectedName || !record.tool || !record.toolVersion) throw new Error('manifest mismatch')
    const uploadPath = path.join(cacheDir, 'images', expectedName)
    if ((await fsp.lstat(uploadPath)).isSymbolicLink()) throw new Error('image symlink')
    const bytes = await readBounded(uploadPath, policy.perFileTarget)
    if (bytes.length !== record.uploadBytes || sha256(bytes) !== record.uploadSha256) throw new Error('digest mismatch')
    validatePrepared(record, bytes, policy)
    return { ...record, uploadPath }
  } catch {
    throw preflightError('reference_cache_corrupt', '参考图缓存不完整或校验不符，已保留现场且停止上传。请检查缓存或指定新的缓存目录；未覆盖缓存，未提交生成。')
  }
}
const inFlight = new Map()
async function prepareCached(cacheDir, key, bytes, sourceDigest, policy, options, deadline) {
  const cached = await cachedEntry(cacheDir, key, sourceDigest, policy)
  if (cached) return { ...cached, cacheHit: true }
  const flightKey = path.join(cacheDir, key)
  if (inFlight.has(flightKey)) return { ...await inFlight.get(flightKey), cacheHit: true }
  const work = (async () => {
    const tool = await selectProcessor(options, policy, deadline, inspectReferenceImage(bytes)?.mime)
    const prepared = tool.kind === 'pillow' ? await preparePillow(bytes, policy, tool, deadline) : await prepareMagick(bytes, policy, tool, deadline)
    validatePrepared(prepared, prepared.bytes, policy)
    const uploadSha256 = sha256(prepared.bytes)
    const file = `${uploadSha256}${EXTENSIONS[prepared.output.mime]}`
    const record = { version: REFERENCE_POLICY_VERSION, policyKey: policy.policyKey, sourceSha256: sourceDigest, uploadSha256,
      uploadBytes: prepared.bytes.length, file, source: prepared.source, output: prepared.output,
      changed: prepared.changed, reason: prepared.reason, tool: prepared.tool, toolVersion: prepared.toolVersion, quality: prepared.quality ?? null }
    await publishExclusive(path.join(cacheDir, 'images', file), prepared.bytes)
    await publishExclusive(path.join(cacheDir, 'entries', `${key}.json`), Buffer.from(JSON.stringify(record)))
    // A concurrent process may have won. Read its complete entry, never overwrite.
    return await cachedEntry(cacheDir, key, sourceDigest, policy)
  })()
  inFlight.set(flightKey, work)
  try { return { ...await work, cacheHit: false } } finally { inFlight.delete(flightKey) }
}
function formatBytes(bytes) { return bytes >= MiB ? `${(bytes / MiB).toFixed(2)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB` }
export function publicReferencePreparation(preparation) {
  return { version: REFERENCE_POLICY_VERSION, changedCount: preparation.changedCount, originalTotalBytes: preparation.originalTotalBytes,
    uploadTotalBytes: preparation.uploadTotalBytes, policy: { key: preparation.policy.policyKey, maxBytes: preparation.policy.maxBytes,
      maxTotalBytes: preparation.policy.maxTotalBytes, maxEdge: preparation.policy.maxEdge, outputFormat: preparation.policy.outputFormat,
      acceptedMimes: preparation.policy.acceptedMimes },
    items: preparation.items.map((item) => ({ name: path.basename(item.originalPath), changed: item.changed, reason: item.reason,
      cacheHit: item.cacheHit, tool: item.tool, toolVersion: item.toolVersion,
      source: { sha256: item.sourceSha256, bytes: item.originalBytes, mime: item.originalMime, width: item.originalWidth, height: item.originalHeight, hasAlpha: item.originalHasAlpha },
      upload: { sha256: item.uploadSha256, bytes: item.uploadBytes, mime: item.mime, width: item.outputWidth, height: item.outputHeight, hasAlpha: item.hasAlpha } })) }
}

/** Fully decode local references, then prepare immutable upload snapshots. Never submit or install anything. */
export async function prepareReferenceImages(inputPaths, options = {}) {
  if (!Array.isArray(inputPaths) || inputPaths.some((value) => typeof value !== 'string' || !value.trim())) {
    throw preflightError('invalid_reference_path', '参考图必须是非空本地路径组成的数组；未提交生成。')
  }
  const policy = resolvePolicy(options, inputPaths.length)
  if (!inputPaths.length) return { items: [], changedCount: 0, originalTotalBytes: 0, uploadTotalBytes: 0, policy, notes: [] }
  const timeout = boundedInt(options.processorTimeoutMs, 120000, '本地处理总超时', 1000, 300000)
  const deadline = Date.now() + timeout
  const files = []
  let totalInputBytes = 0
  for (const raw of inputPaths) {
    const originalPath = expandReferencePath(raw)
    let stat
    try { stat = await fsp.stat(originalPath) } catch { /* fail clearly before any processor call */ }
    if (!stat?.isFile()) throw preflightError('missing_reference', `参考图不存在或不是文件：${originalPath}`)
    if (!stat.size) throw preflightError('empty_reference_image', `参考图为空：${path.basename(originalPath)}`)
    totalInputBytes += stat.size
    if (stat.size > policy.maxInputBytes || totalInputBytes > 256 * MiB) throw preflightError('reference_input_too_large', '参考图超出本地读取上限（单张受策略限制，整组最多 256 MiB）；未提交生成。')
    files.push(originalPath)
  }
  const cacheDir = expandReferencePath(options.cacheDir ?? envValue('TAPTAP_IMAGE_REFERENCE_CACHE') ?? referenceImageCacheDir(options.dshHome))
  const items = []
  let snapshotTotalBytes = 0
  try {
    await fsp.mkdir(path.join(cacheDir, 'entries'), { recursive: true, mode: 0o700 })
    await fsp.mkdir(path.join(cacheDir, 'images'), { recursive: true, mode: 0o700 })
    for (const originalPath of files) {
      // Path stats can become stale. Bound each fresh handle read by the
      // remaining batch budget, and account for the actual immutable snapshot.
      const remainingInputBytes = 256 * MiB - snapshotTotalBytes
      if (remainingInputBytes <= 0) throw preflightError('reference_input_too_large', '参考图实际输入已达到整组 256 MiB 上限；未提交生成。')
      let bytes
      try { bytes = await readBounded(originalPath, Math.min(policy.maxInputBytes, remainingInputBytes)) }
      catch { throw preflightError('reference_read_failed', `参考图读取失败、超出剩余输入预算或读取时发生变化：${path.basename(originalPath)}；未提交生成。`) }
      snapshotTotalBytes += bytes.length
      if (snapshotTotalBytes > 256 * MiB) throw preflightError('reference_input_too_large', '参考图实际输入超出整组 256 MiB 上限；未提交生成。')
      const info = inspectReferenceImage(bytes)
      if (!info) throw preflightError('unsupported_reference_image', `参考图不是可识别的 PNG/JPEG/WebP/GIF/BMP/AVIF：${path.basename(originalPath)}；未提交生成。`)
      if (info.animated) throw preflightError('animated_reference_unsupported', '动画参考图需先导出需要的静态帧；未提交生成。')
      assertDimensions(info, policy)
      const sourceDigest = sha256(bytes)
      const entry = await prepareCached(cacheDir, `${sourceDigest}-${policy.policyKey}`, bytes, sourceDigest, policy, options, deadline)
      const ext = path.extname(originalPath).toLowerCase()
      const renamed = ext !== EXTENSIONS[entry.output.mime] && !(entry.output.mime === 'image/jpeg' && ext === '.jpeg')
      items.push({ originalPath, uploadPath: entry.uploadPath, originalBytes: bytes.length, uploadBytes: entry.uploadBytes,
        sourceSha256: sourceDigest, uploadSha256: entry.uploadSha256, changed: entry.changed, cacheHit: entry.cacheHit,
        reason: entry.reason + (renamed && !entry.changed ? '+extension' : ''), tool: entry.tool, toolVersion: entry.toolVersion,
        originalMime: entry.source.mime, originalWidth: entry.source.width, originalHeight: entry.source.height,
        originalHasAlpha: entry.source.hasAlpha, mime: entry.output.mime, outputWidth: entry.output.width,
        outputHeight: entry.output.height, hasAlpha: entry.output.hasAlpha })
    }
  } catch (error) {
    if (error?.phase === 'preflight') throw error
    throw preflightError('reference_cache_unavailable', '无法安全创建/读取本地参考图快照缓存；未提交生成。')
  }
  const originalTotalBytes = items.reduce((sum, item) => sum + item.originalBytes, 0)
  const uploadTotalBytes = items.reduce((sum, item) => sum + item.uploadBytes, 0)
  if (uploadTotalBytes > policy.maxTotalBytes) throw preflightError('reference_aggregate_too_large', '参考图总量仍超出上传预算；未提交生成。')
  const changedCount = items.filter((item) => item.changed).length
  const notes = [changedCount
    ? `参考图上传前已本地规范化 ${changedCount}/${items.length} 张：${formatBytes(originalTotalBytes)} → ${formatBytes(uploadTotalBytes)}；原图未覆盖。`
    : `参考图 ${items.length} 张已本地校验，上传使用内容一致的快照；原图未覆盖。`]
  return { items, changedCount, originalTotalBytes, uploadTotalBytes, policy, cacheDir, notes }
}
