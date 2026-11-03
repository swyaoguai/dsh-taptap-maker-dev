/**
 * Windows 子进程调用的安全性（离线自测，不联网、不启动浏览器）。
 *
 * 盯的是一个**实打实的命令注入**：网页生图与 BGM 在超时后要按 profile 路径
 * 清理残留的 Chromium，原来把路径直接拼进 PowerShell 的单引号字符串：
 *
 *   Where-Object { $_.CommandLine -like '*${prof}*' }
 *
 * PowerShell 的单引号字符串里，单引号必须写成两个才表示一个。所以路径里只要
 * 出现一个 `'`（用户名 O'Brien、把 DSH_HOME 指到带引号的目录…），字符串就会
 * 提前闭合，后面的内容被当成命令执行。这里验证：
 *
 *   1. 转义函数正确（往返一致）
 *   2. 通配符 `*` `?` 不会破坏 -like 模式
 *   3. 源码里不再有任何「路径直接拼进 PowerShell」的写法
 *   4. 转义后的字符串在真实 PowerShell 里能还原成原值
 *
 * 用法：node scripts/verify-win-proc.mjs
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

import { countProcessesContaining, psSingleQuote } from '../src/win-proc.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

console.log('\n[1] 单引号转义')
{
  ok(psSingleQuote('abc') === "'abc'", '普通字符串原样包起来', psSingleQuote('abc'))
  ok(psSingleQuote("O'Brien") === "'O''Brien'", '单引号被写成两个', psSingleQuote("O'Brien"))
  ok(psSingleQuote("a'b'c") === "'a''b''c'", '多个单引号逐个转义', psSingleQuote("a'b'c"))
  ok(psSingleQuote("x'; rm -rf /; '") === "'x''; rm -rf /; '''", '典型注入串被完全中和', psSingleQuote("x'; rm -rf /; '"))
  ok(psSingleQuote('') === "''", '空串也不破语法')
}

console.log('\n[2] 匹配模式：不用 -like，且不会前缀误配')
{
  const src = fs.readFileSync(new URL('../src/win-proc.mjs', import.meta.url), 'utf8')
  // 只看代码行（模块注释里仍引用旧的 -like 写法作为反例，不能算违规）
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  ok(/function psCommandLineMatch/.test(code), '有统一的命令行匹配构造器')
  ok(code.includes('[regex]::Escape'), 'needle 先做 regex 转义（路径里的 [ ] . 不再当元字符）')
  ok(code.includes('(?!['), '带负向前瞻：不把 -gpt / -bgm-a 这类兄弟目录当成同一个 profile')
  ok(!/-like\s+'\*\$\{/.test(code), '不再把变量拼进 -like 单引号模式')

  // 行为验证（不依赖 PowerShell）：同样的语义在 JS 里跑一遍
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = (needle) => new RegExp(esc(needle) + '(?![\\w.-])')
  const cmd = (...parts) => parts.join(' ')
  ok(matcher('C:\\p\\browser-profile').test(cmd('chrome.exe', '--user-data-dir=C:\\p\\browser-profile')),
    '命中自己的 profile')
  ok(!matcher('C:\\p\\browser-profile').test(cmd('chrome.exe', '--user-data-dir=C:\\p\\browser-profile-gpt')),
    '不误杀 browser-profile-gpt（前缀误配回归）')
  ok(!matcher('C:\\p\\bgm-a').test(cmd('chrome.exe', '--user-data-dir=C:\\p\\bgm-ab')),
    '不误杀 bgm-ab')
  ok(matcher('C:\\p[a]\\prof').test(cmd('chrome.exe', '--user-data-dir=C:\\p[a]\\prof')),
    '路径带方括号也能命中（旧 -like 写法会失败）')
}

console.log('\n[3] 源码里不再有裸拼接')
{
  for (const f of ['game-image-web.mjs', 'game-bgm-web.mjs', 'audio-library.mjs']) {
    const s = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
    // 只看真正的代码行（跳过注释），确认没有把变量塞进 PowerShell 单引号串
    const code = s.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n')
    ok(!/-like\s+'\*\$\{/.test(code), `${f} 代码里没有把变量直接拼进单引号模式`)
    const DOLLAR = '$'
    ok(!/-LiteralPath\s+'/.test(code), f + " 没有未转义的 -LiteralPath '" + DOLLAR + "{...}'")
    ok(!/DestinationPath\s+'/.test(code), f + " 没有未转义的 -DestinationPath '" + DOLLAR + "{...}'")
    // 「双写反斜杠」是旧转义；pyStr 是 Python 单引号转义（不同东西），排除它
    const legacy = code.split('\n').filter((l) => /replace\(\/\\\\\/g, '\\\\\\\\'\)/.test(l) && !l.includes('pyStr'))
    ok(legacy.length === 0, `${f} 没有残留旧的「双写反斜杠」PowerShell 转义`, legacy.join(' | '))
    ok(/win-proc\.mjs/.test(s), `${f} 引入了 win-proc`)
    ok(/psSingleQuote|killProcessesContaining|countProcessesContaining/.test(s), `${f} 用了统一的转义实现`)
  }
}

console.log('\n[4] 真实 PowerShell 里往返一致')
{
  const cases = [
    'C:\\Users\\test\\.dsh\\browser-profile',
    "C:\\Users\\O'Brien\\.dsh\\browser-profile",
    "C:\\a'b\\c''d",
    "C:\\x' ; Write-Output 'INJECTED' ; '",
  ]
  for (const v of cases) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `Write-Output ${psSingleQuote(v)}`], { encoding: 'utf8' })
    const got = (r.stdout ?? '').trim()
    ok(got === v, `往返一致: ${v.slice(0, 40)}`, got)
  }
}

console.log('\n[5] 实际调用不会崩、不会误杀')
{
  const t = Date.now()
  const n = countProcessesContaining('C:\\definitely\\not\\here-12345')
  ok(Number.isFinite(n) && n >= 0, `count 返回合理数字（${n}），耗时 ${Date.now() - t}ms`)
  ok(n === 0, '不存在的路径返回 0')
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)