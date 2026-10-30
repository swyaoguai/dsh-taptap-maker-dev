/** Real host API + dispatch integration, all children/fetch mocked in memory.
 * node scripts/verify-zaiduyu-integration.mjs
 * Temporary fixtures deliberately retained; no login, network, file deletion.
 */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

let passed = 0, failed = 0, calls = [], response = { code: 0, stderr: '' }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zaiduyu-integration-'))
const image = path.join(scratch, 'offline-result.png')
fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBhsAAAAASUVORK5CYII=', 'base64'))
const oldSpawn = childProcess.spawn, oldSync = childProcess.spawnSync, oldFetch = globalThis.fetch
childProcess.spawnSync = (program, argv, options) => { calls.push({ sync: true, program, argv, options }); return { status: 0, stdout: '3', stderr: '' } }
childProcess.spawn = (program, argv, options) => {
  calls.push({ sync: false, program, argv, options })
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
  setTimeout(() => { child.stdout.emit('data', Buffer.from(response.code === 0 ? image + '\n' : '')); child.stderr.emit('data', Buffer.from(response.stderr)); child.emit('close', response.code) }, 0)
  return child
}
globalThis.fetch = async () => new Response(JSON.stringify({ version: '0.2.0' }))
syncBuiltinESMExports()
const { apply } = await import('../index.js')
const { stopBackgroundCheck } = await import('../src/version-checker.mjs')
const { writeZaiduyuConfigPatch, readZaiduyuConfigRaw } = await import('../src/paths.js')
const { readZaiduyuPreferences, writeZaiduyuPreferences } = await import('../src/zaiduyu-preferences.mjs')
const { writeLanes, readLanes } = await import('../src/lanes.mjs')
const { plan } = await import('../src/taptap-zaiduyu.mjs')
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`) }
}
function fixture(name) {
  const home = path.join(scratch, name), commands = new Map(), sections = []
  let route
  const noop = () => () => {}
  writeZaiduyuConfigPatch(home, { identifier: 'offline-user', password: 'fake-offline-only', lastVerifiedAt: '2026-10-30T00:00:00.000Z', lastIdentifier: 'offline-user' })
  writeLanes(home, { autoFallback: false, groups: { image: { order: ['zaiduyu', 'gptWeb', 'relayImage'], enabled: { zaiduyu: true, gptWeb: false, relayImage: false } } } })
  const context = { logger: { info() {}, warn() {} }, inject(_names, fn) { fn({ effect: (f) => f(), webServer: { register(r) { route = r.handler; return () => {} } }, systemPrompt: { section(s) { sections.push(s); return () => {} } }, skills: { registerProvider: noop }, commands: { register(c) { commands.set(c.name, c); return () => {} } } }) } }
  apply(context, { dshHome: home, skills: { autoUpdate: false }, audio: { autoEnsure: false } }); stopBackgroundCheck()
  async function call(method, sub, value) {
    const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]); Object.assign(req, { method, url: `/api/taptap-maker-dev/${sub}`, headers: {} })
    let status, payload
    await route(req, { writeHead(s) { status = s }, end(text) { payload = JSON.parse(text) } })
    return { status, payload }
  }
  return { home, commands, sections, call }
}
try {
  await check('preferred sources are read-only discovery metadata, not a license allowlist', async () => {
    const f = fixture('sources'); calls = []
    const result = await f.call('GET', 'asset-sources')
    assert.equal(result.status, 200); assert.equal(result.payload.ok, true)
    assert.deepEqual(result.payload.sources.map((s) => s.id), ['gameui', 'interfaceingame', 'enotsixlm-game-ui-kits', 'lemooui', 'pixlab24', 'kenney'])
    assert.equal(result.payload.sources[1].automation, 'forbidden')
    assert.equal(result.payload.sources[5].suppliedUrl, 'https://kenney.nl/games')
    assert.equal(result.payload.sources[5].searchUrl, 'https://kenney.nl/assets')
    assert.equal(calls.length, 0)
    const text = f.sections.at(-1).text
    assert.ok(text.includes('taptap-maker-free-assets'))
    assert.ok(text.indexOf('免费合法素材') < text.indexOf('确需生成新图'))
  })
  await check('model-only POST saves without login and preserves credentials/lane settings', async () => {
    const f = fixture('settings'), before = readZaiduyuConfigRaw(f.home), lanes = JSON.stringify(readLanes(f.home))
    calls = []
    const saved = await f.call('POST', 'zaiduyu/settings', { defaultModel: 'offline-model-a' })
    assert.equal(saved.status, 200); assert.equal(saved.payload.defaultModel, 'offline-model-a')
    assert.equal(calls.length, 0, 'preferences never start Python or login')
    assert.deepEqual(readZaiduyuConfigRaw(f.home), before)
    assert.equal(JSON.stringify(readLanes(f.home)), lanes)
    const loaded = await f.call('GET', 'zaiduyu')
    assert.equal(loaded.payload.defaultModel, 'offline-model-a'); assert.equal(loaded.payload.hasCredentials, true)
    assert.ok(!JSON.stringify(saved.payload).includes('fake-offline-only'))
    assert.ok(!JSON.stringify(saved.payload).includes('offline-user'))
    assert.ok(f.sections.at(-1).text.includes('offline-model-a'), 'saved choice refreshes live agent instructions')
  })
  await check('malformed/mixed model payloads reject before writing or login', async () => {
    const f = fixture('invalid'); writeZaiduyuPreferences(f.home, { defaultModel: 'offline-model-a' }); calls = []
    for (const body of [null, [], {}, { defaultModel: true }, { defaultModel: ['b'] }, { defaultModel: 'a\nb' }, { defaultModel: 'b', password: 'not-accepted' }, { defaultModel: 'b', clear: true }]) {
      const result = await f.call('POST', 'zaiduyu/settings', body)
      assert.equal(result.status, 400, JSON.stringify(body)); assert.equal(result.payload.ok, false)
      assert.equal(readZaiduyuPreferences(f.home).defaultModel, 'offline-model-a')
    }
    assert.equal(calls.length, 0)
  })
  await check('clear default writes empty preference but keeps account and does not delete files', async () => {
    const f = fixture('clear-default'); writeZaiduyuPreferences(f.home, { defaultModel: 'offline-model-a' }); const before = readZaiduyuConfigRaw(f.home)
    calls = []; const result = await f.call('POST', 'zaiduyu/settings', { defaultModel: '' })
    assert.equal(result.status, 200); assert.equal(readZaiduyuPreferences(f.home).defaultModel, '')
    assert.deepEqual(readZaiduyuConfigRaw(f.home), before); assert.equal(calls.length, 0)
  })
  await check('dedicated generation uses saved default; explicit override does not change it', async () => {
    const f = fixture('dedicated'); writeZaiduyuPreferences(f.home, { defaultModel: 'offline-model-a' })
    for (const [rawInput, expected] of [['offline icon', 'offline-model-a'], ['offline icon --model offline-model-b', 'offline-model-b']]) {
      calls = []; response = { code: 0, stderr: '' }
      const result = await f.commands.get('taptap-zaiduyu').handler({ rawInput })
      assert.equal(result.kind, 'success', result.text)
      const child = calls.find((c) => !c.sync); assert.ok(child)
      assert.equal(child.argv[child.argv.indexOf('--model') + 1], expected)
      assert.ok(child.options.env.ZAIDUYU_USER === 'offline-user' && child.options.env.ZAIDUYU_PASS === 'fake-offline-only', 'only isolated fixture credentials enter the mocked child')
      assert.equal(readZaiduyuPreferences(f.home).defaultModel, 'offline-model-a')
    }
  })
  await check('unified generation forwards saved model and explicit model without prompt pollution', async () => {
    const f = fixture('unified'); writeZaiduyuPreferences(f.home, { defaultModel: 'offline-model-a' })
    for (const [rawInput, expected] of [['offline icon', 'offline-model-a'], ['offline icon --model offline-model-b', 'offline-model-b']]) {
      calls = []; response = { code: 0, stderr: '' }
      const result = await f.commands.get('taptap-gpt').handler({ rawInput }); assert.equal(result.kind, 'success', result.text)
      const children = calls.filter((c) => !c.sync); assert.equal(children.length, 1)
      const a = children[0].argv; assert.equal(a[a.indexOf('--model') + 1], expected); assert.equal(a[a.indexOf('--prompt') + 1], 'offline icon')
      assert.equal(readZaiduyuPreferences(f.home).defaultModel, 'offline-model-a')
    }
  })
  await check('unset model stops with model instruction, zero generation or login children', async () => {
    const f = fixture('unset'); calls = []
    const result = await f.commands.get('taptap-zaiduyu').handler({ rawInput: 'offline icon' })
    assert.equal(result.kind, 'error'); assert.match(result.text, /模型/)
    assert.equal(calls.length, 0)
  })
  await check('plan forwards saved default on read-only path', async () => {
    const f = fixture('plan'); writeZaiduyuPreferences(f.home, { defaultModel: 'offline-model-a' }); calls = []
    await plan('offline icon', { dshHome: f.home })
    const a = calls.find((c) => !c.sync).argv; assert.ok(a.includes('--plan')); assert.equal(a[a.indexOf('--model') + 1], 'offline-model-a')
  })
  await check('409 from Zaiduyu is not mislabeled as failed web login and never resubmits', async () => {
    const f = fixture('409'); writeZaiduyuPreferences(f.home, { defaultModel: 'offline-model-a' }); calls = []
    response = { code: 1, stderr: '服务器分配失败（HTTP 409），未提交生成：请刷新页面以获取服务器分配' }
    const result = await f.commands.get('taptap-gpt').handler({ rawInput: 'offline icon' })
    assert.equal(result.kind, 'error'); assert.match(result.text, /章鱼生图/); assert.doesNotMatch(result.text, /网页生图失败|重新登录|更换模型/)
    assert.equal(calls.filter((c) => !c.sync).length, 1)
  })
} finally {
  stopBackgroundCheck(); globalThis.fetch = oldFetch; childProcess.spawn = oldSpawn; childProcess.spawnSync = oldSync; syncBuiltinESMExports()
}
console.log(`Result: ${passed} passed, ${failed} failed; fixtures retained: ${scratch}`)
process.exitCode = failed ? 1 : 0
