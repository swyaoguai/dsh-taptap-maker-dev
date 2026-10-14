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
 * Kill any leftover Chromium holding our profile, and clear stale lock files.
 *
 * Why this is needed: a crashed/killed browser leaves SingletonLock behind and
 * the next launch dies with exitCode=21. We only touch processes whose command
 * line references OUR profile dir, so the user's own Chrome is never harmed.
 */
function releaseProfile(prof) {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${prof.replace(/\\/g, '\\\\')}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore', timeout: 20000 })
    if (r.status !== 0) { /* best effort */ }
  } catch { /* best effort */ }
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile',
    path.join('Default', 'LOCK')]) {
    try { fs.rmSync(path.join(prof, f), { force: true }) } catch { /* ignore */ }
  }
}

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
  releaseProfile(prof)
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
        # Graceful close matters: a hard kill can lose the login cookie before
        # Chromium flushes it to disk (we hit exactly that while debugging).
        try:
            b.close()
        except Exception:
            pass
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
export async function login(dshHome, { waitMs = 300000, site, graceSec = 8 } = {}) {
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
    # Stop early if the user closed the browser window themselves.
    try:
        if len(b.pages) == 0:
            result["log"].append("browser window closed by user")
            break
    except Exception:
        pass
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
# Grace period: the auth cookie can appear mid-login (e.g. right after a QR
# scan), and closing instantly made the window "flash past" before the user
# could see the result. Give them a moment, and let them close it themselves.
if logged:
    result["log"].append("login detected; keeping window open ${graceSec}s")
    for _ in range(${graceSec}):
        try:
            if len(b.pages) == 0:
                break
        except Exception:
            break
        pg.wait_for_timeout(1000)
# Flush the cookie jar to disk explicitly. Chromium normally persists on clean
# close, but a hard kill can lose the auth cookie before it is written — we hit
# exactly that while debugging, which silently logged the user back out.
try:
    b.add_cookies(b.cookies())
    pg.wait_for_timeout(1500)
except Exception:
    pass
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
  // Chromium stores cookies under Default/Network/Cookies (verified here).
  // Default/Cookies is the pre-M76 path — checking only that made status say
  // "not logged in" even after a successful login.
  const cookieCandidates = [
    path.join(prof, 'Default', 'Network', 'Cookies'),
    path.join(prof, 'Default', 'Cookies'),
  ]
  const cookieFile = cookieCandidates.find((f) => fs.existsSync(f))
  // Size alone is NOT a login signal: 13 analytics cookies also exceed 4KB, and
  // we shipped that false positive once. Query the DB for the real auth cookie.
  const authCookie = findAuthCookie(cookieFile)
  return {
    profile: prof,
    exists,
    hasCookies: authCookie !== null,
    authCookie,
    cookieFile: cookieFile ?? null,
    downloadDir: downloadDir(dshHome),
    site: loadSite(dshHome) ?? null,
  }
}

/**
 * Read the cookie DB and look for the site's real auth cookie (`_token`).
 * Chromium's encrypted_value is not decryptable without the OS key, but the
 * NAME is plaintext and that is all we need to answer "are we logged in".
 * Returns the cookie name, or null.
 */
