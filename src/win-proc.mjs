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

/**
 * 生成「命令行里出现 needle，且 needle 后面不是路径名字符」的 PowerShell 判断式。
 *
 * 不能用裸的 `-like '*<needle>*'`：
 *   - 前缀误配：`...\browser-profile` 会命中 `...\browser-profile-gpt`、
 *     `browser-profile-bgm-a` 会命中 `browser-profile-bgm-ab`，于是清理一个账号的
 *     浏览器会顺手杀掉别的账号/通道正在跑的浏览器；
 *   - `-like` 里 `[` 是字符类，路径带方括号时匹配不到。
 * 改用 `[regex]::Escape` 后的 `-match`（大小写不敏感），并用负向前瞻要求后面不是
 * `[\w.-]`。needle 只经 psSingleQuote 转义一次（以前在这里多转了一次单引号，
 * 导致路径含 `'` 时永远匹配不到）。
 */
function psCommandLineMatch(needle) {
  return `($_.CommandLine -match ([regex]::Escape(${psSingleQuote(needle)}) + '(?![\\w.-])'))`
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
    `Where-Object { ${psCommandLineMatch(needle)} } | `,
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
    `Where-Object { ${psCommandLineMatch(needle)} }).Count`,
  ].join('')
  try {
    const probe = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: timeoutMs })
    const n = Number.parseInt((probe.stdout ?? '0').trim(), 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}