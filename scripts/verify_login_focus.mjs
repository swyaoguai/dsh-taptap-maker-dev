/**
 * 登录窗口「必须让用户看得见」的回归测试。
 *
 * 背景（2026-10-23 用户反馈：点「添加账号」不跳登录、点「登录」也没用）：
 * 查下来**后端其实一直是好的** —— 浏览器确实启动了、profile 也建了、cookie 也能读到。
 * 真正的问题是：Chromium 窗口**开在 DSH 窗口后面**，从来没被拉到前台。
 * 用户点完按钮什么都没发生，于是以为按钮坏了。
 *
 * 验证：
 *   1. runBrowser 在 headed 模式下主动置前（两条链路都要）
 *   2. 置前按 profile 路径匹配，而不是「抓最新的 chrome」
 *   3. 置前失败不影响主流程
 *   4. /gpt-pool add 直接启动登录，不再要求用户再点一次
 *
 * 用法：node scripts/verify-login-focus.mjs
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log('  ✓ ' + label) }
  else { failed += 1; console.log('  ✗ ' + label + (extra ? ' — ' + extra : '')) }
}

const Q = String.fromCharCode(39)
const POOL_ANCHOR = 'sub === ' + Q + 'gpt-pool' + Q
const ADD_ANCHOR = 'if (action === ' + Q + 'add' + Q + ')'
const LOGIN_TOKEN = Q + 'login' + Q

const gptSrc = fs.readFileSync(new URL('../src/taptap-gpt.mjs', import.meta.url), 'utf8')
const bgmSrc = fs.readFileSync(new URL('../src/taptap-bgm-web.mjs', import.meta.url), 'utf8')
const idxSrc = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const cliSrc = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const focusSrc = fs.readFileSync(new URL('../src/win-focus.mjs', import.meta.url), 'utf8')

const bodyOf = (src, name) => {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) return ''
  const end = src.indexOf('\nfunction ', start + 10)
  return src.slice(start, end < 0 ? src.length : end)
}

console.log('\n[1] 两条链路的 runBrowser 都会主动把窗口拉到前台')
{
  const pairs = [['taptap-gpt.mjs', gptSrc], ['taptap-bgm-web.mjs', bgmSrc]]
  for (const pair of pairs) {
    const name = pair[0]
    const fn = bodyOf(pair[1], 'runBrowser')
    ok(fn.length > 0, name + ' 找到 runBrowser')
    ok(fn.includes('focusBrowserWindow('), name + ' 调用了置前')
    ok(/setTimeout\([\s\S]{0,200}focusBrowserWindow/.test(fn), name + ' 置前放在定时器里')
    ok(fn.includes('const focusTimer = headless'), name + ' headless 时不做')
    ok(fn.includes('只是提升可见性'), name + ' 置前失败被吞掉')
    const clears = fn.split('clearTimeout(focusTimer)').length - 1
    ok(clears >= 3, name + ' 三条收尾路径都清定时器（实测 ' + clears + ' 处）')
  }
}

console.log('\n[2] 置前按 profile 路径匹配，不抓「最新 chrome」')
{
  ok(focusSrc.includes('CommandLine -like'), '用命令行匹配 profile 路径')
  ok(focusSrc.includes('--type=*'), '排除 helper 进程，只找主窗口')
  ok(!focusSrc.includes('MainWindowTitle -match'), '不会按标题乱抓用户自己的窗口')
  ok(focusSrc.includes('AttachThreadInput'), '用 AttachThreadInput 绕过抢焦点限制')
  ok(focusSrc.includes('SetForegroundWindow'), '最终调用 SetForegroundWindow')
  ok(focusSrc.includes('IsIconic') && focusSrc.includes('ShowWindow($target, 9)'), '最小化的窗口先还原')
  ok(focusSrc.includes('timeoutMs') && focusSrc.includes('intervalMs'), '支持轮询重试')
  ok(focusSrc.includes("process.platform !== 'win32'"), '非 Windows 直接返回')
}

console.log('\n[3] 转义：路径含单引号时不能被当成命令')
{
  ok(focusSrc.includes("replace(/'/g, \"''\")"), '单引号被转义（与 win-proc 一致）')
  ok(focusSrc.includes('[?]') && focusSrc.includes('[*]'), '-like 模式里的 * ? 被转义')
  const ps = 'Write-Output ' + Q.replace(Q, Q + Q) + 'O' + Q + Q + 'Brien' + Q.replace(Q, Q + Q)
  const probe = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  ok(/Brien/.test(probe.stdout ?? ''), 'PowerShell 侧解析正常', (probe.stdout ?? '').trim())
}

console.log('\n[4] 「添加并登录」是服务端一步到位')
{
  const poolRoute = idxSrc.indexOf(POOL_ANCHOR)
  ok(poolRoute > 0, '找到 /gpt-pool 路由')
  const addAt = idxSrc.indexOf(ADD_ANCHOR, poolRoute)
  const addBlock = addAt > 0 ? idxSrc.slice(addAt, addAt + 1500) : ''
  ok(addBlock.length > 0, '找到 add 分支')
  ok(addBlock.includes(LOGIN_TOKEN) && addBlock.includes('spawn('), 'add 时服务端直接 spawn 登录')
  ok(addBlock.includes('--account'), '带上新账号 id（独立 profile）')
  ok(addBlock.includes('warn'), '启动失败用 warn 如实说明')
  ok(addBlock.includes('parsed.login !== false'), '允许显式关闭自动登录')

  const addStart = cliSrc.indexOf('const addAndLogin = useCallback')
  // client.js 里有两个 addAndLogin（BGM 卡 + 生图卡），这里要的是**生图卡**那个 ——
// 用「它请求 /gpt-pool」来定位，避免拿到 BGM 卡的同名函数。
const allAdds = []
let at = 0
while (true) {
  const i = cliSrc.indexOf('const addAndLogin = useCallback', at)
  if (i < 0) break
  allAdds.push(i)
  at = i + 10
}
let addSlice = ''
for (const start of allAdds) {
  const slice = cliSrc.slice(start, start + 1400)
  if (slice.includes('gpt-pool')) { addSlice = slice; break }
}
ok(addSlice.length > 0, '找到「生图卡」的 addAndLogin（不是 BGM 卡那个）')
ok(!addSlice.includes('API_BASE}/gpt-login'), '前端不再重复调用 /gpt-login（否则会弹两次窗口）')
ok(addSlice.includes('login: true'), '前端要求服务端顺便开登录')
ok(addSlice.includes('waitForLogin(id)'), 'add 完进入轮询等待')
  ok(/const waitForLogin = useCallback\(\(account\) => \{[\s\S]{0,200}setBusy\(/.test(cliSrc),
    'waitForLogin 自己置 busy')
}

console.log('\n[5] 登录判定逻辑没被改坏')
{
  ok(gptSrc.includes('__Secure-next-auth.session-token'), '只认真正的 session cookie')
  ok(gptSrc.includes('launch_persistent_context(${pyStr(prof)}'), '用账号各自的 profile')
  ok(gptSrc.includes('wait_for_timeout'), '仍等待用户完成登录')
}

console.log('\n结果：' + passed + ' 项通过，' + failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)