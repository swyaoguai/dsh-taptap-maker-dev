import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createDemoDocument, validateUiDocument } from '../src/ui-document.mjs'
import { createUiWorkspace, saveUiRevision, safeUiPath } from '../src/ui-workflow.mjs'

// Runtime RED is deliberate: this test file executes even before the target
// modules exist and reports the exact missing API, rather than a setup failure.
const contractUrl = new URL('../src/ui-maker-contract.mjs', import.meta.url)
const exportUrl = new URL('../src/ui-maker-export.mjs', import.meta.url)
async function optionalTarget(url) {
  try { return await import(url) } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === url.href) return {}
    throw error
  }
}
const contract = await optionalTarget(contractUrl)
const emitter = await optionalTarget(exportUrl)
function api(name, ...args) {
  assert.equal(typeof emitter[name], 'function', `Missing intended Maker export implementation: ${name}`)
  return emitter[name](...args)
}
const SDK_FILES = ['init.lua', 'Core/UI.lua', 'Core/UILoader.lua', 'Core/UISerializer.lua', 'Core/Widget.lua', 'Core/Style.lua', 'Core/Theme.lua', 'Widgets/Panel.lua', 'Widgets/Label.lua', 'Widgets/Button.lua', 'Widgets/SafeAreaView.lua']
const READ_ONLY_SDK = process.env.TAPTAP_UI_TEST_SDK ?? 'D:\\ftjx'
const OPTIONS = Object.freeze({ fontSizeMethod: 'pixel', fontScale: 1 })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F9sAAAAASUVORK5CYII=', 'base64')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taptap-maker-review-test-'))
const writeNew = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' }); return file }
const jsonNew = (file, value) => writeNew(file, JSON.stringify(value, null, 2) + '\n')
const clone = value => JSON.parse(JSON.stringify(value))
const walk = node => [node, ...(node.children ?? []).flatMap(walk)]
const has = (plan, code) => plan.blockers.some(item => item.code === code)
// Fixtures and failed/intermediate outputs are retained, never deleted.
function projectFixture({ orientation = 'landscape', omit = [] } = {}) {
  assert.equal(Object.keys(contract.AUDITED_MAKER_FILES ?? {}).length, 11, 'Missing intended AUDITED_MAKER_FILES contract')
  const directory = fresh()
  fs.mkdirSync(path.join(directory, 'assets'))
  if (!omit.includes('project')) jsonNew(path.join(directory, '.project/project.json'), { taptap_publish: { screen_orientation: orientation } })
  if (!omit.includes('settings')) jsonNew(path.join(directory, '.project/settings.json'), {})
  for (const relative of SDK_FILES) {
    if (omit.includes(relative)) continue
    const source = path.join(READ_ONLY_SDK, 'urhox-libs/UI', relative)
    assert.ok(fs.existsSync(source), `Read-only SDK fixture unavailable: set TAPTAP_UI_TEST_SDK to an audited SDK (missing ${relative})`)
    writeNew(path.join(directory, 'urhox-libs/UI', relative), fs.readFileSync(source))
  }
  return directory
}
function imageDocument({ fit = 'contain', license = {} } = {}) {
  const document = createDemoDocument()
  document.assets = [{ id: 'portrait', path: 'art/portrait.png', sha256: sha(PNG), license: { kind: 'own', author: 'Fixture author', source: 'self-authored fixture', verifiedAt: '2026-10-31T00:00:00Z', ...license } }]
  document.nodes.push({ id: 'portrait-image', type: 'image', parent: 'root', layout: { x: 4, y: 8, width: 64, height: 64 }, props: { asset: 'portrait', imageFit: fit, ...(fit === 'sliced' ? { slice: [0, 0, 0, 0] } : {}) } })
  return document
}
function workspaceFixture(document = createDemoDocument()) {
  const root = fresh()
  const saved = createUiWorkspace(root, { name: 'Review fixture', document })
  const assetRoot = safeUiPath(saved.directory, 'assets-source')
  if (document.assets.length) writeNew(path.join(assetRoot, 'art/portrait.png'), PNG)
  return { root, saved, assetRoot }
}
function treeFingerprint(directory) {
  const collect = current => fs.readdirSync(current, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(current, entry.name)
    return entry.isDirectory() ? collect(file) : [{ path: path.relative(directory, file), sha256: sha(fs.readFileSync(file)) }]
  })
  return collect(directory).sort((a, b) => a.path.localeCompare(b.path))
}

