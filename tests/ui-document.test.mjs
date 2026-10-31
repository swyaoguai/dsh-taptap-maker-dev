import test from 'node:test'
import assert from 'node:assert/strict'

// A missing *new feature* is the intended RED signal, not a missing dependency.
const moduleUrl = new URL('../src/ui-document.mjs', import.meta.url)
let ui = {}
try { ui = await import(moduleUrl) } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || error.url !== moduleUrl.href) throw error
}
function call(name, ...args) {
  assert.equal(typeof ui[name], 'function', `UI workflow implementation missing: ${name}`)
  return ui[name](...args)
}
const demo = () => call('createDemoDocument')
const check = (document) => call('validateUiDocument', document)

test('the independently authored shop demo is a valid versioned document', () => {
  const document = demo()
  assert.equal(document.format, 'taptap-ui')
  assert.equal(document.version, 1)
  assert.equal(check(document).ok, true)
  assert.ok(document.nodes.some(node => node.type === 'button'))
  assert.ok(document.nodes.some(node => node.type === 'list'))
  assert.ok(document.nodes.some(node => node.type === 'modal'))
  assert.equal(document.assets.length, 0, 'the demo must not borrow unlicensed artwork')
})

test('demo calls return independent state rather than a shared mutable singleton', () => {
  const a = demo(); const b = demo()
  a.state.coins = 1
  assert.equal(b.state.coins, 120)
})

test('unknown versions and non-document input fail closed', () => {
  for (const input of [null, [], 'text', { ...demo(), version: 2 }, { ...demo(), format: 'FairyGUI' }]) {
    assert.equal(check(input).ok, false)
  }
})

test('duplicate IDs, missing parents and cyclic node ownership are errors', () => {
  const duplicate = demo(); duplicate.nodes.push(structuredClone(duplicate.nodes[1]))
  assert.ok(check(duplicate).errors.some(error => error.code === 'UI_DUPLICATE_ID'))
  const missing = demo(); missing.nodes[1].parent = 'does-not-exist'
  assert.ok(check(missing).errors.some(error => error.code === 'UI_PARENT'))
  const cyclic = demo(); cyclic.nodes[1].parent = cyclic.nodes[2].id; cyclic.nodes[2].parent = cyclic.nodes[1].id
  assert.ok(check(cyclic).errors.some(error => error.code === 'UI_CYCLE'))
})

test('invalid geometry and unknown controls are not silently flattened', () => {
  const invalid = demo(); invalid.nodes[1].layout.width = -10
  assert.ok(check(invalid).errors.some(error => error.code === 'UI_LAYOUT'))
  const unsupported = demo(); unsupported.nodes[1].type = 'particle-system'
  assert.ok(check(unsupported).errors.some(error => error.code === 'UI_UNSUPPORTED'))
  const nonFinite = demo(); nonFinite.nodes[1].layout.x = Infinity
  assert.equal(check(nonFinite).ok, false)
})

test('script-like props, prototype keys and raw engine callbacks are forbidden', () => {
  for (const key of ['onClick', 'onclick', 'innerHTML', 'script']) {
    const document = demo(); document.nodes[1].props[key] = 'alert(1)'
    assert.equal(check(document).ok, false, key)
  }
  const polluted = demo(); polluted.state = JSON.parse('{"__proto__":{"polluted":true}}')
  assert.equal(check(polluted).ok, false)
  assert.equal({}.polluted, undefined)
})

test('assets require explicit local paths, reviewed rights and immutable hashes', () => {
  const document = demo()
  document.assets = [{ id: 'icon', path: '../credentials.json', sha256: 'a'.repeat(64), license: { kind: 'own', author: 'self', source: 'self-authored' } }]
  assert.equal(check(document).ok, false)
  document.assets[0].path = 'images/icon.png'; document.assets[0].license.kind = 'unknown'
  assert.equal(check(document).ok, false)
  document.assets[0].license.kind = 'own'; document.assets[0].sha256 = 'not-a-hash'
  assert.equal(check(document).ok, false)
  document.assets[0].sha256 = 'a'.repeat(64)
  assert.equal(check(document).ok, true)
})

test('remote image URLs are not fetched or accepted as reviewed local assets', () => {
  const document = demo()
  document.assets = [{ id: 'icon', path: 'https://example.com/icon.png', sha256: 'a'.repeat(64), license: { kind: 'CC0', author: 'author', source: 'https://example.com/license' } }]
  assert.equal(check(document).ok, false)
})

test('events and state bindings must point to existing nodes, actions and keys', () => {
  const document = demo(); document.events[0].action = 'missing'
  assert.ok(check(document).errors.some(error => error.code === 'UI_EVENT'))
  const bindings = demo(); bindings.bindings[0].template = 'missing {not-a-state-key}'
  assert.ok(check(bindings).errors.some(error => error.code === 'UI_BINDING'))
})

test('the bounded action interpreter buys an item and binds the new value', () => {
  const document = demo()
  const result = call('applyUiAction', document, document.state, 'buy-potion')
  assert.equal(result.state.coins, 110)
  assert.equal(result.state.bought, 1)
  assert.equal(document.state.coins, 120, 'actions must be immutable')
  assert.match(result.toast, /背包/)
  const resolved = call('resolveUiBindings', document, result.state)
  assert.match(resolved.coins.text, /110/)
})

test('insufficient currency does not apply part of a transaction', () => {
  const document = demo()
  const result = call('applyUiAction', document, { ...document.state, coins: 3 }, 'buy-potion')
  assert.equal(result.state.coins, 3)
  assert.equal(result.state.bought, 0)
  assert.match(result.toast, /不足/)
})

test('modal visibility is controlled by a declared action, not executable JSON', () => {
  const document = demo()
  const shown = call('applyUiAction', document, document.state, 'open-bag')
  assert.equal(shown.visibility['bag-modal'], true)
  const closed = call('applyUiAction', document, shown.state, 'close-bag')
  assert.equal(closed.visibility['bag-modal'], false)
  assert.throws(() => call('applyUiAction', document, document.state, 'missing'), /action|动作/i)
})

test('action instructions are finite, whitelisted and only update declared state', () => {
  const document = demo(); document.actions[0].steps.push({ type: 'eval', script: 'process.exit()' })
  assert.equal(check(document).ok, false)
  const undeclared = demo(); undeclared.actions[0].steps.push({ type: 'set', key: 'missing', value: true })
  assert.equal(check(undeclared).ok, false)
})

test('serialization prevents closing a script element or injecting HTML', () => {
  const source = '</script><img src=x onerror=alert(1)>\u2028\u2029'
  const encoded = call('jsonForScript', { text: source })
  assert.equal(encoded.includes('</script>'), false)
  assert.equal(encoded.includes('<img'), false)
  assert.deepEqual(JSON.parse(encoded), { text: source })
  assert.equal(call('escapeHtml', '<b>"&\''), '&lt;b&gt;&quot;&amp;&#39;')
})

test('documents have bounded node count and input size', () => {
  const document = demo()
  while (document.nodes.length <= 1000) {
    document.nodes.push({ id: `extra-${document.nodes.length}`, type: 'label', parent: 'root', layout: { x: 0, y: 0, width: 10, height: 10 }, props: { text: 'x' } })
  }
  assert.ok(check(document).errors.some(error => error.code === 'UI_LIMIT'))
  const huge = demo(); huge.name = 'x'.repeat(1_100_000)
  assert.equal(check(huge).ok, false)
})
