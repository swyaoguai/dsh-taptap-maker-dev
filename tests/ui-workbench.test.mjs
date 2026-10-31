import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as ui from '../src/ui-document.mjs'

// Missing NEW workbench functionality is the intended RED signal. No npm,
// browser download, server, test-directory cleanup, or git side effects.
const moduleUrl = new URL('../src/ui-workbench.mjs', import.meta.url)
let workbench = {}
try { workbench = await import(moduleUrl) } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== moduleUrl.href) throw error
}
async function source(relative) {
  try { return await readFile(new URL(relative, import.meta.url), 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}
function feature(name, ...args) {
  assert.equal(typeof workbench[name], 'function', `Workbench implementation missing: ${name}`)
  return workbench[name](...args)
}
const demo = () => ui.createDemoDocument()
const saved = (document = demo(), workspaceId = 'ui-a', revisionId = 'rev-a') => ({
  ok: true, document, workspaceId, revisionId, directory: 'D:\\Explicit-UI-Root\\ui-a', file: 'document.json',
})
const sourceAudit = { ok: true, commit: 'e962aa3617aaad5a2fd5ddf2c80ace4bb1551240', license: 'MIT', parser: 'python-stdlib-adapter' }
function fixture({ confirm = true, handler } = {}) {
  const calls = []; const confirmations = []
  const api = { request: async (path, options = {}) => {
    const call = { path, method: options.method ?? 'GET', body: options.body }
    calls.push(call)
    if (handler) return handler(call)
    if (path === '/status') return { ok: true, root: 'D:\\Explicit-UI-Root', sourceAudit, maker: { available: false }, workspaces: [] }
    if (path === '/workspaces' && call.method === 'GET') return { ok: true, workspaces: [] }
    if (path === '/workspaces' && call.method === 'POST') return saved(call.body.document)
    if (path.endsWith('/revisions')) return saved(call.body.document, 'ui-a', 'rev-b')
    if (path.startsWith('/workspaces/')) return saved()
    if (path === '/check') return ui.validateUiDocument(call.body.document)
    if (path === '/plan') return { ok: true, ready: true, blockers: [], warnings: [] }
    if (path === '/export') return { ok: true, status: 'staged', directory: 'D:\\Explicit-UI-Root\\ui-a\\exports\\new-review', files: ['UI.json'] }
    throw new Error(`Unexpected test route: ${path}`)
  } }
  const model = feature('createWorkbenchModel', { ui, api, confirmDiscard: message => {
    confirmations.push(message)
    return typeof confirm === 'function' ? confirm(message) : confirm
  } })
  return { model, calls, confirmations }
}
function deferred() {
  let resolve; let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const node = (model, id) => model.getState().document.nodes.find(item => item.id === id)
const target = model => model.setTarget({ projectDirectory: 'D:\\Approved-Game', fontSizeMethod: 'pixel', fontScale: 1 })

// Minimal DOM adapter exercises the REAL renderer; it is not a browser or a
// claim that the current DSH GUI is updated. Optional real-DOM coverage below
// uses already-installed Python Playwright, with explicitly mocked HTTP.
class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase(); this.ownerDocument = ownerDocument
    this.children = []; this.parentNode = null; this.dataset = {}; this.style = {}
    this.attributes = new Map(); this.listeners = new Map(); this._text = ''
    this.hidden = false; this.disabled = false; this.inert = false; this.tabIndex = -1
    this.className = ''; this.value = ''; this.clientWidth = 1000; this.clientHeight = 600
    this.style.setProperty = (name, value) => { this.style[name] = value }
    this.style.removeProperty = name => { delete this.style[name] }
    this.classList = { add: (...names) => { this.className += ` ${names.join(' ')}` }, toggle: (name, enabled) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean)); enabled ? names.add(name) : names.delete(name); this.className = [...names].join(' ')
    } }
  }
  set textContent(value) { this._text = String(value); this.replaceChildren() }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  append(...children) { for (const child of children) {
    if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child)
    child.parentNode = this; this.children.push(child)
  } }
  appendChild(child) { this.append(child); return child }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children) }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener(type, listener) { const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners) }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)) }
  contains(element) { return element === this || this.children.some(child => child.contains(element)) }
  closest(tag) { let element = this; while (element) { if (element.tagName.toLowerCase() === tag) return element; element = element.parentNode } return null }
  querySelector(selector) { if (selector.startsWith('#')) return this.ownerDocument.ids?.get(selector.slice(1)) ?? null; return null }
  click() { if (this.tagName === 'A') (this.ownerDocument.downloads ??= []).push({ filename: this.download, href: this.href }); this.dispatch('click') }
  focus() { this.ownerDocument.activeElement = this }
  dispatch(type, init = {}) {
    const event = { type, target: this, key: '', shiftKey: false, defaultPrevented: false, cancelBubble: false,
      preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.cancelBubble = true }, ...init }
    if (type === 'click' && this.disabled) return event
    let current = this
    while (current) {
      for (const listener of current.listeners.get(type) ?? []) listener(event)
      if (event.cancelBubble) break
      current = current.parentNode
    }
    return event
  }
}
class Dom {
  constructor() { this.activeElement = null; this.ids = new Map(); this.listeners = new Map(); this.documentElement = new Element('html', this); this.body = new Element('body', this) }
  createElement(name) { return new Element(name, this) }
  getElementById(id) { return this.ids.get(id) ?? null }
  addEventListener(type, listener) { Element.prototype.addEventListener.call(this, type, listener) }
  removeEventListener(type, listener) { Element.prototype.removeEventListener.call(this, type, listener) }
  dispatch(type, init) { return Element.prototype.dispatch.call(this, type, init) }
}
function descendants(root) { return [root, ...root.children.flatMap(descendants)] }
function byId(root, id) { return descendants(root).find(element => element.dataset.uiId === id) }
function render(snapshot, callbacks = {}, container) {
  const dom = container?.ownerDocument ?? new Dom(); const host = container ?? dom.createElement('div')
  feature('renderUiPreview', host, snapshot, { ui, dom, ...callbacks })
  return { host, dom }
}