test('the intended contract and static export APIs exist and pin eleven source hashes', () => {
  for (const name of ['planMakerExport', 'compileMakerUi', 'createMakerReview', 'createMakerBindings']) assert.equal(typeof emitter[name], 'function', `Missing intended Maker export implementation: ${name}`)
  assert.equal(Object.keys(contract.AUDITED_MAKER_FILES ?? {}).length, 11)
  assert.deepEqual(Object.keys(contract.AUDITED_MAKER_FILES).sort(), SDK_FILES.toSorted())
  for (const value of Object.values(contract.AUDITED_MAKER_FILES)) assert.match(value, /^[a-f0-9]{64}$/)
  assert.equal(contract.AUDITED_MAKER_CONTRACT.nativeVerified, false)
  assert.equal(contract.AUDITED_MAKER_CONTRACT.sdk, 'dev-kit20260922-133551')
  assert.equal(contract.AUDITED_MAKER_CONTRACT.mcpDocs, '0.0.39')
  assert.deepEqual(contract.AUDITED_MAKER_CONTRACT.allowedTypes, ['Panel', 'Label', 'Button'])
})

test('a nested IR retains parent-relative x/y exactly and emits flat native props', () => {
  const document = createDemoDocument()
  const output = api('compileMakerUi', document, OPTIONS)
  assert.equal(output.type, 'Panel')
  assert.equal(output.width, document.design.width)
  assert.equal(output.height, document.design.height)
  const nodes = walk(output)
  const card = nodes.find(node => node.id === 'card-potion')
  const title = nodes.find(node => node.id === 'title-potion')
  assert.equal(card.left, 0)
  assert.equal(card.top, 0)
  assert.equal(title.left, 24)
  assert.equal(title.top, 110)
  assert.equal(nodes.find(node => node.id === 'bag-modal-title').left, 32)
  assert.equal(nodes.find(node => node.id === 'bag-modal-title').top, 32)
  for (const node of nodes) {
    assert.ok(['Panel', 'Label', 'Button'].includes(node.type))
    assert.equal('props' in node || 'layout' in node || 'parent' in node, false)
    assert.equal('actions' in node || 'events' in node || 'bindings' in node, false)
  }
  assert.deepEqual(document, createDemoDocument(), 'compilation does not mutate the IR')
})

test('pixel font sizes use pt = IR px / ((96/72) * fontScale)', () => {
  const nodes = walk(api('compileMakerUi', createDemoDocument(), { fontSizeMethod: 'pixel', fontScale: 1.25 }))
  const title = nodes.find(node => node.id === 'title')
  const label = nodes.find(node => node.id === 'coins')
  const button = nodes.find(node => node.id === 'buy-potion')
  assert.equal(title.fontSize, 38 / ((96 / 72) * 1.25))
  assert.equal(title.fontWeight, 'bold')
  assert.equal(label.fontColor, '#F3D38B')
  assert.equal(label.textAlign, 'right')
  assert.equal(label.verticalAlign, 'middle')
  assert.equal(button.textColor, '#13282B')
  assert.equal('textAlign' in button || 'fontColor' in button, false)
})

test('common style props and author disabled flags are not nested or discarded', () => {
  const document = createDemoDocument()
  document.nodes.find(node => node.id === 'card-potion').props = { backgroundColor: '#123456', borderColor: '#abcdef', borderWidth: 2, borderRadius: 8, opacity: 0.5, visible: false, enabled: false }
  document.nodes.find(node => node.id === 'buy-potion').props.enabled = false
  const nodes = walk(api('compileMakerUi', document, OPTIONS))
  const panel = nodes.find(node => node.id === 'card-potion')
  for (const [key, value] of Object.entries(document.nodes.find(node => node.id === panel.id).props)) {
    if (key !== 'enabled') assert.equal(panel[key], value)
  }
  assert.equal(panel.pointerEvents, 'none')
  assert.equal(nodes.find(node => node.id === 'buy-potion').disabled, true)
})

