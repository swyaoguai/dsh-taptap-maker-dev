import test from 'node:test'
import assert from 'node:assert/strict'
import * as workbench from '../src/ui-workbench.mjs'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const create = options => {
  assert.equal(typeof workbench.createOnboardingGuide, 'function', 'First-use guide implementation is missing')
  return workbench.createOnboardingGuide(options)
}
function storageFixture(initial) {
  const entries = new Map(initial ? [[workbench.ONBOARDING_KEY, initial]] : [])
  const writes = []
  return { writes, entries, storage: { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { writes.push([key, value]); entries.set(key, value) } } }
}

test('first-use guide starts visibly at one of four steps without writing a preference', () => {
  const { storage, writes } = storageFixture()
  const guide = create({ storage })
  assert.equal(guide.getState().visible, true)
  assert.equal(guide.getState().index, 0)
  assert.equal(guide.getState().count, 4)
  assert.deepEqual(writes, [])
})
test('step navigation is reversible, bounded and does not write a document or preference', () => {
  const { storage, writes } = storageFixture()
  const guide = create({ storage })
  guide.back(); assert.equal(guide.getState().index, 0)
  guide.next(); guide.next(); assert.equal(guide.getState().index, 2)
  guide.back(); assert.equal(guide.getState().index, 1)
  assert.deepEqual(writes, [])
})
test('only explicit completion records a scoped version preference and hides the guide', () => {
  const { storage, writes } = storageFixture()
  const guide = create({ storage })
  guide.next(); guide.next(); guide.next(); assert.equal(guide.getState().visible, true)
  guide.next(); assert.equal(guide.getState().visible, false)
  assert.deepEqual(writes, [[workbench.ONBOARDING_KEY, 'completed']])
  assert.equal(create({ storage }).getState().visible, false)
})
test('skip is explicit, remembered and never marks the document saved', () => {
  const { storage, writes } = storageFixture()
  const guide = create({ storage })
  guide.skip()
  assert.equal(guide.getState().visible, false)
  assert.deepEqual(writes, [[workbench.ONBOARDING_KEY, 'skipped']])
  assert.equal(create({ storage }).getState().visible, false)
})
test('reopening the guide does not erase the remembered preference or authored state', () => {
  const { storage, writes } = storageFixture('completed')
  const guide = create({ storage })
  guide.start()
  assert.equal(guide.getState().visible, true); assert.equal(guide.getState().index, 0)
  guide.next(); guide.dismiss()
  assert.equal(guide.getState().visible, false)
  assert.deepEqual(writes, [])
  assert.equal(create({ storage }).getState().visible, false)
})
test('Escape/session dismissal does not silently persist an incomplete tour', () => {
  const { storage, writes } = storageFixture()
  const guide = create({ storage })
  guide.dismiss(); assert.equal(guide.getState().visible, false)
  assert.deepEqual(writes, [])
  assert.equal(create({ storage }).getState().visible, true)
})
test('unavailable or blocked storage cannot prevent using or skipping the guide', () => {
  for (const storage of [undefined, { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }, { getItem: () => null, setItem() { throw new Error('quota') } }]) {
    const guide = create({ storage })
    assert.equal(guide.getState().visible, true)
    assert.doesNotThrow(() => guide.skip())
    assert.equal(guide.getState().visible, false)
    assert.equal(guide.getState().remembered, false)
  }
})
test('guide subscriptions unsubscribe exactly and steps target real workbench controls', () => {
  const guide = create({ storage: storageFixture().storage }); const states = []
  const stop = guide.subscribe(state => states.push(state))
  const before = states.length; guide.next(); assert.equal(states.length, before + 1)
  stop(); guide.back(); assert.equal(states.length, before + 1)
  const html = readFileSync(new URL('../src/ui-workbench.html', import.meta.url), 'utf8')
  for (const step of workbench.ONBOARDING_STEPS) {
    assert.match(html, new RegExp(`id="${step.target}"`))
    assert.ok(step.title && step.description)
  }
  assert.match(html, /id="show-guide"/)
  assert.match(html, /id="onboarding-guide"/)
})

