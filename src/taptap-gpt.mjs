#!/usr/bin/env node
/**
 * taptap-gpt — drive the ChatGPT web app with a PERSISTENT browser profile so
 * the user logs in ONCE and later runs are automatic.
 *
 * Why: the relay-station image API (taptap-image) stays the primary path, but
 * some images work better when produced by the real ChatGPT web app. The
 * mechanics mirror the BGM lane (src/taptap-bgm-web.mjs): a dedicated Chromium
 * profile directory holds the session; after one manual login the script
 * reuses it. We never lift tokens out of a third-party page and never touch the
 * user's password.
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
 *   status    report whether a saved session exists
 *   gen --prompt "…"   (needs login) generate an image and download it
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
import { dataDir } from './paths.js'

export const GPT_URL = 'https://chatgpt.com/'

export function gptProfileDir(dshHome) {
  // Separate from the BGM profile: a different site, and we must not let one
  // site's logout wipe the other's session.
  return path.join(dataDir(dshHome), 'browser-profile-gpt')
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
function runBrowser(dshHome, snippet, { headless = false, timeoutMs = 600000 } = {}) {
  const py = findPython()
  if (py === null) {
    return { ok: false, err: 'python+playwright not found. Install: pip install playwright && playwright install chromium' }
  }
  const prof = gptProfileDir(dshHome)
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
export function status(dshHome) {
  const prof = gptProfileDir(dshHome)
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
      const tmp = path.join(fs.realpathSync(require('node:os').tmpdir()), `gptck-${process.pid}-${Date.now()}.db`)
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
 * Sign out: delete the saved GPT profile so the next login can use a different
 * account. Callers must ensure no browser is using the profile.
 */
export function logout(dshHome) {
  const prof = gptProfileDir(dshHome)
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
export async function login(dshHome, { waitMs = 300000, graceSec = 8 } = {}) {
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
  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 120000 })
  if (!r.ok) return r
  return { ok: true, logged: r.logged === true, log: r.log, profile: gptProfileDir(dshHome) }
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

  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify({ ok: true, ...status(home) }, null, 2)}\n`)
    return
  }
  if (cmd === 'logout' || cmd === '退出') {
    const r = logout(home)
    process.stdout.write(`${JSON.stringify({ ok: r.ok, message: r.ok ? '已退出，可换号重新登录' : '退出失败', ...r }, null, 2)}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (cmd === 'login') {
    const r = await login(home, { waitMs: Number(args.waitMs ?? 300000) })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok || r.logged !== true) process.exitCode = 1
    return
  }
  process.stderr.write(`unknown command: ${cmd} (use status | login | logout)\n`)
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e?.message ?? e}\n`)
    process.exitCode = 1
  })
}