test('non-centered IR buttons are explicitly blocked rather than faking textAlign', () => {
  const document = createDemoDocument()
  document.nodes.find(node => node.id === 'buy-potion').props.align = 'left'
  assert.throws(() => api('compileMakerUi', document, OPTIONS), error => error.code === 'MAKER_BUTTON_ALIGNMENT_UNSUPPORTED')
  const plan = api('planMakerExport', document, projectFixture(), OPTIONS)
  assert.equal(plan.ready, false)
  assert.ok(has(plan, 'MAKER_BUTTON_ALIGNMENT_UNSUPPORTED'))
})

test('images become background Panels, fixed lists and custom modals remain Panels', () => {
  for (const [fit, expected] of [['contain', 'contain'], ['cover', 'cover'], ['stretch', 'fill'], ['sliced', 'sliced']]) {
    const document = imageDocument({ fit })
    const nodes = walk(api('compileMakerUi', document, { ...OPTIONS, assetPaths: { portrait: 'ui/example/revision/images/portrait.png' } }))
    const image = nodes.find(node => node.id === 'portrait-image')
    assert.equal(image.type, 'Panel')
    assert.equal(image.backgroundImage, 'ui/example/revision/images/portrait.png')
    assert.equal(image.backgroundFit, expected)
    if (fit === 'sliced') assert.deepEqual(image.backgroundSlice, [0, 0, 0, 0])
    assert.equal(nodes.find(node => node.id === 'supplies').type, 'Panel')
    assert.equal(nodes.find(node => node.id === 'bag-modal').type, 'Panel')
    assert.equal(nodes.find(node => node.id === 'bag-modal').visible, false)
  }
})

test('image compilation requires explicit safe assets-root-relative ui resource paths', () => {
  const document = imageDocument()
  assert.throws(() => api('compileMakerUi', document, OPTIONS), error => error.code === 'MAKER_ASSET_PATH_REQUIRED')
  for (const resource of ['../private.png', '/absolute.png', 'assets/ui/image.png', 'https://example.com/image.png', 'ui/../secret.png', 'ui\\bad.png', 'ui/image.lua']) {
    assert.throws(() => api('compileMakerUi', document, { ...OPTIONS, assetPaths: { portrait: resource } }), error => error.code === 'MAKER_ASSET_PATH_UNSAFE')
  }
})

test('preflight never guesses a target or font mode, rejects char and invalid scales', () => {
  assert.ok(has(api('planMakerExport', createDemoDocument(), undefined, OPTIONS), 'MAKER_PROJECT_MISSING'))
  const project = projectFixture()
  assert.ok(has(api('planMakerExport', createDemoDocument(), project, {}), 'MAKER_FONT_METHOD_REQUIRED'))
  assert.ok(has(api('planMakerExport', createDemoDocument(), project, { fontSizeMethod: 'char', fontScale: 1 }), 'MAKER_CHAR_FONT_UNVERIFIED'))
  for (const fontScale of [0.09, 4.01, NaN, Infinity, '1', null]) {
    assert.ok(has(api('planMakerExport', createDemoDocument(), project, { fontSizeMethod: 'pixel', fontScale }), 'MAKER_FONT_SCALE_INVALID'))
  }
  for (const fontScale of [0.1, 1, 4]) assert.equal(api('planMakerExport', createDemoDocument(), project, { fontSizeMethod: 'pixel', fontScale }).ready, true)
})

test('the static-ready plan is read-only, audited and explicitly not native verification', () => {
  const project = projectFixture()
  const before = treeFingerprint(project)
  const plan = api('planMakerExport', createDemoDocument(), project, OPTIONS)
  assert.equal(plan.ok, true)
  assert.equal(plan.ready, true)
  assert.equal(plan.stagedOnly, true)
  assert.equal(plan.nativeVerified, false)
  assert.equal(plan.orientation, 'landscape')
  assert.equal(plan.sourceFiles.length, 11)
  assert.ok(plan.warnings.some(item => item.code === 'MAKER_NATIVE_NOT_VERIFIED'))
  assert.ok(plan.warnings.some(item => item.code === 'MAKER_CUSTOM_MODAL'))
  assert.deepEqual(treeFingerprint(project), before)
})

