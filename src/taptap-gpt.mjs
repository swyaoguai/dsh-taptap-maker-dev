#!/usr/bin/env node
/**
 * taptap-gpt — drive the ChatGPT web app with a PERSISTENT browser profile so
 * the user logs in ONCE and later runs are automatic.
 *
 * Why: this is the PRIMARY image lane (2026-10 change) — images come out of the
 * real ChatGPT web app, which the user already pays for / gets free quota on.
 * The relay-station API (taptap-image) is now the FALLBACK for when this lane
 * is unavailable (not logged in, quota exhausted everywhere, selectors broken).
 * The mechanics mirror the BGM lane (src/taptap-bgm-web.mjs): a dedicated
 * Chromium profile directory holds the session; after one manual login the
 * script reuses it. We never lift tokens out of a third-party page and never
 * touch the user's password.
 *
 * Account rotation: `gen` walks the account pool (see paths.js readGptPool).
 * Each account has its own browser profile, and when one account reports a
 * quota / rate-limit message we mark it and move to the next one. ⚠️ Rotating
 * accounts to work around per-account quotas is against OpenAI's ToS and can
 * get accounts banned — the user asked for this explicitly and owns the risk.
 *
 * Honest limitations (verified 2026-10):
 *  - chatgpt.com sits behind Cloudflare; a bare HTTP request gets 403 and a
 *    headless browser shows "请稍候…". Only a headed browser gets through.
 *  - LOGIN must be done by the user in person (Google / Apple / phone / email).
 *  - Generation selectors are best-effort: OpenAI redesigns the UI often, so a
 *    step can fail. When that happens the script reports exactly which step
 *    failed rather than pretending success.
 *  - Free accounts have image-generation quotas; when exhausted OpenAI blocks
 *    it and we surface the real message.
 *
 * Commands:
 *   login     open ChatGPT, wait for the user to sign in, save the profile
 *             (--account <id> logs in a NAMED pool account)
 *   status    report whether a saved session exists (+ the whole account pool)
 *   gen       (needs login) generate an image and download it; rotates accounts
 *   pool      list | add --id <名> | remove --id <名> | ban | unban | rotate
 *
 * Requires python + playwright (`pip install playwright && playwright install chromium`).
 *
 * @module src/taptap-gpt.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dataDir, readGptPool, writeGptPool, touchGptAccount, pickGptAccount } from './paths.js'
import { downscaleFile } from './taptap-image.mjs'

export const GPT_URL = 'https://chatgpt.com/'

/**
 * Base profile dir (single-account / default account).
 * Multi-account mode uses one profile per account: see gptAccountProfileDir.
 */
export function gptProfileDir(dshHome) {
  // Separate from the BGM profile: a different site, and we must not let one
  // site's logout wipe the other's session.
  return path.join(dataDir(dshHome), 'browser-profile-gpt')
}

/** Profile dir for a specific pool account (each account is fully isolated). */
export function gptAccountProfileDir(dshHome, accountId) {
  const id = String(accountId ?? '').replace(/[^\w.-]/g, '_')
  if (id.length === 0) return gptProfileDir(dshHome)
  return path.join(dataDir(dshHome), `browser-profile-gpt-${id}`)
}

export function imageDownloadDir(dshHome) {
  return path.join(dataDir(dshHome), 'gpt-images')
}

/** Escape a string into a python single-quoted literal. */
const pyStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

function findPython() {
  for (const bin of ['python', 'python3', 'py']) {
    const r = spawnSync(bin, ['-c', 'import playwright; print(1)'], { encoding: 'utf8' })
    if (r.status === 0) return bin
  }
  return null
}

