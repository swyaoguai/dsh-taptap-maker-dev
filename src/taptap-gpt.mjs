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
import { downscaleFile, generateImage as relayGenerate } from './taptap-image.mjs'
import { laneOrder, laneEnabled as isLaneEnabled, readLanes, runWithFallback } from './lanes.mjs'
import { resolveAssetDir } from './assets.mjs'
import { countProcessesContaining, killProcessesContaining } from './win-proc.mjs'
import { focusBrowserWindow } from './win-focus.mjs'

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

/**
 * Resolve WHERE generated images go. Precedence:
 *   1. explicit `--dir` (this call only)
 *   2. configured `downloadDir` in imageLane.json (supports {project} / {home},
 *      relative paths resolve against the project dir)
 *   3. auto: inside a Maker project → <project>/sucai/images
 *            otherwise          → $DSH_HOME/taptap-maker-dev/gpt-images
 *
 * "Follow the project" is the DEFAULT because dumping game assets into C:\ by
 * surprise is exactly what the user objected to (2026-10-17).
 *
 * 目录解析本身搬到 src/assets.mjs：视频和 BGM 用的是同一套规则，放在一处才
 * 不会出现「图片跟项目、视频不跟」这种不一致。
 */
export function resolveDownloadDir(dshHome, { explicit, projectDir } = {}) {
  const cwd = path.resolve(projectDir ?? process.cwd())
  const r = resolveAssetDir(dshHome, 'image', {
    explicit,
    configured: readGptDownloadDir(dshHome),
    projectDir: cwd,
    fallback: 'gpt-images',
  })
  return { dir: r.dir, source: r.source, projectDir: r.projectDir }
}

/** Escape a string into a python single-quoted literal. */
const pyStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

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

/** Kill leftover Chromium holding our GPT profile and clear stale locks. */
export function releaseProfile(prof) {
  for (let pass = 0; pass < 3; pass += 1) {
    // ⚠️ 原来这里把路径直接拼进 PowerShell 的单引号字符串：`-like '*${prof}*'`。
    //    PowerShell 里单引号要写两个才表示一个，所以路径里只要有一个单引号
    //    （用户名 O'Brien、把 DSH_HOME 指到带引号的目录…）字符串就提前闭合，
    //    后面的内容被当命令执行 —— 已实测可注入。现在统一走 win-proc 的转义实现。
    killProcessesContaining(prof)
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile',
      path.join('Default', 'LOCK')]) {
      try { fs.rmSync(path.join(prof, f), { force: true }) } catch { /* ignore */ }
    }
    try {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},400)'], { stdio: 'ignore', timeout: 3000 })
    } catch { /* ignore */ }
    const remaining = countProcessesContaining(prof)
    if (remaining === 0) return true
  }
  return false
}

/**
 * Run a python playwright snippet with the GPT persistent profile.
 * The snippet is a callable body receiving (pg, b, result).
 */