test('project/settings and explicit matching orientation are mandatory', () => {
  for (const omit of [['project'], ['settings']]) assert.ok(has(api('planMakerExport', createDemoDocument(), projectFixture({ omit }), OPTIONS), 'MAKER_PROJECT_MISSING'))
  assert.ok(has(api('planMakerExport', createDemoDocument(), projectFixture({ orientation: null }), OPTIONS), 'MAKER_ORIENTATION_MISSING'))
  assert.ok(has(api('planMakerExport', createDemoDocument(), projectFixture({ orientation: 'portrait' }), OPTIONS), 'MAKER_ORIENTATION_MISMATCH'))
  const directory = fresh(); fs.mkdirSync(path.join(directory, 'Assets'))
  assert.ok(has(api('planMakerExport', createDemoDocument(), directory, OPTIONS), 'MAKER_PROJECT_MISSING'))
})

test('the eleventh Theme source must exist and match, not just the previous ten files', () => {
  assert.ok(has(api('planMakerExport', createDemoDocument(), projectFixture({ omit: ['Core/Theme.lua'] }), OPTIONS), 'MAKER_UI_SOURCE_MISSING'))
  const project = projectFixture()
  fs.appendFileSync(path.join(project, 'urhox-libs/UI/Core/Theme.lua'), '\n-- deliberate fixture-only corruption\n')
  assert.ok(has(api('planMakerExport', createDemoDocument(), project, OPTIONS), 'MAKER_UI_VERSION_UNVERIFIED'))
})

test('invalid UI and unsupported options are reported without writing a review', () => {
  const document = createDemoDocument(); document.nodes[0].type = 'eval'
  const plan = api('planMakerExport', document, projectFixture(), OPTIONS)
  assert.equal(plan.ready, false)
  assert.ok(has(plan, 'UI_DOCUMENT'))
  assert.ok(has(api('planMakerExport', createDemoDocument(), projectFixture(), { ...OPTIONS, autoImport: true }), 'MAKER_OPTION_UNSUPPORTED'))
})

test('assets require an explicit saved UI-workspace root, never a game assets fallback', () => {
  const document = imageDocument(); const project = projectFixture()
  assert.ok(has(api('planMakerExport', document, project, OPTIONS), 'MAKER_ASSET_ROOT_REQUIRED'))
  writeNew(path.join(project, 'assets/art/portrait.png'), PNG)
  assert.ok(has(api('planMakerExport', document, project, { ...OPTIONS, assetRoot: path.join(project, 'assets') }), 'MAKER_ASSET_ROOT_UNVERIFIED'))
  const workspace = workspaceFixture(document)
  assert.equal(api('planMakerExport', document, project, { ...OPTIONS, assetRoot: workspace.assetRoot }).ready, true)
})

test('missing, changed, oversized and non-image assets block static readiness', () => {
  const project = projectFixture()
  const missing = imageDocument(); missing.assets[0].path = 'art/absent.png'
  const workspace = workspaceFixture(missing)
  assert.ok(has(api('planMakerExport', missing, project, { ...OPTIONS, assetRoot: workspace.assetRoot }), 'MAKER_ASSET_MISSING'))
  const altered = imageDocument(); altered.assets[0].sha256 = '0'.repeat(64)
  assert.ok(has(api('planMakerExport', altered, project, { ...OPTIONS, assetRoot: workspace.assetRoot }), 'MAKER_ASSET_INTEGRITY'))
  const large = imageDocument(); large.assets[0].path = 'art/large.png'
  writeNew(path.join(workspace.assetRoot, large.assets[0].path), Buffer.alloc(10 * 1024 * 1024 + 1))
  assert.ok(has(api('planMakerExport', large, project, { ...OPTIONS, assetRoot: workspace.assetRoot }), 'MAKER_ASSET_SIZE'))
  const notImage = imageDocument(); notImage.assets[0].path = 'art/not-image.png'; const bytes = Buffer.from('not an image')
  notImage.assets[0].sha256 = sha(bytes); writeNew(path.join(workspace.assetRoot, notImage.assets[0].path), bytes)
  assert.ok(has(api('planMakerExport', notImage, project, { ...OPTIONS, assetRoot: workspace.assetRoot }), 'MAKER_ASSET_FORMAT'))
})

