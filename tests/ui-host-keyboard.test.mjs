import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// These adapters execute the ACTUAL registered component and its callbacks.
// They do not implement a second keyboard trap or copy the production logic.
function hub() {
  const listeners = new Map()
  return {
    listeners,
    addEventListener(type, fn) { const items = listeners.get(type) ?? new Set(); items.add(fn); listeners.set(type, items) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    dispatch(type, event) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event) },
  }
}
function keyboard(key, init = {}) {
  return { key, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...init }
}
function collect(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(node => collect(node, predicate))]
}
function actualHost({ dirty = true } = {}) {
  const registered = []; const effects = []; const stateWrites = []; const confirmations = []
  const hostDocument = { ...hub() }
  const outer = { ...hub(), document: hostDocument, confirm: message => { confirmations.push(message); return false } }
  const React = {
    Component: class {}, Fragment: Symbol('React.Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [true, value => stateWrites.push(value)],
    useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => effects.push(fn), useRef: initial => ({ current: initial }),
  }
  outer.__ModuleLoader__ = { load({ factory }) {
    factory(name => { assert.equal(name, 'react'); return React }).apply({ slots: {
      inject: (_name, fn) => fn(), register: (meta, component) => registered.push({ meta, component }),
    } })
  } }
  vm.runInNewContext(client, {
    window: outer, document: hostDocument, console,
    fetch: () => { throw new Error('Keyboard lifecycle tests must not use an API or provider') },
  })
  const entry = registered.find(item => item.meta.id === 'taptap-maker-dev-ui')
  assert.ok(entry, 'Test the registered UI dock, not copied layout/control logic')
  const tree = entry.component()
  const frame = collect(tree, node => node.type === 'iframe')[0]
  const dialog = collect(tree, node => node.props.role === 'dialog')[0]
  const close = collect(tree, node => node.props['aria-label'] === '关闭 UI 工作台')[0]
  assert.ok(frame && dialog && close)
  const previous = { focus() { hostDocument.activeElement = this } }
  hostDocument.activeElement = previous
  const closeDom = { tagName: 'BUTTON', hidden: false, inert: false, disabled: false, tabIndex: 0, focus() { hostDocument.activeElement = this } }
  const inner = { ...hub() }
  const innerDocument = {
    getElementById: () => ({ dataset: { dirty: String(dirty) } }), querySelector: () => null,
    querySelectorAll: () => [first, middle, last], activeElement: null,
  }
  inner.document = innerDocument
  inner.getComputedStyle = () => ({ display: 'block', visibility: 'visible' })
  outer.getComputedStyle = inner.getComputedStyle
  const frameDom = { tagName: 'IFRAME', hidden: false, inert: false, contentWindow: inner, contentDocument: innerDocument, focus() { hostDocument.activeElement = this } }
  function innerControl(id) {
    return { id, tagName: 'BUTTON', hidden: false, inert: false, disabled: false, tabIndex: 0,
      ownerDocument: innerDocument, parentElement: null, getAttribute: () => null,
      getClientRects: () => [{}], matches: () => false, closest: () => null,
      focus() { hostDocument.activeElement = frameDom; innerDocument.activeElement = this },
    }
  }
  const first = innerControl('first'); const middle = innerControl('middle'); const last = innerControl('last')
  const body = { children: [], parentElement: null }; hostDocument.body = body
  const root = { parentElement: body, focus() { hostDocument.activeElement = this },
    contains: node => [root, closeDom, frameDom].includes(node), querySelectorAll: () => [closeDom, frameDom] }
  body.children = [root]
  frame.props.ref.current = frameDom; dialog.props.ref.current = root
  const cleanups = effects.map(fn => fn()).filter(fn => typeof fn === 'function')
  frame.props.onLoad()
  return { tree, frame, close, inner, innerDocument, outer, hostDocument, frameDom, closeDom, first, middle, last,
    stateWrites, confirmations, cleanup() { for (const fn of cleanups) fn() } }
}

test('Tab from the final iframe control returns to the visible host close instead of leaving the modal', () => {
  const host = actualHost({ dirty: false })
  try {
    host.last.focus()
    host.inner.dispatch('keydown', keyboard('Tab'))
    assert.equal(host.hostDocument.activeElement, host.closeDom, 'The iframe window owns this key event: its final Tab must return focus to the host close')
    assert.deepEqual(host.stateWrites, [], 'Navigation must not close or write the workbench')
  } finally { host.cleanup() }
})

test('Shift+Tab from host close enters the final iframe control, not an unfocused child body', () => {
  const host = actualHost({ dirty: false })
  try {
    host.closeDom.focus()
    host.outer.dispatch('keydown', keyboard('Tab', { shiftKey: true }))
    assert.equal(host.innerDocument.activeElement, host.last, 'Reverse wrap must target a real child control, not merely iframe.focus()')
  } finally { host.cleanup() }
})

test('iframe Escape respects defaultPrevented and denied dirty-draft consent', () => {
  const host = actualHost()
  try {
    host.inner.dispatch('keydown', keyboard('Escape', { defaultPrevented: true }))
    assert.equal(host.confirmations.length, 0, 'An inner modal that handled Escape has priority over host close')
    host.inner.dispatch('keydown', keyboard('Escape'))
    assert.equal(host.confirmations.length, 1)
    assert.deepEqual(host.stateWrites, [], 'Denied consent must leave the iframe mounted')
  } finally { host.cleanup() }
})

test('onLoad removes the old iframe listener, tolerates a cleared ref, and open-effect cleanup removes the new listener', () => {
  const host = actualHost()
  const second = hub()
  assert.equal(host.inner.listeners.get('keydown')?.size, 1)
  host.frame.props.ref.current = { contentWindow: second, contentDocument: host.innerDocument }
  host.frame.props.onLoad()
  assert.equal(host.inner.listeners.get('keydown')?.size, 0, 'Do not leave the old iframe window attached')
  assert.equal(second.listeners.get('keydown')?.size, 1)
  host.frame.props.onLoad()
  assert.equal(second.listeners.get('keydown')?.size, 1, 'Repeated load must not multiply listeners')
  host.cleanup()
  assert.equal(second.listeners.get('keydown')?.size, 0, 'Closing/unmounting removes the current iframe listener')
  host.frame.props.ref.current = null
  assert.doesNotThrow(() => host.frame.props.onLoad())
  assert.equal(second.listeners.get('keydown')?.size, 0)
})

// Opt-in uses only an ALREADY installed Python/Playwright/Chromium.
// UI_WORKBENCH_BROWSER=1 node --test tests/ui-host-keyboard.test.mjs
// A fresh browser visits a synthetic .invalid origin; every request is mocked.
// The actual client and actual iframe modules run. No server/live GUI/game,
// credentials, downloads, provider calls, test deletion or existing-file writes.
if (process.env.UI_WORKBENCH_BROWSER === '1') {
  test('offline Chromium verifies real cross-frame Tab, modal Escape priority, and pending inspector draft close', { timeout: 60_000 }, () => {
    const script = String.raw`
import hashlib, json, os, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
root = Path(os.environ['UI_HOST_KEYBOARD_ROOT'])
base = 'http://ui-host-keyboard.invalid'
api = '/api/taptap-maker-dev/ui'
artifacts = Path(tempfile.mkdtemp(prefix='ui-host-keyboard-'))
client_bytes = (root / 'client.js').read_bytes()
client = client_bytes.decode('utf-8')
assets = {
    api + '/workbench': ('ui-workbench.html', 'text/html'),
    api + '/workbench.css': ('ui-workbench.css', 'text/css'),
    api + '/workbench.mjs': ('ui-workbench.mjs', 'text/javascript'),
    api + '/document.mjs': ('ui-document.mjs', 'text/javascript'),
}
requests = []; records = []; failures = []; revision = 0

def handle(route):
    global revision
    url = route.request.url
    if not url.startswith(base + '/'):
        route.abort(); return
    path = url[len(base):].split('?')[0]
    requests.append({'path': path, 'method': route.request.method})
    if path == '/':
        route.fulfill(body='<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font:14px/1.4 sans-serif}</style></head><body><button id="outside">Outside host background</button><div id="mount"></div></body></html>', content_type='text/html')
        return
    if path in assets:
        name, kind = assets[path]
        route.fulfill(body=(root / 'src' / name).read_text(encoding='utf-8'), content_type=kind)
        return
    if path == api + '/status':
        route.fulfill(json={'ok': True, 'root': 'mock-ui-root', 'sourceAudit': {'ok': True, 'license': 'MIT'}, 'maker': {'available': False}})
        return
    if path == api + '/workspaces' and route.request.method == 'GET':
        route.fulfill(json={'ok': True, 'workspaces': []})
        return
    if path == api + '/workspaces' and route.request.method == 'POST':
        revision += 1
        route.fulfill(json={'ok': True, 'workspaceId': 'ui-keyboard', 'revisionId': 'rev-' + str(revision)})
        return
    route.abort()

# Render the real registered component into real DOM and flush its actual
# useEffect callbacks after refs are assigned. The fake React supplies hooks,
# not keyboard/focus/draft logic. The child uses the unmodified real HTML/JS.
harness = r'''(() => {
  const registered = [], effects = [];
  window.__stateWrites = []; window.__confirmations = []; window.__loads = 0; window.__cleanups = [];
  window.confirm = message => { window.__confirmations.push(message); return false; };
  const React = {
    Component: class {}, Fragment: Symbol('React.Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: () => [true, value => window.__stateWrites.push(value)],
    useMemo: fn => fn(), useCallback: fn => fn, useEffect: fn => effects.push(fn), useRef: initial => ({ current: initial })
  };
  window.__ModuleLoader__ = { load({ factory }) {
    factory(name => { if (name !== 'react') throw Error('Unexpected module ' + name); return React; }).apply({ slots: {
      inject: (_name, fn) => fn(), register: (meta, component) => registered.push({ meta, component })
    } });
  } };
  window.__mountActual = () => {
    const entry = registered.find(item => item.meta.id === 'taptap-maker-dev-ui');
    if (!entry) throw Error('Actual UI dock is not registered');
    const tree = entry.component();
    const unitless = new Set(['flex', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight', 'zIndex', 'opacity', 'order']);
    function mount(node) {
      if (node == null || typeof node === 'boolean') return document.createDocumentFragment();
      if (typeof node !== 'object') return document.createTextNode(String(node));
      const el = typeof node.type === 'symbol' ? document.createDocumentFragment() : document.createElement(node.type);
      for (const [name, value] of Object.entries(node.props)) {
        if (name === 'ref') value.current = el;
        else if (name === 'style') {
          for (const [key, raw] of Object.entries(value)) el.style[key] = typeof raw === 'number' && raw !== 0 && !unitless.has(key) ? raw + 'px' : String(raw);
        } else if (name.startsWith('on')) {
          const type = name.slice(2).toLowerCase();
          el.addEventListener(type, event => { if (type === 'load') window.__loads++; value(event); });
        } else if (name === 'tabIndex') el.setAttribute('tabindex', value);
        else if (name === 'className') el.className = value;
        else el.setAttribute(name, value);
      }
      for (const child of node.children.flat(Infinity)) el.append(mount(child));
      return el;
    }
    document.getElementById('mount').append(mount(tree));
    document.querySelector('#mount > button').focus();
    for (const effect of effects) { const cleanup = effect(); if (typeof cleanup === 'function') window.__cleanups.push(cleanup); }
  };
})()'''

def require(condition, message):
    if not condition: failures.append(message)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1512, 'height': 920}, reduced_motion='reduce')
    context.route('**/*', handle)
    errors = []
    def open_host():
        page = context.new_page(); page.set_default_timeout(10_000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base + '/')
        page.add_script_tag(content=harness); page.add_script_tag(content=client)
        page.evaluate('window.__mountActual()')
        page.wait_for_function('window.__loads === 1')
        child = page.frame_locator('iframe')
        child.locator('[data-ui-id="title"]').wait_for()
        if child.locator('#guide-skip').is_visible(): child.locator('#guide-skip').click()
        return page, child
    def focus_state(page):
        return page.evaluate(r'''() => {
          const frame = document.querySelector('iframe'), active = document.activeElement, inner = frame.contentDocument.activeElement;
          return { outerTag: active.tagName, outerClose: active === document.querySelector('[role="dialog"] button'),
            outerIsFrame: active === frame, innerId: inner.id, innerTag: inner.tagName,
            innerLast: inner.matches('details.report-details > summary'), hasFocus: document.hasFocus(),
            stateWrites: window.__stateWrites.slice(), confirmations: window.__confirmations.length };
        }''')
    def record(page, case, before=None):
        state = focus_state(page); records.append({'case': case, 'before': before, 'after': state})
        page.screenshot(path=str(artifacts / (case + '.png')))
        return state

    page, child = open_host()
    child.locator('details.report-details > summary').focus()
    before = focus_state(page); page.keyboard.press('Tab')
    state = record(page, 'forward-final-iframe-tab', before)
    require(state['outerClose'] and state['hasFocus'], 'Final iframe Tab must focus host close immediately, not BODY/browser chrome: ' + json.dumps(state))
    page.close()

    page, child = open_host()
    page.locator('[role="dialog"] button').focus()
    before = focus_state(page); page.keyboard.press('Shift+Tab')
    state = record(page, 'reverse-host-close-tab', before)
    require(state['outerIsFrame'] and state['innerLast'], 'Host close Shift+Tab must enter final child control, not merely iframe body: ' + json.dumps(state))
    page.close()

    page, child = open_host()
    child.locator('#mode-interact').click(); child.locator('[data-ui-id="bag-button"]').click()
    page.keyboard.press('Escape')
    state = record(page, 'inner-modal-escape-priority')
    require(child.locator('[data-ui-id="bag-modal"]').is_hidden() and not state['stateWrites'] and state['confirmations'] == 0, 'Inner modal Escape must not close the host')
    page.evaluate(r'''() => { const inner = document.querySelector('iframe').contentWindow;
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      event.preventDefault(); inner.dispatchEvent(event); }''')
    require(focus_state(page)['confirmations'] == 0, 'A defaultPrevented inner Escape must remain handled by the child')
    page.evaluate('document.querySelector("iframe").contentWindow.location.reload()')
    page.wait_for_function('window.__loads === 2')
    child.locator('[data-ui-id="title"]').wait_for()
    if child.locator('#guide-skip').is_visible(): child.locator('#guide-skip').click()
    child.locator('#property-text').focus(); page.keyboard.press('Escape')
    state = record(page, 'escape-after-iframe-reload')
    require(state['confirmations'] == 1 and not state['stateWrites'], 'Reload must bind the new iframe Escape exactly once and retain denied draft')
    page.close()

    page, child = open_host()
    child.locator('[data-ui-id="title"]').click(); child.locator('#save-workspace').click()
    child.locator('#draft-status[data-dirty="false"]').wait_for()
    child.locator('#property-x').fill('70')
    pending = child.locator('#property-x').evaluate('(el) => ({value:el.value, invalid:el.getAttribute("aria-invalid"), dirty:document.querySelector("#draft-status").dataset.dirty})')
    page.keyboard.press('Escape')
    state = record(page, 'pending-inspector-input-escape', pending)
    require(state['confirmations'] == 1 and not state['stateWrites'], 'Typed inspector input must be protected before blur/change; denied Escape must retain the draft: ' + json.dumps(state))
    page.close()

    require(not errors, 'Unexpected page errors: ' + json.dumps(errors))
    version = browser.version
    context.close(); browser.close()
report = {'artifacts': str(artifacts), 'sourceSha256': hashlib.sha256(client_bytes).hexdigest(),
          'browserVersion': version, 'records': records, 'failures': failures, 'requests': requests,
          'isolation': 'actual registered host and actual child modules; synthetic .invalid origin; all requests mocked; no server/live GUI/game/native verification'}
(artifacts / 'keyboard.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=True))
`
    const result = spawnSync(process.env.UI_WORKBENCH_TEST_PYTHON || 'python', ['-c', script], {
      env: { ...process.env, UI_HOST_KEYBOARD_ROOT: fileURLToPath(new URL('../', import.meta.url)) },
      encoding: 'utf8', timeout: 55_000, maxBuffer: 1_000_000,
    })
    assert.equal(result.status, 0, `Existing offline Python Playwright must execute before business assertions: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    const report = JSON.parse(result.stdout.trim())
    console.log(`UI_HOST_KEYBOARD_EVIDENCE=${report.artifacts}`)
    assert.deepEqual(report.failures, [], `Actual host keyboard/draft regressions (${report.sourceSha256}; evidence: ${report.artifacts}):\n${report.failures.join('\n')}`)
  })
}