// Structure and safety contracts, written before HTML/CSS/JS implementation.
test('workbench shell exposes three labelled regions and all explicit authoring actions', async () => {
  const html = await source('../src/ui-workbench.html')
  assert.ok(html.length > 0, 'Workbench HTML implementation missing')
  for (const id of ['workspace-panel', 'node-tree', 'preview-panel', 'preview-host', 'inspector-panel', 'property-text', 'node-id', 'property-x', 'property-y', 'property-width', 'property-height', 'property-font-size', 'property-color', 'property-background', 'property-visible', 'new-demo', 'import-json', 'json-file', 'download-json', 'save-workspace', 'check-document', 'plan-export', 'export-review', 'maker-project', 'font-size-method', 'workspace-root', 'source-audit', 'draft-status', 'mode-edit', 'mode-interact', 'viewport-preset', 'safe-area']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `Missing UI contract: ${id}`)
  }
  assert.match(html, /浏览器预览不是Maker引擎验收/)
  assert.match(html, /自定义覆盖层/)
  assert.match(html, /安全区.*模拟|模拟.*安全区/)
  assert.match(html, /node-id[^>]*readonly/)
  assert.match(html, /export-review[^>]*disabled/)
})
test('shell has self-origin assets only and does not preload a guessed Maker target', async () => {
  const html = await source('../src/ui-workbench.html')
  assert.ok(html.length > 0, 'Workbench HTML implementation missing')
  assert.match(html, /\/api\/taptap-maker-dev\/ui\/workbench\.css/)
  assert.match(html, /\/api\/taptap-maker-dev\/ui\/workbench\.mjs/)
  assert.doesNotMatch(html, /<img\b|<iframe\b|https?:\/\/|@import|on(?:click|load|error)\s*=/i)
  const projectInput = html.match(/<input\b[^>]*id=["']maker-project["'][^>]*>/)?.[0]
  assert.ok(projectInput)
  assert.doesNotMatch(projectInput, /value=["'][^"']+["']/)
  assert.match(html, /value=["']["'][^>]*>.*选择字号/s)
})
test('layout owns paired theme tokens, contain scaling, collapsible narrow layout and reduced motion', async () => {
  const css = await source('../src/ui-workbench.css')
  assert.ok(css.length > 0, 'Workbench CSS implementation missing')
  for (const token of ['--wb-bg', '--wb-fg', '--wb-muted', '--wb-faint', '--wb-input', '--wb-accent', '--wb-ok', '--wb-warn', '--wb-danger']) assert.ok(css.includes(token), token)
  assert.doesNotMatch(css, /--dsh-/, 'Unpaired host colors must not leak into owned light/dark palettes')
  assert.match(css, /@media\s*\(max-width:\s*\d+px\)/)
  assert.match(css, /minmax\(0,\s*1fr\)/)
  assert.match(css, /\[hidden\][\s\S]*?display:\s*none\s*!important/)
  assert.match(css, /prefers-reduced-motion/)
  assert.match(css, /\.viewport-frame[\s\S]*?overflow:\s*hidden/)
  assert.doesNotMatch(css, /@font-face|https?:\/\/|url\(/i)
})
test('frontend exposes no executable-user-content or arbitrary server-file-read surface', async () => {
  const js = await source('../src/ui-workbench.mjs')
  assert.ok(js.length > 0, 'Workbench JS implementation missing')
  assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|\beval\s*\(|new\s+Function\b|\.outerHTML\s*=/)
  assert.doesNotMatch(js, /sessionStorage|Authorization|credentials\.json|file-read|file\?path/)
  // Only an explicit first-use preference is persisted; never drafts or credentials.
  assert.match(js, /getItem\(ONBOARDING_KEY\)/)
  assert.match(js, /setItem\(ONBOARDING_KEY, value\)/)
  assert.doesNotMatch(js, /storage\.(?:clear|removeItem)|localStorage\[/)
  assert.match(js, /FileReader/)
  assert.match(js, /document\.mjs/)
  assert.match(js, /beforeunload/)
})

test('viewport presets include landscape desktop, landscape phone and portrait phone', () => {
  assert.ok(Array.isArray(workbench.VIEWPORT_PRESETS), 'Workbench viewport presets missing')
  for (const [width, height] of [[1280, 720], [844, 390], [390, 844]]) assert.ok(workbench.VIEWPORT_PRESETS.some(item => item.width === width && item.height === height))
})
test('stage preserves design aspect ratio, contains and centers within the chosen viewport', () => {
  const fit = feature('fitStage', { width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 390, height: 844 })
  assert.equal(fit.viewportScale, 1)
  assert.equal(fit.scale, 390 / 1280)
  assert.equal(fit.x, 0)
  assert.equal(fit.y, (844 - 720 * fit.scale) / 2)
  assert.equal(fit.width / fit.height, 1280 / 720)
  assert.ok(fit.width <= fit.viewportWidth && fit.height <= fit.viewportHeight)
})
test('stage also fits the physical viewport into its available workbench area', () => {
  const fit = feature('fitStage', { width: 1280, height: 720 }, { width: 844, height: 390 }, { width: 600, height: 500 })
  assert.equal(fit.viewportScale, 600 / 844)
  assert.ok(fit.viewportWidth <= 600 && fit.viewportHeight <= 500)
  assert.ok(fit.x >= 0 && fit.y >= 0)
  assert.equal(feature('fitStage', { width: 0, height: 10 }, { width: 10, height: 10 }, { width: 10, height: 10 }), null)
})
test('JSON download filename is stable, prefixed and safe on Windows', () => {
  const name = feature('normalizeJsonFilename', '../CAMP: UI*?<>|"\\\n')
  assert.equal(name, 'taptap-ui-CAMP-UI.json')
  assert.equal(feature('normalizeJsonFilename', ''), 'taptap-ui-document.json')
  assert.ok(feature('normalizeJsonFilename', 'x'.repeat(200)).length <= 120)
})
test('local JSON parsing validates limits, extension, MIME and the shared schema', () => {
  const text = JSON.stringify(demo())
  assert.equal(feature('parseLocalUiJson', text, ui, { name: 'camp.json', type: 'application/json', size: text.length }).name, '营地补给')
  assert.throws(() => feature('parseLocalUiJson', '{broken', ui, { name: 'camp.json' }), /JSON/)
  assert.throws(() => feature('parseLocalUiJson', text, ui, { name: 'camp.svg' }), /JSON|json/)
  assert.throws(() => feature('parseLocalUiJson', text, ui, { name: 'camp.json', type: 'text/html' }), /类型|MIME|JSON/)
  assert.throws(() => feature('parseLocalUiJson', ' '.repeat(ui.UI_LIMITS.bytes + 1), ui, { name: 'camp.json' }), /1 MB|大小|限制/)
  const invalid = demo(); invalid.nodes[0].props.onclick = 'alert(1)'
  assert.throws(() => feature('parseLocalUiJson', JSON.stringify(invalid), ui, { name: 'camp.json' }), /文档|字段/)
})
test('same-origin API helper sends JSON, never follows redirects, and preserves conflict details', async () => {
  const requests = []
  const api = feature('createUiApi', async (url, options) => {
    requests.push({ url, options })
    return { ok: true, status: 200, json: async () => ({ ok: true, root: 'D:\\UI' }) }
  })
  await api.request('/plan', { method: 'POST', body: { document: demo() } })
  assert.equal(requests[0].url, '/api/taptap-maker-dev/ui/plan')
  assert.equal(requests[0].options.headers['content-type'], 'application/json')
  assert.equal(requests[0].options.credentials, 'same-origin')
  assert.equal(requests[0].options.redirect, 'error')
  assert.deepEqual(JSON.parse(requests[0].options.body), { document: demo() })
  await assert.rejects(api.request('https://other.invalid/file'), /路径|route|API/)
  const conflict = feature('createUiApi', async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'UI_REVISION_CONFLICT', error: '版本冲突', details: { currentRevision: 'rev-c' } }) }))
  await assert.rejects(conflict.request('/workspaces/ui-a/revisions', { method: 'POST', body: {} }), error => error.status === 409 && error.code === 'UI_REVISION_CONFLICT' && error.details.currentRevision === 'rev-c')
})

test('initial demo is unsaved, has an empty Maker target and makes no automatic writes', async () => {
  const { model, calls } = fixture()
  const initial = model.getState()
  assert.equal(initial.dirty, true)
  assert.equal(initial.workspaceId, null)
  assert.equal(initial.target.projectDirectory, '')
  assert.equal(initial.target.fontSizeMethod, '')
  assert.equal(initial.target.fontScale, 1)
  assert.equal(initial.mode, 'edit')
  await model.initialize()
  assert.deepEqual(calls.map(item => item.method), ['GET', 'GET'])
  assert.equal(model.getState().status.root, 'D:\\Explicit-UI-Root')
  assert.equal(model.getState().status.sourceAudit.commit, sourceAudit.commit)
  assert.equal(model.canExport(), false)
})
test('preflight includes the selected immutable workspace context for reviewed local images', async () => {
  const { model, calls } = fixture()
  await model.loadWorkspace('ui-a'); target(model)
  await model.planExport()
  const body = calls.find(call => call.path === '/plan').body
  assert.equal(body.workspaceId, 'ui-a')
  assert.equal(body.revisionId, 'rev-a')
  assert.equal(body.options.assetRoot, undefined, 'The browser never invents a filesystem root; the host derives it from verified IDs')
})

test('edit selection is separate from button interaction', () => {
  const { model } = fixture()
  model.clickNode('buy-potion')
  assert.equal(model.getState().selectedId, 'buy-potion')
  assert.equal(model.getState().previewState.coins, 120)
  model.setMode('interact'); model.clickNode('buy-potion')
  assert.equal(model.getState().previewState.coins, 110)
  assert.equal(model.getState().previewState.bought, 1)
  assert.equal(model.getState().document.state.coins, 120, 'preview actions are not authoring edits')
  assert.match(model.getState().previewToast, /背包/)
})
test('open custom modal guards background actions, closes with Escape and does not save document visibility', () => {
  const { model } = fixture()
  model.setMode('interact'); model.clickNode('bag-button')
  assert.equal(model.getState().visibility['bag-modal'], true)
  model.clickNode('buy-potion')
  assert.equal(model.getState().previewState.coins, 120)
  model.closeModal()
  assert.equal(model.getState().visibility['bag-modal'], false)
  assert.equal(node(model, 'bag-modal').props.visible, false)
  model.clickNode('buy-potion')
  assert.equal(model.getState().previewState.coins, 110)
})
test('visibility toggles use the effective preview state rather than stale authored props', () => {
  const document = demo()
  document.actions.push({ id: 'toggle-bag', steps: [{ type: 'toggle', node: 'bag-modal' }] })
  document.events.find(event => event.node === 'bag-button').action = 'toggle-bag'
  const { model } = fixture()
  model.importJson(JSON.stringify(document), { name: 'camp.json' }); model.setMode('interact')
  model.clickNode('bag-button')
  assert.equal(model.getState().visibility['bag-modal'], true)
  model.closeModal(); model.clickNode('bag-button')
  assert.equal(model.getState().visibility['bag-modal'], true)
})
test('property editing validates the shared schema and protects IDs and unsupported fields', async () => {
  const { model } = fixture()
  await model.loadWorkspace('ui-a')
  assert.equal(model.getState().dirty, false)
  assert.equal(model.updateNode('title', { text: '<img src=x onerror=alert(1)>', x: 60, y: 84, width: 700, height: 70, fontSize: 32, color: '#AABBCC', backgroundColor: '#10212C', visible: true }), true)
  assert.equal(node(model, 'title').props.text, '<img src=x onerror=alert(1)>')
  assert.equal(node(model, 'title').layout.x, 60)
  assert.equal(model.getState().dirty, true)
  const before = model.getState().document
  for (const patch of [{ id: 'rename' }, { onClick: 'evil' }, { x: NaN }, { width: -1 }, { color: 'url(https://evil)' }, { fontSize: 1000 }]) assert.equal(model.updateNode('title', patch), false)
  assert.deepEqual(model.getState().document, before)
  assert.equal(model.updateNode('supplies', { text: 'not supported' }), false)
})
test('discard refusal prevents workspace loads, JSON replacement and sample reset', async () => {
  const { model, calls, confirmations } = fixture({ confirm: false })
  model.updateNode('title', { text: '保留草稿' })
  assert.equal(await model.loadWorkspace('ui-b'), false)
  assert.equal(model.newDemo(), false)
  assert.equal(model.importJson(JSON.stringify(demo()), { name: 'camp.json' }), false)
  assert.equal(node(model, 'title').props.text, '保留草稿')
  assert.equal(calls.length, 0)
  assert.equal(confirmations.length, 3)
})
test('invalid local JSON never discards a draft and valid import is a new unsaved workspace', () => {
  const { model, calls, confirmations } = fixture()
  model.updateNode('title', { text: '现有草稿' })
  assert.equal(model.importJson('{}', { name: 'bad.json' }), false)
  assert.equal(confirmations.length, 0)
  assert.equal(node(model, 'title').props.text, '现有草稿')
  const imported = demo(); imported.name = 'JSON 营地'
  assert.equal(model.importJson(JSON.stringify(imported), { name: 'camp.json' }), true)
  assert.equal(model.getState().workspaceId, null)
  assert.equal(model.getState().dirty, true)
  assert.equal(calls.length, 0)
  const download = model.toJsonDownload()
  assert.equal(JSON.parse(download.contents).name, 'JSON 营地')
  assert.match(download.filename, /^taptap-ui-.*\.json$/)
  assert.equal(model.getState().dirty, true, 'downloading does not pretend to save a server revision')
})
test('a workspace response never silently replaces edits made during its read', async () => {
  const pending = deferred()
  const { model } = fixture({ handler: () => pending.promise })
  const loading = model.loadWorkspace('ui-a')
  model.updateNode('title', { text: '读取期间的新草稿' })
  pending.resolve(saved())
  assert.equal(await loading, false)
  assert.equal(node(model, 'title').props.text, '读取期间的新草稿')
  assert.equal(model.getState().workspaceId, null)
  assert.match(model.getState().error, /草稿|改变|过期/)
})
test('malformed and failed workspace responses retain the current draft', async () => {
  for (const response of [{ ok: true, workspaceId: 'ui-a', revisionId: 'rev-a', document: {} }, { ok: false, error: '不可读取' }]) {
    const { model } = fixture({ handler: () => response })
    model.updateNode('title', { text: '不可覆盖' })
    assert.equal(await model.loadWorkspace('ui-a'), false)
    assert.equal(node(model, 'title').props.text, '不可覆盖')
  }
})
test('explicit save creates one workspace then appends revisions using baseRevision', async () => {
  const { model, calls } = fixture()
  assert.equal(await model.save(), true)
  assert.equal(model.getState().dirty, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/workspaces')
  assert.equal(calls[0].body.name, '营地补给')
  model.updateNode('title', { text: '第二版' })
  assert.equal(await model.save(), true)
  assert.equal(calls[1].path, '/workspaces/ui-a/revisions')
  assert.equal(calls[1].body.baseRevision, 'rev-a')
  assert.equal(model.getState().revisionId, 'rev-b')
  assert.equal(model.getState().dirty, false)
})
test('409 conflict keeps the current draft and base revision, with no automatic read or retry', async () => {
  const { model, calls } = fixture({ handler: call => {
    if (call.method === 'GET') return saved()
    throw Object.assign(new Error('版本冲突'), { status: 409, code: 'UI_REVISION_CONFLICT', details: { currentRevision: 'rev-c' } })
  } })
  await model.loadWorkspace('ui-a'); model.updateNode('title', { text: '冲突中的草稿' })
  assert.equal(await model.save(), false)
  assert.equal(model.getState().revisionId, 'rev-a')
  assert.equal(model.getState().dirty, true)
  assert.equal(node(model, 'title').props.text, '冲突中的草稿')
  assert.equal(model.getState().conflict, true)
  assert.equal(calls.length, 2)
  assert.match(model.getState().error, /冲突|保留/)
})
test('explicit save-as-new allows conflict recovery without overwriting a workspace', async () => {
  const { model, calls } = fixture()
  await model.loadWorkspace('ui-a'); model.updateNode('title', { text: '另存' })
  await model.save({ asNew: true })
  assert.equal(calls[1].path, '/workspaces')
  assert.equal(calls[1].body.baseRevision, undefined)
})
test('saving a snapshot does not mark later edits as saved and never duplicates an in-flight write', async () => {
  const pending = deferred()
  const { model, calls } = fixture({ handler: () => pending.promise })
  const saving = model.save()
  assert.equal(await model.save(), false)
  model.updateNode('title', { text: '保存期间编辑' })
  pending.resolve(saved())
  assert.equal(await saving, true)
  assert.equal(calls.length, 1)
  assert.equal(model.getState().dirty, true)
  assert.equal(node(model, 'title').props.text, '保存期间编辑')
  assert.equal(model.canExport(), false)
})
test('Maker preflight blocks empty target or unselected font method without guessing or writing', async () => {
  const { model, calls } = fixture()
  await model.planExport()
  assert.equal(model.getState().plan.ready, false)
  assert.ok(model.getState().plan.blockers.some(item => item.code === 'MAKER_PROJECT_MISSING'))
  model.setTarget({ projectDirectory: 'D:\\Approved-Game' })
  await model.planExport()
  assert.ok(model.getState().plan.blockers.some(item => item.code === 'FONT_SIZE_METHOD_REQUIRED'))
  assert.equal(calls.length, 0)
  assert.equal(model.getState().target.fontSizeMethod, '')
})
test('HTTP success or structure-only reports cannot authorize native or staged export', async () => {
  for (const response of [{ ok: true }, { ok: true, ready: false, blockers: [] }, { ok: true, ready: true, blockers: [{ code: 'BLOCKED', message: '未就绪' }] }]) {
    const { model } = fixture({ handler: call => call.path === '/plan' ? response : saved() })
    await model.loadWorkspace('ui-a'); target(model); await model.planExport()
    assert.equal(model.canExport(), false)
    assert.equal(await model.exportReview(), false)
  }
})
test('preflight is invalidated by authoring edits, target changes and new saved revisions', async () => {
  const { model } = fixture()
  await model.save(); target(model); await model.planExport()
  assert.equal(model.canExport(), true)
  model.setTarget({ fontSizeMethod: 'char' })
  assert.equal(model.canExport(), false)
  await model.planExport(); model.updateNode('title', { text: '预检后编辑' })
  assert.equal(model.canExport(), false)
  await model.save()
  assert.equal(model.canExport(), false)
})
test('a stale asynchronous preflight report is not applied to a newer draft', async () => {
  const pending = deferred()
  const { model } = fixture({ handler: () => pending.promise })
  target(model)
  const planning = model.planExport()
  model.updateNode('title', { text: '新一轮' })
  pending.resolve({ ok: true, ready: true, blockers: [], warnings: [] })
  assert.equal(await planning, false)
  assert.equal(model.canExport(), false)
})
test('export requires a current saved revision plus ready preflight and reports staged only', async () => {
  const { model, calls } = fixture()
  target(model); await model.planExport()
  assert.equal(model.canExport(), false, 'an unsaved preview cannot be exported by revision ID')
  await model.save(); await model.planExport()
  assert.equal(model.canExport(), true)
  assert.equal(await model.exportReview(), true)
  const exported = calls.at(-1)
  assert.equal(exported.path, '/export')
  assert.deepEqual(exported.body, { workspaceId: 'ui-a', revisionId: 'rev-a', projectDirectory: 'D:\\Approved-Game', options: { fontSizeMethod: 'pixel', fontScale: 1 } })
  assert.equal(model.getState().exported.status, 'staged')
  assert.equal(model.getState().exported.nativeVerified, undefined)
  assert.equal(calls.filter(call => /build|import|generate|config|theme/.test(call.path)).length, 0)
})
test('explicit validation reports structure but cannot manufacture Maker readiness', async () => {
  const { model, calls } = fixture()
  assert.equal(await model.checkDocument(), true)
  assert.equal(calls.at(-1).path, '/check')
  assert.equal(model.getState().report.ok, true)
  assert.equal(model.canExport(), false)
})

test('renderer preserves relative parent coordinates, node order and static list roles', () => {
  const { model } = fixture()
  const { host } = render(model.getState())
  const card = byId(host, 'card-potion'); const label = byId(host, 'title-potion')
  assert.equal(label.parentNode, card)
  assert.equal(label.style.left, '24px')
  assert.equal(label.style.top, '110px')
  const list = byId(host, 'supplies')
  assert.equal(list.getAttribute('role'), 'list')
  assert.deepEqual(list.children.map(child => child.dataset.uiId), ['card-potion', 'card-ration', 'card-torch'])
  assert.equal(card.getAttribute('role'), 'listitem')
  assert.equal(byId(host, 'bag-modal').hidden, true)
})
test('renderer binds current currency and inventory using textContent, never HTML or remote media', () => {
  const { model } = fixture()
  model.setMode('interact'); model.clickNode('buy-potion')
  model.updateNode('title', { text: '<img src=x onerror=alert(1)>' })
  const { host } = render(model.getState())
  assert.match(byId(host, 'coins').textContent, /110/)
  assert.match(byId(host, 'bag-count').textContent, /1 件/)
  assert.equal(byId(host, 'title').textContent, '<img src=x onerror=alert(1)>')
  assert.equal(descendants(host).some(element => element.tagName === 'IMG'), false)
})
test('renderer keeps unavailable local images as explicit placeholders without fetching paths', () => {
  const document = demo()
  document.assets = [{ id: 'own-icon', path: 'images/icon.png', sha256: 'a'.repeat(64), license: { kind: 'own', author: 'self', source: 'original' } }]
  document.nodes.push({ id: 'icon', parent: 'root', type: 'image', layout: { x: 4, y: 4, width: 24, height: 24 }, props: { asset: 'own-icon' } })
  const { model } = fixture(); model.importJson(JSON.stringify(document), { name: 'icons.json' })
  const { host } = render(model.getState())
  assert.match(byId(host, 'icon').textContent, /未加载|占位/)
  assert.equal(descendants(host).some(element => element.getAttribute('src') !== null), false)
})
test('renderer selection does not purchase in edit mode; disabled ancestors prevent interaction', () => {
  const { model } = fixture()
  const selections = []; const actions = []
  let output = render(model.getState(), { onSelect: id => selections.push(id), onAction: id => actions.push(id) })
  byId(output.host, 'buy-potion').dispatch('click')
  assert.deepEqual(selections, ['buy-potion']); assert.deepEqual(actions, [])
  model.setMode('interact'); model.updateNode('card-potion', { visible: false })
  output = render(model.getState(), { onAction: id => actions.push(id) })
  byId(output.host, 'buy-potion').dispatch('click')
  assert.equal(actions.length, 0)
})
test('custom modal renderer blocks background, traps Tab, handles Escape and restores trigger focus', () => {
  const { model } = fixture()
  model.setMode('interact')
  const callbacks = { onAction: id => model.clickNode(id), onSelect: id => model.selectNode(id), onDismissModal: () => model.closeModal() }
  const { host, dom } = render(model.getState(), callbacks)
  byId(host, 'bag-button').focus(); model.clickNode('bag-button'); render(model.getState(), callbacks, host)
  const modal = byId(host, 'bag-modal')
  assert.equal(modal.getAttribute('role'), 'dialog')
  assert.equal(modal.getAttribute('aria-modal'), 'true')
  assert.match(modal.getAttribute('aria-label'), /自定义覆盖层/)
  assert.ok(descendants(host).some(element => element.dataset.previewBackdrop === 'true'))
  byId(host, 'buy-potion').dispatch('click')
  assert.equal(model.getState().previewState.coins, 120)
  const tab = modal.dispatch('keydown', { key: 'Tab' })
  assert.equal(tab.defaultPrevented, true)
  assert.ok(modal.contains(dom.activeElement))
  const escape = modal.dispatch('keydown', { key: 'Escape' })
  assert.equal(escape.defaultPrevented, true)
  render(model.getState(), callbacks, host)
  assert.equal(byId(host, 'bag-modal').hidden, true)
  assert.equal(dom.activeElement.dataset.uiId, 'bag-button')
})

// Mount integration uses an explicitly limited DOM adapter, with no filesystem
// or network writes. Real CSS/DOM visual evidence remains the browser test.
async function mountFixture() {
  const html = await source('../src/ui-workbench.html'); const dom = new Dom()
  const root = dom.createElement('main'); dom.ids.set('ui-workbench', root); dom.body.append(root)
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const [, tag, attrs, id] = match
    if (id === 'ui-workbench') continue
    const element = dom.createElement(tag); element.id = id; element.hidden = /\bhidden\b/.test(attrs); element.open = /\bopen\b/.test(attrs)
    dom.ids.set(id, element); root.append(element)
  }
  const audit = dom.createElement('details'); root.append(audit); audit.append(dom.getElementById('source-audit'))
  dom.getElementById('viewport-preset').value = '1280x720'
  const browser = new Element('window', dom); browser.parent = browser; browser.confirm = () => true
  const timers = new Map(); let timerId = 0
  browser.setTimeout = listener => { timers.set(++timerId, listener); return timerId }
  browser.clearTimeout = id => timers.delete(id)
  browser.Blob = Blob; browser.URL = { createObjectURL: () => 'blob:local-test-only', revokeObjectURL: () => {} }
  const media = new Map()
  browser.matchMedia = query => {
    if (!media.has(query)) { const item = new Element('media', dom); item.matches = false; media.set(query, item) }
    return media.get(query)
  }
  browser.getComputedStyle = () => ({ paddingLeft: '18px', paddingRight: '18px', paddingTop: '18px', paddingBottom: '18px' })
  browser.FileReader = class extends Element {
    constructor() { super('reader', dom) }
    readAsText(file) { if (file.readError) this.dispatch('error'); else { this.result = file.text; this.dispatch('load') } }
  }
  const calls = []; let savedDocument = demo(); let revision = 0
  const fetchImpl = async (url, options) => {
    const path = url.slice(workbench.API_BASE.length); const body = options.body ? JSON.parse(options.body) : null
    calls.push({ path, body, method: options.method })
    let result
    if (path === '/status') result = { ok: true, root: 'D:\\Explicit-UI-Root', sourceAudit, maker: { available: false } }
    else if (path === '/workspaces' && body === null) result = { ok: true, workspaces: [{ workspaceId: 'ui-a', revisionId: 'rev-a', name: '保存的营地', nodeCount: 32 }] }
    else if (path === '/workspaces' || path.endsWith('/revisions')) { savedDocument = body.document; result = saved(savedDocument, 'ui-a', `rev-${++revision}`) }
    else if (path.startsWith('/workspaces/')) result = saved(savedDocument)
    else if (path === '/check') result = ui.validateUiDocument(body.document)
    else if (path === '/plan') result = { ok: true, ready: true, blockers: [], warnings: ['Mock only', { code: 'DOM', message: '非 native 验收' }] }
    else if (path === '/export') result = { ok: true, status: 'staged', directory: 'D:\\UI\\review', files: ['UI.json', { path: 'review.json' }] }
    else throw new Error(`Unexpected mounted route ${path}`)
    return { ok: true, status: 200, json: async () => result }
  }
  const mounted = feature('mountWorkbench', { root, ui, browser, dom, fetchImpl })
  await new Promise(resolve => setImmediate(resolve))
  return { ...mounted, root, dom, browser, calls, timers, media, get: id => dom.getElementById(id), settle: () => new Promise(resolve => setImmediate(resolve)) }
}
test('mounted controls bind all property inputs, local file IO, readiness layers and explicit write actions', async () => {
  const context = await mountFixture(); const { model, get, calls, dom, browser, settle } = context
  assert.equal(calls.length, 2); assert.equal(get('export-review').disabled, true)
  assert.equal(get('workspace-root').textContent, 'D:\\Explicit-UI-Root')
  model.selectNode('title')
  for (const [id, value, event] of [['property-text', '挂接文字', 'input'], ['property-x', '70', 'change'], ['property-y', '90', 'change'], ['property-width', '680', 'change'], ['property-height', '65', 'change'], ['property-font-size', '30', 'change'], ['property-color', '#AACCEE', 'change'], ['property-background', '#10212C', 'change']]) {
    get(id).value = value; get(id).focus(); get(id).dispatch(event)
  }
  assert.equal(node(model, 'title').props.text, '挂接文字'); assert.equal(node(model, 'title').layout.x, 70)
  get('property-visible').checked = false; get('property-visible').dispatch('change'); assert.equal(node(model, 'title').props.visible, false)
  get('property-visible').checked = true; get('property-visible').dispatch('change')
  get('property-color').value = 'bad-color'; get('property-color').dispatch('change'); assert.equal(get('property-color').getAttribute('aria-invalid'), 'true')
  get('document-name').value = '挂接文档'; get('document-name').focus(); get('document-name').dispatch('input')
  assert.equal(model.getState().document.name, '挂接文档')
  get('mode-interact').click(); byId(get('preview-host'), 'buy-potion').click(); byId(get('preview-host'), 'bag-button').click()
  dom.dispatch('keydown', { key: 'Escape' }); assert.equal(model.getState().visibility['bag-modal'], false)
  get('mode-edit').click(); get('check-document').click(); await settle()
  assert.match(get('structure-state').textContent, /结构有效/)
  get('plan-export').click(); await settle(); assert.match(get('plan-state').textContent, /blocked/)
  get('maker-project').value = 'D:\\Approved-Game'; get('maker-project').focus(); get('maker-project').dispatch('input')
  get('font-size-method').value = 'pixel'; get('font-size-method').dispatch('change')
  get('save-workspace').click(); await settle(); assert.equal(model.getState().dirty, false)
  get('plan-export').click(); await settle(); assert.equal(get('export-review').disabled, false)
  get('export-review').click(); await settle(); assert.match(get('export-result').textContent, /staged/)
  assert.match(get('package-state').textContent, /当前版本/)
  model.updateNode('title', { text: '旧快照后改动' }); assert.match(get('package-state').textContent, /旧快照/)
  get('download-json').click(); assert.match(dom.downloads[0].filename, /^taptap-ui-.*\.json$/)
  get('json-file').files = [{ name: 'invalid.svg', size: 10, type: 'image/svg+xml', text: '{}' }]; get('json-file').dispatch('change')
  assert.match(model.getState().error, /json|JSON/)
  get('json-file').files = [{ name: 'local.json', size: 10, type: 'application/json', readError: true }]; get('json-file').dispatch('change')
  assert.match(model.getState().error, /FileReader/)
  get('json-file').files = [{ name: 'local.json', size: JSON.stringify(demo()).length, type: 'application/json', text: JSON.stringify(demo()) }]; get('json-file').dispatch('change')
  assert.equal(model.getState().workspaceId, null)
  const writes = calls.filter(call => call.method === 'POST').length
  get('new-demo').click(); assert.equal(calls.filter(call => call.method === 'POST').length, writes)
  const unload = browser.dispatch('beforeunload'); assert.equal(unload.defaultPrevented, true)
  get('safe-area').checked = true; get('safe-area').dispatch('change'); assert.equal(get('safe-area-overlay').hidden, false)
  get('viewport-preset').value = '390x844'; get('viewport-preset').dispatch('change'); assert.match(get('viewport-info').textContent, /390 × 844/)
  const narrow = context.media.get('(max-width: 900px)'); narrow.matches = true; narrow.dispatch('change')
  assert.equal(get('workspace-panel').open, false); assert.equal(get('inspector-panel').open, false)
  model.selectNode('root'); assert.equal(get('property-width').disabled, true); assert.equal(get('property-font-size').disabled, true)
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight']) get('node-tree').children[0].dispatch('keydown', { key })
  const nested = get('node-tree').children.find(button => button.textContent.includes('title-potion')); nested.dispatch('keydown', { key: 'ArrowLeft' })
  get('workspace-list').children[0].children[0].click(); await settle(); assert.equal(model.getState().workspaceId, 'ui-a')
  get('refresh-workspaces').click(); await settle()
  get('import-json').click(); get('property-form').dispatch('submit')
  for (const callback of context.timers.values()) callback()
  browser.dispatch('resize'); context.dispose()
  assert.equal(browser.listeners.get('beforeunload').length, 0)
})
test('same-origin iframe theme reads a paired dark/light parent and never changes parent configuration', () => {
  const dom = new Dom(); const parentDom = new Dom(); parentDom.documentElement.dataset.theme = 'light'
  const browser = new Element('window', dom); const parent = { document: parentDom }; browser.parent = parent
  const media = new Element('media', dom); media.matches = false; browser.matchMedia = () => media
  const callbacks = []; let disconnected = false
  browser.MutationObserver = class { constructor(callback) { callbacks.push(callback) } observe() {} disconnect() { disconnected = true } }
  const values = { '--dsh-border': '#bbc9c4', '--dsh-accent': '#267c65' }
  parent.getComputedStyle = () => ({ backgroundColor: 'rgb(240, 244, 242)', color: 'rgb(25, 42, 37)', colorScheme: 'light', getPropertyValue: name => values[name] ?? '' })
  const stop = feature('connectHostTheme', browser, dom)
  assert.equal(dom.documentElement.dataset.theme, 'light'); assert.equal(dom.documentElement.style['--dsh-accent'], undefined)
  assert.equal(dom.documentElement.style['--wb-fg'], undefined, 'Host foreground is not copied independently of its palette')
  assert.equal(dom.documentElement.style['--wb-bg'], undefined)
  assert.equal(parentDom.documentElement.dataset.theme, 'light')
  parentDom.documentElement.dataset.theme = 'dark'
  parent.getComputedStyle = () => ({ backgroundColor: 'rgb(21, 27, 29)', color: 'rgb(226, 236, 232)', colorScheme: 'dark', getPropertyValue: () => '' })
  callbacks[0](); assert.equal(dom.documentElement.dataset.theme, 'dark'); assert.equal(dom.documentElement.style['--dsh-accent'], undefined)
  stop(); assert.equal(disconnected, true)
})
test('bootstrap safely handles an absent root or unavailable host document route without writing', async () => {
  const dom = new Dom(); const browser = new Element('window', dom)
  assert.equal(await feature('bootstrapWorkbench', { dom, browser }), null)
  const root = dom.createElement('main'); dom.ids.set('ui-workbench', root); const banner = dom.createElement('p'); dom.ids.set('boot-error', banner)
  assert.equal(await feature('bootstrapWorkbench', { dom, browser }), null)
  assert.match(banner.textContent, /没有保存|没有.*导出/)
})
test('keyboard-selected tree item keeps focus after selection redraw', async () => {
  const { get, dom, dispose } = await mountFixture()
  const button = get('node-tree').children.find(button => button.textContent.endsWith('title'))
  button.focus(); button.click()
  assert.equal(get('node-tree').contains(dom.activeElement), true, 'Selecting must not strand focus in a removed tree item')
  dispose()
})
test('Maker availability is visible separately from document structure and native acceptance', async () => {
  const html = await source('../src/ui-workbench.html')
  assert.match(html, /id="maker-availability"/, 'Workbench must show the status API Maker availability without calling it native completion')
})

// Opt-in: UI_WORKBENCH_BROWSER=1 node --test tests/ui-workbench.test.mjs
// This uses an existing Python+Playwright installation. It starts NO HTTP
// server and intercepts a separate browser context's same-origin routes. All
// artifacts remain in tempfile.mkdtemp() output; NEVER rmtree or delete them.
if (process.env.UI_WORKBENCH_BROWSER === '1') {
  test('real browser DOM, modal focus, import/save/preflight/export and narrow overflow (mock HTTP, not live GUI)', { timeout: 90000 }, () => {
    const script = String.raw`
import json, os, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
root = Path(os.environ['UI_WORKBENCH_TEST_ROOT'])
demo = json.loads(os.environ['UI_WORKBENCH_TEST_DEMO'])
base = 'http://127.0.0.1:54984'
api = '/api/taptap-maker-dev/ui'
artifacts = Path(tempfile.mkdtemp(prefix='ui-workbench-dom-'))
posts = []
workspace = None
revision = 0

def handle(route):
    global workspace, revision
    path = route.request.url.removeprefix(base).split('?')[0]
    mapping = {
      api + '/workbench': ('src/ui-workbench.html', 'text/html'),
      api + '/workbench.css': ('src/ui-workbench.css', 'text/css'),
      api + '/workbench.mjs': ('src/ui-workbench.mjs', 'text/javascript'),
      api + '/document.mjs': ('src/ui-document.mjs', 'text/javascript')
    }
    if path in mapping:
        name, kind = mapping[path]
        route.fulfill(body=(root / name).read_text(encoding='utf-8'), content_type=kind)
        return
    body = route.request.post_data_json if route.request.method == 'POST' else None
    if body is not None: posts.append({'path': path, 'body': body})
    if path == api + '/status': result = {'ok': True, 'root': r'D:\Approved-UI-Root', 'sourceAudit': {'ok': True, 'license': 'MIT', 'commit': 'audit-commit', 'parser': 'python-stdlib-adapter'}, 'maker': {'available': False}, 'workspaces': []}
    elif path == api + '/workspaces' and body is None: result = {'ok': True, 'workspaces': []}
    elif path == api + '/workspaces' or path.endswith('/revisions'):
        workspace = body['document']; revision += 1
        result = {'ok': True, 'workspaceId': 'ui-browser', 'revisionId': 'rev-' + str(revision), 'directory': r'D:\Approved-UI-Root\ui-browser', 'file': 'document.json'}
    elif path == api + '/plan': result = {'ok': True, 'ready': True, 'blockers': [], 'warnings': [{'code': 'DOM_ONLY', 'message': 'Mock HTTP, not native acceptance'}]}
    elif path == api + '/check': result = {'ok': True, 'errors': [], 'warnings': [], 'nodeCount': len(demo['nodes'])}
    elif path == api + '/export': result = {'ok': True, 'status': 'staged', 'directory': r'D:\Approved-UI-Root\ui-browser\exports\new-review', 'files': ['UI.json', 'review.json']}
    elif path.startswith(api + '/workspaces/'): result = {'ok': True, 'workspaceId': 'ui-browser', 'revisionId': 'rev-' + str(revision), 'document': workspace}
    else:
        route.abort(); return
    route.fulfill(json=result)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1512, 'height': 920}, color_scheme='dark', reduced_motion='reduce', record_video_dir=str(artifacts / 'videos'), record_video_size={'width': 1512, 'height': 920})
    context.tracing.start(screenshots=True, snapshots=True)
    page = context.new_page(); page.route('**/*', handle)
    errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + api + '/workbench')
    page.locator('[data-ui-id="buy-potion"]').wait_for()
    page.screenshot(path=str(artifacts / 'desktop-original.png'), full_page=True)
    assert not posts, 'Boot must not save or export'
    assert page.locator('#maker-project').input_value() == ''
    assert page.locator('#font-size-method').input_value() == ''
    assert page.locator('#export-review').is_disabled()
    assert page.locator('#workspace-root').inner_text() == r'D:\Approved-UI-Root'
    page.locator('#mode-interact').click()
    page.locator('[data-ui-id="buy-potion"]').click()
    assert '110' in page.locator('[data-ui-id="coins"]').inner_text()
    assert '1 件' in page.locator('[data-ui-id="bag-count"]').inner_text()
    page.locator('[data-ui-id="bag-button"]').click()
    assert page.locator('[data-ui-id="bag-modal"]').get_attribute('aria-modal') == 'true'
    page.locator('[data-ui-id="buy-potion"]').evaluate('(el) => el.click()')
    assert '110' in page.locator('[data-ui-id="coins"]').inner_text()
    page.screenshot(path=str(artifacts / 'desktop-modal.png'), full_page=True)
    page.keyboard.press('Escape')
    assert page.locator('[data-ui-id="bag-modal"]').is_hidden()
    assert page.locator('[data-ui-id="bag-button"]').evaluate('(el) => document.activeElement === el')
    page.locator('#mode-edit').click()
    page.locator('[data-ui-id="title"]').click()
    injected = '<img src=x onerror=alert(1)>'
    page.locator('#property-text').fill(injected)
    page.locator('#property-text').blur()
    assert page.locator('[data-ui-id="title"]').inner_text() == injected
    assert page.locator('#preview-host img').count() == 0
    page.locator('#save-workspace').click()
    page.wait_for_function('document.querySelector("#draft-status").dataset.dirty === "false"')
    assert len(posts) == 1
    page.locator('#maker-project').fill(r'D:\Approved-Test-Maker')
    page.locator('#maker-project').blur()
    page.locator('#font-size-method').select_option('pixel')
    page.locator('#plan-export').click()
    page.wait_for_function('!document.querySelector("#export-review").disabled')
    page.locator('#export-review').click()
    page.locator('#export-result').get_by_text('staged', exact=False).wait_for()
    assert posts[-1]['body']['workspaceId'] == 'ui-browser'
    assert posts[-1]['body']['options'] == {'fontSizeMethod': 'pixel', 'fontScale': 1}
    page.screenshot(path=str(artifacts / 'desktop-workbench.png'), full_page=True)
    imports = dict(demo); imports['name'] = '本地 JSON 新工作区'
    page.locator('#json-file').set_input_files({'name': 'local.json', 'mimeType': 'application/json', 'buffer': json.dumps(imports).encode()})
    page.wait_for_function('document.querySelector("#draft-status").dataset.dirty === "true"')
    assert len(posts) == 3, 'FileReader import must not perform server writes'
    page.on('dialog', lambda dialog: dialog.dismiss())
    page.locator('#new-demo').click()
    assert page.locator('#document-name').input_value() == '本地 JSON 新工作区'
    page.set_viewport_size({'width': 390, 'height': 844})
    page.locator('#viewport-preset').select_option('390x844')
    page.wait_for_function('document.documentElement.scrollWidth <= window.innerWidth')
    assert not page.locator('#workspace-panel').evaluate('(el) => el.open')
    assert not page.locator('#inspector-panel').evaluate('(el) => el.open')
    page.screenshot(path=str(artifacts / 'portrait-workbench.png'), full_page=True)
    page.emulate_media(color_scheme='light')
    page.screenshot(path=str(artifacts / 'portrait-light.png'), full_page=True)
    assert not errors, errors
    context.tracing.stop(path=str(artifacts / 'trace.zip'))
    context.close(); browser.close()
print(json.dumps({'ok': True, 'evidence': 'isolated browser, mocked API only; no live GUI update claim', 'artifacts': str(artifacts), 'posts': len(posts)}, ensure_ascii=False))
`
    const result = spawnSync(process.env.UI_WORKBENCH_TEST_PYTHON || 'python', ['-c', script], {
      env: { ...process.env, UI_WORKBENCH_TEST_ROOT: fileURLToPath(new URL('../', import.meta.url)), UI_WORKBENCH_TEST_DEMO: JSON.stringify(demo()) },
      encoding: 'utf8', timeout: 85000, maxBuffer: 1_000_000,
    })
    assert.equal(result.status, 0, `Existing Python Playwright failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    console.log(result.stdout.trim())
  })
}
