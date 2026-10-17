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
import { dataDir, readGptPool, writeGptPool, touchGptAccount, pickGptAccount, readGptLaneEnabled, writeGptLaneEnabled, readGptDownloadDir, writeGptDownloadDir, readGptPending, writeGptPending, clearGptPending } from './paths.js'
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

/** Fallback download dir (used when not inside a Maker project). */
export function imageDownloadDir(dshHome) {
  return path.join(dataDir(dshHome), 'gpt-images')
}

/** Does `dir` look like a TapTap Maker project root? (has assets/) */
function isMakerProject(dir) {
  try {
    return fs.existsSync(path.join(dir, 'assets'))
  } catch {
    return false
  }
}

/**
 * Ensure a generated-image folder exists AND cannot be committed by accident.
 * The Maker runtime auto-commits the whole workspace, so anything we drop
 * inside a project must be git-ignored — a self-ignoring .gitignore does that
 * without touching the user's root .gitignore.
 */
function ensureImageDir(dir, { insideProject }) {
  fs.mkdirSync(dir, { recursive: true })
  if (insideProject) {
    const gi = path.join(dir, '.gitignore')
    try {
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n!.gitignore\n', 'utf8')
    } catch { /* best effort */ }
  }
  return dir
}

/**
 * Resolve WHERE generated images go. Precedence:
 *   1. explicit `--dir` (this call only)
 *   2. configured `downloadDir` in imageLane.json (supports {project} / {home},
 *      relative paths resolve against the project dir)
 *   3. auto: inside a Maker project → <project>/.taptap-images
 *            otherwise          → $DSH_HOME/taptap-maker-dev/gpt-images
 *
 * "Follow the project" is the DEFAULT because dumping game assets into C:\ by
 * surprise is exactly what the user objected to (2026-10-17).
 */
