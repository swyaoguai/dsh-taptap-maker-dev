import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

import {
  DEFAULT_REFERENCE_POLICY,
  prepareReferenceImages,
  assertReferenceOutputIsSeparate,
  publicReferencePreparation,
  inspectReferenceImage,
} from '../src/reference-image-preparation.mjs'

let passed = 0, failed = 0
const check = async (name, run) => {
  try { await run(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${String(error.message).slice(0, 600)}`) }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  const out = Buffer.alloc(4)
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return out
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  return Buffer.concat([size, name, data, crc32(Buffer.concat([name, data]))])
}

function rgbaPng(width, height, { noisy = false, alpha = false } = {}) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  let state = 0x12345678
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    rows[row] = 0
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4
      if (noisy) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        rows[at] = state & 0xff
        rows[at + 1] = (state >>> 8) & 0xff
        rows[at + 2] = (state >>> 16) & 0xff
      } else {
        rows[at] = 40
        rows[at + 1] = 100
        rows[at + 2] = 180
      }
      rows[at + 3] = alpha && ((x + y) % 7 === 0) ? 80 : 255
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reference-prep-'))
const cacheDir = path.join(scratch, 'cache')
const small = path.join(scratch, 'small.png')
const large = path.join(scratch, 'large-alpha.png')
const tooWide = path.join(scratch, 'wide.png')
const fake = path.join(scratch, 'not-image.txt')
fs.writeFileSync(small, rgbaPng(16, 16))
fs.writeFileSync(large, rgbaPng(1200, 900, { noisy: true, alpha: true }))
fs.writeFileSync(tooWide, rgbaPng(3000, 32, { alpha: true }))
fs.writeFileSync(fake, 'not an image')

await check('default policy bounds individual and aggregate uploads', async () => {
  assert.equal(DEFAULT_REFERENCE_POLICY.maxEdge, 2048)
  assert.equal(DEFAULT_REFERENCE_POLICY.maxBytes, 1024 * 1024)
  assert.equal(DEFAULT_REFERENCE_POLICY.maxTotalBytes, 8 * 1024 * 1024)
})

await check('small safe references pass through byte-for-byte', async () => {
  const before = crypto.createHash('sha256').update(fs.readFileSync(small)).digest('hex')
  const result = await prepareReferenceImages([small], { cacheDir, maxBytes: 512 * 1024, maxEdge: 1024 })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].changed, false)
  assert.deepEqual(fs.readFileSync(result.items[0].uploadPath), fs.readFileSync(small))
  assert.equal(result.items[0].mime, 'image/png')
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(small)).digest('hex'), before)
})

await check('oversize alpha image is compressed before upload without touching the original', async () => {
  const before = fs.readFileSync(large)
  assert.ok(before.length > 512 * 1024, `fixture must exceed target, got ${before.length}`)
  const result = await prepareReferenceImages([large], {
    cacheDir,
    maxBytes: 512 * 1024,
    maxTotalBytes: 512 * 1024,
    maxEdge: 1024,
  })
  const item = result.items[0]
  assert.equal(item.changed, true)
  assert.notEqual(item.uploadPath, path.resolve(large))
  assert.ok(item.uploadBytes <= 512 * 1024, `${item.uploadBytes} > target`)
  assert.ok(item.outputWidth <= 1024 && item.outputHeight <= 1024)
  assert.equal(item.mime, 'image/webp')
  assert.ok(fs.existsSync(item.uploadPath))
  assert.deepEqual(fs.readFileSync(large), before, 'source bytes must remain unchanged')

  const python = process.env.TAPTAP_PY || 'python'
  const probe = execFileSync(python, ['-c', [
    'import json,sys',
    'from PIL import Image',
    'im=Image.open(sys.argv[1])',
    'print(json.dumps({"mode": im.mode, "width": im.width, "height": im.height, "alpha": "A" in im.getbands() or "transparency" in im.info}))',
  ].join(';'), item.uploadPath], { encoding: 'utf8' })
  const decoded = JSON.parse(probe)
  assert.equal(decoded.alpha, true, `alpha lost: ${probe}`)
})

await check('dimension-only oversize image is also normalized', async () => {
  const result = await prepareReferenceImages([tooWide], { cacheDir, maxBytes: 512 * 1024, maxEdge: 1024 })
  assert.equal(result.items[0].changed, true)
  assert.ok(Math.max(result.items[0].outputWidth, result.items[0].outputHeight) <= 1024)
})

await check('content-addressed cache is reused without overwriting the source', async () => {
  const first = await prepareReferenceImages([large], { cacheDir, maxBytes: 512 * 1024, maxTotalBytes: 512 * 1024, maxEdge: 1024 })
  const cachedBytes = fs.readFileSync(first.items[0].uploadPath)
  const second = await prepareReferenceImages([large], { cacheDir, maxBytes: 512 * 1024, maxTotalBytes: 512 * 1024, maxEdge: 1024 })
  assert.equal(second.items[0].uploadPath, first.items[0].uploadPath)
  assert.equal(second.items[0].cacheHit, true)
  assert.deepEqual(fs.readFileSync(second.items[0].uploadPath), cachedBytes)
})

await check('aggregate budget lowers the per-file target for multiple references', async () => {
  const result = await prepareReferenceImages([large, large], {
    cacheDir: path.join(scratch, 'aggregate-cache'),
    maxBytes: 512 * 1024,
    maxTotalBytes: 600 * 1024,
    maxEdge: 1024,
  })
  assert.equal(result.items.length, 2)
  assert.ok(result.uploadTotalBytes <= 600 * 1024, `${result.uploadTotalBytes} > aggregate target`)
})

await check('unsupported content is rejected before any upload', async () => {
  await assert.rejects(
    () => prepareReferenceImages([fake], { cacheDir }),
    (error) => error?.code === 'unsupported_reference_image' && error?.submitted === false,
  )
})

await check('lane defaults and explicit/env precedence are effective', async () => {
  const name = 'TAPTAP_IMAGE_REF_MAX_EDGE', old = process.env[name]
  try {
    const base = await prepareReferenceImages([], { lane: 'relayImage' })
    assert.equal(base.policy.outputFormat, 'png')
    assert.equal(base.policy.maxBytes, 4 * 1024 * 1024)
    process.env[name] = '1600'
    assert.equal((await prepareReferenceImages([], { lane: 'zaiduyu' })).policy.maxEdge, 1600)
    assert.equal((await prepareReferenceImages([], { lane: 'zaiduyu', maxEdge: 1200 })).policy.maxEdge, 1200)
  } finally { if (old === undefined) delete process.env[name]; else process.env[name] = old }
})

await check('malformed ref collection cannot silently become text-only generation', async () => {
  for (const invalid of [small, {}, true, 123]) {
    await assert.rejects(() => prepareReferenceImages(invalid, { cacheDir }), { code: 'invalid_reference_path' })
  }
})

await check('small references are snapshotted, not re-read from a mutable original during upload', async () => {
  const result = await prepareReferenceImages([small], { cacheDir })
  assert.notEqual(result.items[0].uploadPath, small)
  assert.equal(result.items[0].changed, false)
  assert.equal(result.items[0].sourceSha256, result.items[0].uploadSha256)
})

await check('renaming valid PNG only canonicalizes the upload name without lossy conversion', async () => {
  const renamed = path.join(scratch, 'valid-content.txt')
  fs.writeFileSync(renamed, fs.readFileSync(small), { flag: 'wx' })
  const result = await prepareReferenceImages([renamed], { cacheDir })
  assert.equal(result.items[0].mime, 'image/png')
  assert.equal(path.extname(result.items[0].uploadPath), '.png')
  assert.deepEqual(fs.readFileSync(result.items[0].uploadPath), fs.readFileSync(renamed))
})

await check('valid PNG container with damaged pixels is rejected', async () => {
  const broken = path.join(scratch, 'valid-crc-broken-pixels.png')
  const header = fs.readFileSync(small).subarray(16, 29)
  fs.writeFileSync(broken, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('IDAT', Buffer.from('not-deflate')), pngChunk('IEND', Buffer.alloc(0)),
  ]), { flag: 'wx' })
  await assert.rejects(() => prepareReferenceImages([broken], { cacheDir }),
    (e) => e.submitted === false && ['unsupported_reference_image', 'reference_decode_failed'].includes(e.code))
})

await check('opaque RGBA can compress to opaque WebP instead of failing a false alpha-loss guard', async () => {
  const opaque = path.join(scratch, 'opaque-rgba.png')
  fs.writeFileSync(opaque, rgbaPng(3000, 32), { flag: 'wx' })
  const r = await prepareReferenceImages([opaque], { cacheDir, maxEdge: 1024 })
  assert.equal(r.items[0].hasAlpha, false)
  assert.ok(r.items[0].outputWidth <= 1024)
})

await check('concurrent callers get the same complete cached result', async () => {
  const options = { cacheDir: path.join(scratch, 'concurrent-cache'), maxEdge: 768 }
  const results = await Promise.all(Array.from({ length: 4 }, () => prepareReferenceImages([tooWide], options)))
  assert.equal(new Set(results.map((r) => r.items[0].uploadPath)).size, 1)
  for (const r of results) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(r.items[0].uploadPath)).digest('hex'), r.items[0].uploadSha256)
    assert.ok(r.items[0].outputWidth <= 768)
  }
})

await check('same-path, relative-path and hardlink output aliases are refused', async () => {
  assert.throws(() => assertReferenceOutputIsSeparate(small, [small]), { code: 'reference_output_alias' })
  assert.throws(() => assertReferenceOutputIsSeparate(path.join(scratch, '.', 'small.png'), [small]), { code: 'reference_output_alias' })
  const hardlink = path.join(scratch, 'hardlink-to-small.png')
  fs.linkSync(small, hardlink)
  assert.throws(() => assertReferenceOutputIsSeparate(hardlink, [small]), { code: 'reference_output_alias' })
})

await check('no local image processor fails before submitting and does not fall back to original', async () => {
  await assert.rejects(() => prepareReferenceImages([tooWide], {
    cacheDir: path.join(scratch, 'no-tool-cache'), pythonBins: [], imageMagickBins: [],
  }), (error) => error.code === 'reference_preprocess_unavailable' && error.phase === 'preflight' && error.submitted === false)
})

await check('cache result retains processor version and full source/output audit', async () => {
  const options = { cacheDir, maxBytes: 512 * 1024, maxTotalBytes: 512 * 1024, maxEdge: 1024 }
  const r = await prepareReferenceImages([large], options)
  const audit = publicReferencePreparation(r), item = audit.items[0]
  assert.match(item.source.sha256, /^[a-f0-9]{64}$/)
  assert.match(item.upload.sha256, /^[a-f0-9]{64}$/)
  assert.equal(item.source.width, 1200)
  assert.equal(item.upload.hasAlpha, true)
  assert.ok(item.toolVersion)
  assert.equal(JSON.stringify(audit).includes(scratch), false, 'public audit must not expose private paths')
})

await check('unrecognized or contradictory policy cannot escape output MIME limits', async () => {
  await assert.rejects(() => prepareReferenceImages([], { lane: 'missing-lane' }), { code: 'invalid_reference_policy' })
  await assert.rejects(() => prepareReferenceImages([large], { cacheDir, acceptedMimes: ['image/png'], outputFormat: 'webp' }), { code: 'invalid_reference_policy' })
})

await check('independent processes publish one complete immutable cache entry', async () => {
  const run = promisify(execFile)
  const script = `const m=await import(process.argv[1]); const r=await m.prepareReferenceImages([process.argv[2]],JSON.parse(process.argv[3])); console.log(JSON.stringify(r.items[0]));`
  const options = { cacheDir: path.join(scratch, 'cross-process-cache'), maxEdge: 640 }
  const runOne = async () => {
    const r = await run(process.execPath, ['--input-type=module', '-e', script,
      new URL('../src/reference-image-preparation.mjs', import.meta.url).href, tooWide, JSON.stringify(options)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000 })
    return JSON.parse(r.stdout)
  }
  const [one, two] = await Promise.all([runOne(), runOne()])
  assert.equal(one.uploadPath, two.uploadPath)
  assert.equal(one.uploadSha256, two.uploadSha256)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(one.uploadPath)).digest('hex'), one.uploadSha256)
})

await check('full policy changes separate cache keys without relying on filenames', async () => {
  const a = (await prepareReferenceImages([], { minEdge: 128 })).policy.policyKey
  const b = (await prepareReferenceImages([], { minEdge: 256 })).policy.policyKey
  const c = (await prepareReferenceImages([], { outputFormat: 'png' })).policy.policyKey
  assert.notEqual(a, b)
  assert.notEqual(b, c)
})

await check('real JPEG WebP GIF BMP and AVIF inputs pass the Node-to-decoder boundary', async () => {
  const python = process.env.TAPTAP_PY || 'python'
  const fixtures = JSON.parse(execFileSync(python, ['-c', [
    'import io,json,base64', 'from PIL import Image', 'Image.init()', 'result={}',
    'for fmt in ("JPEG","WEBP","GIF","BMP","AVIF"):',
    ' im=Image.new("RGB",(24,12),(40,100,180)); buf=io.BytesIO(); im.save(buf,format=fmt); result[fmt]=base64.b64encode(buf.getvalue()).decode()',
    'print(json.dumps(result))',
  ].join('\n')], { encoding: 'utf8' }))
  for (const [format, data] of Object.entries(fixtures)) {
    const file = path.join(scratch, `format-${format.toLowerCase()}.${format.toLowerCase()}`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'), { flag: 'wx' })
    const r = await prepareReferenceImages([file], { cacheDir })
    assert.ok(['image/png', 'image/jpeg', 'image/webp'].includes(r.items[0].mime), format)
    assert.equal(r.items[0].outputWidth, 24)
    assert.equal(r.items[0].outputHeight, 12)
  }
})

await check('input count, size, empty paths and invalid budgets reject locally', async () => {
  for (const [refs, options, code] of [
    [Array(17).fill(small), {}, 'too_many_reference_images'],
    [[large], { maxInputBytes: 1024 * 1024 }, 'reference_input_too_large'],
    [[''], {}, 'invalid_reference_path'],
    [[path.join(scratch, 'does-not-exist.png')], {}, 'missing_reference'],
    [[small], { maxBytes: true }, 'invalid_reference_policy'],
    [[small, small], { maxTotalBytes: 65536 }, 'reference_aggregate_budget_too_small'],
  ]) await assert.rejects(() => prepareReferenceImages(refs, { cacheDir, ...options }), (e) => e.code === code && e.submitted === false)
})

await check('private default cache follows the explicit DSH home and originals retain mtime', async () => {
  const old = process.env.TAPTAP_IMAGE_REFERENCE_CACHE
  try {
    delete process.env.TAPTAP_IMAGE_REFERENCE_CACHE
    const dshHome = path.join(scratch, 'isolated-home'), before = fs.statSync(small).mtimeMs
    const r = await prepareReferenceImages([small], { dshHome })
    assert.ok(r.items[0].uploadPath.startsWith(dshHome + path.sep))
    assert.equal(fs.statSync(small).mtimeMs, before)
  } finally { if (old === undefined) delete process.env.TAPTAP_IMAGE_REFERENCE_CACHE; else process.env.TAPTAP_IMAGE_REFERENCE_CACHE = old }
})

await check('default pixel budget rejects large decoded working sets before any processor', async () => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(7000, 0); ihdr.writeUInt32BE(5000, 4); ihdr[8] = 8; ihdr[9] = 6
  const image = path.join(scratch, 'large-decoded-footprint.png')
  fs.writeFileSync(image, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 255]))), pngChunk('IEND', Buffer.alloc(0))]), { flag: 'wx' })
  await assert.rejects(() => prepareReferenceImages([image], { cacheDir, pythonBins: [], imageMagickBins: [] }),
    (e) => e.code === 'reference_image_dimensions_exceeded' && e.submitted === false)
  assert.ok(DEFAULT_REFERENCE_POLICY.maxInputPixels <= 32_000_000)
})

console.log(`Result: ${passed} passed, ${failed} failed; fixtures retained: ${scratch}`)
process.exitCode = failed ? 1 : 0
