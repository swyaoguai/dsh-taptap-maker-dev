import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runUiCommand } from '../src/taptap-ui.mjs'
import { createDemoDocument } from '../src/ui-document.mjs'
import { AUDITED_MAKER_FILES } from '../src/ui-maker-contract.mjs'

// All command roots, inputs, fake projects and process outputs are newly made
// temp fixtures. Nothing is deleted. The only real SDK reads are these eleven
// pinned UI sources; no real .project, credential, GUI, server or Maker tool.
const RETAINED = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-cli-integration-'))
const SDK_UI = 'D:\\ftjx\\urhox-libs\\UI'
const SDK_FILES = ['init.lua', 'Core/UI.lua', 'Core/UILoader.lua', 'Core/UISerializer.lua', 'Core/Widget.lua', 'Core/Style.lua', 'Core/Theme.lua', 'Widgets/Panel.lua', 'Widgets/Label.lua', 'Widgets/Button.lua', 'Widgets/SafeAreaView.lua']
const VERIFIED_AT = '2026-10-31T00:00:00Z'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const writeNew = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' }); return file }
const jsonNew = (file, value) => writeNew(file, JSON.stringify(value, null, 2) + '\n')
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
function fixture() {
  const base = fs.mkdtempSync(path.join(RETAINED, 'case-'))
  const root = path.join(base, 'workspaces'); fs.mkdirSync(root)
  return { base, root }
}
const cli = (root, args) => runUiCommand([...args, '--root', root])
function fingerprint(directory) {
  const collect = current => fs.readdirSync(current, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(current, entry.name)
    assert.equal(entry.isSymbolicLink(), false, 'fixtures must not redirect to other files')
    const item = { path: path.relative(directory, file), kind: entry.isDirectory() ? 'directory' : 'file' }
    return entry.isDirectory() ? [item, ...collect(file)] : [{ ...item, sha256: sha(fs.readFileSync(file)) }]
  })
  return collect(directory).sort((a, b) => a.path.localeCompare(b.path))
}
// Author a real one-pixel RGBA PNG locally, including CRCs; no third-party image
// or generation service. Each fixture grants own/CC0/MIT rights to its pixel.
function png(red, green, blue) {
  const chunk = (type, data) => {
    const name = Buffer.from(type); let crc = 0xffffffff
    for (const byte of Buffer.concat([name, data])) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, name, data, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk('IEND', Buffer.alloc(0))])
}
const PNG = png(40, 80, 120)
const OTHER_PNG = png(120, 80, 40)
const MIT_NOTICE = `MIT License

Copyright (c) 2026 UI CLI fixture author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
const ownLicense = () => ({ kind: 'own', author: 'UI CLI fixture author', source: 'self-authored one-pixel fixture', verifiedAt: VERIFIED_AT })
function fairyFixture({ license = ownLicense(), changeRights, notice = false } = {}) {
  const saved = fixture(); const source = path.join(saved.base, 'fairy-source'); const pkg = path.join(source, 'assets/Fixture')
  const fairy = writeNew(path.join(source, 'UI.fairy'), '<project/>')
  writeNew(path.join(pkg, 'package.xml'), '<packageDescription id="FIXTURE1"><resources><component id="PANEL001" name="Panel.xml" path="/"/><image id="PIXEL001" name="pixel.png" path="/"/></resources></packageDescription>')
  writeNew(path.join(pkg, 'Panel.xml'), '<component size="640,360"><displayList><text id="title" xy="20,20" size="300,40" text="Own &amp; reviewed" fontSize="24"/><image id="pixel" src="PIXEL001" xy="20,80" size="32,32"/></displayList></component>')
  writeNew(path.join(pkg, 'pixel.png'), PNG)
  const rightsDirectory = path.join(saved.base, 'rights-manifest')
  const rights = { 'FIXTURE1/PIXEL001': { sha256: sha(PNG), license: clone(license) } }
  if (changeRights) changeRights(rights['FIXTURE1/PIXEL001'])
  const rightsFile = jsonNew(path.join(rightsDirectory, 'rights.json'), rights)
  if (notice) {
    writeNew(path.join(rightsDirectory, 'notices/NOTICE.txt'), MIT_NOTICE)
    writeNew(path.join(source, 'notices/NOTICE.txt'), 'Wrong base directory; this is not the manifest notice.\n')
  }
  return { ...saved, source, fairy, rightsDirectory, rightsFile }
}
const importArgs = files => ['import-xml', '--fairy', files.fairy, '--component', 'Fixture/Panel', '--rights', files.rightsFile]
function imageDocument() {
  const document = createDemoDocument()
  document.assets = [{ id: 'pixel', path: 'art/pixel.png', sha256: sha(PNG), license: ownLicense() }]
  document.nodes.push({ id: 'pixel-image', type: 'image', parent: 'root', layout: { x: 0, y: 0, width: 32, height: 32 }, props: { asset: 'pixel', imageFit: 'contain' } })
  return document
}
function jsonFixture(document = imageDocument()) {
  const saved = fixture(); const source = path.join(saved.base, 'incoming')
  const input = jsonNew(path.join(source, 'input.json'), document)
  return { ...saved, source, input, document }
}
function fakeProject(base, { orientation = 'landscape', settings = true } = {}) {
  const directory = path.join(base, 'fake-maker')
  fs.mkdirSync(path.join(directory, 'assets'), { recursive: true })
  jsonNew(path.join(directory, '.project/project.json'), { taptap_publish: { screen_orientation: orientation } })
  if (settings) jsonNew(path.join(directory, '.project/settings.json'), {})
  assert.deepEqual(Object.keys(AUDITED_MAKER_FILES).sort(), [...SDK_FILES].sort())
  for (const relative of SDK_FILES) {
    const bytes = fs.readFileSync(path.join(SDK_UI, relative))
    assert.equal(sha(bytes), AUDITED_MAKER_FILES[relative], `read-only SDK is not pinned: ${relative}`)
    writeNew(path.join(directory, 'urhox-libs/UI', relative), bytes)
  }
  return directory
}
const fontArgs = ['--font-method', 'pixel', '--font-scale', '1.25']
const walk = node => [node, ...(node.children ?? []).flatMap(walk)]
const blocked = (plan, code) => { assert.equal(plan.ready, false); assert.ok(plan.blockers.some(item => item.code === code), JSON.stringify(plan.blockers)) }
test.after(() => console.log(`Retained CLI fixtures: ${RETAINED}`))

test('CLI imports self-authored XML and own/CC0 PNGs with verified SHA/date without changing source bytes', async () => {
  for (const kind of ['own', 'CC0']) {
    const files = fairyFixture({ license: { ...ownLicense(), kind }, changeRights: rights => { rights.sha256 = rights.sha256.toUpperCase() } })
    const sourceBefore = fingerprint(files.source); const rightsBefore = fingerprint(files.rightsDirectory)
    const result = await cli(files.root, [...importArgs(files), '--name', 'Reviewed XML'])
    const document = readJson(result.file); const asset = document.assets[0]
    assert.equal(result.ok, true); assert.equal(result.assetCount, 1)
    assert.equal(document.name, 'Reviewed XML'); assert.equal(document.design.orientation, 'landscape')
    assert.equal(asset.sha256, sha(PNG)); assert.equal(asset.license.verifiedAt, VERIFIED_AT); assert.equal(asset.license.kind, kind)
    assert.deepEqual(fs.readFileSync(path.join(result.directory, asset.path)), PNG)
    assert.ok(document.nodes.some(node => node.props.text === 'Own & reviewed'))
    assert.deepEqual(fingerprint(files.source), sourceBefore); assert.deepEqual(fingerprint(files.rightsDirectory), rightsBefore)
  }
})

test('CLI XML MIT notice is materialized as complete text relative to the rights manifest, not the fairy directory', async () => {
  const files = fairyFixture({ license: { ...ownLicense(), kind: 'MIT', notice: 'notices/NOTICE.txt' }, notice: true })
  const sourceBefore = fingerprint(files.source); const rightsBefore = fingerprint(files.rightsDirectory)
  const result = await cli(files.root, importArgs(files))
  assert.equal(readJson(result.file).assets[0].license.notice, MIT_NOTICE)
  assert.equal(fs.existsSync(path.join(result.directory, 'notices/NOTICE.txt')), false, 'the document retains text, not a dangling filename')
  assert.deepEqual(fingerprint(files.source), sourceBefore); assert.deepEqual(fingerprint(files.rightsDirectory), rightsBefore)
})

test('CLI XML missing flags, absent rights, bad SHA/date and missing notice fail before creating a workspace', async () => {
  const missing = fairyFixture()
  for (const args of [['import-xml', '--fairy', missing.fairy], ['import-xml', '--component', 'Fixture/Panel'], ['import-xml', '--fairy']]) {
    await assert.rejects(() => cli(missing.root, args), { code: 'UI_COMMAND' })
  }
  await assert.rejects(() => cli(missing.root, ['import-xml', '--fairy', missing.fairy, '--component', 'Fixture/Panel']), { code: 'UI_IMPORT_LICENSE' })
  assert.deepEqual(fs.readdirSync(missing.root), [])
  for (const changeRights of [rights => { rights.sha256 = '0'.repeat(64) }, rights => { rights.license.verifiedAt = 'invalid-date' }]) {
    const files = fairyFixture({ changeRights }); const before = fingerprint(files.source)
    await assert.rejects(() => cli(files.root, importArgs(files)), { code: 'UI_IMPORT_LICENSE' })
    assert.deepEqual(fs.readdirSync(files.root), []); assert.deepEqual(fingerprint(files.source), before)
  }
  const notice = fairyFixture({ license: { ...ownLicense(), kind: 'MIT', notice: 'missing/NOTICE.txt' } })
  await assert.rejects(() => cli(notice.root, importArgs(notice)), { code: 'UI_ASSET_LICENSE' })
  assert.deepEqual(fs.readdirSync(notice.root), [])
})

test('CLI JSON create/save reuses the same SHA without replacing a bitmap or the prior revision', async () => {
  const files = jsonFixture(); writeNew(path.join(files.source, 'art/pixel.png'), PNG)
  const sourceBefore = fingerprint(files.source)
  const created = await cli(files.root, ['create', '--in', files.input])
  const image = path.join(created.directory, 'art/pixel.png'); const oldBytes = fs.readFileSync(created.file); const imageStat = fs.statSync(image)
  const edited = clone(files.document); edited.name = 'Appended JSON revision'
  const input = jsonNew(path.join(files.base, 'edited/input.json'), edited)
  // No bitmap in this new input directory: the saved SHA owns the existing asset.
  const next = await cli(files.root, ['save', '--id', created.workspaceId, '--base', created.revisionId, '--in', input])
  assert.notEqual(next.revisionId, created.revisionId); assert.deepEqual(fs.readFileSync(created.file), oldBytes)
  assert.deepEqual(fs.readFileSync(image), PNG); assert.equal(fs.statSync(image).mtimeMs, imageStat.mtimeMs)
  assert.equal(readJson(next.file).name, edited.name); assert.deepEqual(fingerprint(files.source), sourceBefore)
})

test('CLI JSON bad SHA, case aliases and missing MIT notice are preflight failures with no partial workspace', async () => {
  for (const scenario of ['sha', 'case', 'notice']) {
    const document = imageDocument()
    if (scenario === 'sha') document.assets[0].sha256 = '0'.repeat(64)
    if (scenario === 'case') document.assets.push({ ...clone(document.assets[0]), id: 'pixel-alias', path: 'art/Pixel.png' })
    if (scenario === 'notice') document.assets[0].license = { ...ownLicense(), kind: 'MIT', notice: 'notices/absent.txt' }
    const files = jsonFixture(document); writeNew(path.join(files.source, 'art/pixel.png'), PNG)
    if (scenario === 'case' && !fs.existsSync(path.join(files.source, 'art/Pixel.png'))) writeNew(path.join(files.source, 'art/Pixel.png'), PNG)
    const before = fingerprint(files.source)
    const code = { sha: 'UI_ASSET_INTEGRITY', case: 'UI_ASSET_CONFLICT', notice: 'UI_ASSET_LICENSE' }[scenario]
    await assert.rejects(() => cli(files.root, ['create', '--in', files.input]), { code })
    assert.deepEqual(fs.readdirSync(files.root), []); assert.deepEqual(fingerprint(files.source), before)
  }
})

test('CLI save rejects a conflicting existing SHA before copying any newly prepared asset or revision', async () => {
  const files = jsonFixture(); writeNew(path.join(files.source, 'art/pixel.png'), PNG)
  const created = await cli(files.root, ['create', '--in', files.input]); const before = fingerprint(created.directory)
  const document = clone(files.document); document.assets[0].sha256 = sha(OTHER_PNG)
  document.assets.unshift({ id: 'new-pixel', path: 'art/new.png', sha256: sha(PNG), license: ownLicense() })
  const input = jsonNew(path.join(files.base, 'edited/input.json'), document)
  writeNew(path.join(files.base, 'edited/art/new.png'), PNG); writeNew(path.join(files.base, 'edited/art/pixel.png'), OTHER_PNG)
  await assert.rejects(() => cli(files.root, ['save', '--id', created.workspaceId, '--base', created.revisionId, '--in', input]), { code: 'UI_ASSET_CONFLICT' })
  assert.deepEqual(fingerprint(created.directory), before)
})

test('CLI plan --in saved JSON and --id/--revision select the same older revision read-only', async () => {
  const files = jsonFixture(createDemoDocument()); const project = fakeProject(files.base)
  const created = await cli(files.root, ['create', '--in', files.input])
  const newer = createDemoDocument(); newer.design = { width: 720, height: 1280, orientation: 'portrait' }
  newer.nodes[0].layout.width = 720; newer.nodes[0].layout.height = 1280
  const input = jsonNew(path.join(files.base, 'newer.json'), newer)
  await cli(files.root, ['save', '--id', created.workspaceId, '--base', created.revisionId, '--in', input])
  const targetBefore = fingerprint(project); const uiBefore = fingerprint(files.root)
  const fromInput = await cli(files.root, ['plan', '--in', created.file, '--project', project, ...fontArgs])
  const fromId = await cli(files.root, ['plan', '--id', created.workspaceId, '--revision', created.revisionId, '--project', project, ...fontArgs])
  assert.equal(fromInput.ready, true); assert.deepEqual(fromInput, fromId)
  assert.equal(fromId.orientation, 'landscape'); assert.equal(fromId.sourceFiles.length, 11); assert.equal(fromId.nativeVerified, false)
  blocked(await cli(files.root, ['plan', '--id', created.workspaceId, '--project', project, ...fontArgs]), 'MAKER_ORIENTATION_MISMATCH')
  await assert.rejects(() => cli(files.root, ['plan', '--in', created.file, '--id', created.workspaceId, '--project', project, ...fontArgs]), { code: 'UI_COMMAND' })
  assert.deepEqual(fingerprint(project), targetBefore); assert.deepEqual(fingerprint(files.root), uiBefore)
})

test('CLI plan blocks missing/incompatible font choices, scales and targets without staging', async () => {
  const files = fixture(); const project = fakeProject(files.base)
  const created = await cli(files.root, ['demo']); const before = fingerprint(files.root); const targetBefore = fingerprint(project)
  const args = ['plan', '--id', created.workspaceId, '--project', project]
  for (const [extra, code] of [[[], 'MAKER_FONT_METHOD_REQUIRED'], [['--font-method', 'char'], 'MAKER_CHAR_FONT_UNVERIFIED'], [['--font-method', 'pixels'], 'MAKER_FONT_METHOD_INVALID'], [['--font-method', 'pixel', '--font-scale', 'NaN'], 'MAKER_FONT_SCALE_INVALID']]) blocked(await cli(files.root, [...args, ...extra]), code)
  blocked(await cli(files.root, ['plan', '--id', created.workspaceId, ...fontArgs]), 'MAKER_PROJECT_MISSING')
  const badFiles = fixture(); const badProject = fakeProject(badFiles.base, { settings: false }); const badBefore = fingerprint(badProject)
  blocked(await cli(files.root, ['plan', '--id', created.workspaceId, '--project', badProject, ...fontArgs]), 'MAKER_PROJECT_MISSING')
  await assert.rejects(() => cli(files.root, ['export', '--id', created.workspaceId, '--revision', created.revisionId, '--project', project, '--font-method', 'char']), { code: 'MAKER_EXPORT_BLOCKED' })
  assert.deepEqual(fingerprint(project), targetBefore); assert.deepEqual(fingerprint(badProject), badBefore); assert.deepEqual(fingerprint(files.root), before)
})

test('CLI export creates two fresh staged reviews only under the selected workspace and leaves fake target bytes intact', async () => {
  const files = fixture(); const project = fakeProject(files.base); const targetBefore = fingerprint(project)
  const created = await cli(files.root, ['demo']); const revisionBefore = fs.readFileSync(created.file)
  const args = ['export', '--id', created.workspaceId, '--revision', created.revisionId, '--project', project, ...fontArgs]
  const first = await cli(files.root, args); const firstBefore = fingerprint(first.directory); const second = await cli(files.root, args)
  assert.equal(first.status, 'staged'); assert.equal(first.stagedOnly, true); assert.equal(first.nativeVerified, false)
  assert.equal(first.metadata.status, 'pending'); assert.notEqual(first.directory, second.directory)
  assert.ok(first.directory.startsWith(path.join(created.directory, 'exports') + path.sep))
  const manifest = readJson(path.join(first.directory, 'manifest.json')); const native = readJson(path.join(first.directory, 'main.ui.json'))
  assert.equal(manifest.targetAccess, 'read-only'); assert.equal(manifest.installation.automated, false); assert.equal(manifest.uuid, undefined)
  assert.equal(manifest.orientation, 'landscape'); assert.equal(manifest.sourceFiles.length, 11)
  assert.equal(walk(native).find(node => node.id === 'title').fontSize, 38 / ((96 / 72) * 1.25))
  for (const item of manifest.files) assert.equal(sha(fs.readFileSync(path.join(first.directory, item.path))), item.sha256)
  assert.deepEqual(fingerprint(first.directory), firstBefore); assert.deepEqual(fs.readFileSync(created.file), revisionBefore)
  assert.deepEqual(fingerprint(project), targetBefore)
})

test('CLI plan accepts an explicit asset-free input JSON without demanding an unrelated saved asset workspace', async () => {
  const files = jsonFixture(createDemoDocument()); const project = fakeProject(files.base)
  const targetBefore = fingerprint(project); const before = fingerprint(files.source)
  const result = await cli(files.root, ['plan', '--in', files.input, '--project', project, ...fontArgs])
  assert.deepEqual(fs.readdirSync(files.root), []); assert.deepEqual(fingerprint(project), targetBefore); assert.deepEqual(fingerprint(files.source), before)
  assert.equal(result.ready, true, `asset-free --in should be plannable: ${JSON.stringify(result.blockers)}`)
})

test('CLI export resolves copied image assets from its explicitly selected saved workspace', async () => {
  const files = jsonFixture(); writeNew(path.join(files.source, 'art/pixel.png'), PNG)
  const project = fakeProject(files.base); const targetBefore = fingerprint(project)
  const created = await cli(files.root, ['create', '--in', files.input])
  const plan = await cli(files.root, ['plan', '--id', created.workspaceId, '--revision', created.revisionId, '--project', project, ...fontArgs])
  assert.equal(plan.ready, true)
  let result; let failure
  try { result = await cli(files.root, ['export', '--id', created.workspaceId, '--revision', created.revisionId, '--project', project, ...fontArgs]) } catch (error) { failure = error }
  assert.deepEqual(fingerprint(project), targetBefore)
  assert.equal(failure?.code, undefined, `saved asset CLI bridge: ${failure?.code} ${JSON.stringify(failure?.details?.blockers)}`)
  assert.equal(result.status, 'staged'); assert.deepEqual(fs.readFileSync(path.join(result.directory, 'images/pixel.png')), PNG)
})

test('the executable CLI uses only an explicit fresh temp root and reports real JSON exit status', () => {
  const files = jsonFixture(createDemoDocument()); const executable = fileURLToPath(new URL('../src/taptap-ui.mjs', import.meta.url))
  const stdout = path.join(files.base, 'stdout.json'); const stderr = path.join(files.base, 'stderr.json')
  // Exclusive file-backed stdio avoids named-pipe capture and replaces nothing.
  const out = fs.openSync(stdout, 'wx'); const err = fs.openSync(stderr, 'wx')
  let result
  try { result = spawnSync(process.execPath, [executable, 'create', '--in', files.input, '--root', files.root, '--json'], { cwd: files.base, stdio: ['ignore', out, err], windowsHide: true, timeout: 30_000 }) } finally { fs.closeSync(out); fs.closeSync(err) }
  assert.equal(result.error, undefined); assert.equal(result.status, 0)
  const created = readJson(stdout); assert.equal(created.ok, true); assert.ok(created.directory.startsWith(files.root + path.sep))
  assert.equal(fs.readFileSync(stderr, 'utf8'), ''); assert.equal(fs.readdirSync(files.root).length, 1)
})
