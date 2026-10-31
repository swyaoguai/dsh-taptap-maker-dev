import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createDemoDocument, readUiWorkspace, safeUiPath } from '../src/ui-workflow.mjs'
import { runUiCommand } from '../src/ui-command.mjs'

function fixture({ missingNotice = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-asset-boundaries-'))
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9E0AAAAASUVORK5CYII=', 'base64')
  const notice = 'MIT License\nCopyright Fixture author\nPermission is hereby granted, free of charge, to any person obtaining a copy.'
  const document = createDemoDocument()
  document.assets = [{ id: 'icon', path: 'images/icon.png', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), license: { kind: 'MIT', author: 'Fixture author', source: 'self-authored fixture', verifiedAt: '2026-10-31T00:00:00Z', notice: 'licenses/icon-LICENSE.txt' } }]
  fs.mkdirSync(path.join(base, 'images')); fs.mkdirSync(path.join(base, 'licenses'))
  fs.writeFileSync(path.join(base, 'images/icon.png'), bytes, { flag: 'wx' })
  if (!missingNotice) fs.writeFileSync(path.join(base, 'licenses/icon-LICENSE.txt'), notice, { flag: 'wx' })
  const input = path.join(base, 'source.json'); fs.writeFileSync(input, JSON.stringify(document), { flag: 'wx' })
  return { base, bytes, notice, input, root: path.join(base, 'workspaces') }
}
// All fixtures are self-created and retained. No overwrite of real assets,
// deletion, installation, credentials, provider calls or game targets.
test('JSON creation preserves full MIT notice when copying the reviewed bitmap', async () => {
  const files = fixture()
  const created = await runUiCommand(['create', '--in', files.input, '--root', files.root])
  const saved = readUiWorkspace(files.root, created.workspaceId)
  assert.equal(saved.document.assets[0].license.notice, files.notice)
  assert.deepEqual(fs.readFileSync(path.join(saved.directory, saved.document.assets[0].path)), files.bytes)
  assert.equal(fs.readFileSync(path.join(files.base, 'licenses/icon-LICENSE.txt'), 'utf8'), files.notice)
})
test('missing required notice aborts before any workspace or asset copy', async () => {
  const files = fixture({ missingNotice: true })
  await assert.rejects(() => runUiCommand(['create', '--in', files.input, '--root', files.root]), error => error.code === 'UI_ASSET_LICENSE')
  assert.equal(fs.existsSync(files.root), false)
})
test('dangling junction ancestors are unsafe even when their target does not exist', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-dangling-link-'))
  const junction = path.join(root, 'link')
  try { fs.symlinkSync(path.join(root, 'not-yet-created'), junction, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    t.skip('OS cannot create a fixture link; not verified on this platform'); return
  }
  assert.equal(fs.lstatSync(junction).isSymbolicLink(), true)
  assert.throws(() => safeUiPath(root, 'link/new-file.json'), error => error.code === 'UI_PATH')
})
