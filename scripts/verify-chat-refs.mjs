/**
 * 对话入口（斜杠命令）的图生图参数解析验证 —— 纯字符串逻辑，不联网。
 *
 * 守的是「功能做了但入口没接」这类 bug：
 *  1. --ref 能从命令原文解析出来（可重复、逗号分隔、带引号路径）
 *  2. --ref 必须从提示词里剥掉（否则会被当成文字要求发给模型）
 *  3. 没有描述时报错，而不是发一个空提示词
 */
import fs from 'node:fs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')

// 与 index.js 里 /taptap-gpt handler 完全相同的两段表达式（源码断言 + 逻辑复刻）
const refsRe = /(?:--ref(?:erence)?s?|-r)\s+(?:"([^"]+)"|(\S+))/g

function parseRefs(raw) {
  const out = []
  for (const m of raw.matchAll(refsRe)) {
    const value = m[1] ?? m[2] ?? ''
    for (const part of value.split(',')) {
      const p = part.trim()
      if (p.length > 0) out.push(p)
    }
  }
  return out
}

function stripPrompt(raw) {
  return raw
    .replace(/(?:--downscale|-d)\s+\d+x\d+/g, '')
    .replace(/(?:--account|-a)\s+\S+/g, '')
    .replace(/(?:--ref(?:erence)?s?|-r)\s+(?:"[^"]+"|\S+)/g, '')
    .trim()
}

console.log('\n[1] 入口确实把参考图接到两条通道上（源码契约）')
{
  // 这是本轮修复的核心：以前 gptOpts 只传 {accountId, downscale}，refs 被丢掉。
  ok(/gptOpts:\s*\{[\s\S]{0,200}?references:\s*refs/.test(src), '网页通道 gptOpts 传了 references')
  ok(/relayOpts:\s*\{[\s\S]{0,300}?in:\s*refs\[0\]/.test(src), '中转站单图回退传了 in')
  ok(/relayOpts:\s*\{[\s\S]{0,300}?in:\s*refs\b/.test(src), '中转站多图回退传了 in 数组')
  ok(/raw\.matchAll\(\/\?:\?--ref/.test(src) || /--ref\(\?:erence\)\?s\?/.test(src) || /matchAll\([\s\S]{0,40}--ref/.test(src), '命令里解析 --ref 参数')
}

console.log('\n[2] --ref 解析：重复 / 逗号 / 引号路径')
{
  ok(parseRefs('画猫 --ref a.png').join('|') === 'a.png', '单个 --ref')
  ok(parseRefs('画猫 --ref a.png --ref b.png').join('|') === 'a.png|b.png', '重复 --ref')
  ok(parseRefs('画猫 --ref a.png,b.png').join('|') === 'a.png|b.png', '逗号分隔')
  ok(parseRefs('画猫 --refs a.png b.png').join('|') === 'a.png', '--refs 只吃紧随的一个值（b.png 留在提示词）')
  // 带空格路径必须用引号
  ok(parseRefs('画猫 --ref "C:/a b/x.png"').join('|') === 'C:/a b/x.png', '带引号的空格路径')
  ok(parseRefs('画猫 -r a.png').join('|') === 'a.png', '短开关 -r')
  ok(parseRefs('画猫').length === 0, '没有 --ref 时为空')
  ok(parseRefs('画猫 --reference x.png,y.png,z.png').join('|') === 'x.png|y.png|z.png', '--reference 长名 + 多值')
}

console.log('\n[3] 提示词里必须剥掉参数（否则会被当成文字要求）')
{
  ok(stripPrompt('改成水彩风 --ref a.png').includes('--ref') === false, '--ref 已从提示词剥离')
  ok(stripPrompt('改成水彩风 --ref a.png') === '改成水彩风', '剥离后只剩描述')
  ok(stripPrompt('改成水彩风 --ref "C:/a b/x.png"') === '改成水彩风', '带引号路径也能剥离')
  ok(stripPrompt('画猫 --downscale 128x128') === '画猫', '--downscale 仍被剥离（既有行为）')
  ok(stripPrompt('画猫 --account acc1') === '画猫', '--account 仍被剥离（既有行为）')
  ok(stripPrompt('画猫 -r a.png -d 64x64') === '画猫', '短开关组合也能剥离')
}

console.log('\n[4] 空提示词明确报错（不发空描述）')
{
  ok(/请给一句图片描述/.test(src), '提示词为空时给出明确提示')
  ok(/图生图：\/taptap-gpt/.test(src), '提示里带图生图用法示例')
}

console.log('\n[5] /taptap-image 命令也有图生图入口（不再只能从 /taptap-gpt 走）')
{
  // 本轮修复：该命令原先只有文生图分支，--ref 会原样混进提示词、
  // 图生图在对话里根本触发不了。
  ok(/relayRefs/.test(src), '命令里收集了 relayRefs')
  ok(/relayRefs\.length > 0\s*\?\s*\[cli, 'edit'/.test(src), '有参考图时走 edit 子命令')
  ok(/argv\.push\('--in', ref\)/.test(src), '把每张参考图作为 --in 传给 CLI')
  ok(/--multi-ref\\b/.test(src) && /--single-ref\\b/.test(src), '把 --multi-ref / --single-ref 透传给 CLI')
  ok(/图生图需要一句/.test(src), '只有参考图没有描述时明确报错')
  ok(/中转站图生图/.test(src), '失败时的文案区分图生图与文生图')
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
