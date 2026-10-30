/**
 * Offline runtime tests: real preference helpers and settings callbacks.
 * No login/generation, credentials, network, servers, or fixture deletion.
 * Run: node scripts/verify-zaiduyu-preferences.mjs
 * Unique temporary fixtures are intentionally retained for inspection.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

let passed = 0
let failed = 0
async function check(name, run) {
  try { await run(); passed += 1; console.log(`  PASS ${name}`) }
  catch (error) { failed += 1; console.error(`  FAIL ${name}: ${error.message}`) }
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zaiduyu-preferences-'))
console.log(`Retained offline fixtures: ${scratch}`)
const homeFor = (name) => path.join(scratch, name)
const fileFor = (home) => path.join(home, 'taptap-maker-dev', 'zaiduyu-preferences.json')
let preferences
let importError
try { preferences = await import('../src/zaiduyu-preferences.mjs') }
catch (error) { importError = error }
function helpers() {
  assert.ok(preferences, `preference helper exists (${importError?.code ?? 'not loaded'})`)
  return preferences
}
const invalid = (error) => error?.code === 'invalid_model'

console.log('\n[1] Real independent preference helpers')
await check('unset preferences contain no automatic model', () => {
  assert.deepEqual(helpers().readZaiduyuPreferences(homeFor('unset')), { defaultModel: '' })
})
await check('save trims the selected ID and persists only the preference', () => {
  const h = homeFor('save')
  const p = helpers()
  assert.deepEqual(p.writeZaiduyuPreferences(h, { defaultModel: '  offline-image-B  ', unrelated: 'ignore me' }), { defaultModel: 'offline-image-B' })
  assert.deepEqual(p.readZaiduyuPreferences(h), { defaultModel: 'offline-image-B' })
  assert.deepEqual(JSON.parse(fs.readFileSync(fileFor(h), 'utf8')), { defaultModel: 'offline-image-B' })
})
await check('clear writes an empty preference without deleting or touching other files', () => {
  const h = homeFor('clear')
  const p = helpers()
  p.writeZaiduyuPreferences(h, { defaultModel: 'offline-image-A' })
  const marker = path.join(h, 'taptap-maker-dev', 'account-placeholder.txt')
  fs.writeFileSync(marker, 'untouched offline marker', 'utf8')
  assert.deepEqual(p.writeZaiduyuPreferences(h, { defaultModel: '' }), { defaultModel: '' })
  assert.ok(fs.existsSync(fileFor(h)))
  assert.equal(fs.readFileSync(marker, 'utf8'), 'untouched offline marker')
  assert.deepEqual(p.readZaiduyuPreferences(h), { defaultModel: '' })
})
for (const [name, value] of [
  ['boolean', true], ['number', 12], ['null', null], ['array', ['image']], ['object', {}],
  ['too long', 'm'.repeat(201)], ['newline', 'image\n'], ['NUL', 'image\0'],
  ['DEL', 'image\u007f'], ['C1 control', 'image\u0085'],
]) {
  await check(`invalid saved preference (${name}) is rejected before writing`, () => {
    const h = homeFor(`invalid-${name.replace(/\W/g, '-')}`)
    assert.throws(() => helpers().writeZaiduyuPreferences(h, { defaultModel: value }), invalid)
    assert.equal(fs.existsSync(fileFor(h)), false)
  })
}
await check('200-character IDs and Unicode names remain valid user choices', () => {
  const p = helpers()
  const h = homeFor('boundaries')
  assert.equal(p.writeZaiduyuPreferences(h, { defaultModel: 'm'.repeat(200) }).defaultModel.length, 200)
  assert.equal(p.writeZaiduyuPreferences(h, { defaultModel: '  离线模型  ' }).defaultModel, '离线模型')
})
await check('missing preference patch is rejected without writing', () => {
  const h = homeFor('missing-patch')
  assert.throws(() => helpers().writeZaiduyuPreferences(h, {}), invalid)
  assert.throws(() => helpers().writeZaiduyuPreferences(h, null), invalid)
  assert.equal(fs.existsSync(fileFor(h)), false)
})
await check('invalid stored model never becomes a usable automatic selection', () => {
  const p = helpers()
  const h = homeFor('invalid-read')
  fs.mkdirSync(path.dirname(fileFor(h)), { recursive: true })
  for (const raw of [{ defaultModel: true }, { defaultModel: 'image\n' }, { defaultModel: 'm'.repeat(201) }, null, []]) {
    fs.writeFileSync(fileFor(h), JSON.stringify(raw), 'utf8')
    assert.deepEqual(p.readZaiduyuPreferences(h), { defaultModel: '' })
  }
})
await check('explicit model beats saved default without changing it', () => {
  const p = helpers()
  const h = homeFor('precedence')
  p.writeZaiduyuPreferences(h, { defaultModel: 'offline-image-A' })
  assert.equal(p.resolveZaiduyuModel(h, '  offline-image-B  '), 'offline-image-B')
  assert.equal(p.resolveZaiduyuModel(h), 'offline-image-A')
  assert.deepEqual(p.readZaiduyuPreferences(h), { defaultModel: 'offline-image-A' })
})
for (const [name, explicit] of [['empty', ''], ['blank', '   '], ['missing flag value', true], ['null', null]]) {
  await check(`invalid explicit selection (${name}) cannot fall back to saved model`, () => {
    const p = helpers()
    const h = homeFor(`explicit-${name.replace(/\W/g, '-')}`)
    p.writeZaiduyuPreferences(h, { defaultModel: 'offline-image-A' })
    assert.throws(() => p.resolveZaiduyuModel(h, explicit), invalid)
  })
}
await check('no model stops with model_required; saved changes apply immediately', () => {
  const p = helpers()
  const h = homeFor('required')
  assert.throws(() => p.resolveZaiduyuModel(h), (error) => error?.code === 'model_required')
  p.writeZaiduyuPreferences(h, { defaultModel: 'offline-image-B' })
  assert.equal(p.resolveZaiduyuModel(h), 'offline-image-B')
  p.writeZaiduyuPreferences(h, { defaultModel: '' })
  assert.throws(() => p.resolveZaiduyuModel(h), (error) => error?.code === 'model_required')
})

console.log('\n[2] Real settings component, stateful hooks and callbacks')
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('function ZaiduyuAccount()')
assert.ok(start >= 0, 'real component exists')
const component = source.slice(start, source.indexOf('\n    /**', start))
const inputStart = source.indexOf('function LabeledInput(props)')
const inputEnd = source.indexOf('\n    }', inputStart) + '\n    }'.length
const inputComponent = source.slice(inputStart, inputEnd)
const API_BASE = '/api/offline-preferences'
const catalog = [
  { model: 'offline-image-A', credits: '2 积分/张', route: 'images' },
  { model: 'offline-image-B', credits: '5 积分/张', route: 'images' },
  { model: 'offline-disabled', credits: '', route: 'chat，已停用' },
]
function uiFixture({ defaultModel = '', models = catalog, source: credentialSource = 'file', hasCredentials = true } = {}) {
  const store = { defaultModel, models }
  const calls = []
  const unexpected = []
  const hooks = []
  let cursor = 0
  let dirty = false
  let effects = []
  let tree
  let failure = null
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const h = (tag, props, ...kids) => {
    const children = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)
    if (typeof tag === 'function') return tag({ ...(props ?? {}), children })
    return { tag, props: props ?? {}, kids: children }
  }
  const sandbox = {
    h, API_BASE, console,
    S: new Proxy({}, { get: () => ({}) }),
    StatusChip: (props) => ({ tag: '#StatusChip', props, kids: [] }),
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, (next) => {
        hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next
        dirty = true
      }]
    },
    useCallback(fn, dependencies) {
      const index = cursor++
      if (!hooks[index] || !same(hooks[index].dependencies, dependencies)) hooks[index] = { fn, dependencies }
      return hooks[index].fn
    },
    useEffect(fn, dependencies) {
      const index = cursor++
      if (!hooks[index] || !same(hooks[index].dependencies, dependencies)) {
        hooks[index] = { dependencies }
        effects.push(fn)
      }
    },
    setTimeout: () => 0, clearTimeout() {},
    fetch: async (url, options = {}) => {
      const method = options.method ?? 'GET'
      const body = options.body ? JSON.parse(options.body) : undefined
      calls.push({ url, method, body })
      let json
      let status = 200
      if (url === `${API_BASE}/zaiduyu` && method === 'GET') {
        json = { ok: true, defaultModel: store.defaultModel, identifier: 'offline-account', password: 'of…', hasCredentials, source: credentialSource, script: true, usable: hasCredentials }
      } else if (url === `${API_BASE}/zaiduyu/models` && method === 'POST') {
        json = { ok: true, models: store.models }
      } else if (url === `${API_BASE}/zaiduyu/balance` && method === 'POST') {
        // Record the old unwanted mount effect without touching any account.
        json = { ok: true, balance: '100', permanent: '100', limited: '0' }
      } else if (url === `${API_BASE}/zaiduyu/settings` && method === 'POST') {
        if (failure instanceof Error) throw failure
        if (failure) { status = failure.status ?? 400; json = failure.json ?? { ok: false, error: 'offline write rejected' } }
        else { store.defaultModel = body.defaultModel; json = { ok: true, defaultModel: store.defaultModel } }
      } else {
        unexpected.push({ url, method })
        throw new Error(`unexpected API operation: ${method} ${url}`)
      }
      return { ok: status >= 200 && status < 300, status, json: async () => json }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(`${inputComponent}\n${component}\nthis.__card = ZaiduyuAccount`, sandbox, { filename: 'client.js' })
  function render() {
    cursor = 0; dirty = false
    tree = sandbox.__card()
    const pending = effects; effects = []
    pending.forEach((effect) => effect())
    return tree
  }
  async function flush() {
    for (let i = 0; i < 30; i += 1) { await Promise.resolve(); if (dirty) render() }
    return tree
  }
  function nodes() {
    const out = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      out.push(node)
      ;(node.kids ?? []).forEach(walk)
    }
    walk(tree)
    return out
  }
  const textOf = (node) => typeof node === 'string' ? node : (node?.kids ?? []).map(textOf).join('')
  function button(label) {
    const node = nodes().find((n) => n.tag === 'button' && textOf(n) === label)
    assert.ok(node, `button exists: ${label}`)
    return node
  }
  function select() {
    const node = nodes().find((n) => n.tag === 'select' && n.props['aria-label'] === '章鱼默认生图模型')
    assert.ok(node, 'default model selector exists')
    return node
  }
  render()
  return {
    calls, store, unexpected, flush, nodes, button, select, text: () => textOf(tree),
    failWith: (value) => { failure = value },
    async click(label) { const b = button(label); assert.equal(Boolean(b.props.disabled), false, `button enabled: ${label}`); b.props.onClick(); await flush() },
    async choose(value) { select().props.onChange({ target: { value } }); await flush() },
  }
}
await check('mount reads only local status, never automatic models/login/balance', async () => {
  const page = uiFixture({ defaultModel: 'offline-image-A' }); await page.flush()
  assert.deepEqual(page.calls.map((c) => `${c.method} ${c.url}`), [`GET ${API_BASE}/zaiduyu`])
  assert.deepEqual(page.unexpected, [])
})
await check('saved default renders before catalogue load, without repeat asking', async () => {
  const page = uiFixture({ defaultModel: 'offline-image-A' }); await page.flush()
  assert.equal(page.select().props.value, 'offline-image-A')
  assert.match(page.text(), /无需每次|不再.*询问|不用每次/)
  assert.match(page.text(), /单次|本次/)
  assert.equal(page.nodes().find((n) => n.tag === 'input' && n.props.type === 'password').props.value, '')
})
await check('model-load callback shows cost and disabled/unknown price; never first-selects', async () => {
  const page = uiFixture(); await page.flush(); await page.click('看模型价目')
  assert.equal(page.select().props.value, '')
  const options = page.nodes().filter((n) => n.tag === 'option')
  const text = (n) => (n?.kids ?? []).join('')
  assert.match(text(options.find((n) => n.props.value === 'offline-image-B')), /5 积分\/张/)
  const disabled = options.find((n) => n.props.value === 'offline-disabled')
  assert.equal(disabled.props.disabled, true)
  assert.match(text(disabled), /未标价/); assert.match(text(disabled), /已停用/)
  assert.equal(page.calls.filter((c) => c.url.endsWith('/models')).length, 1)
})
await check('real choose/save callbacks post only defaultModel and survive remount', async () => {
  const page = uiFixture({ defaultModel: 'offline-image-A' }); await page.flush(); await page.click('看模型价目')
  await page.choose('offline-image-B'); await page.click('保存默认模型')
  const writes = page.calls.filter((c) => c.url.endsWith('/settings'))
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].body, { defaultModel: 'offline-image-B' })
  assert.equal(page.store.defaultModel, 'offline-image-B')
  assert.match(page.text(), /已保存默认模型.*offline-image-B/); assert.deepEqual(page.unexpected, [])
  const remount = uiFixture({ defaultModel: page.store.defaultModel }); await remount.flush()
  assert.equal(remount.select().props.value, 'offline-image-B')
})
await check('save callback uses latest draft after rerender, not stale closure', async () => {
  const page = uiFixture({ defaultModel: 'offline-image-A' }); await page.flush(); await page.click('看模型价目')
  await page.choose('offline-image-B'); await page.choose('offline-image-A'); await page.choose('offline-image-B')
  await page.click('保存默认模型')
  assert.equal(page.calls.find((c) => c.url.endsWith('/settings')).body.defaultModel, 'offline-image-B')
})
await check('missing saved catalogue ID is retained, never silently replaced', async () => {
  const page = uiFixture({ defaultModel: 'offline-retired' }); await page.flush(); await page.click('看模型价目')
  assert.equal(page.select().props.value, 'offline-retired')
  assert.ok(page.nodes().some((n) => n.tag === 'option' && n.props.value === 'offline-retired'))
  assert.match(page.text(), /未在.*价目|价目.*未.*找到/); assert.match(page.text(), /不会自动/)
  assert.equal(page.calls.filter((c) => c.url.endsWith('/settings')).length, 0)
})
await check('empty catalogue never invents a default', async () => {
  const page = uiFixture({ models: [] }); await page.flush(); await page.click('看模型价目')
  assert.equal(page.select().props.value, '')
  assert.equal(Boolean(page.button('保存默认模型').props.disabled), true)
})
for (const [name, failure] of [
  ['rejected write', { status: 400 }], ['network error', new Error('offline transport failure')],
  ['HTTP failure claiming ok', { status: 500, json: { ok: true, defaultModel: 'offline-image-B' } }],
]) {
  await check(`${name} retains draft and old model without false saved state`, async () => {
    const page = uiFixture({ defaultModel: 'offline-image-A' }); await page.flush(); await page.click('看模型价目')
    await page.choose('offline-image-B'); page.failWith(failure); await page.click('保存默认模型')
    assert.equal(page.select().props.value, 'offline-image-B'); assert.equal(page.store.defaultModel, 'offline-image-A')
    assert.match(page.text(), /失败/); assert.doesNotMatch(page.text(), /已保存默认模型.*offline-image-B/)
  })
}
await check('clear-default callback writes only empty preference, never logout/delete', async () => {
  const page = uiFixture({ defaultModel: 'offline-image-A' }); await page.flush()
  await page.choose(''); await page.click('保存默认模型')
  assert.deepEqual(page.calls.find((c) => c.url.endsWith('/settings')).body, { defaultModel: '' })
  assert.equal(page.store.defaultModel, ''); assert.match(page.text(), /默认模型已清空|已清空默认模型/)
  assert.deepEqual(page.unexpected, [])
  assert.equal(page.calls.filter((c) => c.method === 'POST' && c.url === `${API_BASE}/zaiduyu`).length, 0)
})
await check('model save preserves typed account draft and works with env credentials', async () => {
  const page = uiFixture({ defaultModel: 'offline-image-A', source: 'env' }); await page.flush()
  page.nodes().find((n) => n.tag === 'input' && n.props.type === 'text').props.onChange({ target: { value: 'offline-typed-account' } })
  await page.flush(); await page.click('看模型价目'); await page.choose('offline-image-B'); await page.click('保存默认模型')
  assert.equal(page.nodes().find((n) => n.tag === 'input' && n.props.type === 'text').props.value, 'offline-typed-account')
  assert.deepEqual(page.calls.find((c) => c.url.endsWith('/settings')).body, { defaultModel: 'offline-image-B' })
  assert.deepEqual(page.unexpected, [])
})
console.log(`\nResult: ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