function runBrowser(dshHome, snippet, { headless = false, timeoutMs = 600000, accountId, sidecar } = {}) {
  const py = findPython()
  if (py === null) {
    return { ok: false, err: 'python+playwright not found. Install: pip install playwright && playwright install chromium' }
  }
  // Whatever the snippet managed to write before dying (e.g. the conversation
  // URL) survives here — that is the whole point of the sidecar.
  const readSidecar = () => {
    if (typeof sidecar !== 'string' || sidecar.length === 0) return null
    try {
      const v = fs.readFileSync(sidecar, 'utf8').trim()
      return v.length > 0 ? v : null
    } catch { return null }
  }
  const dropSidecar = () => {
    if (typeof sidecar === 'string' && sidecar.length > 0) {
      try { fs.rmSync(sidecar, { force: true }) } catch { /* ignore */ }
    }
  }
  const prof = accountId ? gptAccountProfileDir(dshHome, accountId) : gptProfileDir(dshHome)
  fs.mkdirSync(prof, { recursive: true })
  releaseProfile(prof)
  // 浏览器起来后**主动把它拉到前台**。否则窗口会开在 DSH 后面：用户点完「登录」
  // 什么都没发生，以为按钮坏了，于是反复点或以为功能坏了（实测正是如此：
  // 进程在跑、标题正确，但前台窗口始终是 DSH）。登录要人操作，窗口必须看得见。
  // 只在 headed 时做（headless 本来就没有窗口），失败也不影响主流程。
  const focusTimer = headless
    ? null
    : setTimeout(() => {
      focusBrowserWindow(prof, { timeoutMs: 45000 }).catch(() => { /* 只是提升可见性 */ })
    }, 1500)
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
      clearTimeout(focusTimer)
      // Killing python alone leaves the Chromium tree alive and holding the
      // profile lock; kill the whole tree, then release the profile.
      try { ch.kill('SIGKILL') } catch { /* ignore */ }
      killProcessesContaining(prof)
      releaseProfile(prof)
      fs.rmSync(tmp, { force: true })
      const convUrl = readSidecar()
      dropSidecar()
      resolve({ ok: false, err: `timed out after ${Math.round(timeoutMs / 1000)}s`, convUrl })
    }, timeoutMs)
    ch.stdout.on('data', (d) => { out += d.toString() })
    ch.stderr.on('data', (d) => { out += d.toString() })
    ch.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(focusTimer)
      fs.rmSync(tmp, { force: true })
      resolve({ ok: false, err: error?.message ?? String(error) })
    })
    ch.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(focusTimer)
      fs.rmSync(tmp, { force: true })
      const marker = out.indexOf('__RESULT__')
      if (marker < 0) {
        const convUrl = readSidecar()
        dropSidecar()
        resolve({ ok: false, err: out.trim().split('\n').slice(-3).join(' | ') || 'no result', convUrl })
        return
      }
      try {
        const parsed = JSON.parse(out.slice(marker + '__RESULT__'.length).split('\n')[0])
        dropSidecar()
        resolve({ ok: true, ...parsed })
      } catch {
        const convUrl = readSidecar()
        dropSidecar()
        resolve({ ok: false, err: 'unparseable result: ' + out.slice(marker, marker + 300), convUrl })
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
  if (!r.ok) {
    // Same err/error mismatch the BGM lane had: the UI reads `error`, so a
    // browser-level failure (no python, profile locked) showed an empty reason.
    return {
      ok: false,
      error: r.err,
      logged: false,
      closedEarly: false,
      log: r.log ?? [],
      profile: accountId ? gptAccountProfileDir(dshHome, accountId) : gptProfileDir(dshHome),
      account: accountId ?? null,
    }
  }
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
  // Sidecar: the snippet drops the conversation URL here the moment it exists.
  // A timeout kills python (SIGKILL) before it can print its result, so without
  // this the most common failure — "still generating when we gave up" — lost the
  // URL and the only recovery left was regenerating (burning a generation).
  const sidecar = path.join(os.tmpdir(), `gptconv-${process.pid}-${Date.now()}.txt`)

  const snippet = `import time, os
steps = {}
DL = ${pyStr(dl)}
DEST = ${pyStr(dest)}
SIDECAR = ${pyStr(sidecar)}
def _remember_conv(u):
    try:
        open(SIDECAR, "w", encoding="utf-8").write(u or "")
    except Exception:
        pass
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

def _challenge():
    # Cloudflare Turnstile ("请验证您是真人" / "Verify you are human"). When this
    # is up the app never renders: no composer, no image. Report it instead of
    # waiting minutes and blaming the selectors (verified 2026-10-17).
    try:
        for fr in pg.frames:
            try:
                if "challenges.cloudflare.com" in (fr.url or ""):
                    return "turnstile-iframe"
            except Exception:
                pass
        txt = pg.inner_text("body") or ""
        for kw in ("请验证您是真人", "Verify you are human", "确认您是真人", "Just a moment", "请稍候"):
            if kw in txt:
                return kw
    except Exception:
        pass
    return None

def _try_click_challenge():
    # Best effort ONLY. Measured 2026-10-17:
    #  - selector-based clicks inside the Turnstile frame find nothing (the
    #    checkbox sits in a nested frame/shadow root Playwright cannot query),
    #  - so we click BY COORDINATES where the checkbox is drawn (what a human
    #    does). That may or may not satisfy Cloudflare's behaviour check.
    # We never spoof fingerprints to defeat the challenge: that is an arms race
    # and circumvents the site's bot protection. One attempt, then ask the user.
    clicked = False
    try:
        box = pg.evaluate("""() => {
            const fr = Array.from(document.querySelectorAll('iframe')).find(f =>
                (f.src || '').indexOf('challenges.cloudflare.com') !== -1);
            if (!fr) return null;
            const r = fr.getBoundingClientRect();
            return { x: r.x, y: r.y, h: r.height };
        }""")
        if box:
            pg.mouse.click(box["x"] + 28, box["y"] + box["h"] / 2)
            clicked = True
    except Exception:
        pass
    return clicked

box = None
composer_sel = None
waited = 0
challenge_seen = None
challenge_clicked = False
# Budget is generous because a human may need to tick the box in the visible window.
while waited < 150:
    box, composer_sel = _find_composer()
    if box is not None:
        break
    c = _challenge()
    if c is not None:
        challenge_seen = c
        if not challenge_clicked:
            challenge_clicked = _try_click_challenge()
            steps["challenge_click_attempted"] = challenge_clicked
    pg.wait_for_timeout(1000)
    waited += 1
steps["composer_wait_s"] = waited
steps["challenge"] = challenge_seen
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
    # Keep a screenshot so the failure can be diagnosed without guessing.
    try:
        shot = os.path.join(DL, "failed-%d.png" % int(time.time()))
        pg.screenshot(path=shot)
        steps["screenshot"] = shot
    except Exception:
        pass
    result["steps"] = steps
    if challenge_seen is not None:
        result["error"] = "cloudflare_challenge"
    else:
        result["error"] = "no composer found after ${Math.floor(150)}s (page not usable / UI changed?)"
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
# Guard against context leaking between runs: if the "new" chat already holds
# messages (ChatGPT's client-side local chats can restore the previous thread),
# the model may mix the old prompt into the render — we saw a shield+chest image
# after asking only for a chest (2026-10-17). Record it, and try one clean
# reload when it happens.
def _msg_count():
    try:
        return pg.evaluate("() => document.querySelectorAll('[data-message-author-role]').length")
    except Exception:
        return 0

msgs = _msg_count()
steps["existing_messages"] = msgs
if msgs and msgs > 0:
    # Click the new-chat affordance again, then re-check.
    for sel in ["a[href='/']", "button[aria-label*='新聊天']", "button[aria-label*='New chat']"]:
        try:
            el = pg.query_selector(sel)
            if el and el.is_visible():
                el.click(force=True)
                break
        except Exception:
            pass
    pg.wait_for_timeout(2500)
    msgs = _msg_count()
    steps["existing_messages_after_retry"] = msgs
if len(before) > 0:
    # A previous image is still on screen: the "new image" filter would still
    # work, but the model is clearly reusing the thread. Do not silently pretend.
    steps["context_leak_risk"] = True
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
def _conv():
    u = pg.url.split("?")[0]
    return u if "/c/" in u else None

conv_url = None
for _ in range(40):
    pg.wait_for_timeout(1000)
    conv_url = _conv()
    if conv_url is not None:
        break
steps["conv_url"] = conv_url
result["conv_url"] = conv_url
_remember_conv(conv_url)
# Wait for generation. Signals:
#  (a) a NEW <img> (not in the pre-submit snapshot) that is large enough,
#  (b) the page is no longer "generating",
#  (c) a quota / rate-limit banner (means: stop, this account is out).
#
# Timeout policy: a soft deadline (waitMs) plus a HARD cap. Past the soft
# deadline we only keep going while the page says it is still generating —
# quitting mid-generation is exactly what the user complained about, and the
# conversation may be a client-only ("local-chatgpt:") session that cannot be
# reopened later, so waiting is the only reliable way to keep the image.
soft_deadline = time.time() + ${Math.floor(waitMs / 1000)}
hard_deadline = soft_deadline + ${Math.floor(300)}
img_src = None
quota_hit = None
polls = 0
stable = 0
last_src = None
extended = 0
while time.time() < hard_deadline:
    polls += 1
    # Track a real (server-side) conversation URL when ChatGPT assigns one.
    u = _conv()
    if u is not None and "local-chatgpt" not in u:
        conv_url = u
        result["conv_url"] = u
        _remember_conv(u)
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
    # Quota check runs on EVERY poll, not only when no new image exists: the
    # banner can coexist with stale images on the page (a leftover thumbnail
    # that slipped the "before" filter makes new_img non-null, which used to
    # skip this check entirely and the run degraded to a plain no_image).
    if quota_hit is None:
        try:
            txt = pg.inner_text("body")
        except Exception:
            txt = ""
        # Quota keywords: the exact CN free-tier banner is 「今日免费额度已用完」
        # (user-reported 2026-10-24). The old list missed it, so the run ended as
        # a plain no_image failure — no account rotation, no lane fallback, and
        # the user saw the same banner again on every retry.
        for kw in ["达到上限", "已达上限", "今日免费额度已用完", "免费额度已用完", "额度已用完",
                    "用量已达上限", "今日额度", "rate limit", "Rate limit", "too many requests",
                    "稍后再试", "limit reached", "quota"]:
            if kw in txt:
                quota_hit = kw
                break
        if quota_hit:
            break
    # Past the soft deadline: only stay alive while it is still drawing.
    if time.time() >= soft_deadline:
        if not busy and img_src is None:
            break
        extended += 1
    pg.wait_for_timeout(2000)
steps["polls"] = polls
steps["extended_polls_past_soft_deadline"] = extended
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

  // The python side keeps waiting past the soft deadline while the page still
  // says "generating" (hard cap = soft + 300s). The node watchdog must therefore
  // sit ABOVE that cap — at waitMs+120s it always killed a run that python was
  // still productively working on, throwing away a nearly-finished image.
  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 360000, accountId, sidecar })
  if (!r.ok) {
    const lostUrl = typeof r.convUrl === 'string' && r.convUrl.length > 0 ? r.convUrl : null
    if (lostUrl !== null) {
      // Keep the conversation so the next call can grab the finished image
      // instead of generating a second one.
      writeGptPending(dshHome, {
        url: lostUrl,
        prompt,
        accountId: accountId ?? '',
        at: Date.now(),
        state: 'generating',
      })
      return {
        ok: false,
        error: r.err,
        account: accountId ?? null,
        pendingUrl: lostUrl,
        hint: `这次没等到图（${r.err}），但对话已经建好——**不要重新生成**，等 1~2 分钟用 grab 抓同一个对话：taptap-gpt grab --url "${lostUrl}"`,
      }
    }
    return { ok: false, error: r.err, account: accountId ?? null }
  }
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
  // Rotation OFF means "use this account and stop" — the settings switch has to
  // actually change behaviour, otherwise a user who turned it off (e.g. to keep
  // one account's quota intact) still silently gets walked through the pool.
  if (pool.autoRotate === false) {
    const only = typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
    const r = await gen(dshHome, prompt, { accountId: only, waitMs, out, downscale, size, dir, projectDir })
    return { ...r, rotated: false, tried: [only ?? null] }
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
    // Always carry a concrete reason + the step log: a bare `{account}` told us
    // nothing when diagnosing the Cloudflare failure (2026-10-17).
    failures.push({
      account: acct.id,
      error: last?.error ?? last?.steps?.stage ?? 'unknown',
      steps: last?.steps ?? null,
    })
    // A hard UI failure (selectors / bot wall) will repeat on every account —
    // stop early instead of opening N browsers to fail the same way.
    if (last?.error === 'no_image' || last?.error === 'download_failed') break
    if (last?.error === 'cloudflare_challenge' || last?.error === 'not_logged_in') break
  }
  const lastErr = last?.error ?? 'no usable account (all not logged in)'
  // Give the caller a hint that actually matches how it failed.
  const hints = {
    // The browser window IS open and visible — the human can clear it.
    cloudflare_challenge: '被 Cloudflare 人机验证拦住（页面显示「请验证您是真人」，应用没渲染）。'
      + '重试时在弹出的浏览器窗口里手动勾选验证框即可；勾完它会自动继续。若反复出现，隔几分钟再试。',
    not_logged_in: '账号未登录：/taptap-gpt login --account <id>（或设置页点「登录」）。',
    no_image: '没有等到新图（可能仍在生成或该账号额度不足）。先确认 pending，再决定是否重试。',
  }
  return {
    ok: false,
    error: lastErr,
    rotated: tried.length > 1,
    tried,
    failures,
    hint: hints[lastErr] ?? 'pool: /taptap-gpt pool list 查看账号，login --account <id> 登录，unban 恢复冷却账号',
  }
}

/**
 * 生图的统一入口：按设置页排好的通道顺序 + 开关决定走哪条，额度不足时按开关
 * 决定要不要换下一条。
 *
 * 为什么不让调用方自己挑：`taptap-gpt gen`（网页）和 `taptap-image`（中转站）
 * 过去是两个独立命令，用户要自己判断该用哪个。现在「网页优先、中转站兜底」
 * 这条策略变成了**可排序、可关掉的显式配置**，由这一个函数统一执行。
 *
 * 返回值形状与各通道自己的返回值一致（都带 ok/error/hint），额外加 `lane`
 * 说明最终是谁出的图 —— 界面与对话里都要如实告诉用户。
 *
 * @param {object} relayOpts 传给中转站通道的参数（baseURL/apiKey/prompt/…）
 */
export async function generateImage(dshHome, prompt, { gptOpts = {}, relayOpts = {}, relayReady: relayOk = () => false } = {}) {
  const enabled = laneOrder(dshHome, 'image')
  const ready = {
    gptWeb: () => readGptLaneEnabled(dshHome),
    relayImage: () => (typeof relayOk === 'function' ? Boolean(relayOk()) : false),
  }
  const usable = enabled.filter((id) => {
    try { return ready[id]?.() } catch { return false }
  })
  if (usable.length === 0) {
    return {
      ok: false,
      error: 'no_lane_enabled',
      hint: '生图通道都被关掉了：设置页 → 生成通道 → 生图，把至少一条打开。',
    }
  }

  // 只有开了「额度不足自动换通道」才回退；否则就用第一条可用的。
  const chain = readLanes(dshHome).autoFallback ? usable : usable.slice(0, 1)
  const runLane = async (laneId) => {
    if (laneId === 'gptWeb') {
      const r = await generateWithRotation(dshHome, prompt, gptOpts)
      // 把「额度用光」翻译成统一信号，好让下一条通道知道自己该接手了。
      if (!r.ok && typeof r.error === 'string' && r.error.startsWith('quota:')) {
        const e = new Error(`quota:${r.error.slice(6)}`)
        e.laneError = r
        throw e
      }
      return r
    }
    return relayGenerate(relayOpts)
  }

  const result = await runWithFallback(chain, runLane, (err) => err?.message ?? String(err))
  if (result.ok) return { ...result.value, lane: result.lane, rotatedLanes: result.attempts.length > 0 }

  const summary = result.attempts.map((a) => `  ${a.lane}：${a.reason}`).join('\n')
  return {
    ok: false,
    error: 'all_lanes_failed',
    lane: null,
    hint: `所有生图通道都没成功：\n${summary}\n（可在设置页调整「生图通道优先级」与各通道开关）`,
    attempts: result.attempts,
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
    // A client-only conversation ("local-chatgpt:…") is NOT persisted by
    // ChatGPT, so reopening it shows nothing. Say that plainly — otherwise
    // "no_image" looks like the selectors broke (verified 2026-10-17).
    const isLocal = /local-chatgpt/i.test(target)
    return {
      ok: false,
      error: isLocal && r.error === 'no_image' ? 'local_conversation' : r.error,
      steps,
      url: target,
      stillGenerating: steps.still_generating === true,
      hint: isLocal
        ? '这个对话是本地会话（local-chatgpt:…），ChatGPT 没有存到服务端，重新打开看不到图。'
          + '下次生成时不要中途关窗口；若已错过，只能重新生成一次。'
        : undefined,
    }
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
    // 设置页里「生图通道」把网页这条关掉后，gen 必须真的拒绝 —— 界面开关
    // 不算数的话，用户关了还会照样弹浏览器、照样烧配额。
    if (!isLaneEnabled(home, 'image', 'gptWeb')) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error: 'lane_disabled',
        hint: '「ChatGPT 网页生图」通道已在设置页关闭。打开它，或改用中转站：/taptap-image <描述>。',
      }, null, 2)}\n`)
      process.exitCode = 1
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
      // NEVER run this without an id: gptAccountProfileDir('') resolves to the
      // DEFAULT profile, so `pool remove` with no id used to delete the user's
      // main ChatGPT login (and report ok:true).
      if (typeof id !== 'string' || id.length === 0) {
        process.stderr.write('usage: taptap-gpt pool remove --id <短名>（不能省略，否则会误删主账号登录态）\n')
        process.exitCode = 2
        return
      }
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
      if (typeof id !== 'string' || id.length === 0) {
        process.stderr.write('usage: taptap-gpt pool ban --id <短名>\n')
        process.exitCode = 2
        return
      }
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
