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
  // 与 win-proc 同一判据：regex 转义 + 要求路径后面不是路径名字符，避免
  // `browser-profile` 误配 `browser-profile-gpt`（把别的通道的窗口抢到前台），
  // 也避免 -like 把路径里的 `[` 当字符类。
  const script = [
    '$ErrorActionPreference = 0',
    `$p = Get-CimInstance Win32_Process -Filter 'Name="${name}"' | `,
    `  Where-Object { $_.CommandLine -match ([regex]::Escape('${psNeedle}') + '(?![\\w.-])') -and $_.CommandLine -notlike '*--type=*' } | `,
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

/**
 * 把窗口句柄恢复到前台。
 *
 * ⚠️ 每次都必须带 Add-Type：runPowerShell 每次 spawn 一个**新的** powershell 进程，
 * Add-Type 定义的类型只活在那个进程里。以前用模块级标记「编译过就不再下发」，
 * 结果从第二次起 `[DshFocus]` 根本不存在，置前永远失败。
 * 编译开销只发生在真找到窗口句柄之后（focusWindowByCmdline 先查句柄），
 * 窗口未出现前的轮询不会触发编译。
 */
function focusHandle(handle) {
  const compile = `
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
`
  const script = `
$ErrorActionPreference = 0
${compile}
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
 * 间隔做成**渐进退避**（700ms 起步，逐次 ×1.5 封顶 3s）：窗口出现前每轮都是
 * 「查一遍进程 + 空手而归」，固定 700ms 意味着 30 秒窗口期要跑 ~40 次
 * PowerShell 子进程 —— 恰好撞上浏览器正在冷启动抢 CPU 的阶段（「添加账号
 * 卡顿」的另一半）。成功即返回，所以正常路径只跑 1~2 次。
 *
 * @param {string} needle profile 路径
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 * @returns {Promise<boolean>} 是否成功置前过
 */
export async function focusBrowserWindow(needle, { timeoutMs = 30000, intervalMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs
  let wait = Math.max(200, intervalMs)
  while (Date.now() < deadline) {
    try {
      if (focusWindowByCmdline(needle)) return true
    } catch { /* 忽略，继续轮询 */ }
    await new Promise((r) => setTimeout(r, wait))
    wait = Math.min(3000, Math.round(wait * 1.5))
  }
  return false
}