import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Opt-in: UI_WORKBENCH_BROWSER=1 node --test tests/ui-guide-theme-browser.test.mjs
// Existing Python Playwright + fresh Chromium contexts only. All HTTP is mocked
// under a virtual test hostname; no live GUI, server, user profile, providers,
// credentials, game access, dependency installation or artifact deletion.
// Each independent test freezes real UI sources and retains new tempfile evidence.
const browserEnabled = process.env.UI_WORKBENCH_BROWSER === '1'
const pythonPrelude = String.raw`
import hashlib, json, os, tempfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

root = Path(os.environ['UI_GUIDE_THEME_TEST_ROOT'])
artifacts = Path(tempfile.mkdtemp(prefix='ui-guide-theme-browser-'))
source_dir = artifacts / 'source'
source_dir.mkdir()
base = 'http://ui-guide-theme-browser.test'
api = '/api/taptap-maker-dev/ui'
key = 'taptap-maker-dev.ui-onboarding.v1'
sources = {}
hashes = {}
for path, name, mime in [
    (api + '/workbench', 'src/ui-workbench.html', 'text/html'),
    (api + '/workbench.css', 'src/ui-workbench.css', 'text/css'),
    (api + '/workbench.mjs', 'src/ui-workbench.mjs', 'text/javascript'),
    (api + '/document.mjs', 'src/ui-document.mjs', 'text/javascript'),
]:
    content = (root / name).read_text(encoding='utf-8')
    sources[path] = (content, mime)
    hashes[name] = hashlib.sha256(content.encode('utf-8')).hexdigest()
    with (source_dir / Path(name).name).open('x', encoding='utf-8') as file:
        file.write(content)
failures = []
unsafe_requests = []
unexpected_requests = []
page_errors = []
observations = {}

def check(condition, message):
    if not condition:
        failures.append(message)

def new_page(browser, host=None, init=None):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, color_scheme='dark', reduced_motion='reduce', service_workers='block')
    def handle(route):
        request = route.request
        if request.method != 'GET':
            unsafe_requests.append(request.method + ' ' + request.url)
            route.abort()
            return
        if not request.url.startswith(base + '/'):
            unexpected_requests.append(request.url)
            route.abort()
            return
        path = urlsplit(request.url).path
        if path == '/host' and host is not None:
            route.fulfill(body=host, content_type='text/html')
        elif path in sources:
            content, mime = sources[path]
            route.fulfill(body=content, content_type=mime)
        elif path == api + '/status':
            route.fulfill(json={'ok': True, 'root': 'MOCK-NO-FILESYSTEM', 'sourceAudit': {'ok': True, 'license': 'MIT'}, 'maker': {'available': False}, 'workspaces': []})
        elif path == api + '/workspaces':
            route.fulfill(json={'ok': True, 'workspaces': []})
        elif path == '/favicon.ico':
            route.fulfill(status=204)
        else:
            unexpected_requests.append(request.url)
            route.abort()
    context.route('**/*', handle)
    if init:
        context.add_init_script(init)
    page = context.new_page()
    page.set_default_timeout(10000)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.goto(base + ('/host' if host is not None else api + '/workbench'))
    frame = page.frames[1] if host is not None else page
    frame.locator('[data-ui-id="buy-potion"]').wait_for()
    frame.wait_for_function('document.querySelector("#workspace-root").textContent === "MOCK-NO-FILESYSTEM"')
    return context, page, frame

def paint(page):
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')

def focus(page):
    return page.evaluate('() => ({id: document.activeElement.id, tag: document.activeElement.tagName, uiId: document.activeElement.dataset.uiId ?? null})')

def finish():
    if unsafe_requests:
        failures.append('Non-GET request(s), aborted: ' + json.dumps(unsafe_requests))
    if unexpected_requests:
        failures.append('Unexpected request(s), aborted without network: ' + json.dumps(unexpected_requests))
    if page_errors:
        failures.append('Browser page errors: ' + json.dumps(page_errors))
    result = {'ok': not failures, 'sourceSha256': hashes, 'observations': observations, 'failures': failures,
              'unsafeRequests': unsafe_requests, 'unexpectedRequests': unexpected_requests, 'pageErrors': page_errors, 'artifacts': str(artifacts)}
    with (artifacts / 'report.json').open('x', encoding='utf-8') as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    assert not failures, '\n'.join(failures) + '\nARTIFACTS=' + str(artifacts)
`

