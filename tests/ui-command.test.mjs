import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDemoDocument } from '../src/ui-document.mjs'

const moduleUrl = new URL('../src/ui-command.mjs', import.meta.url)
let command = {}
try { command = await import(moduleUrl) } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== moduleUrl.href) throw error
}
const call = (name, ...args) => {
  assert.equal(typeof command[name], 'function', `UI command implementation missing: ${name}`)
  return command[name](...args)
}
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ui-command-test-'))

test('help and workbench use the current GUI route without starting a server or writing state', async () => {
  const root = fresh()
  const result = await call('runUiCommand', [], { root })
  assert.equal(result.ok, true); assert.match(result.help, /taptap-ui/)
  const workbench = await call('runUiCommand', ['workbench'], { root })
  assert.equal(workbench.url, '/api/taptap-maker-dev/ui/workbench')
  assert.deepEqual(fs.readdirSync(root), [])
})

test('explicit demo creation, listing and reading agree on an isolated root', async () => {
  const root = fresh()
  const created = await call('runUiCommand', ['demo', '--name', '原创样例'], { root })
  assert.equal(created.ok, true)
  const list = await call('runUiCommand', ['list'], { root }); assert.equal(list.workspaces.length, 1)
  const read = await call('runUiCommand', ['read', '--id', created.workspaceId], { root })
  assert.equal(read.document.name, '原创样例'); assert.equal(read.document.state.coins, 120)
  assert.ok(read.directory.startsWith(root + path.sep))
})

test('slash input reuses quote-aware tokens without eating native Windows paths', async () => {
  const root = fresh()
  const result = await call('handleUiSlashInput', 'demo --name "双引号 样例"', { root })
  assert.equal(result.kind, 'success'); assert.match(result.text, /双引号 样例/)
  const parsed = call('parseUiCommand', 'check --in "D:\\a b\\ui.json" --json')
  assert.equal(parsed.flags.input, 'D:\\a b\\ui.json')
  assert.equal(parsed.command, 'check')
})

test('unsupported engines, destructive/generation commands and force flags fail closed', async () => {
  const root = fresh()
  for (const input of [['delete'], ['reset'], ['generate'], ['export', '--engine', 'cocos'], ['demo', '--force'], ['demo', '--model', 'paid-model']]) {
    await assert.rejects(() => call('runUiCommand', input, { root }), error => error.code === 'UI_COMMAND')
  }
  assert.deepEqual(fs.readdirSync(root), [])
})

test('check validates a selected JSON document without creating or copying files', async () => {
  const root = fresh(); const input = path.join(root, 'input.json')
  fs.writeFileSync(input, JSON.stringify(createDemoDocument()), { flag: 'wx' })
  const before = fs.readdirSync(root)
  const result = await call('runUiCommand', ['check', '--in', input], { root })
  assert.equal(result.ok, true); assert.ok(result.nodeCount > 0)
  assert.deepEqual(fs.readdirSync(root), before)
})

test('saving a changed JSON appends a revision, requires its base, and retains old bytes', async () => {
  const root = fresh()
  const created = await call('runUiCommand', ['demo'], { root })
  const before = fs.readFileSync(created.file)
  const document = createDemoDocument(); document.name = '新文档'
  const input = path.join(root, 'edited.json'); fs.writeFileSync(input, JSON.stringify(document), { flag: 'wx' })
  const next = await call('runUiCommand', ['save', '--id', created.workspaceId, '--base', created.revisionId, '--in', input], { root })
  assert.notEqual(next.revisionId, created.revisionId); assert.deepEqual(fs.readFileSync(created.file), before)
  await assert.rejects(() => call('runUiCommand', ['save', '--id', created.workspaceId, '--base', created.revisionId, '--in', input], { root }), error => error.code === 'UI_REVISION_CONFLICT')
})

test('invalid JSON creation creates no workspace and missing required arguments are explicit', async () => {
  const root = fresh(); const input = path.join(root, 'invalid.json'); fs.writeFileSync(input, '{}', { flag: 'wx' })
  await assert.rejects(() => call('runUiCommand', ['create', '--in', input], { root }), error => error.code === 'UI_DOCUMENT')
  await assert.rejects(() => call('runUiCommand', ['create', '--in'], { root }), error => error.code === 'UI_COMMAND')
  await assert.rejects(() => call('runUiCommand', ['save', '--id', 'ui-any'], { root }), error => error.code === 'UI_COMMAND')
  assert.deepEqual(fs.readdirSync(root), ['invalid.json'])
})

test('slash failures retain useful codes without invoking an alternative provider or server', async () => {
  const result = await call('handleUiSlashInput', 'delete --id ui-a', { root: fresh() })
  assert.equal(result.kind, 'error'); assert.match(result.text, /UI_COMMAND/)
})
