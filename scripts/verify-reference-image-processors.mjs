// Offline processor/failure contract tests. No real ImageMagick, network or generation.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import vm from 'node:vm'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

function png(w, h) {
  const chunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    let c = 0xffffffff
    for (const byte of Buffer.concat([name, data])) {
      c ^= byte
      for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0)
    }
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, name, data, crc])
  }
  const header = Buffer.alloc(13), rows = Buffer.alloc((w * 3 + 1) * h, 100)
  header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2
  for (let y = 0; y < h; y++) rows[y * (w * 3 + 1)] = 0
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reference-processors-'))
const source = path.join(scratch, 'original-[0]-中文.png')
const sourceBytes = png(1024, 32), outputBytes = png(512, 16)
fs.writeFileSync(source, sourceBytes, { flag: 'wx' })
// This is a sniff-only fixture: its decoder result is supplied by the mocked IM.
const avifBytes = Buffer.from('00000020667479706176696600000000617669666d6966310000000000000000', 'hex')
const avifSource = path.join(scratch, 'optional-codec.avif')
fs.writeFileSync(avifSource, avifBytes, { flag: 'wx' })
const originalSpawn = childProcess.spawn
let calls = [], killed = 0, mode = 'success'
childProcess.spawn = (bin, args, options) => {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
  const call = { bin, args, options, input: [] }; calls.push(call)
  child.stdin.on('data', (data) => call.input.push(Buffer.from(data)))
  let closed = false
  const finish = (out, code = 0, error) => {
    if (closed) return
    closed = true
    if (error) child.emit('error', error)
    if (out) child.stdout.write(out)
    child.stdout.end(); child.stderr.end(); child.emit('close', code)
  }
  child.kill = () => { killed++; queueMicrotask(() => finish('', -1)); return true }
  child.stdin.on('finish', () => queueMicrotask(() => {
    if (bin === 'blocked-tool') return finish('', -1, Object.assign(new Error('blocked'), { code: 'EPERM' }))
    if (bin === 'missing-tool') return finish('', -1, Object.assign(new Error('missing'), { code: 'ENOENT' }))
    if (args.includes('-version')) return finish('Version: ImageMagick 7.1.1 Q16 test-only\n')
    if (args[0] === '-c') return finish(JSON.stringify({ version: '12.3.0-test', webp: true, resampling: true,
      formats: bin === 'pillow-png-only' ? ['PNG'] : ['PNG', 'JPEG', 'WEBP', 'GIF', 'BMP', 'AVIF'] }))
    const input = Buffer.concat(call.input)
    if (mode === 'timeout') return
    if (args.includes('info:')) {
      const sourceImage = input.equals(sourceBytes) || input.equals(avifBytes)
      return finish(`${input.equals(avifBytes) ? 'AVIF' : 'PNG'}|${sourceImage ? 1024 : 512}|${sourceImage ? 32 : 16}|${mode === 'alpha-loss' && sourceImage ? 'false' : 'true'}|TopLeft\n`)
    }
    if (bin.startsWith('pillow-')) {
      if (bin === 'pillow-png-only' && input.equals(avifBytes)) return finish(JSON.stringify({ ok: false, code: 'reference_decode_failed', message: 'optional AVIF codec absent' }), 2)
      if (mode === 'malformed') return finish('not JSON')
      const output = { mime: 'image/png', width: 512, height: 16, hasAlpha: false, animated: false }
      return finish(JSON.stringify({ ok: true, changed: true, reason: 'dimensions', source: { ...output, width: 1024, height: 32 }, output,
        dataBase64: outputBytes.toString('base64') }))
    }
    return finish(outputBytes)
  }))
  return child
}
syncBuiltinESMExports()
const { prepareReferenceImages, publicReferencePreparation } = await import('../src/reference-image-preparation.mjs')
let passed = 0, failed = 0
const test = async (name, body) => {
  mode = 'success'; calls = []
  try { await body(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`) }
}
const opts = (name, extra = {}) => ({ cacheDir: path.join(scratch, name), lane: 'relayImage', maxEdge: 512,
  pythonBins: [], imageMagickBins: ['fake-magick'], ...extra })
try {
  await test('ImageMagick-only path uses bounded stdin, not user-path decoder syntax', async () => {
    const r = await prepareReferenceImages([source], opts('im-only'))
    assert.equal(r.items[0].tool, 'ImageMagick')
    assert.equal(r.items[0].outputWidth, 512)
    assert.equal(r.items[0].mime, 'image/png')
    const conversion = calls.find((c) => c.args.includes('png:-'))
    assert.ok(conversion)
    assert.ok(conversion.args.includes('-limit'))
    assert.ok(!conversion.args.includes(source))
    assert.deepEqual(Buffer.concat(conversion.input), sourceBytes)
    assert.deepEqual(fs.readFileSync(source), sourceBytes)
  })
  await test('missing executable falls through once to a verified ImageMagick', async () => {
    await prepareReferenceImages([source], opts('missing-fallback', { pythonBins: ['missing-tool'] }))
    assert.equal(calls.filter((c) => c.bin === 'missing-tool').length, 1)
    assert.ok(calls.some((c) => c.args.includes('png:-')))
  })
  await test('sandbox EPERM stops rather than attempting another executable', async () => {
    await assert.rejects(() => prepareReferenceImages([source], opts('blocked', { pythonBins: ['blocked-tool'] })),
      (e) => e.code === 'reference_processor_blocked' && e.submitted === false)
    assert.equal(calls.length, 1)
  })
  await test('decoder-confirmed alpha loss is refused before caching', async () => {
    mode = 'alpha-loss'
    await assert.rejects(() => prepareReferenceImages([source], opts('alpha-loss')), { code: 'reference_preprocess_failed' })
    assert.equal(fs.readdirSync(path.join(scratch, 'alpha-loss', 'entries')).length, 0)
  })
  await test('whole-operation timeout kills local child and does not switch processors', async () => {
    mode = 'timeout'
    const oldKilled = killed
    await assert.rejects(() => prepareReferenceImages([source], opts('timeout', { processorTimeoutMs: 1000 })), { code: 'reference_preprocess_timeout' })
    assert.ok(killed > oldKilled)
    assert.ok(calls.every((c) => c.bin === 'fake-magick'))
  })
  await test('cache reuse requires no processor and preserves its audited version', async () => {
    const first = await prepareReferenceImages([source], opts('cache'))
    calls = []
    const second = await prepareReferenceImages([source], opts('cache', { imageMagickBins: [] }))
    assert.equal(calls.length, 0)
    assert.equal(first.items[0].uploadPath, second.items[0].uploadPath)
    assert.equal(second.items[0].cacheHit, true)
    assert.equal(publicReferencePreparation(second).items[0].toolVersion, 'Version: ImageMagick 7.1.1 Q16 test-only')
  })
  await test('corrupt cache entry is preserved and rejected, not overwritten/reused', async () => {
    const options = opts('corrupt')
    const { policy } = await prepareReferenceImages([], options)
    const key = `${crypto.createHash('sha256').update(sourceBytes).digest('hex')}-${policy.policyKey}`
    const dir = path.join(options.cacheDir, 'entries'); fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${key}.json`), corrupt = Buffer.from('{"invalid":true}')
    fs.writeFileSync(file, corrupt, { flag: 'wx' })
    await assert.rejects(() => prepareReferenceImages([source], options), { code: 'reference_cache_corrupt' })
    assert.equal(calls.length, 0)
    assert.deepEqual(fs.readFileSync(file), corrupt)
  })
  await test('explicit interpreter is honoured and malformed worker JSON fails closed', async () => {
    const r = await prepareReferenceImages([source], opts('pillow-good', { pythonBins: ['pillow-configured'] }))
    assert.equal(r.items[0].tool, 'Pillow')
    assert.ok(calls.every((c) => c.bin === 'pillow-configured'))
    calls = []; mode = 'malformed'
    await assert.rejects(() => prepareReferenceImages([source], opts('pillow-bad', { pythonBins: ['pillow-configured'] })), { code: 'reference_preprocess_failed' })
    assert.ok(calls.every((c) => c.bin === 'pillow-configured'))
  })
  await test('content-identical filenames reuse cache without dropping reference order/count', async () => {
    const other = path.join(scratch, 'other.txt'); fs.writeFileSync(other, sourceBytes, { flag: 'wx' })
    const r = await prepareReferenceImages([other, source, other], opts('duplicates'))
    assert.equal(r.items.length, 3)
    assert.deepEqual(r.items.map((item) => item.originalPath), [other, source, other])
    assert.equal(new Set(r.items.map((item) => item.uploadPath)).size, 1)
    assert.equal(calls.filter((c) => c.args.includes('png:-')).length, 1)
  })
  await test('optional input codec absence selects a capable local processor before decode', async () => {
    const r = await prepareReferenceImages([avifSource], opts('optional-codec', { pythonBins: ['pillow-png-only'] }))
    assert.equal(r.items[0].tool, 'ImageMagick')
    assert.equal(r.items[0].originalMime, 'image/avif')
    assert.equal(calls.filter((c) => c.bin === 'pillow-png-only' && c.args[0] !== '-c').length, 0)
  })
  await test('missing input codec without a capable fallback stops before decoding', async () => {
    await assert.rejects(() => prepareReferenceImages([avifSource], opts('optional-codec-unavailable', {
      pythonBins: ['pillow-png-only'], imageMagickBins: [],
    })), { code: 'reference_preprocess_unavailable' })
    assert.equal(calls.filter((c) => c.args[0] !== '-c').length, 0)
  })
  await test('aggregate safety checks real snapshot lengths, not stale path stats', async () => {
    const text = fs.readFileSync(new URL('../src/reference-image-preparation.mjs', import.meta.url), 'utf8')
    const start = text.indexOf('export async function prepareReferenceImages(')
    let reads = 0, processed = 0
    const context = {
      path, Date, MiB: 1024 * 1024, EXTENSIONS: { 'image/png': '.png' },
      preflightError: (code, message) => Object.assign(new Error(message), { code, phase: 'preflight', submitted: false }),
      resolvePolicy: () => ({ maxInputBytes: 128 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, policyKey: 'memory-test' }),
      boundedInt: (_value, fallback) => fallback, expandReferencePath: (value) => value,
      fsp: { stat: async () => ({ size: 1, isFile: () => true }), mkdir: async () => {} },
      // Virtual 64 MiB snapshots: no large allocation, real files or decoder.
      readBounded: async () => { reads++; return { length: 64 * 1024 * 1024 } },
      inspectReferenceImage: () => ({ mime: 'image/png', width: 1, height: 1, animated: false }),
      assertDimensions() {}, sha256: () => 'a'.repeat(64), formatBytes: String,
      prepareCached: async () => {
        processed++
        const info = { mime: 'image/png', width: 1, height: 1, hasAlpha: false }
        return { source: info, output: info, uploadBytes: 1, reason: 'mock', uploadPath: 'MEMORY.png' }
      },
    }
    vm.runInNewContext(text.slice(start).replace(/^export /, '') + '\nthis.run = prepareReferenceImages', context)
    await assert.rejects(() => context.run(Array(5).fill('memory.png'), { cacheDir: 'MEMORY-CACHE' }),
      (e) => e.code === 'reference_input_too_large' && e.submitted === false)
    assert.equal(reads, 4, 'when the budget is exhausted, do not even read the fifth input')
    assert.equal(processed, 4, 'over-budget fifth snapshot must never reach a decoder/cache')
  })
} finally {
  childProcess.spawn = originalSpawn
  syncBuiltinESMExports()
}
console.log(`Result: ${passed} passed, ${failed} failed; fixtures retained: ${scratch}`)
process.exitCode = failed ? 1 : 0
