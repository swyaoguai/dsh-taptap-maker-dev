/**
 * 插件版本检查：定期对比「本机版本」与「GitHub 上的最新版本」。
 *
 * 版本源：GitHub raw 上的 package.json（仓库 main 分支）。
 * 为什么不用 npm registry：这个插件以 git 仓库分发，npm 上没有（也不打算发）。
 *
 * 行为约定：
 *   - 检查结果**落盘缓存**（version-check.json），设置页直接读缓存展示，
 *     不需要每次打开页面都发网络请求；
 *   - 后台检查带 6 小时冷却，网络失败静默跳过（绝不影响插件主流程）；
 *   - 版本比较用完整 semver（major.minor.patch 三段都比）。
 *
 * @module src/version-checker.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir, writeJson } from './paths.js'

const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url))
/**
 * 版本源候选：新仓库名优先，旧仓库名兜底。
 * ⚠️ 仓库改名期间两边都可能短暂 404 —— 所以永远保持「至少一个可用」。
 */
const REPO_RAW_CANDIDATES = [
  'https://raw.githubusercontent.com/swyaoguai/dsh-game-forge/main/package.json',
  'https://raw.githubusercontent.com/swyaoguai/dsh-taptap-maker-dev/main/package.json',
]
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 小时

/** 本机 package.json 里的版本号。 */
export function currentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 完整 semver 比较。返回 -1（a < b）/ 0（相等）/ 1（a > b）。
 *
 * ⚠️ 必须三段都比：只比 major.minor 的话，0.2.10 vs 0.2.9 会判成相等，
 * 用户就收不到补丁版本的更新提示。
 *
 * prerelease 处理（`-beta` / `-rc.1` 后缀）：parseInt 会把 `0-beta` 静默解析
 * 成 0，导致 1.0.0-beta vs 1.0.0 判成相等 —— 正式版发布后用户收不到更新。
 * 语义：带 prerelease 的一方**小于**不带的一方；两边都带则按字符串比。
 */
export function compareVersions(a, b) {
  const splitVer = (v) => {
    const s = String(v ?? '').replace(/^v/i, '').trim()
    const dash = s.indexOf('-')
    return dash < 0 ? { core: s, pre: '' } : { core: s.slice(0, dash), pre: s.slice(dash + 1) }
  }
  const A = splitVer(a)
  const B = splitVer(b)
  const pa = A.core.split('.')
  const pb = B.core.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10)
    const nb = Number.parseInt(pb[i] ?? '0', 10)
    const pureA = Number.isFinite(na) && String(pa[i] ?? '0') === String(na)
    const pureB = Number.isFinite(nb) && String(pb[i] ?? '0') === String(nb)
    if (pureA && pureB) {
      if (na !== nb) return na < nb ? -1 : 1
    } else {
      // 混入非数字段（异常版本串）按字符串比，避免吞差异。
      const sa = pa[i] ?? ''
      const sb = pb[i] ?? ''
      if (sa !== sb) return sa < sb ? -1 : 1
    }
  }
  // 核心版本相等 → 比 prerelease：无后缀 > 有后缀；都有则字符串比。
  if (A.pre !== B.pre) {
    if (A.pre === '') return 1
    if (B.pre === '') return -1
    return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0
  }
  return 0
}

/** 检查结果缓存文件的路径。 */
export function versionCheckPath(dshHome) {
  return path.join(dataDir(dshHome), 'version-check.json')
}

/** 读缓存的检查结果（没有/损坏返回 undefined）。 */
export function readCachedCheck(dshHome) {
  try {
    const data = JSON.parse(fs.readFileSync(versionCheckPath(dshHome), 'utf8'))
    // ⚠️ error 记录也是合法缓存（没有 latest）：设置页要能显示「上次检查失败」，
    //    而不是显示一个过期的好消息。只要求 current/checkedAt 必须在。
    if (typeof data?.current !== 'string' || typeof data?.checkedAt !== 'number') return undefined
    return {
      current: data.current,
      latest: typeof data.latest === 'string' ? data.latest : undefined,
      isOutdated: data.isOutdated === true,
      checkedAt: data.checkedAt,
      error: typeof data.error === 'string' ? data.error : undefined,
    }
  } catch {
    return undefined
  }
}

/** 写缓存（整体替换，原子写：崩溃/并发不留半截 JSON）。 */
function writeCachedCheck(dshHome, record) {
  writeJson(versionCheckPath(dshHome), record)
}

