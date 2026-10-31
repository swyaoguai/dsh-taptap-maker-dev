import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Same opt-in and existing Python Playwright installation as ui-workbench.test.mjs:
// UI_WORKBENCH_BROWSER=1 node --test tests/ui-theme-regression.test.mjs
// No HTTP server, persistent browser profile, npm/Python install, live UI API, or
// workspace writes. tempfile artifacts (including source snapshots) are retained.
if (process.env.UI_WORKBENCH_BROWSER === '1') {
  test('Chromium: owned readable palettes follow explicit host theme, color-scheme, then OS despite broken DSH tokens', { timeout: 90000 }, () => {
    const script = String.raw`
import hashlib, json, os, tempfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

root = Path(os.environ['UI_WORKBENCH_TEST_ROOT'])
base = 'http://ui-theme-regression.test'
api = '/api/taptap-maker-dev/ui'
artifacts = Path(tempfile.mkdtemp(prefix='ui-theme-regression-'))
source_dir = artifacts / 'source'
source_dir.mkdir()
# Freeze the real sources once: concurrent production edits cannot change a run.
mapping = {
    api + '/workbench': ('src/ui-workbench.html', 'text/html'),
    api + '/workbench.css': ('src/ui-workbench.css', 'text/css'),
    api + '/workbench.mjs': ('src/ui-workbench.mjs', 'text/javascript'),
    api + '/document.mjs': ('src/ui-document.mjs', 'text/javascript'),
}
sources = {}
hashes = {}
for path, (name, kind) in mapping.items():
    content = (root / name).read_text(encoding='utf-8')
    sources[path] = (content, kind)
    (source_dir / Path(name).name).write_text(content, encoding='utf-8')
    hashes[name] = hashlib.sha256(content.encode('utf-8')).hexdigest()

# A light declaration over a dark outer shell reproduces the screenshot bug:
# a white surface/input token, no --dsh-text token, and inherited light fallback
# text must NOT be mixed into the workbench's independently paired light palette.
broken_tokens = {
    '--dsh-bg': '#ffffff', '--dsh-surface': '#ffffff',
    '--dsh-input-bg': '#ffffff', '--dsh-code-bg': '#ffffff',
    '--dsh-border': '#fafafa', '--dsh-accent': '#f7f8fa',
    '--dsh-success': '#f6f7f9', '--dsh-warn': '#f6f7f9', '--dsh-danger': '#f9fafb',
}
scenarios = [
    dict(name='screenshot-broken-light', expected='light', marker='light', scheme='light', shell='dark', os='dark', tokens=broken_tokens),
    dict(name='light-clean', expected='light', marker='light', scheme='light', shell='light', os='dark', tokens={}),
    dict(name='dark-clean', expected='dark', marker='dark', scheme='dark', shell='dark', os='light', tokens={}),
    dict(name='dark-broken-input', expected='dark', marker='dark', scheme='dark', shell='dark', os='light', tokens=broken_tokens),
    dict(name='computed-light', expected='light', marker=None, scheme='light', shell='dark', os='dark', tokens={}),
    dict(name='computed-dark', expected='dark', marker=None, scheme='dark', shell='light', os='light', tokens={}),
    dict(name='os-light', expected='light', marker=None, scheme='normal', shell='dark', os='light', tokens={}),
    dict(name='os-dark', expected='dark', marker=None, scheme='normal', shell='light', os='dark', tokens={}),
]

def host_html(scenario):
    marker = ' data-theme="' + scenario['marker'] + '"' if scenario['marker'] else ''
    # --dsh-text deliberately absent: the incomplete host uses pale fallback text.
    foreground = '#e4ebea' if scenario['shell'] == 'dark' else '#233b37'
    background = '#17171c' if scenario['shell'] == 'dark' else '#f3f5f4'
    tokens = ';'.join(key + ':' + value for key, value in scenario['tokens'].items())
    return '<!doctype html><html lang="zh-CN"' + marker + '><head><style>' + (
        ':root{color-scheme:' + scenario['scheme'] + ';' + tokens + '}'
        'html,body{margin:0;background:' + background + ';color:var(--dsh-text,' + foreground + ')}'
        'iframe{display:block;width:100%;height:1200px;border:0;background:transparent;color:inherit}'
    ) + '</style></head><body><iframe title="Mock host UI workbench" src="' + api + '/workbench"></iframe></body></html>'

# This evaluates actual rendered editor text, not CSS source regexes. Composite
# each transparent background and opacity group up to the canvas (including
# disabled opacity and ::placeholder opacity); WCAG uses linear sRGB luminance.
# Decorative aria-hidden text and the independently authored game preview are
# excluded, NOT hint text, read-only values, or actionable hidden-node tree text.
measure = r'''() => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  function color(value) {
    const rgb = /^rgba?\((.*)\)$/.exec(value);
    if (rgb) {
      const numbers = rgb[1].match(/[\d.+-]+%?/g).map((part, index) => part.endsWith('%') ? parseFloat(part) * (index === 3 ? .01 : 2.55) : Number(part));
      return [numbers[0], numbers[1], numbers[2], numbers[3] ?? 1];
    }
    const srgb = /^color\(srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)(?:\s*\/\s*([\d.e+-]+))?\)$/.exec(value);
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, Number(srgb[4] ?? 1)];
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
    const pixel = [...ctx.getImageData(0, 0, 1, 1).data]; return [...pixel.slice(0, 3), pixel[3] / 255];
  }
  function over(front, back) {
    const alpha = front[3] + back[3] * (1 - front[3]);
    return alpha ? [0, 1, 2].map(i => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha).concat(alpha) : [0, 0, 0, 0];
  }
  function pixel(element, foreground = null) {
    let result = foreground ?? [0, 0, 0, 0];
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      result = over(result, color(style.backgroundColor));
      result[3] *= Number(style.opacity);
    }
    return over(result, [255, 255, 255, 1]);
  }
  function luminance(rgb) {
    const linear = rgb.slice(0, 3).map(channel => {
      const c = channel / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    });
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  }
  function key(element) {
    if (element.id) return '#' + element.id;
    if (element.dataset.treeId) return '[data-tree-id="' + element.dataset.treeId + '"]';
    const parent = element.parentElement;
    const name = element.tagName.toLowerCase() + (element.className ? '.' + String(element.className).trim().split(/\s+/).join('.') : '');
    return (parent ? key(parent) + ' > ' : '') + name + (parent ? ':nth-child(' + ([...parent.children].indexOf(element) + 1) + ')' : '');
  }
  const editor = document.querySelector('#ui-workbench'); const samples = [];
  function eligible(element) {
    if (!element.getClientRects().length || getComputedStyle(element).visibility !== 'visible' ||
        element.closest('[aria-hidden="true"], #preview-host, #safe-area-overlay, .workbench-mark, .separator')) return false;
    // Chromium may report boxes for descendants suppressed by closed details.
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === 'DETAILS' && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(element)) return false;
    }
    return true;
  }
  function sample(element, text, pseudo = null) {
    if (!eligible(element) || !text.trim()) return;
    const style = getComputedStyle(element, pseudo);
    const ink = color(style.webkitTextFillColor && style.webkitTextFillColor !== 'currentcolor' ? style.webkitTextFillColor : style.color);
    if (pseudo) ink[3] *= Number(style.opacity);
    const background = pixel(element); const foreground = pixel(element, ink);
    const bgL = luminance(background); const fgL = luminance(foreground);
    const disabled = Boolean(element.closest(':disabled, [aria-disabled="true"]'));
    samples.push({ selector: key(element) + (pseudo ?? ''), text: text.trim(), color: style.color,
      background: background.slice(0, 3), foreground: foreground.slice(0, 3),
      opacity: getComputedStyle(element).opacity, disabled, readonly: Boolean(element.readOnly),
      ratio: (Math.max(bgL, fgL) + .05) / (Math.min(bgL, fgL) + .05), minimum: disabled ? 3 : 4.5 });
  }
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) sample(walker.currentNode.parentElement, walker.currentNode.textContent);
  for (const element of editor.querySelectorAll('input:not([type="checkbox"]):not([type="file"]), textarea, select')) {
    const text = element.tagName === 'SELECT' ? element.selectedOptions[0]?.textContent ?? '' : element.value;
    if (text) sample(element, text);
    else if (element.placeholder) sample(element, element.placeholder, '::placeholder');
  }
  const surfaceSelectors = ['body', '#workspace-panel', '#preview-panel', '#inspector-panel', '#document-name', '#maker-project', '#node-id'];
  const surfaces = surfaceSelectors.map(selector => {
    const element = document.querySelector(selector); const bg = pixel(element);
    return { selector, background: bg.slice(0, 3), luminance: luminance(bg), color: getComputedStyle(element).color };
  });
  return { colorScheme: getComputedStyle(document.documentElement).colorScheme,
    bodyFontSize: parseFloat(getComputedStyle(document.body).fontSize), samples, surfaces,
    required: { label: samples.some(s => s.selector.includes('field-label')),
      tree: samples.some(s => s.selector.includes('tree-item-name')),
      button: samples.some(s => s.selector === '#new-demo'), input: samples.some(s => s.selector === '#document-name'),
      readonly: samples.some(s => s.readonly), hint: samples.some(s => s.selector === '#name-hint'),
      placeholder: samples.some(s => s.selector === '#maker-project::placeholder'), disabled: samples.some(s => s.disabled) } };
}'''

reports = []
failures = []
unsafe_requests = []
unexpected_requests = []
page_errors = []
summary = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        for scenario in scenarios:
            context = browser.new_context(viewport={'width': 1512, 'height': 1200}, color_scheme=scenario['os'], reduced_motion='reduce', service_workers='block')
            try:
                parent_source = host_html(scenario)
                (artifacts / (scenario['name'] + '-host.html')).write_text(parent_source, encoding='utf-8')
                def handle(route):
                    request = route.request
                    if request.method != 'GET':
                        unsafe_requests.append(request.method + ' ' + request.url); route.abort(); return
                    if not request.url.startswith(base + '/'):
                        unexpected_requests.append(request.url); route.abort(); return
                    path = urlsplit(request.url).path
                    if path == '/theme-host': route.fulfill(body=parent_source, content_type='text/html')
                    elif path in sources:
                        content, kind = sources[path]; route.fulfill(body=content, content_type=kind)
                    elif path == api + '/status':
                        route.fulfill(json={'ok': True, 'root': 'MOCK-UI-ROOT-NO-FILESYSTEM', 'sourceAudit': {'ok': True, 'license': 'MIT', 'commit': 'mock-audit', 'parser': 'mock'}, 'maker': {'available': False}, 'workspaces': []})
                    elif path == api + '/workspaces': route.fulfill(json={'ok': True, 'workspaces': []})
                    elif path == '/favicon.ico': route.fulfill(status=204)
                    else: unexpected_requests.append(request.url); route.abort()
                context.route('**/*', handle)
                page = context.new_page()
                page.on('pageerror', lambda error: page_errors.append(str(error)))
                page.goto(base + '/theme-host')
                frame = page.frames[1]
                frame.locator('[data-ui-id="buy-potion"]').wait_for()
                frame.wait_for_function('document.querySelector("#workspace-root").textContent === "MOCK-UI-ROOT-NO-FILESYSTEM"')
                frame.wait_for_function('document.querySelector("#node-id").value.length > 0')
                page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
                report = frame.evaluate(measure)
                report['scenario'] = scenario['name']; report['expected'] = scenario['expected']
                reports.append(report)
                # One assertion list runs EVERY scenario before reporting RED.
                local = []
                if report['bodyFontSize'] < 14:
                    local.append('body font size ' + str(report['bodyFontSize']) + 'px < 14px')
                if report['colorScheme'] != scenario['expected']:
                    local.append('color-scheme=' + report['colorScheme'] + ', expected ' + scenario['expected'])
                for surface in report['surfaces']:
                    consistent = surface['luminance'] >= .5 if scenario['expected'] == 'light' else surface['luminance'] < .3
                    if not consistent:
                        local.append(surface['selector'] + ' effective background ' + str(surface['background']) + ' inconsistent with ' + scenario['expected'])
                for category, covered in report['required'].items():
                    if not covered: local.append('fixture did not measure required ' + category + ' text')
                for item in report['samples']:
                    if item['ratio'] < item['minimum']:
                        local.append(item['selector'] + ' contrast=' + format(item['ratio'], '.3f') + ' < ' + str(item['minimum']) + (' disabled' if item['disabled'] else ' non-disabled') + ' text=' + json.dumps(item['text'][:90], ensure_ascii=False))
                failures.extend(scenario['name'] + ': ' + failure for failure in local)
                summary.append(scenario['name'] + ': expected=' + scenario['expected'] + ' computed=' + report['colorScheme'] + ' body=' + str(report['bodyFontSize']) + 'px measured=' + str(len(report['samples'])) + ' failures=' + str(len(local)))
                frame.locator('body').screenshot(path=str(artifacts / (scenario['name'] + '.png')))
            finally:
                context.close()
    finally:
        browser.close()

# Behavioral proof that poison tokens cannot alter a theme's text or surfaces.
by_name = {report['scenario']: report for report in reports}
for clean_name, broken_name in [('light-clean', 'screenshot-broken-light'), ('dark-clean', 'dark-broken-input')]:
    clean = by_name[clean_name]; broken = by_name[broken_name]
    clean_colors = {item['selector']: (item['background'], item['foreground']) for item in clean['samples']}
    for item in broken['samples']:
        if item['selector'] in clean_colors and (item['background'], item['foreground']) != clean_colors[item['selector']]:
            failures.append(broken_name + ': host tokens/shell changed owned palette at ' + item['selector'])
    for left, right in zip(clean['surfaces'], broken['surfaces']):
        if left['background'] != right['background']:
            failures.append(broken_name + ': host tokens/shell changed owned background at ' + right['selector'])
if unsafe_requests: failures.append('Unexpected non-GET request(s): ' + json.dumps(unsafe_requests))
if unexpected_requests: failures.append('Unexpected route(s), aborted without network: ' + json.dumps(unexpected_requests))
if page_errors: failures.append('Browser page errors: ' + json.dumps(page_errors))
result = {'ok': not failures, 'browser': 'Chromium', 'sourceSha256': hashes, 'reports': reports, 'failures': failures,
          'unsafeRequests': unsafe_requests, 'unexpectedRequests': unexpected_requests, 'pageErrors': page_errors, 'artifacts': str(artifacts)}
(artifacts / 'contrast-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
output = '\n'.join(summary + ['ARTIFACTS=' + str(artifacts), 'FAILURES=' + str(len(failures))] + failures)
(artifacts / 'run-output.txt').write_text(output + '\n', encoding='utf-8')
print(output, flush=True)
assert not failures, 'Rendered theme/readability regression: ' + str(len(failures)) + ' failures; see ' + str(artifacts / 'contrast-report.json')
`
    const result = spawnSync(process.env.UI_WORKBENCH_TEST_PYTHON || 'python', ['-c', script], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', UI_WORKBENCH_TEST_ROOT: fileURLToPath(new URL('../', import.meta.url)) },
      encoding: 'utf8', timeout: 85000, maxBuffer: 4_000_000,
    })
    assert.equal(result.status, 0, `Chromium theme regression failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    console.log(result.stdout.trim())
  })
}
