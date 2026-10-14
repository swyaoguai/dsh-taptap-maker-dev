#!/usr/bin/env node
/**
 * taptap-bgm-web — drive the MiniMax Audio web page with a PERSISTENT browser
 * profile, so the user logs in ONCE and later runs are automatic.
 *
 * Why this exists: the MiniMax music API returns HTTP 410 to new-user accounts
 * (verified: real key → 410 on music-3.0/2.6/cover; only a fake key gets
 * 200/1004), and the web page is a login-only SPA with no public API — so the
 * only honest way to generate full BGM is to drive the real browser.
 *
 * We do NOT scrape tokens out of an iframe. `www.minimax.io/audio` sends no
 * X-Frame-Options / CSP frame-ancestors, but lifting a session token from a
 * third-party page would be both fragile and improper. Instead we keep a
 * dedicated Chromium profile directory (`~/.dsh/taptap-maker-dev/browser-profile`);
 * cookies persist there, so after one manual login the session survives.
 *
 * Commands:
 *   login            open the page, wait for the user to log in, save profile
 *   status           report whether a saved session exists
 *   gen --prompt "…"  open the page, paste the prompt, click generate, wait,
 *                    then click download and save the file to --out
 *
 * Requires python + playwright (`pip install playwright && playwright install chromium`).
 * DOM selectors are best-effort and configurable; when the page changes, the
 * script reports exactly what it could and could not find instead of lying.
 *
 * @module src/taptap-bgm-web.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolveDshHome, dataDir } from './paths.js'

/**
 * Two sites, chosen by network reachability — the international site forces
 * Google sign-in, which many users in China cannot complete.
 *   CN:   https://www.minimax.cn/audio  (lang zh-CN, title「MiniMax 语音和音乐」)
 *   INTL: https://www.minimax.io/audio  (lang en, title「MiniMax Audio&Music」)
 * Both verified reachable; minimaxi.com/audio redirects to minimax.cn/audio.
 */
export const SITES = [
  { id: 'cn', url: 'https://www.minimax.cn/audio', label: '国内版（minimax.cn）' },
  { id: 'intl', url: 'https://www.minimax.io/audio', label: '国际版（minimax.io）' },
]
export const WEB_URL = SITES[0].url // default until detectSite() decides

/**
 * Probe which site is reachable from here. CN first (no Google login needed),
 * INTL as fallback. Returns { id, url, label, ok, errors }.
 */
export async function detectSite({ timeoutMs = 8000 } = {}) {
  const errors = []
  for (const site of SITES) {
    try {
      const response = await fetch(site.url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      })
      if (response.ok) return { ...site, ok: true, errors }
      errors.push(`${site.id}: HTTP ${response.status}`)
    } catch (error) {
      errors.push(`${site.id}: ${error?.message ?? error}`)
    }
  }
  // Nothing reachable: fall back to CN but report that the probe failed.
  return { ...SITES[0], ok: false, errors }
}

export function profileDir(dshHome) {
  return path.join(dataDir(dshHome), 'browser-profile')
}

export function downloadDir(dshHome) {
  return path.join(dataDir(dshHome), 'bgm-downloads')
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const key = t.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else { args[key] = next; i += 1 }
  }
  return args
}

/** Find a python with playwright importable. */
function findPython() {
  for (const bin of ['python', 'python3', 'py']) {
    const r = spawnSync(bin, ['-c', 'import playwright; print(1)'], { encoding: 'utf8' })
    if (r.status === 0) return bin
  }
  return null
}

/** Escape a string into a python single-quoted literal. */
const pyStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

/**
 * Run a python playwright snippet with the persistent profile.
 * Returns { ok, out, err }.
 */
/**
 * Run a python playwright snippet with the persistent profile.
 * The snippet is a callable body that receives (pg, b, result) and is written
 * to a real .py file so indentation is unambiguous.
 */
