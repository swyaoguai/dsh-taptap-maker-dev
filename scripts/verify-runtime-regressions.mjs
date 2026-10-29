/**
 * Runtime regressions: mock every upstream request and subprocess; no real
 * generation, login, user configuration, model download, or dependency install.
 * Run: node scripts/verify-runtime-regressions.mjs
 * Temporary fixtures are unique and intentionally retained for inspection.
 */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import vm from 'node:vm'

import { runWithFallback } from '../src/lanes.mjs'
import { consumeGenFlags, parseArgs as parseSfxArgs } from '../src/taptap-sfx.mjs'
import { collectReferences, parseArgs as parseZaiduyuArgs } from '../src/taptap-zaiduyu.mjs'

let passed = 0
let failed = 0
async function check(name, run) {
  try { await run(); passed += 1; console.log(`  PASS ${name}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${name}: ${error.message}`) }
}

const gptSource = fs.readFileSync(new URL('../src/taptap-gpt.mjs', import.meta.url), 'utf8')
const sfxSource = fs.readFileSync(new URL('../src/taptap-sfx.mjs', import.meta.url), 'utf8')
const zaiduyuSource = fs.readFileSync(new URL('../src/taptap-zaiduyu.mjs', import.meta.url), 'utf8')

// Execute the real function body with dependencies replaced in memory. Never
// reimplement the logic under test, or execute the CLI's automatic entry point.
function loadExport(source, name, dependencies) {
  const start = source.search(new RegExp(`export (?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `real function ${name} exists`)
  const nextExport = source.indexOf('\nexport ', start + 10)
  const cliEntry = source.indexOf('\nconst isMain =', start + 10)
  const end = Math.min(...[nextExport, cliEntry, source.length].filter((n) => n >= 0))
  const context = vm.createContext({ ...dependencies })
  vm.runInContext(`${source.slice(start, end).replace(/^export /, '')}\nthis.__fn = ${name}`, context)
  return context.__fn
}

const prompt = 'offline shield icon'
const pendingUrl = 'https://chatgpt.com/c/OFFLINE-TEST-CONVERSATION'
function gptFixture({ pending, failure, accounts = [], genResult, loggedIn = true } = {}) {
  const calls = []
  const pendingRecord = pending === undefined
    ? { url: pendingUrl, prompt, accountId: 'offline-a', at: Date.now() - 1000 }
    : pending
  const run = loadExport(gptSource, 'generateWithRotation', {
    readGptLaneEnabled: () => true,
    isLaneEnabled: () => true,
    readGptPool: () => ({ accounts, autoRotate: true }),
    readGptPending: () => pendingRecord,
    pickGptAccount: (_home, { exclude }) => accounts.find((a) => !exclude.includes(a.id)) ?? null,
    statusFor: () => ({ loggedIn }),
    grab: async (_home, options) => {
      calls.push({ operation: 'grab', options })
      if (failure instanceof Error) throw failure
      return { ...failure, url: pendingRecord?.url }
    },
    gen: async (_home, _prompt, options) => {
      calls.push({ operation: 'gen', options })
      return typeof genResult === 'function' ? genResult(options) : (genResult ?? { ok: true, saved: 'MEMORY-ONLY.png', account: options.accountId ?? null })
    },
  })
  return { run, calls }
}

console.log('\n[1] Pending recovery must never submit a duplicate')
for (const failure of [
  { ok: false, error: 'no_image', stillGenerating: true },
  { ok: false, error: 'no_image', stillGenerating: false },
  { ok: false, error: 'timed out after 300s' },
  { ok: false, error: 'download_failed' },
  { ok: false, error: 'write_failed' },
  { ok: false, error: 'not_logged_in' },
  { ok: false },
  new Error('browser recovery failed'),
]) {
  await check(`grab failure stops: ${failure.error ?? failure.message ?? 'unknown'}`, async () => {
    const fixture = gptFixture({ failure })
    const result = await fixture.run('MEMORY-HOME', prompt)
    assert.equal(fixture.calls.filter((c) => c.operation === 'gen').length, 0, 'no new gen after recovery failure')
    assert.equal(result.ok, false)
    assert.equal(result.pendingUrl, pendingUrl, 'recovery URL survives')
    assert.ok(result.error, 'unknown errors get a concrete reason')
  })
}
await check('successful resume forwards output, downscale, wait and directory options', async () => {
  const fixture = gptFixture({ failure: { ok: true, saved: 'MEMORY-ONLY.png' } })
  const result = await fixture.run('MEMORY-HOME', prompt, { out: 'chosen.png', downscale: '128x128', waitMs: 5000, dir: 'chosen-dir', projectDir: 'chosen-project' })
  assert.equal(result.resumed, true)
  assert.equal(fixture.calls.length, 1)
  const { options } = fixture.calls[0]
  assert.equal(options.out, 'chosen.png')
  assert.equal(options.downscale, '128x128')
  assert.equal(options.waitMs, 5000)
  assert.equal(options.dir, 'chosen-dir')
  assert.equal(options.projectDir, 'chosen-project')
})
await check('a different prompt cannot silently reuse the pending image', async () => {
  const fixture = gptFixture({ failure: { ok: true, saved: 'OLD-IMAGE.png' } })
  const result = await fixture.run('MEMORY-HOME', 'a completely different request')
  assert.equal(result.ok, false)
  assert.equal(result.pendingUrl, pendingUrl)
  assert.equal(fixture.calls.length, 0, 'ask whether to recover or start a new request')
})
await check('record age is not evidence that a previous submission failed', async () => {
  const fixture = gptFixture({ pending: { url: pendingUrl, prompt, accountId: 'offline-a', at: Date.now() - 3600000 }, failure: { ok: false, error: 'download_failed' } })
  const result = await fixture.run('MEMORY-HOME', prompt)
  assert.equal(fixture.calls.filter((c) => c.operation === 'gen').length, 0)
  assert.equal(result.pendingUrl, pendingUrl)
})
await check('explicit noResume opts into a new submission', async () => {
  const fixture = gptFixture({ failure: { ok: false, error: 'no_image' } })
  const result = await fixture.run('MEMORY-HOME', prompt, { noResume: true })
  assert.equal(result.ok, true)
  assert.deepEqual(fixture.calls.map((c) => c.operation), ['gen'])
})

console.log('\n[2] Account rotation only retries a confirmed quota rejection')
await check('selected GPT generation still requires a logged-in profile', async () => {
  const fixture = gptFixture({ pending: null, loggedIn: false })
  const result = await fixture.run('MEMORY-HOME', prompt)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not_logged_in')
  assert.equal(fixture.calls.length, 0)
})
for (const error of ['timed out after 660s', 'download_failed', 'write_failed', undefined]) {
  await check(`uncertain gen stops rotation: ${error ?? 'unknown'}`, async () => {
    const fixture = gptFixture({ pending: null, accounts: [{ id: 'offline-a' }, { id: 'offline-b' }], genResult: ({ accountId }) => ({ ok: false, error, pendingUrl, account: accountId, steps: { stage: 'submitted' }, hint: 'recover this conversation' }) })
    const result = await fixture.run('MEMORY-HOME', prompt)
    assert.equal(fixture.calls.length, 1, 'do not submit with the next account')
    assert.equal(result.pendingUrl, pendingUrl)
    assert.equal(result.steps.stage, 'submitted')
    assert.equal(result.hint, 'recover this conversation')
    assert.ok(result.error)
  })
}
await check('quota rejection may rotate even when its response includes a conversation URL', async () => {
  const fixture = gptFixture({ pending: null, accounts: [{ id: 'offline-a' }, { id: 'offline-b' }], genResult: ({ accountId }) => accountId === 'offline-a' ? { ok: false, error: 'quota:rejected', pendingUrl } : { ok: true, saved: 'MEMORY-ONLY.png', account: accountId } })
  const result = await fixture.run('MEMORY-HOME', prompt)
  assert.equal(result.ok, true)
  assert.equal(result.rotated, true)
  assert.deepEqual(fixture.calls.map((c) => c.options.accountId), ['offline-a', 'offline-b'])
})
for (const error of ['timed out after 660s', 'quota:rejected']) {
  await check(`cross-lane fallback respects submission certainty: ${error}`, async () => {
    let relayCalls = 0
    const run = loadExport(gptSource, 'generateImage', {
      laneOrder: () => ['gptWeb', 'relayImage'],
      readGptLaneEnabled: () => true,
      readLanes: () => ({ autoFallback: true }),
      generateWithRotation: async () => ({ ok: false, error, pendingUrl }),
      relayGenerate: async () => { relayCalls += 1; return { ok: true, saved: 'MEMORY-ONLY.png' } },
      runWithFallback,
    })
    const result = await run('MEMORY-HOME', prompt, { relayReady: () => true })
    assert.equal(relayCalls, error.startsWith('quota:') ? 1 : 0)
    assert.equal(result.ok, error.startsWith('quota:'))
    if (!result.ok) assert.equal(result.pendingUrl, pendingUrl)
  })
}

for (const order of [['relayImage', 'zaiduyu'], ['zaiduyu', 'relayImage']]) {
  await check(`unknown paid-lane result never submits through the next lane: ${order[0]}`, async () => {
    const submissions = []
    const run = loadExport(gptSource, 'generateImage', {
      laneOrder: () => order, readGptLaneEnabled: () => false,
      readLanes: () => ({ autoFallback: true }), runWithFallback,
      relayGenerate: async () => {
        submissions.push('relayImage')
        if (order[0] === 'relayImage') throw new Error('offline transport timeout; result unknown')
        return { outputs: ['MEMORY-ONLY.png'] }
      },
      zaiduyuGenerate: async () => {
        submissions.push('zaiduyu')
        if (order[0] === 'zaiduyu') throw new Error('offline transport timeout; result unknown')
        return { ok: true, saved: 'MEMORY-ONLY.png' }
      },
    })
    const result = await run('MEMORY-HOME', prompt, { relayReady: () => true, zaiduyuReady: () => true })
    assert.deepEqual(submissions, [order[0]], 'only the original request is submitted')
    assert.equal(result.ok, false)
    assert.match(result.hint, /result unknown/)
  })
}

await check('confirmed Zaiduyu quota marker may fall back to the relay', async () => {
  let relayCalls = 0
  const run = loadExport(gptSource, 'generateImage', {
    laneOrder: () => ['zaiduyu', 'relayImage'], readGptLaneEnabled: () => false,
    readLanes: () => ({ autoFallback: true }), runWithFallback,
    zaiduyuGenerate: async () => { throw Object.assign(new Error('current credits insufficient'), { quota: true }) },
    relayGenerate: async () => { relayCalls += 1; return { outputs: ['MEMORY-ONLY.png'] } },
  })
  const result = await run('MEMORY-HOME', prompt, { relayReady: () => true, zaiduyuReady: () => true })
  assert.equal(relayCalls, 1)
  assert.equal(result.ok, true)
  assert.equal(result.lane, 'relayImage')
  assert.equal(result.rotatedLanes, true)
})

console.log('\n[3] Browser exceptions retain their reason and recovery URL')
for (const name of ['gen', 'grab']) {
  await check(`${name} preserves Python exception fields`, async () => {
    const records = []
    const run = loadExport(gptSource, name, {
      path, os, process: { pid: 1 },
      fs: { mkdirSync() {}, existsSync: () => true },
      GPT_URL: 'https://chatgpt.com/', pyStr: (s) => JSON.stringify(s),
      readGptLaneEnabled: () => true,
      readGptPending: () => ({ url: pendingUrl, accountId: 'offline-a' }),
      gptAccountProfileDir: () => 'MEMORY-PROFILE', gptProfileDir: () => 'MEMORY-PROFILE',
      resolveDownloadDir: () => ({ dir: 'MEMORY-DIRECTORY' }),
      writeGptPending: (_home, record) => { records.push(record) },
      runBrowser: async () => ({ ok: false, error: 'offline Python exception', conv_url: pendingUrl, steps: { stage: 'submitted' } }),
    })
    const result = name === 'gen' ? await run('MEMORY-HOME', prompt) : await run('MEMORY-HOME', { url: pendingUrl })
    assert.equal(result.error, 'offline Python exception')
    if (name === 'gen') {
      assert.equal(result.pendingUrl, pendingUrl)
      assert.equal(records[0].url, pendingUrl)
    } else assert.equal(result.url, pendingUrl)
  })
}
await check('confirmed quota rejection does not create a generating pending record', async () => {
  const records = []
  const run = loadExport(gptSource, 'gen', {
    path, os, process: { pid: 1 }, fs: { mkdirSync() {}, existsSync: () => true },
    GPT_URL: 'https://chatgpt.com/', pyStr: (s) => JSON.stringify(s),
    readGptLaneEnabled: () => true, touchGptAccount() {},
    gptAccountProfileDir: () => 'MEMORY-PROFILE', gptProfileDir: () => 'MEMORY-PROFILE',
    resolveDownloadDir: () => ({ dir: 'MEMORY-DIRECTORY' }),
    writeGptPending: (_home, record) => { records.push(record) },
    runBrowser: async () => ({ ok: true, error: 'quota:rejected', conv_url: pendingUrl, steps: {} }),
  })
  const result = await run('MEMORY-HOME', prompt)
  assert.equal(result.error, 'quota:rejected')
  assert.equal(records.length, 0)
})

console.log('\n[4] CLI consumers preserve booleans, aliases and missing-value errors')
const numOptSource = /function numOpt[\s\S]*?\n\}/.exec(sfxSource)?.[0]
assert.ok(numOptSource, 'real numeric option helper exists')
const numOpt = vm.runInNewContext(`(${numOptSource})`)
function fakeProcess() {
  const output = { stdout: '', stderr: '' }
  const process = { argv: [], stdout: { write: (s) => { output.stdout += s } }, stderr: { write: (s) => { output.stderr += s } }, exitCode: 0 }
  return { process, output }
}
function sfxCli() {
  const io = fakeProcess()
  const calls = []
  let hardwareChecks = 0
  const run = loadExport(sfxSource, 'main', {
    parseArgs: parseSfxArgs, consumeGenFlags, numOpt, process: io.process,
    checkHardware: () => { hardwareChecks += 1; return { ran: true, usable: true } },
    generate: (description, options) => { calls.push({ description, options }); return { ok: true, generated: 1, files: [] } },
  })
  return { run, calls, io, hardwareChecks: () => hardwareChecks }
}
for (const [flag, expected] of [['--lowvram', true], ['--no-lowvram', false]]) {
  await check(`SFX ${flag} does not consume the first prompt word`, async () => {
    const parsed = parseSfxArgs(['gen', flag, 'laser', 'zap'])
    assert.deepEqual(parsed._, ['gen', 'laser', 'zap'])
    const fixture = sfxCli()
    await fixture.run(['gen', flag, 'laser', 'zap'])
    assert.equal(fixture.calls[0].description, 'laser zap')
    assert.equal(fixture.calls[0].options.lowvram, expected)
  })
}
await check('SFX CLI consumes explicit --prompt and --variants like the slash command', async () => {
  const fixture = sfxCli()
  await fixture.run(['gen', '--prompt', 'coin pickup', '--variants', '2', '--seed', '-1', '-o', 'coins.wav'])
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.calls[0].description, 'coin pickup')
  assert.equal(fixture.calls[0].options.variants, 2)
  assert.equal(fixture.calls[0].options.seed, -1)
  assert.equal(fixture.calls[0].options.outName, 'coins.wav')
})
await check('SFX missing values fail before hardware checks or generation', async () => {
  const fixture = sfxCli()
  await fixture.run(['gen', 'coin pickup', '--seed', '--steps', '150'])
  assert.equal(fixture.hardwareChecks(), 0)
  assert.equal(fixture.calls.length, 0)
  assert.equal(fixture.io.process.exitCode, 2)
  assert.match(fixture.io.output.stderr, /--seed/)
})
await check('SFX positional delimiter preserves a dash-prefixed description', async () => {
  const fixture = sfxCli()
  await fixture.run(['gen', '--', '--laser', 'zap'])
  assert.equal(fixture.calls[0].description, '--laser zap')
})

for (const [flags, expected] of [
  [['-m', 'offline-cheap'], 'offline-cheap'],
  [['-m=offline-cheap'], 'offline-cheap'],
  [['--model', 'offline-first', '-m', 'offline-last'], 'offline-last'],
  [['-m', 'offline-first', '--model', 'offline-last'], 'offline-last'],
]) {
  await check(`Zaiduyu forwards the user's last model selection: ${flags.join(' ')}`, async () => {
    const io = fakeProcess()
    const models = []
    const run = loadExport(zaiduyuSource, 'main', {
      parseArgs: parseZaiduyuArgs, collectReferences, process: io.process,
      resolveDshHome: () => 'MEMORY-HOME',
      generate: async (_home, _prompt, options) => { models.push(options.model); return { ok: true, saved: 'MEMORY-ONLY.png' } },
    })
    await run(['gen', '--prompt', prompt, ...flags])
    assert.deepEqual(models, [expected])
  })
}
await check('Zaiduyu missing -m remains an explicit missing value, not a default model', async () => {
  const args = parseZaiduyuArgs(['gen', '--prompt', prompt, '-m'])
  assert.equal(args.model, true)
})

