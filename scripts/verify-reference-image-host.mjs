// Execute the real host command renderers with in-memory generation results.
// No API/browser/credentials, file writes, config changes or deletion.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const note = 'OFFLINE_PREPARATION: 2048 KiB -> 512 KiB; originals preserved'
function command(name, result) {
  const at = source.indexOf(`name: '${name}'`)
  const start = source.lastIndexOf('scoped.commands.register({', at)
  const end = source.indexOf(name === 'taptap-gpt' ? '// /taptap-gpt 作为首选后' : '// /taptap-sfx ——', at)
  assert.ok(start >= 0 && end > start)
  let handler
  const provide = async () => { if (result instanceof Error) throw result; return result }
  const context = { path, home: 'MEMORY-HOME', PKG_DIR: 'MEMORY-PLUGIN',
    scoped: { commands: { register(c) { handler = c.handler } } },
    extractGenArgs: () => ({ prompt: 'offline icon', references: [], missing: [] }),
    parseSlashGenArgs: () => ({ prompt: 'offline icon', refs: [], missing: [] }),
    readImageConfigRaw: () => ({}), resolveDownloadDir: () => ({ dir: 'MEMORY-OUTPUT' }),
    zaiduyuLaneEnabled: () => true, zaiduyuGenerate: provide, gptGenerateImage: provide,
    zaiduyuQuotaHit: (message) => /quota/i.test(message),
  }
  vm.runInNewContext(source.slice(start, end), context)
  return handler({ rawInput: 'offline icon' })
}
let passed = 0, failed = 0
async function test(name, body) {
  try { await body(); passed++; console.log(`PASS ${name}`) }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`) }
}
await test('direct Zaiduyu success displays actual preparation notes', async () => {
  const r = await command('taptap-zaiduyu', { ok: true, saved: 'MEMORY.png', notes: [note] })
  assert.ok(r.text.includes(note))
})
await test('direct Zaiduyu preflight failure does not misread a quota-looking filename', async () => {
  const error = Object.assign(new Error('bad reference quota.png'), { code: 'reference_decode_failed', kind: 'input', phase: 'preflight', submitted: false, notes: [note] })
  const r = await command('taptap-zaiduyu', error)
  assert.ok(r.text.includes(note))
  assert.doesNotMatch(r.text, /这是积分不足|去站点充值|或换其它生图通道/)
})
await test('confirmed Zaiduyu quota failure retains existing quota guidance', async () => {
  const error = Object.assign(new Error('quota exhausted'), { code: 'quota_exhausted', kind: 'quota', phase: 'generation' })
  const r = await command('taptap-zaiduyu', error)
  assert.match(r.text, /这是积分不足/)
})
await test('unified host failure displays preparation notes', async () => {
  const r = await command('taptap-gpt', { ok: false, error: 'local-error', hint: 'local only', notes: [note], phase: 'preflight', submitted: false })
  assert.ok(r.text.includes(note))
})
await test('unified host gives local hint, not account rotation, for preflight quota text', async () => {
  const r = await command('taptap-gpt', { ok: false, error: 'quota:bad-input', hint: 'LOCAL_PREFLIGHT_HINT', phase: 'preflight', kind: 'input', submitted: false })
  assert.match(r.text, /LOCAL_PREFLIGHT_HINT/)
  assert.doesNotMatch(r.text, /所有可用账号都触到配额|pool unban/)
})
await test('unified success already preserves preparation notes', async () => {
  const r = await command('taptap-gpt', { ok: true, saved: 'MEMORY.png', notes: [note] })
  assert.ok(r.text.includes(note))
})
await test('no-reference success requires no preparation metadata', async () => {
  const r = await command('taptap-zaiduyu', { ok: true, saved: 'MEMORY.png' })
  assert.equal(r.kind, 'success')
})
console.log(`Result: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
