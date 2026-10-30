/**
 * Reference-upload integration gates. Run: node scripts/verify-reference-image-integration.mjs
 * Execute the actual lane function bodies with browser, API, login, config and
 * generation subprocess boundaries replaced in memory. Only locally constructed
 * PNG fixtures / the helper's immutable cache use disk; all generated outputs
 * and failures are simulated. Unique temp directories are deliberately retained.
 * No network, credentials, browser, paid generation, cleanup, or config changes.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'
import {
  prepareReferenceImages, publicReferencePreparation, assertReferenceOutputIsSeparate,
  expandReferencePath, referenceImageCacheDir,
} from '../src/reference-image-preparation.mjs'
import { runWithFallback } from '../src/lanes.mjs'

const source = Object.fromEntries(['image', 'gpt', 'zaiduyu'].map((name) => [name,
  fs.readFileSync(new URL(`../src/taptap-${name}.mjs`, import.meta.url), 'utf8'),
]))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reference-integration-'))
const marker = 'offline reference preparation note'
const prompt = 'offline reference integration fixture'
const pendingUrl = 'https://chatgpt.com/c/OFFLINE-REFERENCE-TEST'
let passed = 0, failed = 0, sequence = 0
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`) }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack ?? error}`) }
}

// Keep CRC-valid PNGs self-contained; do not borrow assets or require ffmpeg.
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const result = Buffer.alloc(4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return result
}
function chunk(kind, data) {
  const name = Buffer.from(kind), length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, name, data, crc32(Buffer.concat([name, data]))])
}
function png(width = 16, height = 12, color = 77) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = y * (width * 4 + 1) + 1 + x * 4
    rows[offset] = color; rows[offset + 1] = 123; rows[offset + 2] = 210
    rows[offset + 3] = (x + y) % 3 ? 255 : 96
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

// Unlike source-regex assertions, these loaders run real conditionals, catches,
// payload building, option forwarding and output selection. The regex only finds
// a top-level declaration (as in verify-runtime-regressions.mjs).
function declaration(text, name) {
  const start = text.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `real function ${name} exists`)
  const rest = text.slice(start)
  const end = /\n\}(?=\r?\n|$)/.exec(rest)
  assert.ok(end, `real function ${name} ends`)
  return rest.slice(0, end.index + end[0].length).replace(/^export /, '')
}
function load(lane, names, dependencies = {}, constants = '') {
  const context = vm.createContext({
    path, os, Buffer, Blob, FormData, AbortSignal, Date, console,
    process: { pid: 1, platform: process.platform, env: {}, cwd: () => scratch },
    expandReferencePath, assertReferenceOutputIsSeparate, referenceImageCacheDir,
    publicReferencePreparation,
    fetch: async () => { throw new Error('unmocked fetch is forbidden') },
    ...dependencies,
  })
  vm.runInContext(`${constants}\n${names.map((name) => declaration(source[lane], name)).join('\n')}\n`
    + `this.functions = { ${names.join(', ')} }`, context, { filename: `offline-taptap-${lane}.mjs` })
  return context.functions
}
function fixture() {
  const dir = path.join(scratch, `case-${++sequence}`)
  fs.mkdirSync(dir)
  const home = path.join(dir, 'fake-dsh-home'), cache = path.join(dir, 'cache')
  const originals = new Map(), outputs = new Map(), calls = [], prepCalls = [], prepared = []
  function file(name, bytes = png()) {
    const target = path.join(dir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes, { flag: 'wx' })
    originals.set(target, Buffer.from(bytes))
    return target
  }
  const read = (target) => outputs.get(path.resolve(target)) ?? fs.readFileSync(target)
  const memoryFs = {
    ...fs,
    mkdirSync() {},
    existsSync: (target) => outputs.has(path.resolve(target)) || fs.existsSync(target),
    readFileSync: (target, encoding) => {
      const value = read(target)
      return typeof encoding === 'string' ? value.toString(encoding) : value
    },
    writeFileSync: (target, bytes) => { outputs.set(path.resolve(target), Buffer.from(bytes)) },
    copyFileSync: (from, to) => { outputs.set(path.resolve(to), Buffer.from(read(from))) },
    rmSync: () => { throw new Error('test forbids deletion, including cleanup') },
  }
  async function prepare(paths, options = {}) {
    prepCalls.push({ paths: [...paths], options: { ...options } })
    // Fill missing isolation ONLY inside the test boundary. Assertions inspect
    // what the lane actually forwarded, so a missing dshHome/lane is still RED.
    const result = await prepareReferenceImages(paths, {
      ...options, dshHome: options.dshHome ?? home,
      cacheDir: options.cacheDir ?? cache,
    })
    result.notes = [...result.notes, marker]
    prepared.push(result)
    return result
  }
  function unchanged() {
    for (const [target, bytes] of originals) {
      assert.deepEqual(fs.readFileSync(target), bytes, `original changed: ${target}`)
      assert.ok(!outputs.has(target), `lane attempted to overwrite original: ${target}`)
    }
  }
  return { dir, home, cache, originals, outputs, calls, prepCalls, prepared, file, memoryFs, prepare, unchanged }
}
function prepFailure(message = 'offline preparation cannot fit upload budget') {
  return Object.assign(new Error(message), { code: 'reference_preprocess_failed', kind: 'input', phase: 'preflight', submitted: false })
}
function assertPreflight(error) {
  assert.equal(error.phase, 'preflight')
  assert.equal(error.submitted, false)
  assert.equal(error.requiresLogin, false)
}
function assertAudit(result, f) {
  assert.ok(result.referencePreparation, 'preparation audit is retained')
  assert.deepEqual(JSON.parse(JSON.stringify(result.referencePreparation)), publicReferencePreparation(f.prepared.at(-1)))
  assert.ok(Array.isArray(result.notes), 'notes accompany preparation audit')
  assert.ok(result.notes.includes(marker), 'preparation notes are retained')
}
function response(body = { data: [{ b64_json: png(8, 8, 199).toString('base64') }] }, status = 200) {
  return { ok: status >= 200 && status < 300, status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body) }
}
function relay(f, { fetch: request = async () => response(), prepare = f.prepare, fs: io = f.memoryFs } = {}) {
  const hints = source.image.slice(source.image.indexOf('const SINGLE_IMAGE_MODEL_HINTS ='),
    source.image.indexOf('\n]', source.image.indexOf('const SINGLE_IMAGE_MODEL_HINTS =')) + 2)
  return load('image', ['collectInputs', 'looksSingleImageModel', 'parseWH', 'snapSize', 'editImage', 'generateImage'], {
    fs: io, prepareReferenceImages: prepare,
    resolveImageConfig: (options) => ({ baseURL: 'https://offline.invalid/v1', apiKey: 'offline-fake',
      model: options.model ?? 'gpt-image-offline', size: '1024x1024', n: 1 }),
    imageConfigPath: () => path.join(f.home, 'fake-image.json'),
    downscaleFile: () => ({ ok: true, tool: 'memory-only' }),
    sleep: async () => { throw new Error('retry sleep is not expected') },
    fetch: async (url, options) => { f.calls.push({ url, options }); return request(url, options) },
  }, `${hints}\nconst ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024'])`)
}
function web(f, { result, thrown, prepare = f.prepare, fs: io = f.memoryFs, resolveDir } = {}) {
  return load('gpt', ['gen', 'grab'], {
    fs: io, prepareReferenceImages: prepare,
    GPT_URL: 'https://chatgpt.com/', pyStr: (s) => JSON.stringify(String(s)),
    readGptLaneEnabled: () => true,
    gptProfileDir: () => path.join(f.home, 'mock-profile'),
    gptAccountProfileDir: () => path.join(f.home, 'mock-account'),
    resolveDownloadDir: resolveDir ?? (() => ({ dir: f.dir, source: 'flag', projectDir: f.dir })),
    readGptPending: () => ({ url: pendingUrl, prompt }),
    touchGptAccount: () => {}, writeGptPending: () => {}, clearGptPending: () => {},
    downscaleFile: () => ({ ok: true, tool: 'memory-only' }),
    runBrowser: async (_home, snippet, options) => {
      f.calls.push({ snippet, options })
      if (thrown) throw thrown
      if (result) return typeof result === 'function' ? result(snippet) : result
      const dest = JSON.parse(snippet.split('\n').find((line) => line.startsWith('DEST = ')).slice(7))
      f.outputs.set(path.resolve(dest), png(8, 8, 199))
      return { ok: true, steps: { saved: dest, bytes: 100 }, saved: dest }
    },
  })
}
function zaiduyu(f, { result, thrown, prepare = f.prepare, status, modelError, fs: io = f.memoryFs } = {}) {
  const classifiers = load('zaiduyu', ['parsePreflight', 'zaiduyuQuotaHit', 'classifyZaiduyuFailure'])
  let probes = 0
  const functions = load('zaiduyu', ['generate'], {
    fs: io, prepareReferenceImages: prepare, ...classifiers,
    expandUser: expandReferencePath,
    resolveZaiduyuModel: (_home, model) => { if (modelError) throw modelError; return model ?? 'offline-saved-choice' },
    zaiduyuLaneUsable: () => { probes += 1; return status ?? { script: true, python: 'mock-python', credentials: true } },
    zaiduyuScriptPath: () => 'offline-script.py',
    resolveAssetDir: () => ({ dir: f.dir }),
    runZaiduyu: async (argv, options) => {
      f.calls.push({ argv, options })
      if (thrown) throw thrown
      if (result) return result
      const dest = argv[argv.indexOf('--out') + 1]
      f.outputs.set(path.resolve(dest), png(8, 8, 199))
      return { code: 0, stdout: `${dest}\n`, stderr: '模型：offline-selected\n' }
    },
  })
  return { ...functions, probes: () => probes }
}
function rotation({ gen, grab = async () => ({ ok: false }), accounts = [], pending = null } = {}) {
  return load('gpt', ['generateWithRotation'], {
    readGptLaneEnabled: () => true, isLaneEnabled: () => true,
    readGptPool: () => ({ accounts, autoRotate: true }), readGptPending: () => pending,
    statusFor: () => ({ loggedIn: true }),
    pickGptAccount: (_home, { exclude }) => accounts.find((a) => !exclude.includes(a.id)) ?? null,
    gen, grab,
  }).generateWithRotation
}
function unified({ order = ['relayImage'], relayEdit, relayGenerate, zaiduyuGenerate, generateWithRotation } = {}) {
  return load('gpt', ['generateImage'], {
    laneOrder: () => order, readGptLaneEnabled: () => true,
    readLanes: () => ({ autoFallback: true }), runWithFallback,
    relayEdit, relayGenerate, zaiduyuGenerate, generateWithRotation,
  }).generateImage
}

console.log('\n[1] Relay: selected uploads, real MIME, budgets and source protection')
await check('relay forwards lane, fake home and explicit reference budgets', async () => {
  const f = fixture(), ref = f.file('input.png'), r = relay(f)
  const result = await r.editImage({ dshHome: f.home, in: ref, out: path.join(f.dir, 'out.png'), prompt,
    referenceCacheDir: f.cache, referenceMaxEdge: 512, referenceMaxBytes: 256 * 1024, referenceMaxTotalBytes: 512 * 1024 })
  assert.equal(f.prepCalls[0].options.lane, 'relayImage')
  assert.equal(f.prepCalls[0].options.dshHome, f.home)
  assert.equal(f.prepCalls[0].options.cacheDir, f.cache)
  assert.equal(f.prepCalls[0].options.maxEdge, 512)
  assert.equal(f.prepCalls[0].options.maxBytes, 256 * 1024)
  assert.equal(f.prepCalls[0].options.maxTotalBytes, 512 * 1024)
  assertAudit(result, f); f.unchanged()
})
await check('relay default preparation remains PNG-compatible without overriding helper/env defaults', async () => {
  const f = fixture(), r = relay(f)
  const result = await r.editImage({ dshHome: f.home, in: f.file('input.png'), out: path.join(f.dir, 'out.png'), prompt })
  assert.equal(f.prepCalls[0].options.lane, 'relayImage')
  assert.equal(f.prepCalls[0].options.maxEdge, undefined)
  assert.equal(f.prepCalls[0].options.maxBytes, undefined)
  assert.equal(f.prepCalls[0].options.maxTotalBytes, undefined)
  assert.equal(result.referencePreparation.policy.outputFormat, 'png')
  const item = f.calls[0].options.body.get('image')
  assert.equal(item.type, 'image/png'); f.unchanged()
})
for (const count of [1, 2]) await check(`relay multipart uses ${count === 1 ? 'image' : 'image[]'} and prepared file bytes/names`, async () => {
  const f = fixture(), refs = [f.file('first.png'), f.file('second.png', png(12, 10, 101))].slice(0, count)
  const result = await relay(f).editImage({ dshHome: f.home, in: refs, out: path.join(f.dir, 'out.png'), prompt })
  const form = f.calls[0].options.body
  const files = form.getAll(count === 1 ? 'image' : 'image[]')
  assert.equal(files.length, count)
  for (const [index, file] of files.entries()) {
    const item = f.prepared[0].items[index]
    assert.equal(file.type, item.mime)
    assert.equal(file.name, path.basename(item.uploadPath))
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), fs.readFileSync(item.uploadPath))
  }
  assert.equal(result.inputCount, count); assertAudit(result, f); f.unchanged()
})
await check('relay JSON format fallback reads prepared uploads, not reference originals', async () => {
  const f = fixture(), ref = f.file('original.png'), upload = f.file('normalized.png', png(4, 4, 33))
  const prepare = async (...args) => {
    const p = await f.prepare(...args), item = p.items[0], bytes = fs.readFileSync(upload)
    Object.assign(item, { uploadPath: upload, mime: 'image/png', uploadBytes: bytes.length, uploadSha256: digest(bytes),
      changed: true, outputWidth: 4, outputHeight: 4 })
    p.changedCount = 1; p.uploadTotalBytes = bytes.length
    return p
  }
  const r = relay(f, { prepare, fetch: async (_url, options) => options.body instanceof FormData
    ? response('use JSON body with base64', 400) : response() })
  const result = await r.editImage({ dshHome: f.home, in: ref, out: path.join(f.dir, 'out.png'), prompt })
  assert.equal(f.calls.length, 2)
  const json = JSON.parse(f.calls[1].options.body)
  assert.equal(json.image, `data:image/png;base64,${fs.readFileSync(upload).toString('base64')}`)
  assertAudit(result, f); f.unchanged()
})
await check('single-ref prepares only the selected input and reports skipped refs', async () => {
  const f = fixture(), selected = f.file('selected.png'), skipped = f.file('skipped.png', Buffer.from('not an image'))
  const result = await relay(f).editImage({ dshHome: f.home, in: [selected, skipped], 'single-ref': true,
    out: path.join(f.dir, 'out.png'), prompt })
  assert.deepEqual(f.prepCalls[0].paths, [selected])
  assert.equal(result.inputCount, 1)
  assert.match(result.notes.join(' '), /只传第 1 张/); f.unchanged()
})
for (const skipped of [false, true]) await check(`relay refuses output alias of ${skipped ? 'single-ref skipped' : 'selected'} reference before fetch`, async () => {
  const f = fixture(), a = f.file('a.png'), b = f.file('b.png', png(9, 9, 24))
  const out = skipped ? b : a
  await assert.rejects(relay(f).editImage({ dshHome: f.home, in: [a, b], 'single-ref': true, out, prompt }), (e) => {
    assert.equal(e.code, 'reference_output_alias'); assertPreflight(e); return true
  })
  assert.equal(f.calls.length, 0); f.unchanged()
})
await check('relay protects hard-linked originals, not only equal path strings', async () => {
  const f = fixture(), ref = f.file('original.png'), alias = path.join(f.dir, 'hardlink.png')
  fs.linkSync(ref, alias)
  await assert.rejects(relay(f).editImage({ dshHome: f.home, in: ref, out: alias, prompt }), (e) => {
    assert.equal(e.code, 'reference_output_alias'); assertPreflight(e); return true
  })
  assert.equal(f.calls.length, 0); f.unchanged()
})
for (const bad of ['missing', 'empty', 'corrupt', 'directory']) await check(`relay rejects ${bad} selected ref before fetch with preflight flags`, async () => {
  const f = fixture()
  const ref = bad === 'missing' ? path.join(f.dir, 'missing.png') : bad === 'directory' ? f.dir
    : f.file('bad.png', bad === 'empty' ? Buffer.alloc(0) : Buffer.from('not png'))
  await assert.rejects(relay(f).editImage({ dshHome: f.home, in: ref, out: path.join(f.dir, 'out.png'), prompt }), (e) => {
    assertPreflight(e); return true
  })
  assert.equal(f.calls.length, 0); f.unchanged()
})
for (const request of [async () => response('image prompt rejected', 400), async () => { throw new Error('offline fetch failed') },
  async () => response('not JSON'), async () => response({ data: [] })]) {
  await check('relay post-preparation failure retains audit/notes and never retries unknown submission', async () => {
    const f = fixture()
    await assert.rejects(relay(f, { fetch: request }).editImage({ dshHome: f.home, in: f.file('input.png'),
      out: path.join(f.dir, 'out.png'), prompt }), (e) => { assertAudit(e, f); return true })
    assert.equal(f.calls.length, 1); f.unchanged()
  })
}
for (const derived of ['out_1.png', 'out_2.png', 'out_1.full.png', 'out.full.png']) {
  await check(`relay generation protects declared reference from derived ${derived} write`, async () => {
    const f = fixture(), ref = f.file(derived)
    await assert.rejects(relay(f).generateImage({ dshHome: f.home, ref, out: path.join(f.dir, 'out.png'),
      prompt, n: derived === 'out.full.png' ? 1 : 2, downscale: '8x8' }), (e) => {
      assert.equal(e.code, 'reference_output_alias'); assertPreflight(e); return true
    })
    assert.equal(f.calls.length, 0); f.unchanged()
  })
}

console.log('\n[2] Web: preparation before browser and complete audit on success/failure')
await check('web forwards policy options and only uploads prepared paths; success carries audit', async () => {
  const f = fixture(), ref = f.file('input.png')
  const result = await web(f).gen(f.home, prompt, { references: [ref], out: path.join(f.dir, 'out.png'),
    referenceCacheDir: f.cache, referenceMaxEdge: 512, referenceMaxBytes: 128 * 1024, referenceMaxTotalBytes: 256 * 1024 })
  assert.equal(f.prepCalls[0].options.lane, 'gptWeb'); assert.equal(f.prepCalls[0].options.dshHome, f.home)
  assert.equal(f.prepCalls[0].options.cacheDir, f.cache); assert.equal(f.prepCalls[0].options.maxEdge, 512)
  assert.equal(f.prepCalls[0].options.maxBytes, 128 * 1024); assert.equal(f.prepCalls[0].options.maxTotalBytes, 256 * 1024)
  const uploads = JSON.parse(f.calls[0].snippet.split('\n').find((line) => line.startsWith('REFS = ')).slice(7))
  assert.deepEqual(uploads, f.prepared[0].items.map((item) => item.uploadPath))
  assert.equal(result.referenceCount, 1); assertAudit(result, f); f.unchanged()
})
for (const suffix of ['', '.full']) await check(`web refuses ${suffix || 'direct'} output alias before browser`, async () => {
  const f = fixture(), ref = f.file(`out${suffix}.png`)
  const result = await web(f).gen(f.home, prompt, { references: [ref], out: path.join(f.dir, 'out.png'), downscale: '8x8' })
  assert.equal(result.ok, false); assert.equal(result.error, 'reference_output_alias'); assertPreflight(result)
  assert.equal(f.calls.length, 0); f.unchanged()
})
for (const bad of ['missing', 'empty', 'corrupt', 'directory']) await check(`web ${bad} reference is terminal preflight, not login/browser work`, async () => {
  const f = fixture(), ref = bad === 'missing' ? path.join(f.dir, 'missing.png') : bad === 'directory' ? f.dir
    : f.file('bad.png', bad === 'empty' ? Buffer.alloc(0) : Buffer.from('bad png'))
  const result = await web(f).gen(f.home, prompt, { references: [ref], out: path.join(f.dir, 'out.png') })
  assert.equal(result.ok, false); assertPreflight(result); assert.equal(f.calls.length, 0); f.unchanged()
})
for (const result of [
  { ok: false, err: 'offline browser failed' },
  { ok: false, error: 'offline browser exception', conv_url: pendingUrl },
  { ok: true, error: 'ref_upload_failed', steps: {} },
  { ok: true, error: 'download_failed', conv_url: pendingUrl, steps: {} },
  { ok: true, error: 'quota:rejected', steps: {} },
  { ok: true, steps: {} },
]) await check(`web failure retains preparation notes and audit: ${result.error ?? result.err ?? 'no saved file'}`, async () => {
  const f = fixture(), ref = f.file('input.png')
  const r = await web(f, { result }).gen(f.home, prompt, { references: [ref], out: path.join(f.dir, 'out.png') })
  assert.equal(r.ok, false); assertAudit(r, f); assert.equal(f.calls.length, 1); f.unchanged()
})
await check('web thrown browser exception retains preparation audit, without a new submission', async () => {
  const f = fixture()
  const result = await web(f, { thrown: new Error('offline browser launch threw') }).gen(f.home, prompt,
    { references: [f.file('input.png')], out: path.join(f.dir, 'out.png') })
  assert.equal(result.ok, false); assertAudit(result, f); assert.equal(f.calls.length, 1); f.unchanged()
})
await check('web post-preparation local output failure is audited preflight', async () => {
  const f = fixture(), io = { ...f.memoryFs, mkdirSync() { throw new Error('offline destination unwritable') } }
  const result = await web(f, { fs: io }).gen(f.home, prompt, { references: [f.file('input.png')], out: path.join(f.dir, 'out.png') })
  assert.equal(result.ok, false); assertAudit(result, f); assertPreflight(result)
  assert.equal(f.calls.length, 0); f.unchanged()
})
await check('web post-download copy exception retains the preparation audit', async () => {
  const f = fixture(), io = { ...f.memoryFs, copyFileSync() { throw new Error('offline backup copy failed') } }
  const result = await web(f, { fs: io }).gen(f.home, prompt, { references: [f.file('input.png')],
    out: path.join(f.dir, 'out.png'), downscale: '8x8' })
  assert.equal(result.ok, false); assertAudit(result, f); assert.equal(f.calls.length, 1); f.unchanged()
})
for (const accounts of [[], [{ id: 'offline-a' }, { id: 'offline-b' }]]) {
  await check(`rotation forwards all reference policy options (${accounts.length ? 'pool' : 'single'})`, async () => {
    const f = fixture(), calls = [], refs = [f.file('input.png')]
    const run = rotation({ accounts, gen: async (_home, _prompt, options) => { calls.push(options); return { ok: true } } })
    const opts = { references: refs, referenceCacheDir: f.cache, referenceMaxEdge: 512,
      referenceMaxBytes: 128 * 1024, referenceMaxTotalBytes: 256 * 1024 }
    assert.equal((await run(f.home, prompt, opts)).ok, true)
    for (const key of Object.keys(opts)) assert.deepEqual(calls[0][key], opts[key], key)
  })
}
await check('a quota-looking reference preparation failure cannot rotate accounts', async () => {
  const f = fixture(), calls = []
  const run = rotation({ accounts: [{ id: 'offline-a' }, { id: 'offline-b' }], gen: async (_home, _prompt, options) => {
    calls.push(options.accountId)
    return { ok: false, error: 'quota:reference cache input', phase: 'preflight', submitted: false,
      requiresLogin: false, notes: [marker], referencePreparation: { offline: true } }
  } })
  const result = await run(f.home, prompt)
  assert.equal(result.ok, false); assert.deepEqual(calls, ['offline-a']); assertPreflight(result)
  assert.ok(result.notes.includes(marker)); assert.equal(result.referencePreparation.offline, true)
})
await check('pending recovery protects current reference originals and downscale backups', async () => {
  const f = fixture(), ref = f.file('out.full.png'), gpt = web(f)
  const run = rotation({ pending: { url: pendingUrl, prompt }, gen: gpt.gen, grab: gpt.grab })
  const result = await run(f.home, prompt, { references: [ref], out: path.join(f.dir, 'out.png'), downscale: '8x8' })
  assert.equal(result.ok, false); assert.equal(result.error, 'reference_output_alias'); assertPreflight(result)
  assert.equal(f.calls.length, 0); f.unchanged()
})

console.log('\n[3] Zaiduyu: local validation before credentials and Python submission')
await check('Zaiduyu forwards prepared upload paths and keeps model/size/count choices unchanged', async () => {
  const f = fixture(), refs = [f.file('main.png'), f.file('material.png', png(11, 9, 14))], z = zaiduyu(f)
  const result = await z.generate(f.home, prompt, { references: refs, out: path.join(f.dir, 'out.png'),
    model: 'offline-user-selection', ratio: '3:2', n: 2, referenceCacheDir: f.cache,
    referenceMaxEdge: 512, referenceMaxBytes: 128 * 1024, referenceMaxTotalBytes: 256 * 1024 })
  assert.equal(f.prepCalls[0].options.lane, 'zaiduyu'); assert.equal(f.prepCalls[0].options.dshHome, f.home)
  assert.equal(f.prepCalls[0].options.cacheDir, f.cache); assert.equal(f.prepCalls[0].options.maxEdge, 512)
  assert.equal(f.prepCalls[0].options.maxBytes, 128 * 1024); assert.equal(f.prepCalls[0].options.maxTotalBytes, 256 * 1024)
  const argv = f.calls[0].argv
  assert.deepEqual(Array.from(argv).flatMap((value, i) => value === '--image' ? [argv[i + 1]] : []),
    f.prepared[0].items.map((item) => item.uploadPath))
  for (const [flag, value] of [['--model', 'offline-user-selection'], ['--ratio', '3:2'], ['--n', '2']])
    assert.equal(argv[argv.indexOf(flag) + 1], value)
  assert.equal(f.calls[0].options.dshHome, f.home)
  assertAudit(result, f); f.unchanged()
})
for (const bad of ['missing', 'empty', 'corrupt', 'directory']) await check(`Zaiduyu ${bad} reference stops before environment/credential probe`, async () => {
  const f = fixture(), ref = bad === 'missing' ? path.join(f.dir, 'missing.png') : bad === 'directory' ? f.dir
    : f.file('bad.png', bad === 'empty' ? Buffer.alloc(0) : Buffer.from('not an image'))
  const z = zaiduyu(f, { status: { script: true, python: null, credentials: false } })
  await assert.rejects(z.generate(f.home, prompt, { model: 'offline-model', references: [ref], out: path.join(f.dir, 'out.png') }), (e) => {
    assertPreflight(e); return true
  })
  assert.equal(z.probes(), 0); assert.equal(f.calls.length, 0); f.unchanged()
})
await check('Zaiduyu direct output alias is rejected before environment/credential probe', async () => {
  const f = fixture(), ref = f.file('input.png'), z = zaiduyu(f)
  await assert.rejects(z.generate(f.home, prompt, { model: 'offline-model', references: [ref], out: ref }), (e) => {
    assert.equal(e.code, 'reference_output_alias'); assertPreflight(e); return true
  })
  assert.equal(z.probes(), 0); assert.equal(f.calls.length, 0); f.unchanged()
})
await check('Zaiduyu preparation failure is terminal preflight even with quota text', async () => {
  const f = fixture(), z = zaiduyu(f, { prepare: async () => { throw prepFailure('quota:input budget only') } })
  await assert.rejects(z.generate(f.home, prompt, { model: 'offline-model', references: [f.file('input.png')],
    out: path.join(f.dir, 'out.png') }), (e) => { assertPreflight(e); return true })
  assert.equal(z.probes(), 0); assert.equal(f.calls.length, 0); f.unchanged()
})
for (const stderr of ['服务器分配失败（HTTP 409），未提交生成：请刷新页面以获取服务器分配',
  '图片生成结果暂时无法确认，未自动重投；网络连接中断', '图片生成失败（HTTP 503）：upstream unavailable']) {
  await check(`Zaiduyu post-preparation failure preserves audit and existing classification: ${stderr.slice(0, 18)}`, async () => {
    const f = fixture(), z = zaiduyu(f, { result: { code: 1, stdout: '', stderr } })
    await assert.rejects(z.generate(f.home, prompt, { model: 'offline-model', references: [f.file('input.png')],
      out: path.join(f.dir, 'out.png') }), (e) => {
      assertAudit(e, f); assert.equal(e.requiresLogin, false)
      assert.equal(e.code, stderr.includes('409') ? 'server_allocation_required' : stderr.includes('无法确认') ? 'result_unknown' : 'upstream_error')
      return true
    })
    assert.equal(f.calls.length, 1); f.unchanged()
  })
}
await check('Zaiduyu credential failure after preparation retains audit without changing login semantics', async () => {
  const f = fixture(), z = zaiduyu(f, { status: { script: true, python: 'mock-python', credentials: false } })
  await assert.rejects(z.generate(f.home, prompt, { model: 'offline-model', references: [f.file('input.png')],
    out: path.join(f.dir, 'out.png') }), (e) => {
    assert.equal(e.code, 'no_credentials'); assert.equal(e.requiresLogin, true); assertAudit(e, f); return true
  })
  assert.equal(f.calls.length, 0); f.unchanged()
})

console.log('\n[4] Unified boundary retains audit and does not retry preflight as quota')
for (const lane of ['relayImage', 'zaiduyu']) await check(`${lane} thrown preparation failure stays terminal and keeps audit in unified catch`, async () => {
  const f = fixture(), p = await f.prepare([f.file('input.png')], { lane, dshHome: f.home })
  let calls = 0
  const fail = async () => { calls += 1; throw Object.assign(prepFailure('quota:reference budget failure'),
    { referencePreparation: publicReferencePreparation(p), notes: [...p.notes] }) }
  const run = unified({ order: lane === 'relayImage' ? ['relayImage', 'zaiduyu'] : ['zaiduyu', 'relayImage'],
    relayEdit: fail, relayGenerate: fail, zaiduyuGenerate: fail })
  const result = await run(f.home, prompt, { relayReady: () => true, zaiduyuReady: () => true })
  assert.equal(calls, 1); assert.equal(result.ok, false); assertPreflight(result); assertAudit(result, f)
})
await check('web preflight cannot become a cross-lane quota retry', async () => {
  const f = fixture(); let relayCalls = 0
  const run = unified({ order: ['gptWeb', 'relayImage'], generateWithRotation: async () => ({
    ok: false, error: 'quota:input validation', phase: 'preflight', submitted: false, requiresLogin: false,
    referencePreparation: { offline: true }, notes: [marker],
  }), relayGenerate: async () => { relayCalls += 1; return { outputs: ['memory-only.png'] } } })
  const result = await run(f.home, prompt, { relayReady: () => true })
  assert.equal(result.ok, false); assert.equal(relayCalls, 0); assertPreflight(result)
  assert.equal(result.referencePreparation.offline, true); assert.ok(result.notes.includes(marker))
})
await check('all web quota failures retain preparation audit instead of losing it in lane summary', async () => {
  const f = fixture(); const p = await f.prepare([f.file('input.png')], { lane: 'gptWeb', dshHome: f.home })
  const run = unified({ order: ['gptWeb'], generateWithRotation: async () => ({ ok: false, error: 'quota:rejected',
    referencePreparation: publicReferencePreparation(p), notes: p.notes }) })
  const result = await run(f.home, prompt)
  assert.equal(result.ok, false); assert.equal(result.error, 'all_lanes_failed'); assertAudit(result, f)
})

await check('Zaiduyu CLI error JSON preserves preflight flags and preparation audit/notes', async () => {
  const f = fixture(), p = await f.prepare([f.file('input.png')], { lane: 'zaiduyu', dshHome: f.home })
  let stdout = ''
  const fakeProcess = { argv: [], stdout: { write: (text) => { stdout += text } }, stderr: { write() {} }, exitCode: 0 }
  const run = load('zaiduyu', ['main'], {
    process: fakeProcess, parseArgs: () => ({ _: ['gen'], prompt }), collectReferences: () => [],
    resolveDshHome: () => f.home,
    generate: async () => { throw Object.assign(prepFailure(), { referencePreparation: publicReferencePreparation(p), notes: p.notes }) },
  }).main
  await run(['gen'])
  const result = JSON.parse(stdout)
  assert.equal(result.ok, false); assert.equal(fakeProcess.exitCode, 1)
  assertPreflight(result); assertAudit(result, f)
})

await check('reference output preflight bounds work for excessive n without silently changing n', async () => {
  const f = fixture(), ref = f.file('input.png')
  await assert.rejects(relay(f).generateImage({ dshHome: f.home, ref, prompt,
    out: path.join(f.dir, 'out.png'), n: 4097 }), (e) => {
    assert.equal(e.code, 'reference_output_count_unbounded'); assertPreflight(e); return true
  })
  assert.equal(f.calls.length, 0); f.unchanged()
})
await check('image CLI keeps stderr but also exposes structured reference failures', async () => {
  const f = fixture(), p = await f.prepare([f.file('input.png')], { lane: 'relayImage', dshHome: f.home })
  let stdout = '', stderr = ''
  const fakeProcess = { stdout: { write: (text) => { stdout += text } }, stderr: { write: (text) => { stderr += text } }, exitCode: 0 }
  const start = source.image.lastIndexOf('main().catch(')
  const end = source.image.indexOf('\n  })', start)
  assert.ok(start >= 0 && end > start, 'real CLI failure callback exists')
  const callback = vm.runInNewContext(`(${source.image.slice(start + 'main().catch('.length, end + 4)})`, { process: fakeProcess })
  await callback(Object.assign(prepFailure(), { referencePreparation: publicReferencePreparation(p), notes: p.notes }))
  assert.match(stderr, /offline preparation/); assert.equal(fakeProcess.exitCode, 1)
  assert.ok(stdout, 'structured failure must be available to CLI consumers')
  const result = JSON.parse(stdout)
  assert.equal(result.ok, false); assertPreflight(result); assertAudit(result, f)
})
await check('numbered generation only guards actual output names, not an unused base path', async () => {
  const f = fixture(), ref = f.file('out.png'), image = png(9, 7, 55).toString('base64')
  const result = await relay(f, { fetch: async () => response({ data: [{ b64_json: image }, { b64_json: image }] }) })
    .generateImage({ dshHome: f.home, ref, out: ref, prompt, n: 2, downscale: '8x8' })
  assert.deepEqual(Array.from(result.outputs), [path.join(f.dir, 'out_1.png'), path.join(f.dir, 'out_2.png')])
  assert.equal(f.calls.length, 1); f.unchanged()
})
await check('relay edits do not acquire numbered/downscale outputs from text-generation options', async () => {
  const f = fixture(), ref = f.file('out_1.full.png'), out = path.join(f.dir, 'out.png')
  const result = await relay(f).editImage({ dshHome: f.home, in: ref, out, prompt, n: 2, downscale: '8x8' })
  assert.deepEqual(Array.from(result.outputs), [out]); assert.equal(f.outputs.size, 1); f.unchanged()
})

console.log('\n[5] Imported production relay + real helper + in-memory fetch')
for (const jsonFallback of [false, true]) await check(`actual imported editImage sends real prepared PNGs (${jsonFallback ? 'JSON fallback' : 'multipart'})`, async () => {
  const f = fixture(), refs = [f.file('misleading-extension.jpg', png(700, 20, 91)), f.file('second.png', png(300, 18, 202))]
  const out = path.join(f.dir, 'new-output.png'), calls = [], returnedImage = png(9, 7, 161)
  assert.equal(fs.existsSync(out), false, 'this run may only create a new output')
  const previousFetch = globalThis.fetch
  const { editImage } = await import('../src/taptap-image.mjs')
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://offline.invalid/v1/images/edits')
      assert.equal(options.method, 'POST')
      assert.equal(options.headers.Authorization, 'Bearer offline-fixture-key')
      calls.push(options)
      if (jsonFallback && options.body instanceof FormData) return response('use JSON body with base64', 400)
      return response({ data: [{ b64_json: returnedImage.toString('base64') }] })
    }
    const result = await editImage({ dshHome: f.home, baseURL: 'https://offline.invalid/v1',
      apiKey: 'offline-fixture-key', model: 'gpt-image-offline', in: refs, prompt, out,
      referenceCacheDir: f.cache, referenceMaxEdge: 256, referenceMaxBytes: 256 * 1024, referenceMaxTotalBytes: 512 * 1024 })
    assert.equal(calls.length, jsonFallback ? 2 : 1)
    assert.equal(result.inputCount, 2); assert.equal(result.referencePreparation.changedCount, 2)
    const files = calls[0].body.getAll('image[]')
    assert.equal(files.length, 2)
    for (const [index, file] of files.entries()) {
      const audit = result.referencePreparation.items[index]
      assert.equal(file.type, 'image/png'); assert.match(file.name, /\.png$/)
      const bytes = Buffer.from(await file.arrayBuffer())
      assert.equal(digest(bytes), audit.upload.sha256)
      assert.equal(audit.upload.mime, 'image/png'); assert.ok(audit.upload.width <= 256)
      assert.equal(audit.source.sha256, digest(fs.readFileSync(refs[index])))
      if (jsonFallback) {
        const body = JSON.parse(calls[1].body)
        assert.equal(body.image[index], `data:image/png;base64,${bytes.toString('base64')}`)
        assert.deepEqual(body.images, body.image)
      }
    }
    assert.deepEqual(fs.readFileSync(out), returnedImage)
    assert.ok(result.notes.length); f.unchanged()
  } finally { globalThis.fetch = previousFetch }
})

console.log(`\nResult: ${passed} passed, ${failed} failed; fixtures retained: ${scratch}`)
process.exitCode = failed ? 1 : 0