function runBrowser(dshHome, snippet, { headless = false, timeoutMs = 600000 } = {}) {
  const py = findPython()
  if (py === null) {
    return { ok: false, err: 'python+playwright not found. Install: pip install playwright && playwright install chromium' }
  }
  const prof = profileDir(dshHome)
  fs.mkdirSync(prof, { recursive: true })
  const script = `import json
from playwright.sync_api import sync_playwright
result = {"ok": False, "log": [], "error": None}
def _snippet(pg, b, result):
${snippet.split('\n').map((l) => (l.length > 0 ? `    ${l}` : l)).join('\n')}
    return result
try:
    with sync_playwright() as p:
        b = p.chromium.launch_persistent_context(${pyStr(prof)}, headless=${headless ? 'True' : 'False'})
        pg = b.pages[0] if b.pages else b.new_page()
        _snippet(pg, b, result)
        b.close()
        result["ok"] = True
except Exception as e:
    result["error"] = str(e)
print("__RESULT__" + json.dumps(result, ensure_ascii=False))
`
  const tmp = path.join(os.tmpdir(), `bgmweb-${Date.now()}.py`)
  fs.writeFileSync(tmp, script, 'utf8')
  const r = spawnSync(py, [tmp], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  fs.rmSync(tmp, { force: true })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const marker = out.indexOf('__RESULT__')
  if (marker < 0) return { ok: false, err: out.trim().split('\n').slice(-3).join(' | ') || 'no result' }
  try {
    return { ok: true, ...JSON.parse(out.slice(marker + '__RESULT__'.length).split('\n')[0]) }
  } catch {
    return { ok: false, err: 'unparseable result: ' + out.slice(marker, marker + 300) }
  }
}

/** `login`: open the page and wait until the user is actually logged in. */
export async function login(dshHome, { waitMs = 300000, site } = {}) {
  const target = site ?? (await detectSite())
  const snippet = `pg.goto(${pyStr(target.url)}, timeout=60000)
result["log"].append("opened " + pg.url)
import time
deadline = time.time() + ${Math.floor(waitMs / 1000)}
# Ads/analytics cookies appear before any login, so they are NOT a login signal
# (verified: 19 such cookies exist while signed out). Look for real auth signals.
NOISE = ("_abck","ak_bmsc","bm_sz","g_state","minimax_cookie_agree","_ga","_gcl","_fbp","_tt","ttcsid",
         "test_cookie","fr","sensorsdata","sajssdk","_gc_")
AUTH = ("token","auth","session","sid","uid","user","login","jwt","access","refresh")
# Names that merely contain an auth-ish substring but are analytics noise
# (verified present while signed out).
FALSE = ("unique_user_id","user_hard_ware_info","sawebjssdk","_gcl","lastExternal","app_active")
def _is_auth(n):
    low = n.lower()
    if any(f in low for f in FALSE):
        return False
    if any(low.startswith(x) for x in NOISE):
        return False
    return any(a in low for a in AUTH)
logged = False
while time.time() < deadline:
    try:
        cks = b.cookies()
        hits = [c["name"] for c in cks if _is_auth(c["name"])]
        if hits:
            logged = True
            result["log"].append("auth cookies: " + str(hits))
            break
    except Exception:
        pass
    try:
        stored = pg.evaluate("() => { try { return Object.keys(localStorage).join(',') } catch(e) { return '' } }")
        keys = [k for k in (stored or "").split(",") if _is_auth(k)]
        if keys:
            logged = True
            result["log"].append("auth localStorage keys: " + str(keys))
            break
    except Exception:
        pass
    pg.wait_for_timeout(3000)
result["logged"] = logged
result["url"] = pg.url
return result`
  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 120000 })
  if (!r.ok) return r
  return { ok: true, logged: r.logged === true, log: r.log, profile: profileDir(dshHome) }
}

/** Where the chosen site is remembered, so we don't re-probe every time. */
export function siteFile(dshHome) {
  return path.join(dataDir(dshHome), 'bgm-site.json')
}

