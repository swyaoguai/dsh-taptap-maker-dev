import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const moduleUrl = new URL('../src/ui-workflow.mjs', import.meta.url)
let workflow = {}
try { workflow = await import(moduleUrl) } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== moduleUrl.href) throw error
}
function call(name, ...args) {
  assert.equal(typeof workflow[name], 'function', `UI workflow implementation missing: ${name}`)
  return workflow[name](...args)
}
const freshRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taptap-ui-test-'))
const demo = () => call('createDemoDocument')
// Temp artifacts are retained. This task never deletes files without approval.

test('creating a workspace only writes an isolated new directory', () => {
  const root = freshRoot()
  const created = call('createUiWorkspace', root, { name: '商店', document: demo() })
  assert.ok(created.workspaceId)
  assert.ok(created.revisionId)
  assert.ok(created.directory.startsWith(root + path.sep))
  assert.equal(fs.readFileSync(path.join(created.directory, '.gitignore'), 'utf8'), '*\n!.gitignore\n')
  const loaded = call('readUiWorkspace', root, created.workspaceId)
  assert.deepEqual(loaded.document, demo())
  assert.equal(loaded.revisionId, created.revisionId)
  assert.equal(fs.existsSync(path.join(root, 'assets')), false)
})

test('new saves retain old revisions and enforce the read base revision', () => {
  const root = freshRoot()
  const first = call('createUiWorkspace', root, { name: 'shop', document: demo() })
  const edited = demo(); edited.name = '新的商店'
  const second = call('saveUiRevision', root, first.workspaceId, edited, { baseRevision: first.revisionId })
  assert.notEqual(second.revisionId, first.revisionId)
  assert.deepEqual(call('readUiWorkspace', root, first.workspaceId, first.revisionId).document, demo())
  assert.equal(call('readUiWorkspace', root, first.workspaceId).document.name, '新的商店')
  assert.throws(() => call('saveUiRevision', root, first.workspaceId, demo(), { baseRevision: first.revisionId }), error => error.code === 'UI_REVISION_CONFLICT')
})

test('immutable saves verify hashes instead of silently accepting changed files', () => {
  const root = freshRoot()
  const created = call('createUiWorkspace', root, { name: 'shop', document: demo() })
  const loaded = call('readUiWorkspace', root, created.workspaceId)
  assert.equal(loaded.sha256, crypto.createHash('sha256').update(fs.readFileSync(loaded.file)).digest('hex'))
  // Deliberate corruption is confined to a fixture created by this test.
  fs.appendFileSync(loaded.file, '\n ')
  assert.throws(() => call('readUiWorkspace', root, created.workspaceId, created.revisionId), error => error.code === 'UI_INTEGRITY')
})

test('workspace IDs and revision IDs never become arbitrary filesystem reads', () => {
  const root = freshRoot()
  for (const id of ['..', '../credentials', 'C:\\Users\\secret', 'bad/name', '%2e%2e', '']) {
    assert.throws(() => call('readUiWorkspace', root, id), error => error.code === 'UI_PATH')
  }
  const created = call('createUiWorkspace', root, { name: 'shop', document: demo() })
  assert.throws(() => call('readUiWorkspace', root, created.workspaceId, '../workspace.json'), error => error.code === 'UI_PATH')
})

test('invalid documents never create a workspace', () => {
  const root = freshRoot()
  assert.throws(() => call('createUiWorkspace', root, { name: 'shop', document: null }), error => error.code === 'UI_DOCUMENT')
  assert.deepEqual(fs.readdirSync(root), [])
})

test('workspace listing contains only reviewed metadata, not private document state', () => {
  const root = freshRoot()
  const created = call('createUiWorkspace', root, { name: 'shop', document: demo() })
  const list = call('listUiWorkspaces', root)
  assert.equal(list.length, 1)
  assert.equal(list[0].workspaceId, created.workspaceId)
  assert.equal(list[0].name, '营地补给')
  assert.equal('document' in list[0], false)
  assert.equal('state' in list[0], false)
})

test('native Maker project detection requires configs and does not accept Assets alone', () => {
  const root = freshRoot()
  fs.mkdirSync(path.join(root, 'Assets'))
  const result = call('inspectMakerProject', root)
  assert.equal(result.ready, false)
  assert.ok(result.blockers.some(blocker => blocker.code === 'MAKER_PROJECT_MISSING'))
})

test('a configured Maker project still requires its real UI loader source', () => {
  const root = freshRoot()
  fs.mkdirSync(path.join(root, '.project'))
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, '.project/project.json'), JSON.stringify({ taptap_publish: { screen_orientation: 'landscape' } }), { flag: 'wx' })
  fs.writeFileSync(path.join(root, '.project/settings.json'), '{}', { flag: 'wx' })
  const result = call('inspectMakerProject', root)
  assert.equal(result.orientation, 'landscape')
  assert.equal(result.ready, false)
  assert.ok(result.blockers.some(blocker => blocker.code === 'MAKER_UI_SOURCE_MISSING'))
})

test('the package integrity report is pinned to the licensed historical commit', () => {
  const result = call('verifyLguiVendor')
  assert.equal(result.commit, 'e962aa3617aaad5a2fd5ddf2c80ace4bb1551240')
  assert.equal(result.license, 'MIT')
  assert.equal(result.ok, true)
  assert.ok(result.files.length >= 2)
  assert.equal(result.files.some(file => /editor\/|unity\/|logo|\.png$/i.test(file.path)), false)
})