console.log('\n[4] Real host routes and commands, with all I/O mocked')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-regressions-'))
const originalFetch = globalThis.fetch
const originalSpawn = childProcess.spawn
const originalSpawnSync = childProcess.spawnSync
let activeFetch
let processResult = { code: 0, stdout: JSON.stringify({ outputs: ['MEMORY-ONLY.png'] }), stderr: '' }
let spawnCalls = []
let events = []
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII='
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('raw.githubusercontent.com')) return new Response(JSON.stringify({ version: '0.2.0' }))
  assert.ok(activeFetch, 'unexpected request is forbidden')
  return activeFetch(String(url), options)
}
childProcess.spawnSync = (bin, args, options) => {
  spawnCalls.push({ bin, args, options, sync: true })
  // Simulate a slow child without actually starting one. A synchronous host
  // call will finish before its scheduled event-loop tick, which is the bug.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  return { status: processResult.code, stdout: processResult.stdout, stderr: processResult.stderr }
}
childProcess.spawn = (bin, args, options) => {
  spawnCalls.push({ bin, args, options, sync: false })
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => true
  setTimeout(() => {
    if (processResult.error) child.emit('error', new Error(processResult.error))
    else {
      child.stdout.emit('data', Buffer.from(processResult.stdout))
      child.stderr.emit('data', Buffer.from(processResult.stderr))
      child.emit('close', processResult.code)
    }
  }, 15)
  return child
}
syncBuiltinESMExports()
const { apply } = await import('../index.js')
const { stopBackgroundCheck } = await import('../src/version-checker.mjs')
const { readImageConfigRaw, readVideoRelayConfigRaw, writeImageConfigPatch, writeVideoRelayConfigPatch, writeGptLaneEnabled } = await import('../src/paths.js')
const { writeLanes } = await import('../src/lanes.mjs')

