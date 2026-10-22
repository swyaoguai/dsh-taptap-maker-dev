/**
 * Windows 上按「命令行里含某段路径」找/杀进程的统一实现。
 *
 * 为什么需要单独一个模块：网页生图与 BGM 都要在超时后清掉残留的 Chromium
 * （否则它会一直占着 profile 锁，下次登录态直接坏掉）。原先两份代码各自拼了
 * 一遍 PowerShell 字符串，而那份拼法是**不安全的**：
 *
 *   `Where-Object { $_.CommandLine -like '*${prof}*' }`
 *
 * PowerShell 的单引号字符串里，**单引号必须写成两个才能表示一个**。所以只要
 * 路径里出现一个 `'`（用户名 O'Brien、把 DSH_HOME 指到带引号的目录等），
 * 字符串就会提前闭合，后面的内容被当成命令执行 —— 这是实打实的命令注入。
 *
 * 现在统一走这里：路径先转义（`'` → `''`），再拼进脚本；并且**不依赖**
 * 「把路径内嵌进 -like 模式」这种写法。
 *
 * @module src/win-proc.mjs
 */
import { spawnSync } from 'node:child_process'

/**
 * 把任意字符串安全地放进 PowerShell 的单引号字面量里。
 *
 * PowerShell 单引号字符串内几乎不转义（`$` 是字面量，正则元字符也不生效），
 * 唯一要处理的就是单引号本身 —— 写成两个。
 */
export function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** PowerShell 单引号字符串里的 `-like` 通配符只有 `*` 和 `?` 特殊。 */
function psLikePattern(value) {
  // 先转义单引号，再把 `*` / `?` 转成 PowerShell 的字符类写法，避免路径里
  // 本来就带方括号/星号时被当成模式。
  return String(value)
    .replace(/'/g, "''")
    .replace(/[?]/g, '[?]')
    .replace(/\*/g, '[*]')
}

/**
 * 杀掉命令行里包含 `needle` 的 chrome.exe（连同其子进程树）。
 *
 * 用 `-like` 而不是 `-eq`：我们要的是「命令行里出现过这个 profile 路径」，
 * 而命令行里通常还带别的参数。
 *
 * @param {string} needle 一般是浏览器 profile 的绝对路径
 * @param {{timeoutMs?: number, name?: string}} [opts]
 */
export function killProcessesContaining(needle, { timeoutMs = 20000, name = 'chrome.exe' } = {}) {
  const script = [
    `Get-CimInstance Win32_Process -Filter ${psSingleQuote(`Name='${name}'`)} | `,
    `Where-Object { $_.CommandLine -like ${psSingleQuote(`*${psLikePattern(needle)}*`)} } | `,
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('')
  try {
    spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore', timeout: timeoutMs })
  } catch { /* best effort：杀不掉就靠下次 releaseProfile 再试 */ }
}

/**
 * 数一数命令行里包含 `needle` 的进程还剩几个。
 *
 * 超时后靠它判断「有没有真的清干净」—— 没清干净就不能急着复用 profile，
 * 否则 Chromium 会带着上次的锁启动，登录态直接坏掉。
 *
 * @returns {number} 解析失败时返回 0（宁可当成已清干净，也不要卡死流程）
 */
export function countProcessesContaining(needle, { timeoutMs = 15000, name = 'chrome.exe' } = {}) {
  const script = [
    `@(Get-CimInstance Win32_Process -Filter ${psSingleQuote(`Name='${name}'`)} | `,
    `Where-Object { $_.CommandLine -like ${psSingleQuote(`*${psLikePattern(needle)}*`)} }).Count`,
  ].join('')
  try {
    const probe = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: timeoutMs })
    const n = Number.parseInt((probe.stdout ?? '0').trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}