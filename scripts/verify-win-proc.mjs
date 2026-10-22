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

console.log('\n[2] -like 通配符：路径里的 * 和 ? 不能被当模式')
{
  const src = fs.readFileSync(new URL('../src/win-proc.mjs', import.meta.url), 'utf8')
  ok(/psLikePattern/.test(src), '有专门处理 -like 通配符的函数')
  ok(src.includes('[*]'), '星号被转成 [*]（避免被当成 -like 通配符）')
  ok(src.includes('[?]'), '问号被转成 [?]')
  // 转义后的模式里必须没有裸露的 * / ?
  const fnBody = /function psLikePattern[\s\S]*?\n\}/.exec(src)?.[0] ?? ''
  ok(fnBody.length > 0, '找到 psLikePattern 实现')
  ok(fnBody.includes("replace(/'/g, \"''\")"), '单引号先转义')
}

console.log('\n[3] 源码里不再有裸拼接')
{
  for (const f of ['taptap-gpt.mjs', 'taptap-bgm-web.mjs', 'audio-library.mjs']) {
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