import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createDemoDocument } from '../src/ui-document.mjs'

const moduleUrl = new URL('../src/ui-http.mjs', import.meta.url)
let api = {}
try { api = await import(moduleUrl) } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== moduleUrl.href) throw error
}
async function withApi(run, overrides = {}) {
  assert.equal(typeof api.createUiHttpHandler, 'function', 'UI HTTP route implementation missing')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-http-test-'))
  const handler = api.createUiHttpHandler({ root, ...overrides })
  // Ephemeral test-only server; never substitutes for the existing DSH GUI.
  const server = http.createServer(handler); server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (route, body, options = {}) => fetch(`${base}/api/taptap-maker-dev/ui${route}`, body === undefined ? options : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...options.headers }, body: JSON.stringify(body), ...options })
  try { return await run({ root, base, send }) } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

test('status is read-only and separates pinned source, adapter and native readiness', async () => {
  await withApi(async ({ root, send }) => {
    const before = fs.readdirSync(root)
    const response = await send('/status'); assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.ok, true); assert.equal(data.sourceAudit.commit, 'e962aa3617aaad5a2fd5ddf2c80ace4bb1551240')
    assert.equal(data.sourceAudit.license, 'MIT'); assert.equal(data.maker.nativeVerified, false)
    assert.deepEqual(fs.readdirSync(root), before)
  })
})

test('explicit POST creates and appends immutable versions, with stale base returning 409', async () => {
  await withApi(async ({ send }) => {
    const document = createDemoDocument()
    const response = await send('/workspaces', { name: document.name, document }); assert.equal(response.status, 201)
    const saved = await response.json(); assert.ok(saved.workspaceId); assert.ok(saved.revisionId)
    const read = await (await send(`/workspaces/${saved.workspaceId}`)).json(); assert.deepEqual(read.document, document)
    document.name = '新版本'
    const update = await send(`/workspaces/${saved.workspaceId}/revisions`, { document, baseRevision: saved.revisionId }); assert.equal(update.status, 201)
    const next = await update.json(); assert.notEqual(next.revisionId, saved.revisionId)
    const conflict = await send(`/workspaces/${saved.workspaceId}/revisions`, { document, baseRevision: saved.revisionId }); assert.equal(conflict.status, 409)
    const old = await (await send(`/workspaces/${saved.workspaceId}?revision=${saved.revisionId}`)).json(); assert.equal(old.document.name, '营地补给')
  })
})

test('invalid documents do not write directories and check does not manufacture engine acceptance', async () => {
  await withApi(async ({ root, send }) => {
    const before = fs.readdirSync(root)
    assert.equal((await send('/workspaces', { name: 'bad', document: {} })).status, 422)
    const check = await (await send('/check', { document: {} })).json()
    assert.equal(check.ok, false); assert.ok(check.errors.length)
    assert.deepEqual(fs.readdirSync(root), before)
  })
})

test('cross-site Origin and Sec-Fetch-Site requests cannot read or mutate workspaces', async () => {
  await withApi(async ({ root, base, send }) => {
    const before = fs.readdirSync(root)
    assert.equal((await send('/status', undefined, { headers: { Origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(`${base}/api/taptap-maker-dev/ui/status`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
    assert.equal((await send('/workspaces', { name: 'bad', document: createDemoDocument() }, { headers: { 'Content-Type': 'application/json', Origin: 'null' } })).status, 403)
    assert.deepEqual(fs.readdirSync(root), before)
  })
})

test('POST requires JSON, rejects unknown fields and reports malformed bodies honestly', async () => {
  await withApi(async ({ base, send }) => {
    const url = `${base}/api/taptap-maker-dev/ui/workspaces`
    const badType = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }); assert.equal(badType.status, 415)
    const malformed = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }); assert.equal(malformed.status, 400)
    const extra = await send('/workspaces', { name: 'a', document: createDemoDocument(), path: 'C:\\private' }); assert.equal(extra.status, 400)
  })
})

test('oversized bodies return 413 without writing a UI workspace', async () => {
  await withApi(async ({ root, base }) => {
    const response = await fetch(`${base}/api/taptap-maker-dev/ui/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: { large: 'x'.repeat(2_100_000) } }) })
    assert.equal(response.status, 413); assert.deepEqual(fs.readdirSync(root), [])
  })
})

test('workbench static files are a fixed allowlist, not an arbitrary filesystem endpoint', async () => {
  await withApi(async ({ send }) => {
    const html = await send('/workbench'); assert.equal(html.status, 200)
    assert.match(html.headers.get('content-type'), /text\/html/)
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
    assert.match(await html.text(), /ui-workbench/)
    assert.equal((await send('/workbench.mjs')).status, 200)
    assert.equal((await send('/document.mjs')).status, 200)
    assert.equal((await send('/file?path=C%3A%5Cprivate')).status, 404)
    assert.equal((await send('/../../../package.json')).status, 404)
  })
})

test('unrecognized methods never delete or overwrite a workspace', async () => {
  await withApi(async ({ root, send }) => {
    const response = await send('/workspaces', undefined, { method: 'DELETE' }); assert.equal(response.status, 405)
    assert.deepEqual(fs.readdirSync(root), [])
  })
})

test('native preflight delegates only to the real adapter and never accepts a client ready flag', async () => {
  const calls = []
  await withApi(async ({ send, root }) => {
    const document = createDemoDocument()
    const before = fs.readdirSync(root)
    const plan = await (await send('/plan', { document, projectDirectory: '', options: {} })).json()
    assert.equal(plan.ok, true); assert.equal(plan.ready, false); assert.equal(calls.length, 1)
    assert.deepEqual(fs.readdirSync(root), before)
    const bypass = await send('/export', { workspaceId: 'ui-unknown', revisionId: 'rev-unknown', projectDirectory: '', options: {}, ready: true }); assert.equal(bypass.status, 400)
  }, { nativeExporter: { planMakerExport: (...args) => { calls.push(args); return { ok: true, ready: false, blockers: [{ code: 'TARGET_MISSING' }], nativeVerified: false } } } })
})

test('missing or invalid workspace IDs cannot become arbitrary filesystem reads', async () => {
  await withApi(async ({ send }) => {
    const missing = await send('/workspaces/ui-missing'); assert.equal(missing.status, 404)
    assert.equal((await send('/workspaces/constructor')).status, 400)
    assert.equal((await send('/workspaces/ui-missing?revision=..%5Csecret')).status, 400)
  })
})