test('licenses require a verification record and preserve bounded MIT notices', () => {
  const project = projectFixture()
  const unverified = imageDocument(); delete unverified.assets[0].license.verifiedAt
  const workspace = workspaceFixture(unverified)
  assert.ok(has(api('planMakerExport', unverified, project, { ...OPTIONS, assetRoot: workspace.assetRoot }), 'MAKER_ASSET_LICENSE_UNVERIFIED'))
  const document = imageDocument({ license: { kind: 'MIT', notice: 'MIT License\nCopyright fixture author\nPermission is hereby granted.' } })
  const saved = workspaceFixture(document)
  const result = api('createMakerReview', saved.root, saved.saved.workspaceId, saved.saved.revisionId, project, { ...OPTIONS, assetRoot: saved.assetRoot })
  const notice = result.files.find(file => /NOTICE-portrait\.txt$/.test(file))
  assert.ok(notice)
  assert.equal(fs.readFileSync(notice, 'utf8'), document.assets[0].license.notice + '\n')
  assert.equal(sha(fs.readFileSync(path.join(result.directory, 'images/portrait.png'))), document.assets[0].sha256)
})

test('each review is fresh, immutable, staged within the saved workspace and target-untouched', () => {
  const project = projectFixture(); const before = treeFingerprint(project)
  const workspace = workspaceFixture()
  const first = api('createMakerReview', workspace.root, workspace.saved.workspaceId, workspace.saved.revisionId, project, OPTIONS)
  const previous = treeFingerprint(first.directory)
  const second = api('createMakerReview', workspace.root, workspace.saved.workspaceId, workspace.saved.revisionId, project, OPTIONS)
  assert.equal(first.ok, true)
  assert.equal(first.status, 'staged')
  assert.equal(first.nativeVerified, false)
  assert.equal(first.metadata.status, 'pending')
  assert.equal(first.metadata.nextAction, '官方generate_resource_meta')
  assert.notEqual(first.directory, second.directory)
  assert.ok(first.directory.startsWith(path.join(workspace.saved.directory, 'exports') + path.sep))
  assert.deepEqual(fs.readdirSync(first.directory).toSorted(), ['bindings.lua', 'host-example.lua', 'main.ui.json', 'manifest.json', 'usage.md'])
  const manifest = JSON.parse(fs.readFileSync(path.join(first.directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.targetAccess, 'read-only')
  assert.equal(manifest.nativeVerified, false)
  assert.equal(manifest.installation.main, `assets/ui/${workspace.saved.workspaceId}/${workspace.saved.revisionId}/main.ui.json`)
  assert.equal(manifest.resourceId, `ui/${workspace.saved.workspaceId}/${workspace.saved.revisionId}/main.ui.json`)
  assert.equal(manifest.uuid, undefined)
  for (const item of manifest.files) assert.equal(sha(fs.readFileSync(path.join(first.directory, item.path))), item.sha256)
  assert.match(fs.readFileSync(path.join(first.directory, 'usage.md'), 'utf8'), /main\.ui\.json\.meta/)
  assert.doesNotMatch(fs.readFileSync(path.join(first.directory, 'host-example.lua'), 'utf8'), /SafeAreaView\.Wrap|SetRoot\([^\n]*true|fontScale\s*=/)
  assert.match(fs.readFileSync(path.join(first.directory, 'host-example.lua'), 'utf8'), /UI\.Theme\.SetFontScale\(1\)/)
  assert.deepEqual(treeFingerprint(first.directory), previous)
  assert.deepEqual(treeFingerprint(project), before)
})

test('review creation reloads immutable revisions and preflight instead of trusting a prior ready result', () => {
  const project = projectFixture()
  const workspace = workspaceFixture()
  assert.equal(api('planMakerExport', createDemoDocument(), project, OPTIONS).ready, true)
  fs.appendFileSync(path.join(project, 'urhox-libs/UI/Widgets/Button.lua'), '\n-- fixture corruption\n')
  assert.throws(() => api('createMakerReview', workspace.root, workspace.saved.workspaceId, workspace.saved.revisionId, project, OPTIONS), error => error.code === 'MAKER_EXPORT_BLOCKED')
  assert.equal(fs.existsSync(path.join(workspace.saved.directory, 'exports')), false)
  const goodProject = projectFixture()
  fs.appendFileSync(workspace.saved.file, '\n ')
  assert.throws(() => api('createMakerReview', workspace.root, workspace.saved.workspaceId, workspace.saved.revisionId, goodProject, OPTIONS), error => error.code === 'UI_INTEGRITY')
})

test('a selected older immutable revision is exported, not an unsaved or newer document', () => {
  const workspace = workspaceFixture()
  const next = createDemoDocument(); next.nodes.find(node => node.id === 'title').props.text = 'New revision'
  saveUiRevision(workspace.root, workspace.saved.workspaceId, next, { baseRevision: workspace.saved.revisionId })
  const result = api('createMakerReview', workspace.root, workspace.saved.workspaceId, workspace.saved.revisionId, projectFixture(), OPTIONS)
  const output = JSON.parse(fs.readFileSync(path.join(result.directory, 'main.ui.json'), 'utf8'))
  assert.equal(walk(output).find(node => node.id === 'title').text, '下一次冒险，从这里开始')
})

test('review paths cannot target a game project, consume another workspace assets or traverse IDs', () => {
  const project = projectFixture()
  const root = path.join(project, 'fixture-ui-workspaces')
  const saved = createUiWorkspace(root, { name: 'Do not export into this game', document: createDemoDocument() })
  assert.throws(() => api('createMakerReview', root, saved.workspaceId, saved.revisionId, project, OPTIONS), error => error.code === 'MAKER_STAGE_INSIDE_PROJECT')
  assert.equal(fs.existsSync(path.join(saved.directory, 'exports')), false)
  const workspace = workspaceFixture(imageDocument()); const other = workspaceFixture(imageDocument())
  assert.throws(() => api('createMakerReview', workspace.root, workspace.saved.workspaceId, workspace.saved.revisionId, project, { ...OPTIONS, assetRoot: other.assetRoot }), error => error.code === 'MAKER_ASSET_WORKSPACE_MISMATCH')
  for (const id of ['../private', '..', 'bad/name', 'C:\\private']) assert.throws(() => api('createMakerReview', workspace.root, id, workspace.saved.revisionId, project, OPTIONS), error => error.code === 'UI_PATH')
  assert.throws(() => api('createMakerReview', workspace.root, workspace.saved.workspaceId, undefined, project, OPTIONS), error => error.code === 'UI_PATH')
})

test('junction/symlink roots, image files and their ancestors are rejected', () => {
  const project = projectFixture()
  const document = imageDocument(); const workspace = workspaceFixture(document)
  const external = fresh(); writeNew(path.join(external, 'portrait.png'), PNG)
  const linkedDirectory = path.join(workspace.saved.directory, 'linked-source')
  fs.symlinkSync(external, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  const plan = api('planMakerExport', document, project, { ...OPTIONS, assetRoot: linkedDirectory })
  assert.equal(plan.ready, false)
  assert.ok(plan.blockers.some(item => /UNSAFE|UNVERIFIED/.test(item.code)))
  const sdkRoot = fresh(); fs.symlinkSync(project, path.join(sdkRoot, 'linked-sdk'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(api('planMakerExport', createDemoDocument(), path.join(sdkRoot, 'linked-sdk'), OPTIONS).ready, false)
})

test('Lua output binds post-load clicks with owned handlers and has no engine root lifecycle takeover', () => {
  const lua = api('createMakerBindings', createDemoDocument())
  assert.match(lua, /function M\.Bind\(instance, state, options\)/)
  assert.match(lua, /OnEvent\("click", handler\)/)
  assert.match(lua, /OffEvent\("click", [^)]+handler\)/)
  assert.match(lua, /instance:GetRoot\(\)/)
  assert.match(lua, /instance:Find\(/)
  assert.match(lua, /pcall\(UI\.LoadJSON, resourceId\)/)
  assert.match(lua, /:SetText\(/)
  assert.match(lua, /:SetVisible\(/)
  assert.match(lua, /:SetDisabled\(/)
  assert.doesNotMatch(lua, /loadstring|\beval\b|props\.onClick\s*=|UI\.SetRoot|UI\.Init|:Destroy\(/)
})

const LUA_MOCK = String.raw`
local M = exportedModule
local definitions = testDefinitions
local widgetById = {}
local outside = { disabled = false }
for _, definition in ipairs(definitions) do
  local widget = { props = { visible = definition.props.visible ~= false, disabled = definition.props.enabled == false }, handlers = {}, texts = {} }
  function widget:OnEvent(name, handler) assert(name == 'click'); table.insert(self.handlers, handler); return self end
  function widget:OffEvent(name, handler) assert(name == 'click' and type(handler) == 'function'); for i = #self.handlers, 1, -1 do if self.handlers[i] == handler then table.remove(self.handlers, i) end end; return self end
  function widget:SetText(text) self.props.text = text; table.insert(self.texts, text); return self end
  function widget:SetVisible(visible) self.props.visible = visible; return self end
  function widget:IsVisible() return self.props.visible ~= false end
  function widget:SetDisabled(disabled) self.props.disabled = disabled; return self end
  function widget:IsDisabled() return self.props.disabled == true end
  function widget:EmitClick() if not self.props.disabled then for _, handler in ipairs(self.handlers) do handler(self) end end end
  widgetById[definition.id] = widget
end
local instance = {}
function instance:GetRoot() return widgetById.root end
function instance:Find(id) return widgetById[id] end
local externalCalls = 0
widgetById['buy-potion']:OnEvent('click', function() externalCalls = externalCalls + 1 end)
local toasts = {}
local state = { coins = 120, bought = 0, text = testText }
local api = M.Bind(instance, state, { onToast = function(text) table.insert(toasts, text) end })
assert(api and api.root == instance:GetRoot())
assert(M.Bind(instance, state, {}) == api, 'Bind must be idempotent')
assert(#widgetById['buy-potion'].handlers == 2)
widgetById['buy-potion']:EmitClick()
assert(state.coins == 110 and state.bought == 1 and externalCalls == 1)
assert(widgetById.coins.props.text == '金币 110')
assert(widgetById['escaped-label'].props.text == testText, 'Lua string/control escaping differs')
assert(#toasts == 1)
assert(widgetById['buy-ration']:IsDisabled(), 'author disabled state must survive')
widgetById['bag-button']:EmitClick()
assert(widgetById['bag-modal']:IsVisible())
assert(widgetById['buy-potion']:IsDisabled(), 'custom modal must suppress background buttons')
assert(not widgetById['bag-close']:IsDisabled())
assert(not outside.disabled, 'instances outside the bound tree must not change')
local previous = state.coins
for _, handler in ipairs(widgetById['buy-potion'].handlers) do handler() end
assert(state.coins == previous, 'a forced callback must still respect modal blocking')
widgetById['bag-close']:EmitClick()
assert(not widgetById['bag-modal']:IsVisible() and not widgetById['buy-potion']:IsDisabled())
assert(widgetById['buy-ration']:IsDisabled())
state.coins = 0
widgetById['buy-potion']:EmitClick()
assert(state.coins == 0 and #toasts == 2 and toasts[2] == '金币不足，先去冒险吧。')
local invalid, reason = api:Dispatch('not-a-declared-action')
assert(invalid == nil and type(reason) == 'string')
assert(M.Dispatch(instance, 'close-bag'))
api:Dispatch('open-bag')
assert(widgetById['buy-potion']:IsDisabled())
api:Dispose()
api:Dispose()
assert(#widgetById['buy-potion'].handlers == 1, 'dispose must remove only its exact handler')
assert(not widgetById['buy-potion']:IsDisabled() and widgetById['buy-ration']:IsDisabled())
assert(api:Dispatch('buy-potion') == nil)
local UI = require('urhox-libs/UI')
UI.LoadJSON = function() return nil, 'missing resource' end
local missing, failure = M.Load('ui/missing.ui.json')
assert(missing == nil and failure:find('missing resource', 1, true))
UI.LoadJSON = function() error("Unknown widget type: 'Image'") end
local unknown, unknownError = M.Load('ui/bad.ui.json')
assert(unknown == nil and unknownError:find('Unknown widget type', 1, true))
UI.LoadJSON = function() return instance end
local attached = 0
local loaded = M.Load('ui/test.ui.json', { coins = 120, bought = 0, text = testText }, { Attach = function(root) assert(root == widgetById.root); attached = attached + 1 end })
assert(loaded and attached == 1)
loaded:Dispose()
local badState = { coins = 0/0, bought = 0, text = testText }
local ok = pcall(M.Bind, instance, badState)
assert(not ok, 'non-finite supplied state must be rejected')
return true
`

test('installed Python lupa executes real Lua syntax and pure binder mocks, not native acceptance', () => {
  const document = createDemoDocument()
  const escaped = '中文 "quoted" \\ slash\nline\rreturn\tTAB\0NUL\u0001SOH\u0007BEL\u001bESC\u007fDEL'
  document.state.text = escaped
  document.nodes.push({ id: 'escaped-label', type: 'label', parent: 'root', layout: { x: 0, y: 0, width: 300, height: 40 }, props: { text: escaped, fontSize: 16 } })
  document.bindings.push({ node: 'escaped-label', property: 'text', template: '{text}' })
  document.nodes.find(node => node.id === 'buy-ration').props.enabled = false
  assert.equal(validateUiDocument(document).ok, true)
  const lua = api('createMakerBindings', document)
  const directory = fresh()
  const moduleFile = writeNew(path.join(directory, 'bindings.lua'), lua)
  const mockFile = writeNew(path.join(directory, 'mock.lua'), LUA_MOCK)
  const dataFile = jsonNew(path.join(directory, 'data.json'), { nodes: document.nodes, text: escaped })
  const python = String.raw`import json, sys
try:
 import lupa
except ImportError:
 print('LUA_NOT_TESTED: no installed Python lupa; no dependency installed')
 sys.exit(77)
from lupa import LuaRuntime
runtime = LuaRuntime(unpack_returned_tuples=True)
def table(value):
 if isinstance(value, dict): return runtime.table_from({key: table(item) for key, item in value.items()})
 if isinstance(value, list): return runtime.table_from([table(item) for item in value])
 return value
runtime.execute('package.preload["urhox-libs/UI"] = function() return { Init = function() error("forbidden Init") end, SetRoot = function() error("forbidden SetRoot") end } end')
with open(sys.argv[3], encoding='utf-8') as stream: data = json.load(stream)
runtime.globals().testDefinitions = table(data['nodes'])
runtime.globals().testText = data['text']
with open(sys.argv[1], encoding='utf-8') as stream: runtime.globals().exportedModule = runtime.execute(stream.read())
with open(sys.argv[2], encoding='utf-8') as stream: result = runtime.execute(stream.read())
assert result is True
print('LUA_MOCK_GREEN: ' + str(lupa.LUA_VERSION) + '; nativeVerified=false')
`
  const result = spawnSync('python', ['-c', python, moduleFile, mockFile, dataFile], { stdio: ['ignore', 'inherit', 'inherit'] })
  if (result.error?.code === 'ENOENT' || result.status === 77) {
    console.log('LUA_NOT_TESTED: no installed Lua runtime; generated Lua is not native-verified')
    return
  }
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, 'real Lua syntax / pure mocked binding behaviour must pass')
})