// Real existing Chromium, a fresh context and mock HTTP only. No server,
// user profiles, providers, game writes or asset/test artifact cleanup.
if (process.env.UI_WORKBENCH_BROWSER === '1') {
  test('real browser first-use, skip, replay, Escape focus and completion never POST or discard a draft', { timeout: 90000 }, () => {
    const script = String.raw`
import json, os, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
root = Path(os.environ['UI_ONBOARDING_TEST_ROOT'])
artifacts = Path(tempfile.mkdtemp(prefix='ui-onboarding-'))
base = 'http://127.0.0.1:49246'
api = '/api/taptap-maker-dev/ui'
posts = []
def handle(route):
    path = route.request.url.removeprefix(base).split('?')[0]
    mapping = {'workbench': ('html','text/html'), 'workbench.css': ('css','text/css'), 'workbench.mjs': ('mjs','text/javascript'), 'document.mjs': (None,'text/javascript')}
    name = path.removeprefix(api + '/')
    if name in mapping:
        ext, mime = mapping[name]
        file = 'src/ui-document.mjs' if ext is None else 'src/ui-workbench.' + ext
        route.fulfill(body=(root/file).read_text(encoding='utf-8'), content_type=mime); return
    if route.request.method != 'GET':
        posts.append(path); route.abort(); return
    if name == 'status': result = {'ok':True,'root':'isolated mock workspace','sourceAudit':{'ok':True,'license':'MIT'},'maker':{'available':False},'workspaces':[]}
    elif name == 'workspaces': result = {'ok':True,'workspaces':[]}
    else: route.abort(); return
    route.fulfill(json=result)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width':1440,'height':1000}, color_scheme='dark', reduced_motion='reduce')
    page = context.new_page(); page.route('**/*', handle)
    errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + api + '/workbench')
    page.locator('[data-ui-id="buy-potion"]').wait_for()
    card = page.locator('#onboarding-guide')
    assert card.is_visible(), 'The first launch must offer the guide'
    assert page.locator('#guide-progress').inner_text() == '1 / 4'
    assert not posts
    page.screenshot(path=str(artifacts/'first-use-dark.png'), full_page=True)
    page.locator('#guide-next').click(); assert page.locator('#guide-progress').inner_text() == '2 / 4'
    page.locator('#guide-back').click(); assert page.locator('#guide-progress').inner_text() == '1 / 4'
    page.locator('#guide-skip').click(); assert card.is_hidden()
    page.reload(); page.locator('[data-ui-id="buy-potion"]').wait_for(); assert card.is_hidden()
    page.locator('[data-ui-id="title"]').click()
    page.locator('#property-text').fill('必须保留的现有草稿')
    page.locator('#show-guide').click(); assert card.is_visible()
    page.locator('#guide-next').focus(); page.keyboard.press('Escape')
    assert card.is_hidden()
    assert page.locator('#show-guide').evaluate('(el) => document.activeElement === el')
    assert page.locator('#property-text').input_value() == '必须保留的现有草稿'
    assert page.locator('#draft-status').get_attribute('data-dirty') == 'true'
    page.locator('#show-guide').click()
    for i in range(3): page.locator('#guide-next').click()
    assert page.locator('#guide-progress').inner_text() == '4 / 4'
    assert '保存' in page.locator('#guide-description').inner_text()
    page.locator('#guide-target').click()
    assert page.locator('#save-workspace').evaluate('(el) => document.activeElement === el'), 'Tour may focus Save but must never click it'
    assert not posts
    page.locator('#guide-next').click(); assert card.is_hidden()
    page.reload(); page.locator('[data-ui-id="buy-potion"]').wait_for(); assert card.is_hidden()
    page.set_viewport_size({'width':390,'height':844}); page.emulate_media(color_scheme='light')
    page.locator('#show-guide').click(); assert card.is_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(artifacts/'first-use-light-mobile.png'), full_page=True)
    assert not posts; assert not errors, errors
    context.close(); browser.close()
print(json.dumps({'ok':True,'artifacts':str(artifacts),'posts':posts,'evidence':'real Chromium; mock HTTP; no live GUI/native claim'},ensure_ascii=False))
`
    const result = spawnSync(process.env.UI_WORKBENCH_TEST_PYTHON || 'python', ['-c', script], {
      env: { ...process.env, UI_ONBOARDING_TEST_ROOT: fileURLToPath(new URL('../', import.meta.url)) },
      encoding: 'utf8', timeout: 85000, maxBuffer: 1_000_000,
    })
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    console.log(result.stdout.trim())
  })
}
