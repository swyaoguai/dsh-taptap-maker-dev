import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const host = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function uiDock({ open = false, confirm = () => false, hostDocument = {} } = {}) {
  const registered = []; const stateWrites = []; const effects = []
  const React = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [open, value => stateWrites.push(value)],
    useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => effects.push(fn), useRef: initial => ({ current: initial }),
  }
  const window = { __ModuleLoader__: { load({ factory }) { const plugin = factory(name => { assert.equal(name, 'react'); return React }); plugin.apply({ slots: { inject: (_name, cb) => cb(), register: (meta, component) => registered.push({ meta, component }) } }) } }, confirm, addEventListener() {}, removeEventListener() {} }
  vm.runInNewContext(client, { window, console, document: hostDocument, fetch: () => { throw new Error('No unexpected API/provider call from client registration') } })
  const entry = registered.find(item => item.meta.id === 'taptap-maker-dev-ui')
  assert.ok(entry, 'Missing intended UI composer dock registration')
  return { tree: entry.component(), entry, stateWrites, effects }
}
function collect(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  const matches = predicate(tree) ? [tree] : []
  return [...matches, ...(tree.children ?? []).flat(Infinity).flatMap(child => collect(child, predicate))]
}

test('host mounts the bounded UI handler inside the existing prefix and registers direct slash adapter', () => {
  assert.match(host, /import\s*\{[^}]*createUiHttpHandler[^}]*\}\s*from\s*['"]\.\/src\/ui-http\.mjs['"]/)
  assert.match(host, /const uiHandler\s*=\s*createUiHttpHandler/)
  assert.match(host, /sub === 'ui' \|\| sub\.startsWith\('ui\/'\)/)
  assert.match(host, /name:\s*'taptap-ui'/)
  assert.match(host, /handleUiSlashInput\(invocation\?\.rawInput/)
})

test('the UI dock is closed by default and does not make a provider request', () => {
  const { tree, entry } = uiDock()
  assert.equal(entry.meta.name, 'conversation.composer.dock')
  assert.equal(collect(tree, node => node.type === 'iframe').length, 0)
  assert.ok(collect(tree, node => node.type === 'button' && node.props['aria-label'] === '打开 UI 工作台').length)
})

test('opening uses the same GUI iframe route, not another port, server or external origin', () => {
  const { tree } = uiDock({ open: true })
  const iframe = collect(tree, node => node.type === 'iframe')[0]
  assert.equal(iframe.props.src, '/api/taptap-maker-dev/ui/workbench')
  assert.match(iframe.props.sandbox, /allow-scripts/)
  assert.match(iframe.props.sandbox, /allow-modals/, 'Authored draft-discard confirmation must work inside the same-origin iframe')
  assert.match(iframe.props.title, /UI 工作台/)
  assert.ok(collect(tree, node => node.props.role === 'dialog' && node.props['aria-modal'] === true).length)
})

test('outer dialog owns initial focus and restores only its own background inert changes', () => {
  const previous = { focus() { hostDocument.activeElement = this } }
  const hostDocument = { activeElement: previous, addEventListener() {}, removeEventListener() {} }
  const { tree, effects } = uiDock({ open: true, hostDocument })
  const dialog = collect(tree, node => node.props.role === 'dialog')[0]
  const background = { inert: false }; const alreadyInert = { inert: true }
  const body = { children: [], parentElement: null }; hostDocument.body = body
  const root = { parentElement: body, contains: node => node === root, focus() { hostDocument.activeElement = this }, querySelectorAll: () => [] }
  body.children = [background, root, alreadyInert]
  assert.ok(dialog.props.ref, 'Dialog must hold its own DOM reference for focus/inert ownership')
  dialog.props.ref.current = root
  const cleanup = effects.map(effect => effect()).filter(fn => typeof fn === 'function')
  assert.equal(hostDocument.activeElement, root)
  assert.equal(background.inert, true); assert.equal(alreadyInert.inert, true)
  cleanup.forEach(fn => fn())
  assert.equal(background.inert, false); assert.equal(alreadyInert.inert, true)
  assert.equal(hostDocument.activeElement, previous)
})

test('host close retains an unsaved iframe draft when confirmation is denied', () => {
  let confirmations = 0
  const { tree, stateWrites } = uiDock({ open: true, confirm: () => { confirmations++; return false } })
  const iframe = collect(tree, node => node.type === 'iframe')[0]
  iframe.props.ref.current = { contentDocument: { getElementById: () => ({ dataset: { dirty: 'true' } }), querySelector: () => null } }
  const close = collect(tree, node => node.type === 'button' && node.props['aria-label'] === '关闭 UI 工作台')[0]
  close.props.onClick()
  assert.equal(confirmations, 1); assert.equal(stateWrites.length, 0)
})

test('confirmed host close unmounts without issuing a save or discard endpoint', () => {
  const { tree, stateWrites } = uiDock({ open: true, confirm: () => true })
  const iframe = collect(tree, node => node.type === 'iframe')[0]
  iframe.props.ref.current = { contentDocument: { getElementById: () => ({ dataset: { dirty: 'true' } }), querySelector: () => null } }
  collect(tree, node => node.type === 'button' && node.props['aria-label'] === '关闭 UI 工作台')[0].props.onClick()
  assert.deepEqual(stateWrites, [false])
})
