/**
 * 把某个窗口提到前台（Windows）。
 *
 * 为什么需要它：登录时启动的 Chromium 窗口**会开在 DSH 窗口后面** —— 用户点完
 * 「登录」什么也没发生，以为按钮坏了，于是反复点、或以为功能坏了。实测就是
 * 这个现象：窗口标题正确、进程在跑，但前台窗口始终是 DSH。
 *
 * ⚠️ Windows 不允许后台进程随意抢焦点（SetForegroundWindow 会失败），所以这里
 * 用「AttachThreadInput + 短暂切到前台线程」这套经典做法：把目标窗口的所属
 * 线程 attach 到当前线程，再 ShowWindow(SW_RESTORE) + SetForegroundWindow，
 * 成功后立刻 detach。
 *
 * 全部失败也不抛 —— 这只是「让用户更容易看见窗口」的增强，不值得因此让登录失败。
 *
 * @module src/win-focus.mjs
 */
import { spawnSync } from 'node:child_process'

/**
 * 按「进程命令行包含某段路径」找到窗口句柄并置前。
 *
 * 用命令行匹配而不是「最新的 chrome」：同机可能开着用户的正常浏览器，
 * 把那个窗口抢到前台比不抢还糟。
 *
 * @param {string} needle 一般是浏览器 profile 的绝对路径
 * @returns {boolean} 是否成功置前
 */
export function focusWindowByCmdline(needle, { name = 'chrome.exe' } = {}) {
  if (process.platform !== 'win32') return false
  const psNeedle = String(needle).replace(/'/g, "''")
  // -like 模式里转义 * 与 ?，免得路径里的字符被当通配符。
  const pattern = psNeedle.replace(/[?]/g, '[?]').replace(/\*/g, '[*]')
  const script = [
    '$ErrorActionPreference = 0',
    `$p = Get-CimInstance Win32_Process -Filter 'Name="${name}"' | `,
    `  Where-Object { $_.CommandLine -like '*${pattern}*' -and $_.CommandLine -notlike '*--type=*' } | `,
    '  Select-Object -First 1',
    'if ($p -and $p.ProcessId) {',
    '  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue',
    '  if ($proc -and $proc.MainWindowHandle -ne 0) { Write-Output $proc.MainWindowHandle }',
    '}',
  ].join('\n')

  const raw = runPowerShell(script)
  const handle = Number.parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isFinite(handle) || handle === 0) return false
  return focusHandle(handle)
}

function runPowerShell(script) {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 15000 })
    return r.stdout ?? ''
  } catch {
    return ''
  }
}

/** 把窗口句柄恢复到前台。 */
function focusHandle(handle) {
  const script = `
$ErrorActionPreference = 0
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DshFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
$target = [IntPtr]${handle}
if ($target -eq [IntPtr]::Zero) { exit 0 }
$dll = [DshFocus]
# 已最小化就先还原
if ($dll::IsIconic($target)) { $dll::ShowWindow($target, 9) | Out-Null }
$fg = $dll::GetForegroundWindow()
$fgThread = if ($fg -ne [IntPtr]::Zero) { $dll::GetWindowThreadProcessId($fg, [IntPtr]::Zero) } else { 0 }
$curThread = $dll::GetCurrentThreadId()
# 后台进程直接 SetForegroundWindow 会被 Windows 拒绝，必须 attach 线程
if ($fgThread -ne 0 -and $fgThread -ne $curThread) { $dll::AttachThreadInput($curThread, $fgThread, $true) | Out-Null }
$dll::ShowWindow($target, 9) | Out-Null
$dll::BringWindowToTop($target) | Out-Null
$ok = $dll::SetForegroundWindow($target)
if ($fgThread -ne 0 -and $fgThread -ne $curThread) { $dll::AttachThreadInput($curThread, $fgThread, $false) | Out-Null }
if ($ok) { Write-Output "FOCUSED" }
`
  const out = runPowerShell(script)
  return /FOCUSED/.test(out ?? '')
}

/**
 * 反复尝试置前，直到成功或超时。
 *
 * 浏览器启动要几秒（实测约 7 秒才出现窗口），一次性调用很可能扑空 ——
 * 所以这里按间隔重试一段时间。
 *
 * @param {string} needle profile 路径
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 * @returns {Promise<boolean>} 是否成功置前过
 */
export async function focusBrowserWindow(needle, { timeoutMs = 30000, intervalMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (focusWindowByCmdline(needle)) return true
    } catch { /* 忽略，继续轮询 */ }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}