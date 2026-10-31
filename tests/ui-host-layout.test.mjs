import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// Exercise the actual registered component, using the React/VM approach from
// ui-plugin-wiring.test.mjs. No production exports, copied layout, or live API.
function hostWidget({ confirm = () => false } = {}) {
  const registered = []
  const stateWrites = []
  const React = {
    Component: class {},
    Fragment: Symbol('React.Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [true, value => stateWrites.push(value)],
    useMemo: fn => fn(), useCallback: fn => fn, useEffect() {},
    useRef: initial => ({ current: initial }),
  }
  const window = {
    __ModuleLoader__: { load({ factory }) {
      const plugin = factory(name => { assert.equal(name, 'react'); return React })
      plugin.apply({ slots: {
        inject: (_name, cb) => cb(),
        register: (meta, component) => registered.push({ meta, component }),
      } })
    } },
    confirm, addEventListener() {}, removeEventListener() {},
  }
  vm.runInNewContext(client, {
    window, console, document: {},
    fetch: () => { throw new Error('Host layout/close must not call an API or provider') },
  })
  const entry = registered.find(item => item.meta.id === 'taptap-maker-dev-ui')
  assert.ok(entry, 'The real UI workbench composer dock must be registered')
  const tree = entry.component()
  const dialog = collect(tree, node => node.props.role === 'dialog')[0]
  const close = collect(tree, node => node.type === 'button' && node.props['aria-label'] === '关闭 UI 工作台')[0]
  const iframe = collect(tree, node => node.type === 'iframe')[0]
  assert.ok(dialog && close && iframe, 'Render the actual open host, close button and iframe')
  return { tree, dialog, close, iframe, stateWrites }
}

function collect(tree, predicate) {
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => collect(child, predicate))]
}

function serializableDom(tree) {
  if (tree == null || typeof tree === 'boolean') return null
  if (typeof tree !== 'object') return String(tree)
  const children = (tree.children ?? []).flat(Infinity).map(serializableDom).filter(child => child !== null)
  if (typeof tree.type === 'symbol') return { tag: null, children }
  assert.equal(typeof tree.type, 'string', 'Host geometry must come from real DOM elements')
  const props = Object.fromEntries(Object.entries(tree.props).filter(([key, value]) =>
    key !== 'ref' && key !== 'key' && !key.startsWith('on') && typeof value !== 'function'))
  return { tag: tree.type, props, children }
}

test('the visible host close protects dirty, invalid and unreadable drafts without saving or discarding them', () => {
  for (const draft of ['dirty', 'invalid', 'unreadable', 'clean']) {
    for (const consent of [false, true]) {
      let confirmations = 0
      const host = hostWidget({ confirm: () => { confirmations++; return consent } })
      host.iframe.props.ref.current = draft === 'unreadable' ? {} : {
        contentDocument: {
          getElementById: () => ({ dataset: { dirty: draft === 'dirty' ? 'true' : 'false' } }),
          querySelector: () => draft === 'invalid' ? {} : null,
        },
      }
      host.close.props.onClick()
      assert.equal(confirmations, draft === 'clean' ? 0 : 1, `${draft}: ask only when necessary`)
      assert.deepEqual(host.stateWrites, draft === 'clean' || consent ? [false] : [], `${draft}: denied consent must leave the workbench open`)
    }
  }
})

