/**
 * 防呆护栏的离线自测（不联网、不花额度）。
 *
 * 这些护栏的目的是「宁可多问一次，也不要替用户毁掉东西」，所以测的重点不是
 * 功能，而是**默认情况下确实会停下来**：
 *   1. 没授权时必须拒绝（而不是默默执行，也不是默默跳过）
 *   2. 带了 --yes / 用户明说才放行
 *   3. 用户已选定的配置（模型 / 通道顺序 / 开关）改之前必须问
 *   4. 注入给 agent 的清单与代码里的护栏一一对得上（防止文档写了但代码没拦）
 *
 * 用法：node scripts/verify-guards.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  AGENT_DO_NOT_SELF_RUN, USER_OWNED_SETTINGS, guardUserSetting, guardrailLines, hasApproval, requireApproval,
} from '../src/guards.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

console.log('\n[1] 显式授权识别')
{
  ok(hasApproval('/taptap-skills reset --yes'), '--yes 视为授权')
  ok(hasApproval('/taptap-skills reset --force'), '--force 视为授权')
  ok(hasApproval('run -y'), '-y 视为授权')
  ok(hasApproval('确认'), '用户说「确认」视为授权')
  ok(hasApproval('确定。'), '带句号也算授权')
  ok(hasApproval('清空禁用表，确认'), '句尾的「确认」也算')
  ok(!hasApproval('确认清空'), '「确认」后接动词不算授权（要求独立成句）')
  ok(!hasApproval('/taptap-skills reset'), '裸命令不算授权')
  ok(!hasApproval('/taptap-video use a.mp4'), '普通命令不算授权')
  ok(!hasApproval(''), '空输入不算授权')
  ok(!hasApproval('/taptap-video prompt 确认一下'), '提示词里出现「确认」不应误判为授权')
  ok(!hasApproval('/taptap-video prompt 确定角色朝向'), '提示词里出现「确定」不应误判为授权')
}

console.log('\n[2] 破坏性动作：默认停下')
{
  const gate = requireApproval({
    rawInput: '/taptap-skills reset',
    action: '清空 skill 禁用表',
    consequence: '当前禁用 12 个 skill',
    undo: '/taptap-skills restore',
  })
  ok(gate.ok === false, '没授权 → 拒绝执行')
  ok(/清空 skill 禁用表/.test(gate.text), '说清楚要做什么')
  ok(/当前禁用 12 个/.test(gate.text), '说清楚后果是什么')
  ok(/restore/.test(gate.text), '给出撤销方式')
  ok(/--yes/.test(gate.text), '告诉用户怎么授权')
  ok(requireApproval({ rawInput: 'reset --yes' }).ok === true, '带 --yes → 放行')
}

console.log('\n[3] 用户已选定的配置：改之前必须问')
{
  const g1 = guardUserSetting('model', { rawInput: '/taptap-video set --model X', from: 'MiniMax-H3', to: 'X' })
  ok(g1.ok === false, '改模型 → 拒绝（视频按秒计费）')
  ok(/MiniMax-H3/.test(g1.text) && /\bX\b/.test(g1.text), '把「现在是什么 / 想改成什么」都讲清楚')

  const g2 = guardUserSetting('lanes.order', { rawInput: 'lanes --order a,b', from: 'a → b', to: 'b → a' })
  ok(g2.ok === false, '改通道顺序 → 拒绝（可能走到要花钱的另一条）')

  const g3 = guardUserSetting('lanes.autoFallback', { rawInput: 'x' })
  ok(g3.ok === false, '改自动回退开关 → 拒绝')

  ok(guardUserSetting('model', { rawInput: 'set --model X --yes' }).ok === true, '带 --yes → 放行')
  ok(guardUserSetting('model', { rawInput: '确认，换成 X' }).ok === true, '用户明说 → 放行')

  // 不在保护清单里的键（比如抽帧张数）应放行 —— 护栏不能把插件变成什么都问。
  ok(guardUserSetting('frameCount', { rawInput: 'frames --count 8' }).ok === true, '非用户决策项放行（不能什么都要问）')
  ok(guardUserSetting('不存在的键', { rawInput: '' }).ok === true, '未知键放行（默认不拦）')
}

console.log('\n[4] 受保护配置清单本身')
{
  for (const k of ['model', 'lanes.order', 'lanes.enabled', 'lanes.autoFallback']) {
    ok(Object.prototype.hasOwnProperty.call(USER_OWNED_SETTINGS, k), `${k} 在受保护清单里`)
  }
  ok(Object.values(USER_OWNED_SETTINGS).every((v) => typeof v === 'string' && v.length > 0), '每一项都有中文说明（报错要说人话）')
}

console.log('\n[5] 注入 agent 的守则与代码护栏对得上')
{
  const lines = guardrailLines()
  ok(lines.length > 0, 'guardrailLines 有内容')
  const text = lines.join('\n')
  for (const item of AGENT_DO_NOT_SELF_RUN) {
    ok(text.includes(item), `清单项已注入守则：${item.slice(0, 28)}…`)
  }
  ok(/--yes/.test(text), '守则里说明了 --yes 机制')
  ok(/不要试图绕过/.test(text), '明确禁止 AI 绕过护栏（反复重试 / 换说法）')
  ok(/由用户决定/.test(text), '要求「说出来即可」，把决定权交回用户')

  // index.js 真的 import 并用上了这些护栏（文档写了但代码没接 = 白写）
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok(/from '\.\/src\/guards\.mjs'/.test(src), 'index.js 引入了 guards.mjs')
  ok(/guardrailLines\(\)/.test(src), 'index.js 把守则注入了 system prompt')
  ok(/requireApproval\(/.test(src), 'index.js 用上了 requireApproval（skills reset）')
  ok(/guardUserSetting\(/.test(src), 'index.js 用上了 guardUserSetting（模型 / 通道）')
  const uses = (src.match(/guardUserSetting\(/g) ?? []).length
  ok(uses >= 3, `至少 3 处配置写入被拦（实测 ${uses} 处）`)
}

console.log('\n[6] 护栏不制造「假成功」')
{
  // 拒绝时必须带说明，且不能让调用方误以为已经执行了。
  const g = guardUserSetting('model', { rawInput: 'x', from: 'a', to: 'b' })
  ok(typeof g.text === 'string' && g.text.length > 0, '拒绝时一定带可读说明')
  ok(!('value' in g), '拒绝时不返回任何「已执行」痕迹')
  const g2 = requireApproval({ rawInput: '', action: '删文件', consequence: '不可恢复' })
  ok(g2.text.includes('不可恢复'), '后果如实写出，不淡化风险')
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)