/** Remember the detected site; returns the stored record. */
export function saveSite(dshHome, site) {
  const file = siteFile(dshHome)
  const rec = { id: site.id, url: site.url, label: site.label, at: new Date().toISOString() }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`, 'utf8')
  return rec
}

/** Read the remembered site, or undefined when never chosen. */
export function loadSite(dshHome) {
  try {
    const rec = JSON.parse(fs.readFileSync(siteFile(dshHome), 'utf8'))
    if (typeof rec?.url === 'string') return rec
  } catch { /* not chosen yet */ }
  return undefined
}

/** `status`: does a saved profile exist with cookies, and which site? */
export function status(dshHome) {
  const prof = profileDir(dshHome)
  const exists = fs.existsSync(prof)
  const cookieFile = path.join(prof, 'Default', 'Cookies')
  return {
    profile: prof,
    exists,
    hasCookies: fs.existsSync(cookieFile),
    downloadDir: downloadDir(dshHome),
    site: loadSite(dshHome) ?? null,
  }
}

/**
 * `gen`: paste the prompt, generate, then download the newest audio into --out.
 * Selectors are best-effort; unmatched steps are reported honestly.
 */
export async function generate(dshHome, prompt, { out, waitMs = 300000, site } = {}) {
  const target = site ?? (await detectSite())
  const dl = downloadDir(dshHome)
  fs.mkdirSync(dl, { recursive: true })
  const snippet = `pg.goto(${pyStr(WEB_URL)}, timeout=60000)
pg.wait_for_timeout(5000)
import time, os
steps = {}
box = None
for sel in ["textarea", "input[type='text']", "[contenteditable='true']", "[placeholder]"]:
    try:
        el = pg.query_selector(sel)
        if el:
            box = el
            steps["prompt_selector"] = sel
            break
    except Exception:
        pass
if box is None:
    steps["prompt_selector"] = None
    result["steps"] = steps
    result["error"] = "no prompt input found (page layout may have changed)"
    return result
try:
    box.click()
except Exception:
    pass
try:
    box.fill(${pyStr(prompt)})
    steps["prompt_filled"] = True
except Exception:
    pg.keyboard.type(${pyStr(prompt)})
    steps["prompt_filled"] = "typed"
clicked = None
for sel in ["button:has-text('生成')", "button:has-text('Generate')", "button:has-text('创建')", "button:has-text('Create')"]:
    try:
        b2 = pg.query_selector(sel)
        if b2:
            b2.click()
            clicked = sel
            break
    except Exception:
        pass
steps["generate_clicked"] = clicked
deadline = time.time() + ${Math.floor(waitMs / 1000)}
found = None
while time.time() < deadline:
    for sel in ["button:has-text('下载')", "button:has-text('Download')", "a[download]", "audio"]:
        try:
            if pg.query_selector(sel):
                found = sel
                break
        except Exception:
            pass
    if found:
        break
    pg.wait_for_timeout(3000)
steps["download_ready"] = found
if found:
    os.makedirs(${pyStr(dl)}, exist_ok=True)
    try:
        with pg.expect_download(timeout=120000) as info:
            pg.click(found)
        d = info.value
        saved = os.path.join(${pyStr(dl)}, d.suggested_filename or "bgm.mp3")
        d.save_as(saved)
        steps["saved"] = saved
    except Exception as e:
        steps["download_error"] = str(e)
result["steps"] = steps
return result`
  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 180000 })
  if (!r.ok) return r
  return { ok: true, steps: r.steps, error: r.error, downloadDir: dl }
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = (argv[0] ?? 'status').toLowerCase()
  const args = parseArgs(argv)
  const home = args.dshHome

  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify({ ok: true, ...status(home) }, null, 2)}\n`)
    return
  }
  if (cmd === 'login') {
    const r = await login(home, { waitMs: Number(args.waitMs ?? 300000) })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok || r.logged !== true) process.exitCode = 1
    return
  }
  if (cmd === 'gen' || cmd === 'generate') {
    const prompt = args.prompt ?? args._?.[0]
    if (typeof prompt !== 'string' || prompt.length === 0) {
      process.stderr.write('usage: taptap-bgm-web gen --prompt "<提示词>"\n')
      process.exitCode = 2
      return
    }
    const r = await generate(home, prompt, { waitMs: Number(args.waitMs ?? 300000) })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok || r.error) process.exitCode = 1
    return
  }
  process.stderr.write(`unknown command: ${cmd} (use status | login | gen)\n`)
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.message ?? e}\n`)
    process.exitCode = 1
  })
}