// Opt-in, matching the existing workbench browser tests:
// UI_WORKBENCH_BROWSER=1 node --test tests/ui-host-layout.test.mjs
// Uses an ALREADY installed Python/Playwright/Chromium; never installs anything.
// It renders only the actual VM component tree in an isolated about:blank page.
// No HTTP server, live GUI, credentials, DSH or Maker are opened. Keep all tmp.
if (process.env.UI_WORKBENCH_BROWSER === '1') {
  test('real Chromium host geometry reserves the titlebar and keeps a left 44px close reachable at desktop and narrow sizes', { timeout: 60_000 }, () => {
    const host = hostWidget()
    const payload = {
      tree: serializableDom(host.tree),
      sourceSha256: createHash('sha256').update(client).digest('hex'),
      viewports: [{ width: 1920, height: 1232 }, { width: 1279, height: 811 }, { width: 390, height: 844 }],
    }
    const script = String.raw`
import json, os, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

payload = json.loads(os.environ['UI_HOST_LAYOUT_TREE'])
artifacts = Path(tempfile.mkdtemp(prefix='ui-host-layout-', dir=os.environ.get('UI_HOST_LAYOUT_ARTIFACT_ROOT') or None))
metrics = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(device_scale_factor=1, reduced_motion='reduce')
    context.route('**/*', lambda route: route.abort())
    for viewport in payload['viewports']:
        page = context.new_page()
        page.set_viewport_size(viewport)
        page.set_content('<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font:14px/1.4 system-ui,sans-serif;background:#101418}</style></head><body></body></html>')
        page.evaluate(r'''tree => {
          const unitless = new Set(['animationIterationCount', 'aspectRatio', 'columnCount', 'fillOpacity', 'flex', 'flexGrow', 'flexShrink', 'fontWeight', 'gridColumn', 'gridRow', 'lineHeight', 'opacity', 'order', 'scale', 'strokeOpacity', 'strokeWidth', 'zIndex', 'zoom']);
          function mount(node) {
            if (typeof node === 'string') return document.createTextNode(node);
            const el = node.tag ? document.createElement(node.tag) : document.createDocumentFragment();
            for (const [name, value] of Object.entries(node.props || {})) {
              if (name === 'style') {
                for (const [key, raw] of Object.entries(value)) {
                  const css = typeof raw === 'number' && raw !== 0 && !unitless.has(key) && !key.startsWith('--') ? raw + 'px' : String(raw);
                  if (key.startsWith('--')) el.style.setProperty(key, css); else el.style[key] = css;
                }
              } else if (name === 'className') el.setAttribute('class', value);
              else if (name === 'tabIndex') el.setAttribute('tabindex', value);
              else if (node.tag === 'iframe' && name === 'src') {
                // Only the child document is blanked; keep every host style as rendered.
                el.setAttribute('data-original-src', value);
                el.srcdoc = '<!doctype html><html><body style="margin:0;background:#141b20;color:#80958b;font:14px system-ui;padding:24px">Isolated iframe: outer host layout only; no API or native game.</body></html>';
              } else el.setAttribute(name, value);
            }
            for (const child of node.children || []) el.append(mount(child));
            return el;
          }
          document.body.append(mount(tree));
        }''', payload['tree'])
        page.locator('[role="dialog"] iframe').wait_for(state='visible')
        measured = page.evaluate(r'''() => {
          const dialog = document.querySelector('[role="dialog"]');
          const close = dialog.querySelector('button[aria-label="关闭 UI 工作台"]');
          const frame = dialog.querySelector('iframe');
          const rect = el => {
            const r = el.getBoundingClientRect();
            return {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height};
          };
          const closeRect = rect(close);
          const target = document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2);
          const computed = getComputedStyle(close);
          return {
            viewport:{width:innerWidth, height:innerHeight}, dialog:rect(dialog), close:closeRect, iframe:rect(frame),
            systemControls:{left:innerWidth - 160, top:0, right:innerWidth, bottom:48},
            closeHit:target === close || close.contains(target),
            closeVisible:computed.display !== 'none' && computed.visibility !== 'hidden' && Number(computed.opacity) > 0,
            closeStyles:{font:computed.font, padding:computed.padding, minWidth:computed.minWidth, minHeight:computed.minHeight},
            dialogInlineStyle:dialog.getAttribute('style'),
            documentScrollWidth:document.documentElement.scrollWidth,
            dialogScrollWidth:dialog.scrollWidth, dialogClientWidth:dialog.clientWidth
          };
        }''')
        metrics.append(measured)
        # Evidence guides cannot influence layout or pointer hit-testing.
        page.evaluate(r'''() => {
          for (const [label, css] of [
            ['64 CSSpx titlebar safety zone', 'left:0;right:0;top:0;height:64px;border-bottom:2px dashed #58c6b5;color:#58c6b5'],
            ['160x48 system controls', 'right:0;top:0;width:160px;height:48px;border:2px solid #ff6b6b;color:#ff6b6b;background:#e0313120']
          ]) {
            const guide = document.createElement('div');
            guide.textContent = label;
            guide.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;font:10px system-ui;' + css;
            document.body.append(guide);
          }
        }''')
        page.screenshot(path=str(artifacts / ('host-' + str(viewport['width']) + 'x' + str(viewport['height']) + '.png')))
        page.close()
    context.close()
    browser.close()
report = {'artifacts':str(artifacts), 'sourceSha256':payload['sourceSha256'], 'metrics':metrics,
          'isolation':'actual VM component styles; isolated Chromium; blank child iframe; no server/live GUI/native verification'}
(artifacts / 'geometry.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
`
    const result = spawnSync(process.env.UI_WORKBENCH_TEST_PYTHON || 'python', ['-c', script], {
      env: { ...process.env, UI_HOST_LAYOUT_TREE: JSON.stringify(payload) },
      encoding: 'utf8', timeout: 55_000, maxBuffer: 1_000_000,
    })
    assert.equal(result.status, 0, `Existing Python Playwright must execute successfully before geometry assertions: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    const report = JSON.parse(result.stdout.trim())
    console.log(`UI_HOST_LAYOUT_EVIDENCE=${report.artifacts}`)
    assert.equal(report.metrics.length, payload.viewports.length, 'Every requested viewport was measured in Chromium')
    const failures = []
    const requireGeometry = (condition, message) => { if (!condition) failures.push(message) }
    const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    for (const m of report.metrics) {
      const prefix = `${m.viewport.width}x${m.viewport.height}`
      const viewportRect = { left: 0, top: 0, right: m.viewport.width, bottom: m.viewport.height }
      requireGeometry(m.dialog.top >= 64 - 0.5, `${prefix}: host top=${m.dialog.top}px must reserve at least 64 CSSpx below the page/desktop titlebar`)
      for (const [side, margin] of [['left', m.dialog.left], ['right', m.viewport.width - m.dialog.right], ['bottom', m.viewport.height - m.dialog.bottom]]) {
        requireGeometry(margin >= 4 && margin <= 32, `${prefix}: ${side} margin=${margin}px must remain small and positive (4..32 CSSpx)`)
      }
      for (const [name, rect] of [['dialog', m.dialog], ['close', m.close], ['iframe', m.iframe]]) {
        requireGeometry(rect.width > 0 && rect.height > 0 && inside(rect, viewportRect), `${prefix}: ${name} must have positive size and stay inside the viewport: ${JSON.stringify(rect)}`)
      }
      requireGeometry(inside(m.close, m.dialog) && inside(m.iframe, m.dialog), `${prefix}: close and iframe must fit inside the host dialog`)
      requireGeometry(m.documentScrollWidth <= m.viewport.width + 1 && m.dialogScrollWidth <= m.dialogClientWidth + 1, `${prefix}: host must not create horizontal overflow`)
      requireGeometry(m.close.width >= 44 - 0.5 && m.close.height >= 44 - 0.5, `${prefix}: close hit area=${m.close.width}x${m.close.height}px must be at least 44x44 CSSpx`)
      requireGeometry(m.close.left - m.dialog.left <= 48 && m.close.right <= m.dialog.left + m.dialog.width / 2, `${prefix}: close must be conspicuous on the left, not at right=${m.close.right}px`)
      requireGeometry(!overlaps(m.close, m.systemControls), `${prefix}: host close ${JSON.stringify(m.close)} overlaps the rightmost 160x48 desktop system-controls region`)
      requireGeometry(m.closeHit && m.closeVisible, `${prefix}: the real close button must be visible and hit-testable at its center`)
    }
    assert.deepEqual(failures, [], `Host layout safety regressions (evidence: ${report.artifacts}):\n${failures.join('\n')}`)
  })
}