function findAuthCookie(cookieFile) {
  if (!cookieFile) return null
  try {
    const py = findPython()
    if (py === null) return null
    const script = `import sqlite3, shutil, tempfile, os, json
src = ${pyStr(cookieFile)}
tmp = os.path.join(tempfile.gettempdir(), "ck_probe_%d.db" % os.getpid())
shutil.copy2(src, tmp)
con = sqlite3.connect(tmp)
names = [r[0] for r in con.execute("SELECT name FROM cookies").fetchall()]
con.close()
os.remove(tmp)
print("__CKN__" + json.dumps(names))
`
    const tmp = path.join(os.tmpdir(), `ckprobe-${Date.now()}.py`)
    fs.writeFileSync(tmp, script, 'utf8')
    const r = spawnSync(py, [tmp], { encoding: 'utf8', timeout: 15000 })
    fs.rmSync(tmp, { force: true })
    const out = r.stdout ?? ''
    const i = out.indexOf('__CKN__')
    if (i < 0) return null
    const names = JSON.parse(out.slice(i + '__CKN__'.length).split('\n')[0])
    // The CN site uses `_token`; keep a small allowlist for robustness.
    const hit = names.find((n) => ['_token', 'token', 'session', 'access_token', 'Authorization'].includes(n))
    return hit ?? null
  } catch {
    return null
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
  // Selectors calibrated against the live CN site (2026-10):
  //   /audio       → must click 「音乐创作」 to reach /audio/music
  //   /audio/music → 风格 textarea placeholder「描述音乐风格与制作要求…」
  //                  纯音乐 toggle, 「创作」 button, then a 下载 action
  const snippet = `import time, os, base64
steps = {}
MUSIC_URL = ${pyStr(target.url)}.replace("/audio", "/audio/music")
# Capture the site's OWN history_list response: the page calls it with its own
# auth headers, which a manual fetch() cannot reproduce (we got HTTP 401 doing
# that). Listening to the real response is both authenticated and version-proof.
captured = {}
def _on_resp(r):
    try:
        if "music/history_list" in r.url and r.status == 200:
            captured["json"] = r.json()
    except Exception:
        pass
pg.on("response", _on_resp)
pg.goto(MUSIC_URL, timeout=60000)
pg.wait_for_timeout(8000)
steps["url"] = pg.url
# Dismiss a first-run consent dialog if it is covering the form.
for sel in ["button:has-text('同意')", "button:has-text('我知道了')", "button:has-text('确定')",
            ".ant-modal button:has-text('同意')", ".ant-modal-close"]:
    try:
        d = pg.query_selector(sel)
        if d and d.is_visible():
            d.click(force=True)
            steps.setdefault("dialog_dismissed", sel)
            pg.wait_for_timeout(1200)
    except Exception:
        pass
try:
    if pg.query_selector(".ant-modal-wrap"):
        pg.evaluate("() => document.querySelectorAll('.ant-modal-wrap,.ant-modal-mask').forEach(e => e.remove())")
        steps["modal_removed"] = True
except Exception:
    pass
# Fill the style/description box.
box = None
for sel in ["textarea[placeholder*='描述音乐风格']", "textarea[placeholder*='风格']", "textarea"]:
    try:
        el = pg.query_selector(sel)
        if el:
            box = el
            steps["prompt_selector"] = sel
            break
    except Exception:
        pass
if box is None:
    result["steps"] = steps
    result["error"] = "no style input found on /audio/music"
    return result
try:
    box.fill(${pyStr(prompt)})
    steps["prompt_filled"] = True
except Exception:
    try:
        box.click(force=True)
        pg.keyboard.type(${pyStr(prompt)})
        steps["prompt_filled"] = "typed"
    except Exception as e:
        result["steps"] = steps
        result["error"] = "could not fill prompt: " + str(e)
        return result
# Turn on 纯音乐 when present — BGM should have no vocals.
for sel in ["text=纯音乐", "label:has-text('纯音乐')"]:
    try:
        t = pg.query_selector(sel)
        if t and t.is_visible():
            t.click(force=True)
            steps["instrumental_toggled"] = sel
            pg.wait_for_timeout(1000)
            break
    except Exception:
        pass
# Snapshot existing track ids so we can identify the NEW one after generating.
before_ids = set()
try:
    lst0 = ((captured.get("json") or {}).get("data") or {}).get("music_list") or []
    before_ids = {x.get("music_id") for x in lst0}
    steps["existing_tracks"] = len(before_ids)
except Exception:
    pass
# Click 创作 / 生成 (button text can include a credit count, e.g. "600\\n创作").
clicked = None
for sel in ["button:has-text('创作')", "button:has-text('生成')", "button:has-text('Create')"]:
    try:
        b2 = pg.query_selector(sel)
        if b2 and b2.is_visible():
            b2.click(force=True)
            clicked = sel
            break
    except Exception:
        pass
steps["generate_clicked"] = clicked
if clicked is None:
    result["steps"] = steps
    result["error"] = "could not find the 创作 button"
    return result
# Wait for a NEW finished track to appear (status 2 = done).
deadline = time.time() + ${Math.floor(waitMs / 1000)}
new_track = None
while time.time() < deadline:
    lst = ((captured.get("json") or {}).get("data") or {}).get("music_list") or []
    for it in lst:
        mid = it.get("music_id")
        if mid and mid not in before_ids and it.get("status") == 2 and it.get("audio_url"):
            new_track = it
            break
    if new_track:
        break
    # Nudge the list to refresh so we see the new item.
    try:
        pg.reload(timeout=45000)
        pg.wait_for_timeout(6000)
    except Exception:
        pg.wait_for_timeout(5000)
steps["new_track"] = None
if new_track:
    steps["new_track"] = {"title": new_track.get("title"), "music_id": new_track.get("music_id"),
                          "duration_ms": new_track.get("duration")}
    audio = new_track.get("audio_url")
    steps["audio_url"] = audio
    os.makedirs(${pyStr(dl)}, exist_ok=True)
    safe = "".join(c for c in (new_track.get("title") or "bgm") if c.isalnum() or c in " -_()")
    saved = os.path.join(${pyStr(dl)}, (safe.strip() or "bgm") + ".mp3")
    # Fetch through the page so the CDN sees the same origin/headers.
    got = pg.evaluate("""async (u) => {
        try {
            const r = await fetch(u);
            if (!r.ok) return { error: 'HTTP ' + r.status };
            const buf = await r.arrayBuffer();
            const by = new Uint8Array(buf);
            let s = '';
            for (let i = 0; i < by.length; i++) s += String.fromCharCode(by[i]);
            return { b64: btoa(s), len: by.length };
        } catch (e) { return { error: String(e) }; }
    }""", audio)
    if got and got.get("b64"):
        open(saved, "wb").write(base64.b64decode(got["b64"]))
        steps["saved"] = saved
        steps["saved_bytes"] = got.get("len")
    else:
        steps["download_error"] = (got or {}).get("error", "no data")
else:
    steps["note"] = "no new finished track appeared before the deadline"
result["steps"] = steps
return result`
  // MUST run headed: verified that headless loses the login session (cookies
  // drop to the 8 analytics-only ones and _token is absent), so the works list
  // and download button never appear.
  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 240000 })
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
