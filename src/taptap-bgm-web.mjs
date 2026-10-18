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
import { spawnSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolveDshHome, dataDir, readBgmConfig, readBgmPool, writeBgmPool, touchBgmAccount, pickBgmAccount } from './paths.js'

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

export function profileDir(dshHome, accountId) {
  const id = String(accountId ?? '').replace(/[^\w.-]/g, '_')
  if (id.length === 0) return path.join(dataDir(dshHome), 'browser-profile')
  // Each pool account is fully isolated so one broken session can't corrupt
  // the others (mirrors the ChatGPT lane).
  return path.join(dataDir(dshHome), `browser-profile-bgm-${id}`)
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

/** Find a python with playwright importable. Cached: probing spawns up to 3
 * subprocesses (~1-2s) and the answer never changes within one process. */
let pyCache
function findPython() {
  if (pyCache !== undefined) return pyCache
  for (const bin of ['python', 'python3', 'py']) {
    const r = spawnSync(bin, ['-c', 'import playwright; print(1)'], { encoding: 'utf8' })
    if (r.status === 0) { pyCache = bin; return bin }
  }
  pyCache = null
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
export function releaseProfile(prof) {
  // Retry a few times: Chromium spawns helper processes that outlive the
  // parent, and a still-exiting tree makes the next launch fail with
  // exitCode=21. Two passes with a pause is enough in practice.
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${prof.replace(/\\/g, '\\\\')}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore', timeout: 20000 })
    } catch { /* best effort */ }
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile',
      path.join('Default', 'LOCK')]) {
      try { fs.rmSync(path.join(prof, f), { force: true }) } catch { /* ignore */ }
    }
    // Give the OS a moment to reap the processes before checking again.
    try {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { stdio: 'ignore', timeout: 3000 })
    } catch { /* ignore */ }
    let remaining = 0
    try {
      const probe = spawnSync('powershell', ['-NoProfile', '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${prof.replace(/\\/g, '\\\\')}*' }).Count`,
      ], { encoding: 'utf8', timeout: 15000 })
      remaining = Number.parseInt((probe.stdout ?? '0').trim(), 10) || 0
    } catch { remaining = 0 }
    if (remaining === 0) return true
  }
  return false
}

/**
 * Run a python playwright snippet with the persistent profile.
 * The snippet is a callable body that receives (pg, b, result) and is written
 * to a real .py file so indentation is unambiguous.
 */
function runBrowser(dshHome, snippet, { headless = false, timeoutMs = 600000, accountId } = {}) {
  const py = findPython()
  if (py === null) {
    return { ok: false, err: 'python+playwright not found. Install: pip install playwright && playwright install chromium' }
  }
  const prof = profileDir(dshHome, accountId)
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
  // MUST be async: spawnSync blocks the whole Node event loop, so the DSH host
  // stopped answering while the browser stayed open — that was the "卡住" the
  // user saw. spawn() streams output and lets the host keep serving requests.
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn(py, [tmp], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // Killing the python process alone is NOT enough: playwright keeps its own
      // driver node plus the whole Chromium tree alive, and those hold the
      // profile lock forever (that was the "卡住" the user hit). Kill the tree,
      // then release the profile so the next run can start.
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      try {
        spawnSync('powershell', ['-NoProfile', '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${prof.replace(/\\/g, '\\\\')}*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ], { stdio: 'ignore', timeout: 20000 })
      } catch { /* best effort */ }
      releaseProfile(prof)
      fs.rmSync(tmp, { force: true })
      resolve({ ok: false, err: `timed out after ${Math.round(timeoutMs / 1000)}s` })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fs.rmSync(tmp, { force: true })
      resolve({ ok: false, err: error?.message ?? String(error) })
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fs.rmSync(tmp, { force: true })
      const marker = out.indexOf('__RESULT__')
      if (marker < 0) {
        resolve({ ok: false, err: out.trim().split('\n').slice(-3).join(' | ') || 'no result' })
        return
      }
      try {
        resolve({ ok: true, ...JSON.parse(out.slice(marker + '__RESULT__'.length).split('\n')[0]) })
      } catch {
        resolve({ ok: false, err: 'unparseable result: ' + out.slice(marker, marker + 300) })
      }
    })
  })
}

/** `login`: open the page and wait until the user is actually logged in. */
export async function login(dshHome, { waitMs = 300000, site, graceSec = 8, accountId } = {}) {
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
  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 120000, accountId })
  if (!r.ok) {
    // Same err/error mismatch generate() had: without this the UI read
    // `r.error` and showed an empty reason when the browser itself failed.
    return { ok: false, error: r.err, logged: false, log: r.log ?? [], profile: profileDir(dshHome, accountId), account: accountId ?? null }
  }
  const prof = profileDir(dshHome, accountId)
  // A fresh login clears any cooling / ban mark for that account.
  if (r.logged === true && accountId) {
    touchBgmAccount(dshHome, accountId, { status: 'ok', lastUsedAt: 0, note: '' })
  }
  return { ok: true, logged: r.logged === true, log: r.log, profile: prof, account: accountId ?? null }
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
export function statusFor(dshHome, accountId) {
  const prof = profileDir(dshHome, accountId)
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
 * Full status: the default single account PLUS the BGM account pool, so the
 * settings page can render every row (mirrors the ChatGPT lane).
 */
export function status(dshHome) {
  const base = statusFor(dshHome)
  let pool = { accounts: [], autoRotate: true }
  try { pool = readBgmPool(dshHome) } catch { /* no pool yet */ }
  const accounts = pool.accounts.map((a) => ({ ...a, ...statusFor(dshHome, a.id) }))
  return {
    ...base,
    pool: {
      autoRotate: pool.autoRotate !== false,
      total: accounts.length,
      loggedIn: accounts.filter((a) => a.hasCookies).length,
      banned: accounts.filter((a) => a.status === 'banned').length,
      cooling: accounts.filter((a) => a.status === 'cooling').length,
      accounts,
    },
  }
}

/**
 * Sign out: delete the saved browser profile so the next login can use a
 * different account.
 *
 * Why this exists: the plugin originally had no way to switch accounts, so a
 * user who ran out of credits was stuck with the same login. Removing the whole
 * profile directory (rather than just cookies) also guarantees no stale session
 * survives — Chromium keeps session state in several files, not only Cookies.
 *
 * Callers must ensure no browser is currently using the profile.
 */
export function logout(dshHome, accountId) {
  const prof = profileDir(dshHome, accountId)
  let removed = false
  try {
    // Make sure nothing holds the profile before deleting it.
    releaseProfile(prof)
    fs.rmSync(prof, { recursive: true, force: true })
    removed = !fs.existsSync(prof)
  } catch {
    removed = false
  }
  // Also drop the remembered site? No — the site choice is independent of the
  // account, so keep it to avoid an extra network probe on next login.
  return { ok: removed, profile: prof, account: accountId ?? null }
}

/**
 * Query the account's remaining credits from the site's own billing endpoint.
 * Verified response shape:
 *   { data: { total_credit: 100, sub_credits: [...], debit_credit: 0 } }
 * Returns { ok, totalCredit, expiresAt } or { ok:false, error }.
 */
export async function credits(dshHome, { site, accountId } = {}) {
  const st = statusFor(dshHome, accountId)
  if (!st.hasCookies) return { ok: false, error: '未登录' }
  const target = site ?? st.site ?? (await detectSite())
  // Build the billing URL ourselves: the page may not request it on load (so
  // waiting to capture it failed), but the endpoint works when called with the
  // same query params the site uses. Verified: returns
  //   {"data":{"total_credit":100,...,"debit_credit":0}}
  const snippet = `import time, json
# Listener MUST be attached before goto(): the page fires the authenticated
# requests during load, so registering afterwards misses the token entirely
# (that was why credits() kept reporting "no token").
cap = {"token": None}
def _on_req(r):
    try:
        if cap["token"] is None:
            t = r.headers.get("token") or r.headers.get("Token")
            if t and t.count(".") == 2:
                cap["token"] = t.replace("Bearer ", "").strip()
    except Exception:
        pass
pg.on("request", _on_req)
pg.goto(${pyStr(target.url.replace('/audio', '/audio/music'))}, timeout=60000)
deadline = time.time() + 40
while time.time() < deadline and cap["token"] is None:
    pg.wait_for_timeout(1500)
steps = {"got_token": cap["token"] is not None}
if cap["token"] is None:
    result["steps"] = steps
    result["error"] = "没能从页面拿到 token（登录态可能已失效，请重新登录）"
    return result
got = pg.evaluate("""async ([t, base]) => {
    try {
        let uuid = '';
        try { uuid = localStorage.getItem('UNIQUE_USER_ID') || ''; } catch (e) {}
        const q = 'scene=1&coin_type=0&biz_line=1&device_platform=web&app_id=3001&version_code=22201&biz_id=1&uuid=' + encodeURIComponent(uuid || 'x');
        const r = await fetch(base + '?' + q, { headers: { token: t } });
        const txt = await r.text();
        if (!r.ok) return { error: 'HTTP ' + r.status, body: txt.slice(0, 200) };
        return JSON.parse(txt);
    } catch (e) { return { error: String(e) }; }
}""", [cap["token"], ${pyStr(target.url.replace('/audio', '/v1/api/audio/billing/credit'))}])
d = (got or {}).get("data") or {}
steps["total_credit"] = d.get("total_credit")
steps["debit_credit"] = d.get("debit_credit")
subs = d.get("sub_credits") or []
if subs:
    steps["expires_at"] = subs[0].get("end_time")
if got and got.get("error"):
    steps["error"] = got["error"]
result["steps"] = steps
return result`
  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: 120000, accountId })
  if (!r.ok) return { ok: false, error: r.err }
  const s = r.steps ?? {}
  if (s.error) return { ok: false, error: s.error }
  if (s.total_credit === undefined || s.total_credit === null) {
    return { ok: false, error: '没拿到额度信息（可能需要重新登录）', steps: s }
  }
  return {
    ok: true,
    totalCredit: s.total_credit,
    debitCredit: s.debit_credit ?? 0,
    expiresAt: s.expires_at ?? null,
  }
}

/**
 * Read the cookie DB and look for the site's real auth cookie (`_token`).
 *
 * Chromium encrypts cookie VALUES, but the NAMES are plaintext — and the name
 * is all we need to answer "are we logged in". Uses Node's built-in
 * `node:sqlite` (available on Node 22+/24) so no python subprocess is needed;
 * the previous python-based probe was slow and could silently fail inside the
 * host, which is what made the settings page hang on 「登录中…」.
 *
 * Returns the cookie name, or null.
 */
function findAuthCookie(cookieFile) {
  if (!cookieFile) return null
  const AUTH_NAMES = ['_token', 'token', 'session', 'access_token', 'Authorization']
  const tmp = path.join(os.tmpdir(), `ckprobe-${process.pid}-${Date.now()}.db`)
  try {
    // Chromium opens the cookie DB with an exclusive lock, so a plain
    // copyFileSync/readFileSync throws EBUSY whenever the browser is running —
    // which silently sent us to the fallback and made status show "(unknown)".
    // Try a few strategies, cheapest first.
    let copied = false
    // 1) Node read (works when the browser is closed)
    try {
      fs.writeFileSync(tmp, fs.readFileSync(cookieFile))
      copied = true
    } catch { copied = false }
    // 2) PowerShell Copy-Item with -Force (often succeeds via a different share mode)
    if (!copied) {
      try {
        const r = spawnSync('powershell', ['-NoProfile', '-Command',
          `Copy-Item -LiteralPath '${cookieFile}' -Destination '${tmp}' -Force -ErrorAction Stop`,
        ], { encoding: 'utf8', timeout: 15000 })
        copied = r.status === 0 && fs.existsSync(tmp)
      } catch { copied = false }
    }
    // 3) esentutl (VSS-free copy that tolerates open files)
    if (!copied) {
      try {
        const r = spawnSync('esentutl', ['/y', cookieFile, '/d', tmp, '/o'],
          { encoding: 'utf8', timeout: 20000 })
        copied = r.status === 0 && fs.existsSync(tmp)
      } catch { copied = false }
    }
    if (!copied) return null

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    let names = []
    try {
      const db = new DatabaseSync(tmp)
      names = db.prepare('SELECT name FROM cookies').all().map((r) => r.name)
      db.close()
    } finally {
      fs.rmSync(tmp, { force: true })
    }
    return names.find((n) => AUTH_NAMES.includes(n)) ?? null
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return null
  }
}

/**
 * `gen`: paste the prompt, generate, then download the newest audio into --out.
 * Selectors are best-effort; unmatched steps are reported honestly.
 */
export async function generate(dshHome, prompt, { out, waitMs = 300000, site, instrumental, count, accountId, ignoreInstrumental = false } = {}) {
  const target = site ?? (await detectSite())
  const dl = downloadDir(dshHome)
  fs.mkdirSync(dl, { recursive: true })
  // Defaults come from the saved BGM settings: game BGM normally has no vocals,
  // so instrumental is on by default, and count 1 avoids the site's wasteful 2.
  const cfg = readBgmConfig(dshHome)
  const instrumentalWanted = typeof instrumental === 'boolean' ? instrumental : cfg.instrumental
  const countWanted = typeof count === 'number' ? count : cfg.count
  // Selectors calibrated against the live CN site (2026-10):
  //   /audio       → must click 「音乐创作」 to reach /audio/music
  //   /audio/music → 风格 textarea placeholder「描述音乐风格与制作要求…」
  //                  纯音乐 toggle, 「创作」 button, then a 下载 action
  const snippet = `import time, os, base64
steps = {}
IGNORE_INSTRUMENTAL = ${ignoreInstrumental ? 'True' : 'False'}
MUSIC_URL = ${pyStr(target.url)}.replace("/audio", "/audio/music")
# Auth on this site is a token REQUEST HEADER (JWT), not a cookie — verified
# by inspecting the real requests. So capture that header once, then we can call
# the API ourselves and never depend on clicking/hovering or reloading.
captured = {"token": None, "json": None, "list_url": None}
def _on_req(r):
    try:
        if captured["token"] is None:
            h = r.headers
            t = h.get("token") or h.get("Token") or h.get("authorization") or h.get("Authorization")
            if t and t.count(".") == 2:
                captured["token"] = t.replace("Bearer ", "").strip()
        # Remember the site's OWN history_list URL. It carries required query
        # params (device_platform/app_id/uuid/unix/...); calling without them
        # returns an empty list (verified).
        if captured["list_url"] is None and "music/history_list" in r.url:
            captured["list_url"] = r.url
    except Exception:
        pass
def _on_resp(r):
    try:
        if "music/history_list" in r.url and r.status == 200:
            captured["json"] = r.json()
    except Exception:
        pass
pg.on("request", _on_req)
pg.on("response", _on_resp)
pg.goto(MUSIC_URL, timeout=60000)
# Wait for both the auth token and the initial work list.
_wait = time.time() + 45
while time.time() < _wait and (captured["token"] is None or captured["json"] is None):
    pg.wait_for_timeout(1500)
steps["got_token"] = captured["token"] is not None
steps["got_list_url"] = captured["list_url"] is not None
steps["url"] = pg.url
TOKEN = captured["token"]
# Without the JWT the history_list API 401s, so we could NEVER detect (let
# alone download) the finished track — the run would just burn waitMs polling
# nothing. Abort early with a clear reason instead (verified: auth on this
# site is the token request header, not a cookie).
if TOKEN is None:
    result["steps"] = steps
    result["error"] = "no auth token captured (login expired? re-login)"
    return result
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
# 纯音乐 (instrumental): driven by the saved setting, default ON.
# Clear any modal overlay FIRST: an open .ant-modal-wrap intercepts pointer
# events, so clicking the switch silently did nothing (verified: Page.click
# timed out with "ant-modal-wrap ... intercepts pointer events").
try:
    pg.evaluate("() => document.querySelectorAll('.ant-modal-wrap,.ant-modal-mask').forEach(e => e.remove())")
except Exception:
    pass
# The old code used the FIRST [role=switch] on the page and treated an
# unreadable state as OFF. Both were wrong: the page has several switches, and
# "read false → click" turned a correctly-ON 纯音乐 into OFF (user-reported
# 2026-10-17: 「一直被我主动关掉」). Now: locate the switch by its 纯音乐 label,
# never guess a state, and verify after clicking.
WANT_INSTRUMENTAL = ${instrumentalWanted ? 'True' : 'False'}
steps["want_instrumental"] = WANT_INSTRUMENTAL

PROBE = """() => {
    const isSwitch = (el) => !!el && el.matches &&
        (el.matches('[role=switch]') || el.matches('button.ant-switch') || el.matches('.ant-switch'));
    const readState = (el) => {
        if (!el) return null;
        const ac = el.getAttribute ? el.getAttribute('aria-checked') : null;
        if (ac === 'true') return true;
        if (ac === 'false') return false;
        const ds = el.getAttribute ? el.getAttribute('data-state') : null;
        if (ds === 'checked' || ds === 'on') return true;
        if (ds === 'unchecked' || ds === 'off') return false;
        const cls = typeof el.className === 'string' ? el.className : '';
        if (cls.indexOf('ant-switch-checked') !== -1) return true;
        if (cls.indexOf('ant-switch') !== -1) return false;   // antd, unchecked
        // Unknown — MUST stay null. Returning false here is what silently
        // flipped the switch to OFF before.
        return null;
    };
    // 1) find the element labelled 纯音乐, then look for a switch near it.
    let sw = null;
    let by = 'none';
    const all = Array.from(document.querySelectorAll('span,div,label,p,button'));
    const labels = all.filter(e => {
        const t = (e.innerText || '').trim();
        return t === '纯音乐' || (t.startsWith('纯音乐') && t.length <= 10);
    }).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    if (labels.length > 0) {
        let node = labels[0];
        for (let i = 0; i < 6 && node && !sw; i += 1) {
            if (isSwitch(node)) sw = node;
            if (!sw && node.querySelector) sw = node.querySelector('[role=switch], button.ant-switch, .ant-switch');
            node = node.parentElement;
        }
        if (sw) by = 'label';
    }
    // 2) fall back ONLY when the page has exactly one switch (unambiguous).
    if (!sw) {
        const list = Array.from(document.querySelectorAll('[role=switch], button.ant-switch, .ant-switch'));
        if (list.length === 1) { sw = list[0]; by = 'only'; }
        else if (list.length > 1) return { by: 'ambiguous', count: list.length, state: null };
    }
    if (!sw) return { by: 'none', count: 0, state: null };
    document.querySelectorAll('[data-dsh-inst]').forEach(e => e.removeAttribute('data-dsh-inst'));
    sw.setAttribute('data-dsh-inst', '1');
    return { by: by, count: 1, state: readState(sw), text: (sw.innerText || '').slice(0, 40) };
}"""

# The switch is set at the LAST moment before generating (see below) — the site
# reloads with 纯音乐 OFF every time, so an early toggle can be lost. Keep only
# an initial observation here for diagnostics.
steps["instrumental_initial"] = pg.evaluate(PROBE).get("state")
# Force 数量 to the configured value (default 1). The site defaults to 2, so
# every generation produced two tracks and burned double the credits.
# Verified DOM (2026-10):
#   <div class="bg-bg_gray_15 flex items-center gap-1 rounded-[20px] px-3 py-2">
#     <span>数量:&nbsp;</span><button>…minus svg…</button><span>2</span><button>…plus…</button>
#   </div>
# So: take the 数量 label's DIRECT parent, and its first <button> is the minus.
WANT_QTY = ${countWanted}
QTY_READ = """() => {
    const all = Array.from(document.querySelectorAll('span,div,label'));
    const lab = all.filter(e => (e.innerText || '').trim().startsWith('数量') && (e.innerText || '').trim().length < 12)
                   .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    if (!lab || !lab.parentElement) return null;
    const box = lab.parentElement;
    const m = (box.innerText || '').match(/(\\d+)/);
    return m ? parseInt(m[1], 10) : null;
}"""
try:
    cur0 = pg.evaluate(QTY_READ)
    steps["qty_initial"] = cur0
    # Drive the value to WANT_QTY in BOTH directions: the old loop only ever
    # clicked MINUS, so a configured count of 3-4 silently stayed at the site's
    # default 2 (no error, just fewer tracks than asked). DOM: first button is
    # minus, second is plus.
    for _ in range(8):
        cur = pg.evaluate(QTY_READ)
        if cur is None or cur == WANT_QTY:
            break
        clicked = pg.evaluate("""(idx) => {
            const all = Array.from(document.querySelectorAll('span,div,label'));
            const lab = all.filter(e => (e.innerText || '').trim().startsWith('数量') && (e.innerText || '').trim().length < 12)
                           .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
            if (!lab || !lab.parentElement) return false;
            const btns = lab.parentElement.querySelectorAll('button');
            if (!btns || btns.length < 2) return false;
            btns[idx].click();
            return true;
        }""", 0 if cur > WANT_QTY else 1)
        if not clicked:
            break
        pg.wait_for_timeout(600)
    steps["qty_final"] = pg.evaluate(QTY_READ)
except Exception as e:
    steps["qty_error"] = str(e)
# Snapshot existing track ids so we can identify the NEW one after generating.
before_ids = set()
try:
    lst0 = ((captured.get("json") or {}).get("data") or {}).get("music_list") or []
    before_ids = {x.get("music_id") for x in lst0}
    steps["existing_tracks"] = len(before_ids)
except Exception:
    pass
# ---- LAST STEP BEFORE GENERATING: force 纯音乐 back to the wanted state ----
# Verified on the live page (2026-10-17): the site loads with 纯音乐 **OFF** by
# default, and the music model obeys this switch rather than the prompt text.
# So it must be set as late as possible and re-verified right here — after the
# prompt is filled and 数量 is adjusted — otherwise a run silently produces a
# vocal track the user asked not to have.
_final = {}
for attempt in range(3):
    _probe = pg.evaluate(PROBE)
    steps["pre_generate_probe_%d" % attempt] = _probe
    if _probe.get("by") in ("none", "ambiguous"):
        break
    if _probe.get("state") == WANT_INSTRUMENTAL:
        _final = _probe
        break
    try:
        pg.click('[data-dsh-inst="1"]', force=True, timeout=4000)
        steps["pre_generate_clicks"] = steps.get("pre_generate_clicks", 0) + 1
    except Exception as e:
        steps["pre_generate_click_error"] = str(e)[:160]
        break
    pg.wait_for_timeout(1200)
    _final = pg.evaluate(PROBE)
steps["instrumental_final"] = _final.get("state")
steps["instrumental_ok"] = (_final.get("state") == WANT_INSTRUMENTAL)
if not steps["instrumental_ok"] and not IGNORE_INSTRUMENTAL:
    # Do NOT spend credits producing a track with the wrong mode.
    result["steps"] = steps
    result["error"] = "instrumental_unset"
    return result
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
# Poll the JSON API quietly with the captured token. CRITICAL: never reload the
# page here — an earlier version did, which made the browser visibly refresh in
# a loop and wiped the typed prompt.
deadline = time.time() + ${Math.floor(waitMs / 1000)}
new_track = None
polls = 0
api_url = captured.get("list_url") or (${pyStr(target.url)}.replace("/audio", "/v1/api/music/history_list") + "?is_favorite=false&page=1&page_size=20")
while time.time() < deadline:
    polls += 1
    # Credit-exhausted accounts fail SILENTLY here: no new track ever appears.
    # So scan the site's own toast/modal text (never the whole body — the page
    # always shows a 「充值」 button, which would false-positive every run).
    try:
        warn = pg.evaluate("""() => {
            const sels = ['.ant-message', '.ant-message-notice', '.ant-notification',
                          '.ant-modal', '[role=alert]', '[class*=toast]', '[class*=Toast]'];
            let t = '';
            for (const s of sels) {
                document.querySelectorAll(s).forEach(e => { t += ' ' + (e.innerText || '') });
            }
            return t;
        }""")
    except Exception:
        warn = ""
    for kw in ("积分不足", "余额不足", "额度不足", "积分已用完", "额度已用完", "余额已用完",
               "积分不够", "购买积分", "insufficient", "not enough", "no credit"):
        if kw in (warn or ""):
            steps["credit_signal"] = kw
            steps["credit_text"] = (warn or "")[:200]
            result["steps"] = steps
            result["error"] = "credit_exhausted:" + kw
            return result
    got = pg.evaluate("""async ([u, t]) => {
        try {
            const r = await fetch(u, { headers: { token: t } });
            if (!r.ok) return { error: 'HTTP ' + r.status };
            return await r.json();
        } catch (e) { return { error: String(e) }; }
    }""", [api_url, TOKEN])
    lst = ((got or {}).get("data") or {}).get("music_list") or []
    for it in lst:
        mid = it.get("music_id")
        if mid and mid not in before_ids and it.get("status") == 2 and it.get("audio_url"):
            new_track = it
            break
    if new_track:
        break
    pg.wait_for_timeout(6000)
steps["polls"] = polls
steps["new_track"] = None
if new_track:
    steps["new_track"] = {"title": new_track.get("title"), "music_id": new_track.get("music_id"),
                          "duration_ms": new_track.get("duration")}
    audio = new_track.get("audio_url")
    steps["audio_url"] = audio
    os.makedirs(${pyStr(dl)}, exist_ok=True)
    safe = "".join(c for c in (new_track.get("title") or "bgm") if c.isalnum() or c in " -_()")
    base_name = safe.strip() or "bgm"
    saved = os.path.join(${pyStr(dl)}, base_name + ".mp3")
    # MiniMax titles repeat (same prompt → same title), and a bare open(...,"wb")
    # SILENTLY OVERWROTE the previous download. Never overwrite: append (2), (3)…
    if os.path.exists(saved):
        n = 2
        while True:
            cand = os.path.join(${pyStr(dl)}, base_name + " (" + str(n) + ").mp3")
            if not os.path.exists(cand):
                saved = cand
                break
            n += 1
    # Fetch through the page so the CDN sees the same origin/headers.
    got = pg.evaluate("""async (u) => {
        try {
            const r = await fetch(u);
            if (!r.ok) return { error: 'HTTP ' + r.status };
            const buf = await r.arrayBuffer();
            const by = new Uint8Array(buf);
            let s = '';
            const CH = 8192;
            for (let i = 0; i < by.length; i += CH) {
                s += String.fromCharCode.apply(null, by.subarray(i, i + CH));
            }
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
  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 240000, accountId })
  if (!r.ok) {
    // runBrowser failures carry `err`, not `error`: without this mapping the
    // rotation loop read `last.error === undefined`, called it "no file", and
    // kept walking accounts for an environment problem (e.g. no python) that
    // would fail identically on every one of them.
    return { ok: false, error: r.err, steps: null, downloadDir: dl, account: accountId ?? null }
  }
  return { ok: true, steps: r.steps, error: r.error, downloadDir: dl, account: accountId ?? null }
}

/**
 * Generate with ACCOUNT ROTATION: run on the current account, and when it has
 * no credits left (or its session died) move to the next usable pool account.
 *
 * ⚠️ Rotating accounts to work around per-account credit limits may breach the
 * site's terms. The user asked for this explicitly (2026-10-17) and owns the
 * risk; we never auto-retry a banned account and never hide the trade-off.
 */
export async function generateWithRotation(dshHome, prompt, { out, waitMs = 300000, site, instrumental, count, accountId, maxAccounts = 4, ignoreInstrumental = false } = {}) {
  const pool = readBgmPool(dshHome)
  if (pool.accounts.length === 0) {
    const r = await generate(dshHome, prompt, { out, waitMs, site, instrumental, count, accountId: undefined, ignoreInstrumental })
    return { ...r, rotated: false, tried: [r.account ?? null] }
  }
  const tried = []
  const failures = []
  const skip = new Set()
  let last = null
  // Rotation OFF: generate with the chosen account only. (The switch used to be
  // stored but never read here, so "轮换关" still walked the whole pool.)
  if (pool.autoRotate === false) {
    const only = typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
    const r = await generate(dshHome, prompt, { out, waitMs, site, instrumental, count, accountId: only, ignoreInstrumental })
    return { ...r, rotated: false, tried: [r.account ?? only ?? null], failures }
  }
  for (let i = 0; i < Math.min(maxAccounts, pool.accounts.length); i += 1) {
    const acct = pickBgmAccount(dshHome, { activeId: i === 0 ? accountId : undefined, exclude: [...skip] })
    if (acct === null) break
    const st = statusFor(dshHome, acct.id)
    if (!st.hasCookies) {
      skip.add(acct.id)
      failures.push({ account: acct.id, error: 'not_logged_in' })
      continue
    }
    tried.push(acct.id)
    last = await generate(dshHome, prompt, { out, waitMs, site, instrumental, count, accountId: acct.id, ignoreInstrumental })
    const isCredit = typeof last.error === 'string' && last.error.startsWith('credit_exhausted')
    if (last.ok && !isCredit) {
      touchBgmAccount(dshHome, acct.id, { status: 'ok', lastUsedAt: Date.now(), note: '' })
      return { ...last, rotated: tried.length > 1, tried, failures }
    }
    if (isCredit) {
      // Out of credits: cool it down so the next picker skips it for a while.
      touchBgmAccount(dshHome, acct.id, { status: 'cooling', lastUsedAt: Date.now(), note: last.error })
    } else {
      touchBgmAccount(dshHome, acct.id, { lastUsedAt: Date.now() })
    }
    skip.add(acct.id)
    failures.push({ account: acct.id, error: last.error ?? 'no file' })
    // A structural failure (selectors, env, auth) would repeat on every account.
    const structural = typeof last.error === 'string'
      && (last.error.includes('no style input') || last.error.includes('创作')
        || last.error.includes('token') || last.error.includes('playwright')
        || last.error.includes('could not fill prompt'))
    if (structural) break
  }
  return {
    ok: false,
    error: last?.error ?? '没有可用账号（全部未登录）',
    rotated: tried.length > 1,
    tried,
    failures,
    hint: '账号池：/taptap-bgm pool list 查看，login --account <名> 登录，pool unban 恢复冷却账号',
  }
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
    const r = await login(home, { waitMs: Number(args.waitMs ?? 300000), accountId: args.account })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok || r.logged !== true) process.exitCode = 1
    return
  }
  if (cmd === 'logout' || cmd === '退出') {
    const r = logout(home, args.account)
    process.stdout.write(`${JSON.stringify({ ok: r.ok, message: r.ok ? '已退出登录，可换账号重新登录' : '退出失败（可能有浏览器正在使用）', ...r }, null, 2)}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (cmd === 'credits' || cmd === '额度') {
    const r = await credits(home, { accountId: args.account })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }
  // ---- account pool (mirrors the ChatGPT lane) ----
  if (cmd === 'pool' || cmd === '池') {
    const sub = (argv[1] ?? 'list').toLowerCase()
    if (sub === 'add') {
      const id = args.id
      if (typeof id !== 'string' || id.length === 0) {
        process.stderr.write('usage: taptap-bgm-web pool add --id <短名> [--label 备注]\n')
        process.exitCode = 2
        return
      }
      const pool = readBgmPool(home)
      if (pool.accounts.some((a) => a.id === id)) {
        process.stderr.write(`account "${id}" already exists\n`)
        process.exitCode = 1
        return
      }
      const next = [...pool.accounts, {
        id, label: typeof args.label === 'string' ? args.label : id,
        profile: profileDir(home, id), status: 'unknown', lastUsedAt: null, note: '',
      }]
      writeBgmPool(home, { accounts: next })
      process.stdout.write(`${JSON.stringify({ ok: true, added: id, total: next.length }, null, 2)}\n`)
      return
    }
    if (sub === 'remove' || sub === 'rm') {
      // args[3] was always undefined (args is keyed by flag name), so a bare
      // `pool remove` fell through to profileDir('') = the DEFAULT profile and
      // deleted the main MiniMax login. Require the id.
      const id = args.id
      if (typeof id !== 'string' || id.length === 0) {
        process.stderr.write('usage: taptap-bgm pool remove --id <短名>（不能省略，否则会误删主账号登录态）\n')
        process.exitCode = 2
        return
      }
      const next = readBgmPool(home).accounts.filter((a) => a.id !== id)
      writeBgmPool(home, { accounts: next })
      let removed = false
      try {
        const prof = profileDir(home, id)
        releaseProfile(prof)
        fs.rmSync(prof, { recursive: true, force: true })
        removed = !fs.existsSync(prof)
      } catch { /* ignore */ }
      process.stdout.write(`${JSON.stringify({ ok: true, removed: id, profileRemoved: removed, total: next.length }, null, 2)}\n`)
      return
    }
    if (sub === 'ban') {
      const id = args.id ?? (typeof argv[2] === 'string' && !argv[2].startsWith('--') ? argv[2] : undefined)
      if (typeof id !== 'string' || id.length === 0) {
        process.stderr.write('usage: taptap-bgm pool ban --id <短名>\n')
        process.exitCode = 2
        return
      }
      touchBgmAccount(home, id, { status: 'banned' })
      process.stdout.write(`${JSON.stringify({ ok: true, banned: id }, null, 2)}\n`)
      return
    }
    if (sub === 'unban' || sub === '恢复') {
      const id = args.id ?? argv[2]
      if (typeof id !== 'string' || id.length === 0) {
        const all = readBgmPool(home).accounts
        for (const a of all) touchBgmAccount(home, a.id, { status: 'ok', note: '' })
        process.stdout.write(`${JSON.stringify({ ok: true, unbanned: 'all', total: all.length }, null, 2)}\n`)
        return
      }
      touchBgmAccount(home, id, { status: 'ok', note: '' })
      process.stdout.write(`${JSON.stringify({ ok: true, unbanned: id }, null, 2)}\n`)
      return
    }
    if (sub === 'rotate' || sub === '轮换') {
      const on = args.on
      const next = on === undefined ? !readBgmPool(home).autoRotate : on !== 'false'
      writeBgmPool(home, { autoRotate: next })
      process.stdout.write(`${JSON.stringify({ ok: true, autoRotate: next }, null, 2)}\n`)
      return
    }
    const st = status(home)
    process.stdout.write(`${JSON.stringify({
      ok: true,
      autoRotate: st.pool.autoRotate,
      total: st.pool.total,
      loggedIn: st.pool.loggedIn,
      cooling: st.pool.cooling,
      banned: st.pool.banned,
      accounts: st.pool.accounts.map((a) => ({
        id: a.id, label: a.label, loggedIn: a.hasCookies, status: a.status, lastUsedAt: a.lastUsedAt,
      })),
    }, null, 2)}\n`)
    return
  }
  if (cmd === 'gen' || cmd === 'generate') {
    const prompt = args.prompt ?? args._?.[0]
    if (typeof prompt !== 'string' || prompt.length === 0) {
      process.stderr.write('usage: taptap-bgm-web gen --prompt "<提示词>" [--account <名>] [--instrumental|--lyrics]\n')
      process.exitCode = 2
      return
    }
    // --instrumental / --lyrics 是显式覆盖；不传就走保存的设置（默认纯音乐）。
    // 传布尔真值给 generateWithRotation，它会优先于 cfg.instrumental。
    let instrumental
    if (args.instrumental !== undefined) {
      instrumental = !(args.instrumental === false || args.instrumental === 'false')
    } else if (args.lyrics !== undefined) {
      instrumental = !(args.lyrics === true || args.lyrics === 'true')
    }
    const r = await generateWithRotation(home, prompt, {
      waitMs: Number(args.waitMs ?? 300000),
      accountId: args.account,
      instrumental,
      ignoreInstrumental: args['ignore-instrumental'] === true,
    })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok || r.error) process.exitCode = 1
    return
  }
  process.stderr.write(`unknown command: ${cmd} (use status | login | logout | credits | gen | pool)\n`)
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.message ?? e}\n`)
    process.exitCode = 1
  })
}