function hostFixture(name) {
  const home = path.join(scratch, name)
  const commands = new Map()
  let handler
  const noop = () => () => {}
  const context = {
    logger: { info() {}, warn() {} },
    inject(_names, setup) {
      setup({
        effect: (effect) => effect(),
        webServer: { register(route) { handler = route.handler; return () => {} } },
        systemPrompt: { section: noop }, skills: { registerProvider: noop },
        commands: { register(command) { commands.set(command.name, command); return () => {} } },
      })
    },
  }
  apply(context, { dshHome: home, skills: { autoUpdate: false }, audio: { autoEnsure: false } })
  stopBackgroundCheck()
  const config = { baseURL: 'https://mock.invalid/v1', apiKey: 'fake-offline-saved-credential', model: 'offline-model' }
  writeImageConfigPatch(home, config)
  writeVideoRelayConfigPatch(home, { ...config, enabled: true })
  async function call(method, sub, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(req, { method, url: `/api/taptap-maker-dev/${sub}`, headers: {} })
    let status, payload
    await handler(req, { writeHead(s) { status = s }, end(text) { payload = JSON.parse(text) } })
    return { status, payload }
  }
  return { home, commands, call, config }
}
try {
  for (const [getPath, postPath, readSaved] of [['image', 'models', readImageConfigRaw], ['video-relay', 'video-relay/models', readVideoRelayConfigRaw]]) {
    await check(`${postPath}: masked GET->POST uses saved credential; a new key still overrides`, async () => {
      const fixture = hostFixture(getPath)
      const loaded = await fixture.call('GET', getPath)
      const form = getPath === 'image' ? loaded.payload : loaded.payload.relay
      assert.notEqual(form.apiKey, fixture.config.apiKey)
      for (const submitted of [form.apiKey, ` ${form.apiKey} `, '', undefined, 'fake-offline-new-credential']) {
        const expected = submitted === 'fake-offline-new-credential' ? submitted : fixture.config.apiKey
        let seen = 0
        activeFetch = async (url, options) => {
          assert.equal(url, 'https://mock.invalid/v1/models')
          seen += 1
          const good = options.headers.Authorization === `Bearer ${expected}`
          return new Response(JSON.stringify(good ? { data: [{ id: 'offline-model' }] } : { error: 'mock authentication rejected' }), { status: good ? 200 : 401 })
        }
        const result = await fixture.call('POST', postPath, { baseURL: form.baseURL, apiKey: submitted })
        assert.equal(result.status, 200, 'mask must not become an upstream key')
        assert.equal(result.payload.ok, true)
        assert.equal(seen, 1)
        assert.equal(readSaved(fixture.home).apiKey, fixture.config.apiKey, 'model discovery never changes saved credentials')
      }
    })
  }
  for (const rawInput of ['offline icon', '--config']) await check(`image command stays responsive and uses its configured home: ${rawInput}`, async () => {
    const fixture = hostFixture(`async-image-${rawInput === '--config' ? 'config' : 'gen'}`)
    spawnCalls = []; events = []
    processResult = { code: 0, stdout: JSON.stringify({ outputs: ['MEMORY-ONLY.png'] }), stderr: '' }
    const tick = new Promise((resolve) => setTimeout(() => { events.push('tick'); resolve() }, 0))
    const result = await fixture.commands.get('taptap-image').handler({ rawInput })
    events.push('done')
    await tick
    assert.equal(result.kind, 'success')
    assert.deepEqual(events, ['tick', 'done'], 'event-loop tick runs while awaiting the child')
    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0].sync, false)
    assert.equal(spawnCalls[0].options.env.DSH_HOME, fixture.home)
  })
  for (const response of [
    { code: 1, stdout: '', stderr: 'mock rejected' },
    { code: -2, stdout: '', stderr: 'mock timeout; result unknown' },
    { code: 0, stdout: 'not valid JSON', stderr: '' },
    { code: 0, stdout: JSON.stringify({}), stderr: '' },
    { code: 0, stdout: JSON.stringify({ outputs: [] }), stderr: '' },
    { code: 0, stdout: '', stderr: '', error: 'mock spawn failed' },
  ]) {
    await check(`image subprocess failure never retries: ${response.error ?? response.stderr}`, async () => {
      const fixture = hostFixture(`failure-${passed + failed}`)
      spawnCalls = []; processResult = response
      const result = await fixture.commands.get('taptap-image').handler({ rawInput: 'offline icon' })
      assert.equal(result.kind, 'error')
      assert.equal(spawnCalls.length, 1)
    })
  }
  for (const masterEnabled of [true, false]) {
    await check(`unified image entry can use relay without GPT login (master=${masterEnabled})`, async () => {
      const fixture = hostFixture(`relay-first-${masterEnabled}`)
      writeGptLaneEnabled(fixture.home, masterEnabled)
      writeLanes(fixture.home, { autoFallback: false, groups: { image: { order: ['relayImage', 'gptWeb', 'zaiduyu'], enabled: { relayImage: true, gptWeb: false, zaiduyu: false } } } })
      let creates = 0
      activeFetch = async (url) => {
        assert.equal(url, 'https://mock.invalid/v1/images/generations')
        creates += 1
        return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }))
      }
      const result = await fixture.commands.get('taptap-gpt').handler({ rawInput: 'offline relay icon' })
      assert.equal(result.kind, 'success', 'do not require an unrelated GPT account')
      assert.equal(creates, 1)
      assert.doesNotMatch(result.text, /\bundefined\b/)
      assert.match(result.text, /\.png\b/)
    })
  }
} finally {
  stopBackgroundCheck()
  globalThis.fetch = originalFetch
  childProcess.spawn = originalSpawn
  childProcess.spawnSync = originalSpawnSync
  syncBuiltinESMExports()
}

console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