function runBrowser(script) {
  const result = spawnSync(process.env.UI_WORKBENCH_TEST_PYTHON || 'python', ['-c', pythonPrelude + script], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', UI_GUIDE_THEME_TEST_ROOT: fileURLToPath(new URL('../', import.meta.url)) },
    encoding: 'utf8', timeout: 85000, maxBuffer: 4_000_000,
  })
  assert.equal(result.status, 0, `Isolated Chromium regression failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  console.log(result.stdout.trim())
}

test('Chromium: iframe theme updates on actual ancestor markers, classes and iframe style mutations', { skip: !browserEnabled, timeout: 90000 }, () => {
  runBrowser(String.raw`
cases = [
    ('ancestor-data-theme', 'data-theme="light"', '', 'document.querySelector("#theme-wrapper").dataset.theme = "dark"'),
    ('ancestor-data-color-scheme', 'data-color-scheme="light"', '', 'document.querySelector("#theme-wrapper").dataset.colorScheme = "dark"'),
    ('ancestor-computed-class', 'class="theme-light"', '', 'document.querySelector("#theme-wrapper").className = "theme-dark"'),
    ('iframe-computed-style', '', 'style="color-scheme:light"', 'document.querySelector("iframe").style.colorScheme = "dark"'),
]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        for name, wrapper_attrs, iframe_attrs, mutation in cases:
            host = '<!doctype html><html><head><style>:root{color-scheme:normal}.theme-light{color-scheme:light}.theme-dark{color-scheme:dark}iframe{height:1200px;width:100%;border:0}</style></head><body><section id="theme-wrapper" ' + wrapper_attrs + '><iframe ' + iframe_attrs + ' src="' + api + '/workbench"></iframe></section></body></html>'
            context, page, frame = new_page(browser, host=host)
            try:
                initial = frame.evaluate('({theme: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme})')
                check(initial == {'theme': 'light', 'scheme': 'light'}, name + ': fixture must initially follow host light over OS dark: ' + json.dumps(initial))
                page.evaluate(mutation)
                paint(page)
                after = frame.evaluate('({theme: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme})')
                observations[name] = {'initial': initial, 'afterHostMutation': after, 'expected': 'dark'}
                check(after == {'theme': 'dark', 'scheme': 'dark'}, name + ': actual host-only mutation must update paired workbench theme to dark, got ' + json.dumps(after))
            finally:
                context.close()
    finally:
        browser.close()
finish()
`)
})

test('Chromium: guide Back keeps focus, modal dismissal preserves outside focus and persistence feedback recovers', { skip: !browserEnabled, timeout: 90000 }, () => {
  runBrowser(String.raw`
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        context, page, frame = new_page(browser)
        try:
            check(page.locator('#onboarding-guide').is_visible(), 'First-use guide must be visible')
            page.locator('#guide-next').click()
            page.locator('#guide-back').focus()
            page.keyboard.press('Enter')
            after_back = focus(page)
            observations['backToFirstStep'] = {'focus': after_back, 'step': page.locator('#guide-progress').inner_text(), 'backDisabled': page.locator('#guide-back').is_disabled()}
            check(page.locator('#guide-progress').inner_text() == '1 / 4', 'Back must return to first step')
            check(page.locator('#guide-back').is_disabled(), 'First-step Back must stay disabled')
            check(after_back['id'] == 'guide-next', 'Disabling the focused Back must move focus to enabled guide-next, not ' + json.dumps(after_back))
            page.locator('#guide-skip').click()
            check(page.locator('#onboarding-guide').is_hidden(), 'Skip must hide guide')
            check(page.locator('#onboarding-guide button:visible').count() == 0, 'Hidden guide must expose no rendered buttons')
            check(focus(page)['id'] == 'show-guide', 'Skip must restore guide opener focus')
            page.locator('#mode-interact').click()
            page.locator('[data-ui-id="bag-button"]').click()
            check(page.locator('[data-ui-id="bag-modal"]').is_visible(), 'Fixture must open preview modal')
            page.locator('#show-guide').click()
            check(focus(page)['id'] == 'guide-next', 'Guide replay must deliberately focus guide-next outside preview')
            page.keyboard.press('Escape')
            after_escape = focus(page)
            observations['modalDismissalWithGuideFocus'] = {'focus': after_escape, 'guideVisible': page.locator('#onboarding-guide').is_visible(), 'modalVisible': page.locator('[data-ui-id="bag-modal"]').is_visible()}
            # Preserve the existing modal-first policy; the regression is stealing
            # focus already deliberately placed OUTSIDE the preview/modal.
            check(page.locator('[data-ui-id="bag-modal"]').is_hidden(), 'Existing modal-first Escape must dismiss preview modal')
            check(page.locator('#onboarding-guide').is_visible(), 'Modal-first Escape must leave guide available')
            check(after_escape['id'] == 'guide-next', 'Closing preview modal must not steal external guide focus: ' + json.dumps(after_escape))
        finally:
            context.close()

        transient_storage = '''window.__blockGuideWrites = true;
const originalSet = Storage.prototype.setItem;
Storage.prototype.setItem = function(key, value) {
  if (key === 'taptap-maker-dev.ui-onboarding.v1' && window.__blockGuideWrites) throw new DOMException('isolated quota', 'QuotaExceededError');
  return originalSet.call(this, key, value);
};'''
        context, page, frame = new_page(browser, init=transient_storage)
        try:
            page.locator('#guide-skip').click()
            check(page.locator('#guide-memory-note').is_visible(), 'A first failed preference write must show feedback')
            check(page.evaluate('(key) => localStorage.getItem(key)', key) is None, 'Failed write must not claim a stored preference')
            page.evaluate('window.__blockGuideWrites = false')
            page.locator('#show-guide').click()
            page.locator('#guide-skip').click()
            stored = page.evaluate('(key) => localStorage.getItem(key)', key)
            note_visible = page.locator('#guide-memory-note').is_visible()
            observations['storageRecovery'] = {'stored': stored, 'failureNoteVisible': note_visible}
            check(stored == 'skipped', 'Recovered storage must persist explicit Skip')
            check(not note_visible, 'Successful preference write must hide stale storage failure feedback')
        finally:
            context.close()

        remembered_storage = '''const originalSet = Storage.prototype.setItem;
originalSet.call(localStorage, 'taptap-maker-dev.ui-onboarding.v1', 'completed');
Storage.prototype.setItem = function(key, value) {
  if (key === 'taptap-maker-dev.ui-onboarding.v1') throw new DOMException('isolated quota', 'QuotaExceededError');
  return originalSet.call(this, key, value);
};'''
        context, page, frame = new_page(browser, init=remembered_storage)
        try:
            check(page.locator('#onboarding-guide').is_hidden(), 'Existing completed preference must suppress first-use guide')
            page.locator('#show-guide').click()
            page.locator('#guide-skip').click()
            stored = page.evaluate('(key) => localStorage.getItem(key)', key)
            note_visible = page.locator('#guide-memory-note').is_visible()
            model_state = page.evaluate('''async () => {
              const wb = await import('/api/taptap-maker-dev/ui/workbench.mjs');
              const guide = wb.createOnboardingGuide({storage: localStorage});
              guide.start(); guide.skip();
              return {remembered: guide.getState().remembered, reopenedVisible: wb.createOnboardingGuide({storage: localStorage}).getState().visible};
            }''')
            observations['failedReplayKeepsExistingPreference'] = {'stored': stored, 'failureNoteVisible': note_visible, **model_state}
            check(stored == 'completed', 'Failed replay write must preserve previous completed preference')
            check(model_state['remembered'], 'Failed replay write must preserve already remembered preference state')
            check(not model_state['reopenedVisible'], 'Existing stored preference must still suppress a fresh guide')
            check(not note_visible, 'Still-remembered preference must not falsely warn that it cannot be remembered')
        finally:
            context.close()
    finally:
        browser.close()
finish()
`)
})