/** Kill leftover Chromium holding our GPT profile and clear stale locks. */
function releaseProfile(prof) {
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
 * Run a python playwright snippet with the GPT persistent profile.
 * The snippet is a callable body receiving (pg, b, result).
 */
function runBrowser(dshHome, snippet, { headless = false, timeoutMs = 600000, accountId } = {}) {
  const py = findPython()
  if (py === null) {
    return { ok: false, err: 'python+playwright not found. Install: pip install playwright && playwright install chromium' }
  }
  const prof = accountId ? gptAccountProfileDir(dshHome, accountId) : gptProfileDir(dshHome)
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
        # Cloudflare blocks headless, so we must stay headed.
        b = p.chromium.launch_persistent_context(${pyStr(prof)}, headless=${headless ? 'True' : 'False'},
                                                 args=["--disable-blink-features=AutomationControlled"])
        pg = b.pages[0] if b.pages else b.new_page()
        _snippet(pg, b, result)
        try:
            b.close()
        except Exception:
            pass
        result["ok"] = True
except Exception as e:
    result["error"] = str(e)
print("__RESULT__" + json.dumps(result, ensure_ascii=False))
`
  const tmp = path.join(os.tmpdir(), `gptweb-${Date.now()}.py`)
  fs.writeFileSync(tmp, script, 'utf8')
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    // Async spawn (NOT spawnSync): blocking the Node event loop froze the DSH
    // host while the browser stayed open — that was the earlier "卡住".
    const ch = spawn(py, [tmp], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // Killing python alone leaves the Chromium tree alive and holding the
      // profile lock; kill the whole tree, then release the profile.
      try { ch.kill('SIGKILL') } catch { /* ignore */ }
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
    ch.stdout.on('data', (d) => { out += d.toString() })
    ch.stderr.on('data', (d) => { out += d.toString() })
    ch.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fs.rmSync(tmp, { force: true })
      resolve({ ok: false, err: error?.message ?? String(error) })
    })
    ch.on('close', () => {
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

/**
 * Report whether a saved GPT session exists, using Node's built-in sqlite to
 * read the cookie DB (the CN-free approach verified in the BGM lane).
 */
/**
 * Report login state for ONE profile directory (or the default one).
 * `accountId` selects a pool account's isolated profile.
 */
export function statusFor(dshHome, accountId) {
  const prof = accountId ? gptAccountProfileDir(dshHome, accountId) : gptProfileDir(dshHome)
  const exists = fs.existsSync(prof)
  const cookieCandidates = [
    path.join(prof, 'Default', 'Network', 'Cookies'),
    path.join(prof, 'Default', 'Cookies'),
  ]
  const cookieFile = cookieCandidates.find((f) => fs.existsSync(f))
  let loggedIn = false
  let sample = null
  if (cookieFile) {
    try {
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
      const tmp = path.join(os.tmpdir(), `gptck-${process.pid}-${Date.now()}.db`)
      fs.writeFileSync(tmp, fs.readFileSync(cookieFile))
      try {
        const db = new DatabaseSync(tmp)
        const names = db.prepare('SELECT name FROM cookies').all().map((r) => r.name)
        db.close()
        // OpenAI's authenticated session carries these; anonymous sessions do not.
        const hit = names.find((n) => ['__Secure-next-auth.session-token', 'oai-dm', '_puid', 'ajs_anonymous_id'].includes(n))
        if (hit) { loggedIn = true; sample = hit }
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    } catch {
      loggedIn = fs.existsSync(cookieFile) && fs.statSync(cookieFile).size > 20480
    }
  }
  return {
    profile: prof,
    exists,
    loggedIn,
    authSample: sample,
    cookieFile: cookieFile ?? null,
    downloadDir: imageDownloadDir(dshHome),
  }
}

/**
 * Full status: the default single account PLUS the account pool (each account
 * with its own real login state), so the settings page can render every row.
 */
export function status(dshHome) {
  const base = statusFor(dshHome)
  let pool = { accounts: [], autoRotate: true }
  try {
    pool = readGptPool(dshHome)
  } catch { /* no pool yet */ }
  const accounts = pool.accounts.map((a) => ({
    ...a,
    ...statusFor(dshHome, a.id),
  }))
  return {
    ...base,
    pool: {
      autoRotate: pool.autoRotate !== false,
      total: accounts.length,
      loggedIn: accounts.filter((a) => a.loggedIn).length,
      banned: accounts.filter((a) => a.status === 'banned').length,
      cooling: accounts.filter((a) => a.status === 'cooling').length,
      accounts,
    },
  }
}

/**
 * Sign out: delete the saved profile so the next login can use a different
 * account. `accountId` targets a pool account; omit for the default profile.
 */
export function logout(dshHome, accountId) {
  const prof = accountId ? gptAccountProfileDir(dshHome, accountId) : gptProfileDir(dshHome)
  let removed = false
  try {
    releaseProfile(prof)
    fs.rmSync(prof, { recursive: true, force: true })
    removed = !fs.existsSync(prof)
  } catch {
    removed = false
  }
  return { ok: removed, profile: prof }
}

/** `login`: open ChatGPT and wait until the user is actually signed in. */
export async function login(dshHome, { waitMs = 300000, graceSec = 8, accountId } = {}) {
  const snippet = `import time
pg.goto(${pyStr(GPT_URL)}, timeout=60000)
result["log"].append("opened " + pg.url)
pg.wait_for_timeout(8000)
deadline = time.time() + ${Math.floor(waitMs / 1000)}
logged = False
while time.time() < deadline:
    # A signed-in ChatGPT shows the composer and no prominent 登录/登录按钮.
    try:
        body = pg.inner_text("body")
    except Exception:
        body = ""
    has_login_button = False
    try:
        for el in pg.query_selector_all("button, a"):
            t = (el.inner_text() or "").strip()
            if t in ("登录", "Log in", "Sign up", "免费注册"):
                has_login_button = True
                break
    except Exception:
        pass
    # Authenticated pages expose the message composer.
    has_composer = pg.query_selector("#prompt-textarea, textarea, [contenteditable='true']") is not None
    if has_composer and not has_login_button:
        logged = True
        result["log"].append("composer visible and no login button")
        break
    try:
        if len(b.pages) == 0:
            result["log"].append("browser closed by user")
            break
    except Exception:
        break
    pg.wait_for_timeout(3000)
result["logged"] = logged
result["url"] = pg.url
if logged:
    # Grace period so the window does not flash past before the user sees it.
    for _ in range(${graceSec}):
        try:
            if len(b.pages) == 0:
                break
        except Exception:
            break
        pg.wait_for_timeout(1000)
# Flush cookies to disk before close (a hard kill can lose the session).
try:
    b.add_cookies(b.cookies())
    pg.wait_for_timeout(1500)
except Exception:
    pass
return result`
  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 120000, accountId })
  if (!r.ok) return r
  const prof = accountId ? gptAccountProfileDir(dshHome, accountId) : gptProfileDir(dshHome)
  // A freshly logged-in account is usable again: clear any cooling/ban mark.
  if (r.logged === true && accountId) {
    touchGptAccount(dshHome, accountId, { status: 'ok', lastUsedAt: 0, note: '' })
  }
  return { ok: true, logged: r.logged === true, log: r.log, profile: prof, account: accountId ?? null }
}

/**
 * `gen`: the primary image lane. Open ChatGPT, type the prompt, let it render
 * an image, and save the result into the download dir.
 *
 * Selectors are BEST-EFFORT against the current ChatGPT DOM: OpenAI redesigns
 * the UI often. Every unmatched step is reported in `steps` so a failure says
 * exactly where it stopped instead of pretending success.
 *
 * Account rotation: on a quota / rate-limit signal we ban the account and the
 * caller (generateWithRotation) retries with the next pool account.
 */
export async function gen(dshHome, prompt, { accountId, waitMs = 300000, out, downscale, size } = {}) {
  const prof = accountId ? gptAccountProfileDir(dshHome, accountId) : gptProfileDir(dshHome)
  const dl = imageDownloadDir(dshHome)
  fs.mkdirSync(dl, { recursive: true })
  // Unique per run so a retry never collides with a previous download.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dest = out || path.join(dl, `gpt-${stamp}.png`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  const snippet = `import time, os
steps = {}
DL = ${pyStr(dl)}
DEST = ${pyStr(dest)}
pg.goto(${pyStr(GPT_URL)}, timeout=60000)
pg.wait_for_timeout(4000)
# If we landed on a login wall, stop immediately and say so — silently
# generating as an anonymous visitor is not possible and must not be faked.
try:
    body = pg.inner_text("body")
except Exception:
    body = ""
if ("登录" in body or "Log in" in body) and pg.query_selector("#prompt-textarea, textarea, [contenteditable='true']") is None:
    result["steps"] = {"stage": "not_logged_in"}
    result["error"] = "not_logged_in"
    return result
# Type the prompt. ChatGPT's composer is a ProseMirror contenteditable.
box = None
for sel in ["#prompt-textarea", "div[contenteditable='true']", "textarea"]:
    try:
        el = pg.query_selector(sel)
        if el and el.is_visible():
            box = el
            steps["composer"] = sel
            break
    except Exception:
        pass
if box is None:
    result["steps"] = steps
    result["error"] = "no composer found (UI changed?)"
    return result
try:
    box.click(force=True)
    pg.wait_for_timeout(500)
    pg.keyboard.type(${pyStr(prompt)}, delay=12)
    steps["typed"] = True
except Exception as e:
    result["steps"] = steps
    result["error"] = "could not type prompt: " + str(e)
    return result
pg.wait_for_timeout(800)
# Submit: the composer's send button, then Enter as a fallback.
sent = None
for sel in ["button[data-testid='send-button']", "button[aria-label*='发送']", "button[aria-label*='Send']"]:
    try:
        b = pg.query_selector(sel)
        if b and b.is_visible() and b.is_enabled():
            b.click(force=True)
            sent = sel
            break
    except Exception:
        pass
if sent is None:
    try:
        pg.keyboard.press("Enter")
        sent = "Enter"
    except Exception as e:
        result["steps"] = steps
        result["error"] = "could not submit: " + str(e)
        return result
steps["sent"] = sent
# Wait for generation. Two independent signals:
#  (a) an <img> that appeared after submit (the rendered image), and
#  (b) a quota / rate-limit / error banner (means: stop, this account is out).
deadline = time.time() + ${Math.floor(waitMs / 1000)}
img_src = None
quota_hit = None
polls = 0
while time.time() < deadline:
    polls += 1
    try:
        txt = pg.inner_text("body")
    except Exception:
        txt = ""
    for kw in ["达到上限", "已达上限", "rate limit", "Rate limit", "too many requests",
               "稍后再试", "limit reached", "quota", "用量"]:
        if kw in txt:
            # Only trust it when no image so far: ChatGPT shows some of these
            # words in unrelated helper copy.
            if pg.query_selector("img[src*='oaiusercontent'], img[alt*='Generated']") is None:
                quota_hit = kw
                break
    if quota_hit:
        break
    got = pg.evaluate("""() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        // Generated images live on the OpenAI CDN; avatars/icons do not.
        const cands = imgs.filter(i => {
            const s = i.currentSrc || i.src || '';
            return s.indexOf('oaiusercontent.com') !== -1 || s.indexOf('/images/') !== -1 ||
                   s.indexOf('sdmntpr') !== -1 || s.indexOf('v1/files') !== -1;
        });
        if (cands.length === 0) return null;
        const last = cands[cands.length - 1];
        return { src: last.currentSrc || last.src, w: last.naturalWidth, h: last.naturalHeight };
    }""")
    if got and got.get("src") and (got.get("w") or 1) > 64:
        img_src = got["src"]
        steps["image"] = {"w": got.get("w"), "h": got.get("h")}
        break
    pg.wait_for_timeout(4000)
steps["polls"] = polls
if quota_hit:
    steps["quota_signal"] = quota_hit
    result["steps"] = steps
    result["error"] = "quota:" + quota_hit
    return result
if img_src is None:
    steps["note"] = "no image element appeared before the deadline"
    result["steps"] = steps
    result["error"] = "no_image"
    return result
# Fetch the bytes THROUGH THE PAGE (same origin/cookies), then write locally.
# A direct fetch from python would hit Cloudflare with a bare request → 403.
got = pg.evaluate("""async (u) => {
    try {
        const r = await fetch(u, { mode: 'cors', credentials: 'include' });
        if (!r.ok) return { error: 'HTTP ' + r.status };
        const b = await r.blob();
        const buf = await b.arrayBuffer();
        const by = new Uint8Array(buf);
        let s = '';
        const CH = 8192;
        for (let i = 0; i < by.length; i += CH) {
            s += String.fromCharCode.apply(null, by.subarray(i, i + CH));
        }
        return { b64: btoa(s), len: by.length };
    } catch (e) { return { error: String(e) }; }
}""", img_src)
if not got or not got.get("b64"):
    steps["fetch_error"] = (got or {}).get("error", "no data")
    result["steps"] = steps
    result["error"] = "download_failed"
    return result
import base64 as _b64
try:
    open(DEST, "wb").write(_b64.b64decode(got["b64"]))
    steps["saved"] = DEST
    steps["bytes"] = got.get("len")
except Exception as e:
    steps["write_error"] = str(e)
    result["steps"] = steps
    result["error"] = "write_failed"
    return result
result["steps"] = steps
result["saved"] = DEST
return result`

  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 120000, accountId })
  if (!r.ok) return { ok: false, error: r.err, account: accountId ?? null }
  const steps = r.steps ?? {}
  touchGptAccount(dshHome, accountId ?? '', { lastUsedAt: Date.now() })
  // A quota signal means this account is spent for now: mark it and let the
  // caller rotate. `banned` would be permanent; `cooling` keeps it in the pool.
  const isQuota = typeof r.error === 'string' && r.error.startsWith('quota:')
  if (isQuota && accountId) {
    touchGptAccount(dshHome, accountId, { status: 'cooling', note: r.error })
  }
  if (typeof r.error === 'string' && r.error.length > 0 && !isQuota) {
    return { ok: false, error: r.error, steps, account: accountId ?? null }
  }
  if (steps.saved === undefined) {
    return { ok: false, error: r.error ?? 'no file saved', steps, account: accountId ?? null }
  }

  // Optional downscale for small assets (icons / UI): keep the full render.
  let saved = steps.saved
  const notes = []
  if (downscale) {
    const ext = path.extname(saved)
    const full = saved.replace(/(\.[a-z0-9]+)?$/i, `.full${ext || '.png'}`)
    fs.copyFileSync(saved, full)
    const res = downscaleFile(full, saved, downscale)
    if (res.ok) notes.push(`downscaled → ${downscale} via ${res.tool} (full kept: ${full})`)
    else { fs.rmSync(full, { force: true }); notes.push(res.hint) }
  }
  if (out && saved !== out) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.copyFileSync(saved, out)
    saved = out
  }
  return { ok: true, saved, bytes: steps.bytes ?? null, size: size ?? null, steps, account: accountId ?? null, notes }
}

/**
 * Generate with ACCOUNT ROTATION: try the current account, and on a quota /
 * rate-limit / session failure move to the next usable pool account.
 *
 * ⚠️ Rotating accounts to work around per-account quotas is against OpenAI's
 * ToS and risks bans. The user asked for this explicitly (2026-10) and owns the
 * risk; we do NOT hide it and we do NOT retry a banned account.
 */
export async function generateWithRotation(dshHome, prompt, { accountId, waitMs = 300000, out, downscale, size, maxAccounts = 4 } = {}) {
  const pool = readGptPool(dshHome)
  // No pool configured → fall back to the single default profile.
  if (pool.accounts.length === 0) {
    const r = await gen(dshHome, prompt, { accountId: undefined, waitMs, out, downscale, size })
    return { ...r, rotated: false, tried: [r.account] }
  }
  if (pool.autoRotate === false && accountId) {
    const r = await gen(dshHome, prompt, { accountId, waitMs, out, downscale, size })
    return { ...r, rotated: false, tried: [accountId] }
  }
  const tried = []
  const failures = []
  const skip = new Set()
  let last = null
  for (let i = 0; i < Math.min(maxAccounts, pool.accounts.length); i += 1) {
    const acct = pickGptAccount(dshHome, { activeId: i === 0 ? accountId : undefined, exclude: [...skip] })
    if (acct === null) break
    const st = statusFor(dshHome, acct.id)
    // Never burn time on a profile that was never logged in.
    if (!st.loggedIn) {
      skip.add(acct.id)
      failures.push({ account: acct.id, error: 'not_logged_in' })
      continue
    }
    tried.push(acct.id)
    last = await gen(dshHome, prompt, { accountId: acct.id, waitMs, out, downscale, size })
    if (last.ok) return { ...last, rotated: tried.length > 1, tried, failures }
    skip.add(acct.id)
    failures.push({ account: acct.id, error: last.error })
    // A hard UI failure (selectors) will repeat on every account — stop early
    // instead of opening N browsers to fail the same way.
    if (last.error === 'no_image' || last.error === 'download_failed') break
  }
  return {
    ok: false,
    error: last?.error ?? 'no usable account (all not logged in)',
    rotated: tried.length > 1,
    tried,
    failures,
    hint: 'pool: /taptap-gpt pool list 查看账号，login --account <id> 登录，unban 恢复冷却账号',
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = (argv[0] ?? 'status').toLowerCase()
  const args = {}
  for (let i = 1; i < argv.length; i += 1) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const key = t.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else { args[key] = next; i += 1 }
  }
  const home = args.dshHome

  if (cmd === 'gen' || cmd === 'generate') {
    const prompt = args.prompt
    if (typeof prompt !== 'string' || prompt.length === 0) {
      process.stderr.write('usage: taptap-gpt gen --prompt "<描述>" [--out <file.png>] [--downscale 128x128] [--account <id>]\n')
      process.exitCode = 2
      return
    }
    const r = await generateWithRotation(home, prompt, {
      accountId: args.account,
      waitMs: Number(args.waitMs ?? 300000),
      out: args.out,
      downscale: args.downscale,
      size: args.size,
    })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }

  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify({ ok: true, ...status(home) }, null, 2)}\n`)
    return
  }
  if (cmd === 'logout' || cmd === '退出') {
    const r = logout(home, args.account)
    process.stdout.write(`${JSON.stringify({ ok: r.ok, message: r.ok ? '已退出，可换号重新登录' : '退出失败', ...r }, null, 2)}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (cmd === 'login') {
    const r = await login(home, { waitMs: Number(args.waitMs ?? 300000), accountId: args.account })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok || r.logged !== true) process.exitCode = 1
    return
  }
  // ---- account pool management ----
  if (cmd === 'pool' || cmd === '池') {
    const sub = (args._?.[0] ?? argv[1] ?? 'list')
    if (sub === 'list' || typeof sub !== 'string') {
      const st = status(home)
      process.stdout.write(`${JSON.stringify({ ok: true, autoRotate: st.pool.autoRotate, total: st.pool.total, loggedIn: st.pool.loggedIn, cooling: st.pool.cooling, banned: st.pool.banned, accounts: st.pool.accounts.map((a) => ({ id: a.id, label: a.label, loggedIn: a.loggedIn, status: a.status, lastUsedAt: a.lastUsedAt, note: a.note })) }, null, 2)}\n`)
      return
    }
    if (sub === 'add') {
      const id = args.id ?? args._?.[1]
      const label = args.label ?? id
      if (typeof id !== 'string' || id.length === 0) {
        process.stderr.write('usage: taptap-gpt pool add --id <短名> [--label 备注]\n')
        process.exitCode = 2
        return
      }
      const pool = readGptPool(home)
      if (pool.accounts.some((a) => a.id === id)) {
        process.stderr.write(`account "${id}" already exists\n`)
        process.exitCode = 1
        return
      }
      const next = [...pool.accounts, {
        id, label: String(label),
        profile: gptAccountProfileDir(home, id),
        status: 'unknown', lastUsedAt: null, note: '',
      }]
      writeGptPool(home, { accounts: next })
      process.stdout.write(`${JSON.stringify({ ok: true, added: id, total: next.length }, null, 2)}\n`)
      return
    }
    if (sub === 'remove' || sub === 'rm') {
      const id = args.id ?? args._?.[1]
      const pool = readGptPool(home)
      const next = pool.accounts.filter((a) => a.id !== id)
      writeGptPool(home, { accounts: next })
      // Also drop that account's isolated profile so no stale session lingers.
      const prof = gptAccountProfileDir(home, id)
      let removed = false
      try { releaseProfile(prof); fs.rmSync(prof, { recursive: true, force: true }); removed = !fs.existsSync(prof) } catch { /* ignore */ }
      process.stdout.write(`${JSON.stringify({ ok: true, removed: id, profileRemoved: removed, total: next.length }, null, 2)}\n`)
      return
    }
    if (sub === 'ban') {
      const id = args.id ?? args._?.[1]
      touchGptAccount(home, id, { status: 'banned' })
      process.stdout.write(`${JSON.stringify({ ok: true, banned: id }, null, 2)}\n`)
      return
    }
    // unban: clear a 'banned' mark AND a 'cooling' mark (cooling is transient —
    // it just means the account hit a quota during the last run).
    if (sub === 'unban' || sub === '恢复') {
      const id = args.id ?? args._?.[1]
      if (typeof id !== 'string' || id.length === 0) {
        // No id given → restore every account in one go.
        const all = readGptPool(home).accounts
        for (const a of all) touchGptAccount(home, a.id, { status: 'ok', note: '' })
        process.stdout.write(`${JSON.stringify({ ok: true, unbanned: 'all', total: all.length }, null, 2)}\n`)
        return
      }
      touchGptAccount(home, id, { status: 'ok', note: '' })
      process.stdout.write(`${JSON.stringify({ ok: true, unbanned: id }, null, 2)}\n`)
      return
    }
    if (sub === 'rotate') {
      if (typeof args.on === 'string') writeGptPool(home, { autoRotate: args.on !== 'false' })
      else writeGptPool(home, { autoRotate: args.on !== false && args.on !== undefined ? true : !readGptPool(home).autoRotate })
      process.stdout.write(`${JSON.stringify({ ok: true, autoRotate: readGptPool(home).autoRotate }, null, 2)}\n`)
      return
    }
    process.stderr.write(`unknown pool subcommand: ${sub} (use list | add --id <名> | remove --id <名> | ban --id <名> | rotate)\n`)
    process.exitCode = 2
    return
  }
  process.stderr.write(`unknown command: ${cmd} (use status | login | logout | gen | pool)\n`)
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.message ?? e}\n`)
    process.exitCode = 1
  })
}