export function resolveDownloadDir(dshHome, { explicit, projectDir } = {}) {
  const cwd = path.resolve(projectDir ?? process.cwd())
  const home = path.join(dataDir(dshHome))
  const expand = (raw) => String(raw)
    .replace(/\{project\}/gi, cwd)
    .replace(/\{home\}/gi, home)
    .trim()
  const configured = (typeof explicit === 'string' && explicit.trim().length > 0)
    ? explicit
    : readGptDownloadDir(dshHome)
  if (configured.length > 0) {
    let dir = expand(configured)
    if (!path.isAbsolute(dir)) dir = path.resolve(cwd, dir)
    // Only treat it as "inside a project" when it really sits under one.
    const insideProject = isMakerProject(cwd) && path.resolve(dir).toLowerCase().startsWith(path.resolve(cwd).toLowerCase())
    return { dir: ensureImageDir(dir, { insideProject }), source: explicit ? 'flag' : 'config', projectDir: cwd }
  }
  if (isMakerProject(cwd)) {
    const dir = path.join(cwd, '.taptap-images')
    return { dir: ensureImageDir(dir, { insideProject: true }), source: 'project', projectDir: cwd }
  }
  return { dir: ensureImageDir(imageDownloadDir(dshHome), { insideProject: false }), source: 'default', projectDir: cwd }
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
  let laneOn = true
  try { laneOn = readGptLaneEnabled(dshHome) } catch { /* default on */ }
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
        // ONLY the next-auth session token proves a login. Everything else in
        // this jar (ajs_anonymous_id, oai-dm, _puid) is set for ANONYMOUS
        // visitors too — verified with a real cookie DB on 2026-10-17, after
        // the settings page wrongly showed 「已登录」 when the user closed the
        // login window mid-verification.
        const hit = names.find((n) => n.startsWith('__Secure-next-auth.session-token'))
        if (hit) { loggedIn = true; sample = hit }
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    } catch {
      // DB unreadable → fall back to a size heuristic, but cap it at "maybe":
      // report not-logged-in unless a previous status proved otherwise. A
      // large anonymous cookie jar still must NOT count as a login.
      loggedIn = false
      sample = 'cookie-db-unreadable'
    }
  }
  // Report the EFFECTIVE download dir (following the project when applicable)
  // plus the raw configured value, so the settings page can show both.
  let resolvedDir = imageDownloadDir(dshHome)
  let dirSource = 'default'
  try {
    const r = resolveDownloadDir(dshHome)
    resolvedDir = r.dir
    dirSource = r.source
  } catch { /* keep the fallback */ }
  return {
    profile: prof,
    exists,
    loggedIn,
    authSample: sample,
    cookieFile: cookieFile ?? null,
    downloadDir: resolvedDir,
    downloadDirDefault: imageDownloadDir(dshHome),
    downloadDirConfigured: readGptDownloadDir(dshHome),
    downloadDirSource: dirSource,
    laneEnabled: laneOn,
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
    laneEnabled: base.laneEnabled ?? true,
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
 * Master switch for the whole web lane (CLI + slash command + agent policy).
 * When off, `gen` refuses to run and the agent must fall back to the relay.
 */
export function laneEnabled(dshHome) {
  return readGptLaneEnabled(dshHome)
}

export function setLaneEnabled(dshHome, enabled) {
  return writeGptLaneEnabled(dshHome, enabled)
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
# IMPORTANT: chatgpt.com now lets ANONYMOUS visitors use the composer, and the
# page already carries analytics cookies (ajs_anonymous_id / oai-dm) when
# logged out. So neither "composer visible" nor "cookie DB is big" proves a
# login. The ONLY trustworthy signal is the real session cookie — verified
# 2026-10-17 after the old heuristic reported 已登录 the moment the user
# closed the login window mid-verification.
SESSION_PREFIX = "__Secure-next-auth.session-token"
def _session_present():
    try:
        cks = b.cookies()
    except Exception:
        return None  # browser closed / context gone
    for c in cks:
        if (c.get("name") or "").startswith(SESSION_PREFIX):
            return True
    return False
deadline = time.time() + ${Math.floor(waitMs / 1000)}
logged = False
closed_early = False
while time.time() < deadline:
    state = _session_present()
    if state is None:
        closed_early = True
        result["log"].append("browser closed by user before a session token appeared")
        break
    if state:
        logged = True
        result["log"].append("session token present")
        break
    try:
        if len(b.pages) == 0:
            closed_early = True
            result["log"].append("no pages left (window closed)")
            break
    except Exception:
        closed_early = True
        break
    pg.wait_for_timeout(3000)
# A cookie can land exactly as the loop exits — check once more.
if not logged:
    logged = _session_present() is True
result["logged"] = logged
result["closed_early"] = closed_early
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
  return {
    ok: true,
    logged: r.logged === true,
    closedEarly: r.closed_early === true,
    log: r.log,
    profile: prof,
    account: accountId ?? null,
  }
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
export async function gen(dshHome, prompt, { accountId, waitMs = 300000, out, downscale, size, dir, projectDir } = {}) {
  // Master switch: when the lane is off, refuse honestly instead of opening a
  // browser. The relay lane (taptap-image) is the documented fallback.
  if (!readGptLaneEnabled(dshHome)) {
    return { ok: false, error: 'lane_disabled', hint: 'ChatGPT 网页生图已在设置里关闭；回退到中转站 taptap-image，或重新打开开关。' }
  }
  const prof = accountId ? gptAccountProfileDir(dshHome, accountId) : gptProfileDir(dshHome)
  // Follow the project by default; --dir / config override it.
  const resolved = resolveDownloadDir(dshHome, { explicit: dir, projectDir })
  const dl = resolved.dir
  // Unique per run so a retry never collides with a previous download.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dest = out || path.join(dl, `gpt-${stamp}.png`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  const snippet = `import time, os
steps = {}
DL = ${pyStr(dl)}
DEST = ${pyStr(dest)}
pg.goto(${pyStr(GPT_URL)}, timeout=60000)
# Wait for the composer instead of sleeping a fixed 3.5s: on a cold profile the
# page can take 10-20s (Cloudflare + app boot), and a fixed sleep made us report
# "no composer found (UI changed?)" on a perfectly fine page (hit 2026-10-17).
def _find_composer():
    for sel in ["#prompt-textarea", "div[contenteditable='true']", "textarea"]:
        try:
            el = pg.query_selector(sel)
            if el and el.is_visible():
                return el, sel
        except Exception:
            pass
    return None, None

box = None
composer_sel = None
waited = 0
while waited < 40:
    box, composer_sel = _find_composer()
    if box is not None:
        break
    pg.wait_for_timeout(1000)
    waited += 1
steps["composer_wait_s"] = waited
# If we landed on a login wall, stop immediately and say so — silently
# generating as an anonymous visitor is not possible and must not be faked.
if box is None:
    try:
        body = pg.inner_text("body")
    except Exception:
        body = ""
    if "登录" in body or "Log in" in body:
        result["steps"] = {"stage": "not_logged_in"}
        result["error"] = "not_logged_in"
        return result
    result["steps"] = steps
    result["error"] = "no composer found after ${Math.floor(40)}s (page not usable / UI changed?)"
    return result
# CRITICAL: the persistent profile usually reopens the PREVIOUS conversation,
# whose images were already complete. The old code accepted "any CDN <img>" as
# this run's result — so it downloaded the previous image and closed the browser
# while the new one was still rendering (user-reported 2026-10-17). Start a NEW
# chat and snapshot existing images so only genuinely new ones count.
if "/c/" in pg.url:
    jumped = False
    for sel in ["a[href='/']", "button[aria-label*='新聊天']", "button[aria-label*='New chat']",
                "a[aria-label*='新聊天']", "a[aria-label*='New chat']"]:
        try:
            el = pg.query_selector(sel)
            if el and el.is_visible():
                el.click(force=True)
                jumped = True
                break
        except Exception:
            pass
    if not jumped:
        pg.goto(${pyStr(GPT_URL)}, timeout=60000)
    pg.wait_for_timeout(2500)
steps["fresh_chat"] = "/c/" not in pg.url

def _img_srcs():
    try:
        return pg.evaluate("""() => {
            const out = [];
            document.querySelectorAll('img').forEach(i => {
                const s = i.currentSrc || i.src || '';
                if (s && s.indexOf('data:') !== 0) out.push(s);
            });
            return out;
        }""")
    except Exception:
        return []

def _busy():
    # While ChatGPT is drawing it shows a stop button / progress state. Only
    # treat the run as finished once that disappears (otherwise we grab a
    # half-rendered or preview image and quit early).
    try:
        return pg.query_selector(
            "button[data-testid='stop-button'], "
            "button[aria-label*='停止'], button[aria-label*='Stop generating'], "
            "[data-testid='stop-button']"
        ) is not None
    except Exception:
        return False

before = set(_img_srcs() or [])
steps["images_before"] = len(before)
# Re-acquire the composer: the "new chat" click above reloads the SPA, so the
# earlier handle is stale. Wait briefly rather than failing instantly.
box = None
composer_sel = None
waited2 = 0
while waited2 < 20:
    box, composer_sel = _find_composer()
    if box is not None:
        break
    pg.wait_for_timeout(1000)
    waited2 += 1
if box is None:
    result["steps"] = steps
    result["error"] = "no composer found after new chat"
    return result
steps["composer"] = composer_sel
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
# Remember the conversation URL as soon as it appears: this is what lets a
# later run FIND this image instead of generating a duplicate.
conv_url = None
for _ in range(40):
    pg.wait_for_timeout(1000)
    if "/c/" in pg.url:
        conv_url = pg.url.split("?")[0]
        break
steps["conv_url"] = conv_url
result["conv_url"] = conv_url
# Wait for generation. Signals:
#  (a) a NEW <img> (not in the pre-submit snapshot) that is large enough,
#  (b) the page is no longer "generating",
#  (c) a quota / rate-limit banner (means: stop, this account is out).
deadline = time.time() + ${Math.floor(waitMs / 1000)}
img_src = None
quota_hit = None
polls = 0
stable = 0
last_src = None
while time.time() < deadline:
    polls += 1
    new_img = pg.evaluate("""(before) => {
        const out = [];
        document.querySelectorAll('img').forEach(i => {
            const s = i.currentSrc || i.src || '';
            if (!s || before.indexOf(s) !== -1) return;
            if (s.indexOf('data:') === 0) return;
            const w = i.naturalWidth || 0, h = i.naturalHeight || 0;
            if (w < 200 || h < 200) return;   // avatars / icons
            out.push({ src: s, w: w, h: h });
        });
        out.sort((a, b) => (b.w * b.h) - (a.w * a.h));
        return out.length ? out[0] : null;
    }""", list(before))
    busy = _busy()
    if new_img and new_img.get("src"):
        # Two consecutive polls with the SAME src and no "generating" state:
        # the image is final (a preview would still be changing).
        if new_img["src"] == last_src and not busy:
            stable += 1
        else:
            stable = 0
        last_src = new_img["src"]
        if stable >= 2:
            img_src = new_img["src"]
            steps["image"] = {"w": new_img.get("w"), "h": new_img.get("h")}
            break
    else:
        stable = 0
    if not new_img:
        try:
            txt = pg.inner_text("body")
        except Exception:
            txt = ""
        for kw in ["达到上限", "已达上限", "rate limit", "Rate limit", "too many requests",
                   "稍后再试", "limit reached", "quota"]:
            if kw in txt:
                quota_hit = kw
                break
        if quota_hit:
            break
    pg.wait_for_timeout(2000)
steps["polls"] = polls
if quota_hit:
    steps["quota_signal"] = quota_hit
    result["steps"] = steps
    result["error"] = "quota:" + quota_hit
    return result
if img_src is None:
    steps["note"] = "no NEW image reached a stable state before the deadline"
    steps["still_generating"] = _busy()
    result["steps"] = steps
    # Might still be rendering: tell the caller WHERE it is so it can grab the
    # finished image later instead of burning quota on a second generation.
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
  // Record the conversation as soon as we know it: if this run ends up timing
  // out, the NEXT run can download the finished image from here instead of
  // generating a duplicate (which silently burns one generation).
  const convUrl = typeof r.conv_url === 'string' && r.conv_url.length > 0
    ? r.conv_url
    : (typeof steps.conv_url === 'string' && steps.conv_url.length > 0 ? steps.conv_url : null)
  if (convUrl !== null && steps.saved === undefined) {
    writeGptPending(dshHome, {
      url: convUrl,
      prompt,
      accountId: accountId ?? '',
      at: Date.now(),
      state: r.error ? 'generating' : 'done',
    })
  }
  // A quota signal means this account is spent for now: mark it and let the
  // caller rotate. `banned` would be permanent; `cooling` keeps it in the pool.
  const isQuota = typeof r.error === 'string' && r.error.startsWith('quota:')
  if (isQuota && accountId) {
    touchGptAccount(dshHome, accountId, { status: 'cooling', note: r.error })
  }
  if (typeof r.error === 'string' && r.error.length > 0 && !isQuota) {
    return {
      ok: false,
      error: r.error,
      steps,
      account: accountId ?? null,
      // Tell the caller how to recover the image WITHOUT regenerating.
      pendingUrl: convUrl,
      hint: convUrl !== null
        ? `这张图可能还在生成：稍后用 grab 抓取同一个对话即可（不用重新生成，省额度）：taptap-gpt grab --url "${convUrl}"`
        : undefined,
    }
  }
  if (steps.saved === undefined) {
    return { ok: false, error: r.error ?? 'no file saved', steps, account: accountId ?? null, pendingUrl: convUrl }
  }
  // Downloaded successfully → the pending record has served its purpose.
  clearGptPending(dshHome)

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
  return {
    ok: true,
    saved,
    bytes: steps.bytes ?? null,
    size: size ?? null,
    steps,
    account: accountId ?? null,
    notes,
    // Where it landed and why — so the caller can tell the user the real path.
    downloadDir: dl,
    dirSource: resolved.source, // project | config | flag | default
    projectDir: resolved.projectDir,
  }
}

/**
 * Generate with ACCOUNT ROTATION: try the current account, and on a quota /
 * rate-limit / session failure move to the next usable pool account.
 *
 * ⚠️ Rotating accounts to work around per-account quotas is against OpenAI's
 * ToS and risks bans. The user asked for this explicitly (2026-10) and owns the
 * risk; we do NOT hide it and we do NOT retry a banned account.
 */
export async function generateWithRotation(dshHome, prompt, { accountId, waitMs = 300000, out, downscale, size, maxAccounts = 4, dir, projectDir, noResume = false } = {}) {
  // Master switch first: never open a browser for a lane the user turned off.
  if (!readGptLaneEnabled(dshHome)) {
    return {
      ok: false,
      error: 'lane_disabled',
      hint: 'ChatGPT 网页生图已在设置里关闭；回退到中转站 taptap-image，或重新打开开关。',
      rotated: false,
      tried: [],
      failures: [],
    }
  }
  const pool = readGptPool(dshHome)
  // Auto-resume FIRST: if a previous run left a conversation behind (its image
  // may have finished after we closed the browser), download that instead of
  // generating a duplicate. `--no-resume` opts out.
  if (!noResume) {
    const pending = readGptPending(dshHome)
    if (pending && Date.now() - pending.at < 30 * 60 * 1000) {
      const got = await grab(dshHome, {
        url: pending.url,
        accountId: pending.accountId || accountId || undefined,
      })
      if (got.ok) {
        return { ...got, resumed: true, rotated: false, tried: [pending.accountId || null] }
      }
      // Still generating / not ready → fall through to a normal generation.
    }
  }
  // No pool configured → fall back to the single default profile.
  if (pool.accounts.length === 0) {
    const r = await gen(dshHome, prompt, { accountId: undefined, waitMs, out, downscale, size, dir, projectDir })
    return { ...r, rotated: false, tried: [r.account] }
  }
  if (pool.autoRotate === false && accountId) {
    const r = await gen(dshHome, prompt, { accountId, waitMs, out, downscale, size, dir, projectDir })
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
    last = await gen(dshHome, prompt, { accountId: acct.id, waitMs, out, downscale, size, dir, projectDir })
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

/**
 * `grab`: download the finished image from a conversation we ALREADY started,
 * without generating anything new. This is the recovery path when a generation
 * outlives our wait window — the image usually lands seconds later, and
 * regenerating would waste one generation for nothing.
 *
 * `url` may be omitted: then the pending record's conversation is used.
 * `requireNew` (used by gen's auto-resume) only accepts images that were not
 * already on the page before the run; `grab` itself accepts the newest large
 * image in the conversation.
 */
export async function grab(dshHome, { url, out, downscale, accountId, waitMs = 180000 } = {}) {
  const pending = readGptPending(dshHome)
  const target = (typeof url === 'string' && url.length > 0) ? url : pending?.url
  if (typeof target !== 'string' || target.length === 0) {
    return { ok: false, error: 'no_url', hint: '还没有待抓取的对话：先用 gen 生成，或 grab --url <对话链接>。' }
  }
  const account = accountId ?? pending?.accountId ?? undefined
  const resolved = resolveDownloadDir(dshHome, {})
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dest = out || path.join(resolved.dir, `gpt-${stamp}.png`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  const snippet = `import time, os, base64 as _b64
steps = {}
DEST = ${pyStr(dest)}
pg.goto(${pyStr(target)}, timeout=60000)
pg.wait_for_timeout(3500)
def _busy():
    try:
        return pg.query_selector(
            "button[data-testid='stop-button'], "
            "button[aria-label*='停止'], button[aria-label*='Stop generating']"
        ) is not None
    except Exception:
        return False
def _best():
    return pg.evaluate("""() => {
        const out = [];
        document.querySelectorAll('img').forEach(i => {
            const s = i.currentSrc || i.src || '';
            if (!s || s.indexOf('data:') === 0) return;
            const w = i.naturalWidth || 0, h = i.naturalHeight || 0;
            if (w < 200 || h < 200) return;
            out.push({ src: s, w: w, h: h });
        });
        out.sort((a, b) => (b.w * b.h) - (a.w * a.h));
        return out.length ? out[0] : null;
    }""")
# Wait for the page to stop generating and settle on a final image.
deadline = time.time() + ${Math.floor(waitMs / 1000)}
img = None
stable = 0
last = None
while time.time() < deadline:
    cur = _best()
    if cur and cur.get("src"):
        if cur["src"] == last and not _busy():
            stable += 1
        else:
            stable = 0
        last = cur["src"]
        if stable >= 2:
            img = cur
            break
    else:
        stable = 0
    pg.wait_for_timeout(2000)
steps["still_generating"] = _busy()
if img is None:
    result["steps"] = steps
    result["error"] = "no_image"
    return result
steps["image"] = {"w": img.get("w"), "h": img.get("h")}
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
}""", img["src"])
if not got or not got.get("b64"):
    steps["fetch_error"] = (got or {}).get("error", "no data")
    result["steps"] = steps
    result["error"] = "download_failed"
    return result
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

  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 120000, accountId: account })
  if (!r.ok) return { ok: false, error: r.err, steps: null, url: target }
  const steps = r.steps ?? {}
  if (typeof r.error === 'string' && r.error.length > 0 && steps.saved === undefined) {
    return { ok: false, error: r.error, steps, url: target, stillGenerating: steps.still_generating === true }
  }
  if (steps.saved === undefined) return { ok: false, error: 'no file saved', steps, url: target }
  clearGptPending(dshHome)
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
  return { ok: true, saved, grabbed: true, url: target, steps, notes }
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

  // Download dir: `dir` (show) | `dir --set <路径>` | `dir --reset`.
  // Empty config = follow the project (…<project>/.taptap-images).
  if (cmd === 'dir' || cmd === '目录') {
    if (args.reset === true) {
      writeGptDownloadDir(home, '')
      const r = resolveDownloadDir(home)
      process.stdout.write(`${JSON.stringify({ ok: true, reset: true, dir: r.dir, source: r.source }, null, 2)}\n`)
      return
    }
    if (typeof args.set === 'string' || typeof args.dir === 'string') {
      const value = args.set ?? args.dir
      writeGptDownloadDir(home, value)
      const r = resolveDownloadDir(home)
      process.stdout.write(`${JSON.stringify({ ok: true, configured: readGptDownloadDir(home), dir: r.dir, source: r.source }, null, 2)}\n`)
      return
    }
    const r = resolveDownloadDir(home)
    process.stdout.write(`${JSON.stringify({
      ok: true,
      configured: readGptDownloadDir(home) || '(空 = 跟随项目)',
      dir: r.dir,
      source: r.source,
      fallback: imageDownloadDir(home),
      hint: '设置：taptap-gpt dir --set "<路径或 {project}/imgs>"；恢复默认：taptap-gpt dir --reset',
    }, null, 2)}\n`)
    return
  }

  // Master switch: `lane on|off|status`.
  if (cmd === 'lane' || cmd === '开关') {
    const sub = (argv[1] ?? 'status').toLowerCase()
    if (sub === 'on' || sub === '开') {
      const on = setLaneEnabled(home, true)
      process.stdout.write(`${JSON.stringify({ ok: true, laneEnabled: on }, null, 2)}\n`)
      return
    }
    if (sub === 'off' || sub === '关') {
      const on = setLaneEnabled(home, false)
      process.stdout.write(`${JSON.stringify({ ok: true, laneEnabled: on, hint: '网页生图已关闭，图片将回退到中转站 taptap-image' }, null, 2)}\n`)
      return
    }
    process.stdout.write(`${JSON.stringify({ ok: true, laneEnabled: laneEnabled(home) }, null, 2)}\n`)
    return
  }

  if (cmd === 'gen' || cmd === 'generate') {
    const prompt = args.prompt
    if (typeof prompt !== 'string' || prompt.length === 0) {
      process.stderr.write('usage: taptap-gpt gen --prompt "<描述>" [--out <file.png>] [--downscale 128x128] [--account <id>] [--no-resume]\n')
      process.exitCode = 2
      return
    }
    const r = await generateWithRotation(home, prompt, {
      accountId: args.account,
      waitMs: Number(args.waitMs ?? 300000),
      out: args.out,
      downscale: args.downscale,
      size: args.size,
      noResume: args['no-resume'] === true,
    })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (cmd === 'grab' || cmd === '抓图' || cmd === '下载') {
    const r = await grab(home, {
      url: typeof args.url === 'string' ? args.url : undefined,
      out: args.out,
      downscale: args.downscale,
      accountId: args.account,
      waitMs: Number(args.waitMs ?? 180000),
    })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (cmd === 'pending' || cmd === '待抓取') {
    const p = readGptPending(home) ?? null
    process.stdout.write(`${JSON.stringify({ ok: true, pending: p }, null, 2)}\n`)
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
  process.stderr.write(`unknown command: ${cmd} (use status | login | logout | gen | dir | lane | pool)\n`)
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.message ?? e}\n`)
    process.exitCode = 1
  })
}
