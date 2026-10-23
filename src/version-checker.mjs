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
import { dataDir } from './paths.js'

const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url))
const REPO_RAW = 'https://raw.githubusercontent.com/swyaoguai/dsh-taptap-maker-dev/main/package.json'
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
 * 用户就收不到补丁版本的更新提示。非数字段（如 -beta 后缀）按字符串处理，
 * 数字段按数值比 —— 简单场景够用，不做完整 semver 规范实现。
 */
export function compareVersions(a, b) {
  const pa = String(a ?? '').split('.')
  const pb = String(b ?? '').split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10)
    const nb = Number.parseInt(pb[i] ?? '0', 10)
    // 两边都是纯数字段 → 按数值比（10 > 9）；否则按字符串比。
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1
    } else {
      const sa = pa[i] ?? ''
      const sb = pb[i] ?? ''
      if (sa !== sb) return sa < sb ? -1 : 1
    }
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

/** 写缓存（整体替换）。 */
function writeCachedCheck(dshHome, record) {
  fs.writeFileSync(versionCheckPath(dshHome), JSON.stringify(record, null, 2), 'utf8')
}

/**
 * 抓远程最新版本号。
 *
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 *   fetchImpl 供测试注入，避免真实联网。
 * @returns {Promise<string>} latest 版本号
 */
export async function fetchLatestVersion({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const res = await fetchImpl(REPO_RAW, {
    headers: { Accept: 'application/json', 'User-Agent': 'dsh-taptap-maker-dev' },
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

let intervalId = null

/**
 * 启动后台检查：先按冷却判断要不要立即查一次，之后每 6 小时一次。
 * 全部 fire-and-forget，任何失败都不影响插件加载。
 */
export function startBackgroundCheck(dshHome, { logger } = {}) {
  if (intervalId !== null) return
  const run = () => {
    if (!shouldCheck(dshHome)) return
    checkForUpdates(dshHome)
      .then((r) => {
        if (r.error) logger?.warn?.(`taptap-maker-dev 版本检查失败：${r.error}`)
        else if (r.isOutdated) logger?.info?.(`taptap-maker-dev 有新版本：${r.current} → ${r.latest}`)
      })
      .catch(() => { /* 上面已经兜过，这里防御 */ })
  }
  run()
  intervalId = setInterval(run, CHECK_INTERVAL_MS)
  // 不让定时器阻止进程退出。
  try { intervalId.unref?.() } catch { /* Node < 18.14 无 unref */ }
}

export function stopBackgroundCheck() {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}