/**
 * 抓远程最新版本号。
 *
 * 依次尝试「新仓库名 → 旧仓库名」：插件从 `dsh-taptap-maker-dev` 改名成
 * `dsh-game-forge`，但 GitHub 上的仓库不一定同一时间改。只写新名字的话，
 * 仓库没跟着改的这段时间「检查更新」会一直 HTTP 404（用户看到的是"插件坏了"）；
 * 只写旧名字则改名后又失效。两个都试，任一命中即可。
 *
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 *   fetchImpl 供测试注入，避免真实联网。
 * @returns {Promise<string>} latest 版本号
 */
export async function fetchLatestVersion({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const errors = []
  for (const url of REPO_RAW_CANDIDATES) {
    try {
      return await fetchVersionFrom(url, { fetchImpl, timeoutMs })
    } catch (error) {
      errors.push(`${url.includes('game-forge') ? '新' : '旧'}仓库：${error?.message ?? error}`)
    }
  }
  throw new Error(errors.join('；') || '没有可用的版本源')
}

/** 从**一个** URL 抓版本号（失败即抛，由 fetchLatestVersion 汇总）。 */
async function fetchVersionFrom(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'dsh-game-forge' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    throw new Error('远端 package.json 不是合法 JSON（可能被代理/防火墙改写）')
  }
  if (typeof pkg?.version !== 'string' || pkg.version.length === 0) {
    throw new Error('远端 package.json 没有 version 字段')
  }
  return pkg.version
}

/**
 * 执行一次检查：抓远程版本 → 与本地比较 → 结果落盘。
 *
 * 网络失败时也落盘一条 { error } 记录（设置页能显示「上次检查失败」，
 * 而不是显示一个过期的好消息）。失败不抛 —— 调用方（后台定时器）不应被打断。
 *
 * @returns {Promise<{current, latest, isOutdated, checkedAt, error?}>}
 */
export async function checkForUpdates(dshHome, opts = {}) {
  const current = currentVersion()
  const record = { current, checkedAt: Date.now() }
  try {
    const latest = await fetchLatestVersion(opts)
    record.latest = latest
    record.isOutdated = compareVersions(current, latest) < 0
  } catch (error) {
    record.error = String(error?.message ?? error).slice(0, 200)
  }
  try { writeCachedCheck(dshHome, record) } catch { /* 缓存写失败不影响返回值 */ }
  return record
}

/** 距上次检查是否已超过冷却时间（从未检查过 = 需要）。 */
export function shouldCheck(dshHome) {
  const cached = readCachedCheck(dshHome)
  if (!cached) return true
  return Date.now() - cached.checkedAt > CHECK_INTERVAL_MS
}

/* ── 后台定时检查 ────────────────────────────────────────────────────── */

/** Unref 一个 timer，别让它拖住进程退出。 */
function unref(timer) {
  try { timer.unref?.() } catch { /* Node < 18.14 无 unref */ }
}

let intervalId = null
let firstCheckId = null

/**
 * 启动后台检查：先延迟一小段再按冷却判断要不要查一次，之后每 6 小时一次。
 * 全部 fire-and-forget，任何失败都不影响插件加载。
 *
 * ⚠️ 返回 disposer，**调用方必须交给 ctx.effect**：
 *  - 以前不给 disposer，`intervalId` 又是模块级单例 —— 插件卸载后定时器继续
 *    联网；热重载时因为是新的模块实例，`intervalId !== null` 判断失效，会再起
 *    一个 → 多个定时器叠加，同一个 6 小时任务跑 N 份。
 * @returns {() => void} 停止函数（幂等）
 */
export function startBackgroundCheck(dshHome, { logger, startDelayMs = 30000 } = {}) {
  if (intervalId !== null) return stopBackgroundCheck
  const run = () => {
    if (!shouldCheck(dshHome)) return
    checkForUpdates(dshHome)
      .then((r) => {
        if (r.error) logger?.warn?.(`game-forge 版本检查失败：${r.error}`)
        else if (r.isOutdated) logger?.info?.(`game-forge 有新版本：${r.current} → ${r.latest}`)
      })
      .catch(() => { /* 上面已经兜过，这里防御 */ })
  }
  // 别在插件加载的那一瞬间就去抢网络/启动时间（设置页首屏比版本号重要）。
  firstCheckId = setTimeout(run, Math.max(0, Number(startDelayMs) || 0))
  unref(firstCheckId)
  intervalId = setInterval(run, CHECK_INTERVAL_MS)
  unref(intervalId)
  return stopBackgroundCheck
}

/** 停掉后台检查（幂等；插件卸载时由 ctx.effect 调用）。 */
export function stopBackgroundCheck() {
  if (firstCheckId !== null) {
    clearTimeout(firstCheckId)
    firstCheckId = null
  }
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}
