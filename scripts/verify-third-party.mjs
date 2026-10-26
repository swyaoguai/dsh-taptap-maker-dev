/**
 * 第三方开源整合的完整性检查（离线，不联网）。
 *
 * 守三件事：
 *  1. 两个整合技能能被 skill provider 正常发现（frontmatter 合法、分类正确）
 *  2. Apache-2.0 合规：致谢文件存在、写明仓库/许可证/版权、逐项列出整合内容
 *  3. 内容别被"优化"掉核心洞见：朝向算不出来、不许用代码补偿旋转、
 *     编译通过≠验证完成
 */
import fs from 'node:fs'
import path from 'node:path'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

console.log('\n[1] 两个整合技能存在且可被发现')
{
  const { TaptapSkillProvider } = await import('../src/skills-provider.js')
  const p = new TaptapSkillProvider('test', [{ dir: path.join(root, 'skills'), rank: 360 }], { disabledFile: null })
  const names = (p.listAll ? p.listAll() : []).map((s) => s.name)
  ok(names.includes('asset-orientation-qa'), 'asset-orientation-qa 被识别')
  ok(names.includes('asset-visual-qa'), 'asset-visual-qa 被识别')

  for (const [dir, expectName] of [['asset-orientation-qa', 'asset-orientation-qa'], ['asset-visual-qa', 'asset-visual-qa']]) {
    const text = read(`skills/${dir}/SKILL.md`)
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
    ok(fm.includes(`name: ${expectName}`), `${dir} frontmatter 的 name 正确`)
    ok(/^description: .{20,}/m.test(fm), `${dir} 有足够长的 description（供路由匹配）`)
    ok(fm.includes('adapted-from-GameFactory-3A'), `${dir} frontmatter 标注了整合来源`)
    ok(fm.includes('Apache-2.0'), `${dir} frontmatter 标注了许可证`)
    ok(/^thirdPartyLicense: Apache-2\.0$/m.test(fm), `${dir} 标明第三方许可证字段`)
    ok(/^thirdPartyModified: true$/m.test(fm), `${dir} 明确标记已修改`)
  }
}

console.log('\n[2] Apache-2.0 合规：致谢与出处')
{
  const notices = (() => { try { return read('THIRD-PARTY-NOTICES.md') } catch { return '' } })()
  ok(notices.length > 0, 'THIRD-PARTY-NOTICES.md 存在')
  ok(/OpenDCAI\/GameFactory-3A/.test(notices), '写明来源仓库')
  ok(/Apache License 2\.0|Apache-2\.0/.test(notices), '写明 Apache-2.0 许可证')
  ok(/Copyright OpenDCAI/i.test(notices), '保留版权归属')
  ok(/orientation_review\.md/.test(notices), '逐项指出整合的源文件')
  ok(/改写|重写/.test(notices), '说明是改写而非逐字复制（Apache-2.0 的修改声明）')
  ok(/未采用|不采用|未搬运|不搬运/.test(notices), '说明哪些部分没有采用及原因')
  ok(fs.existsSync(path.join(root, 'third_party', 'GameFactory-3A', 'LICENSE')),
    '随仓库保留上游 Apache-2.0 LICENSE 全文')
  const upstreamLicense = fs.existsSync(path.join(root, 'third_party', 'GameFactory-3A', 'LICENSE'))
    ? read('third_party/GameFactory-3A/LICENSE') : ''
  ok(/Apache License[\s\S]*Version 2\.0/.test(upstreamLicense), '上游 LICENSE 内容确实是 Apache-2.0 全文')

  // 包发布时必须带上（否则分发出去就没有版权声明）
  const pkg = JSON.parse(read('package.json'))
  ok(pkg.files.includes('THIRD-PARTY-NOTICES.md'), 'package.json files 里包含致谢文件')
  ok(pkg.files.includes('third_party/GameFactory-3A/LICENSE'), 'package.json files 里包含上游 LICENSE 全文')

  // README 里给用户看得见
  const readme = read('README.md')
  ok(/开源致谢/.test(readme), 'README 有「开源致谢」小节')
  ok(/GameFactory-3A/.test(readme), 'README 提到对方仓库')
  ok(/Apache-2\.0/.test(readme), 'README 写明 Apache-2.0')
}

console.log('\n[3] 核心洞见没有被"优化"掉')
{
  const orient = read('skills/asset-orientation-qa/SKILL.md')
  // 这是整个技能的存在理由：几何算不出朝向
  ok(/算不出来|无法.*计算|字节层面.*一致/.test(orient), '保留了「朝向无法由几何计算」这一核心')
  ok(/包围盒/.test(orient), '举了包围盒相同的例子')
  ok(/不要.*gameplay.*旋转|不在 gameplay 代码里.*旋转|绝不在 gameplay/.test(orient), '保留了「不要用代码补偿旋转」的硬规则')
  ok(/看不清|模糊|暧昧/.test(orient), '保留「看不清就说看不清」的原则')
  ok(/一条错误的记录|比没有记录更糟/.test(orient), '说明错记录的危害（比没有更糟）')
  // 题材判据表是可直接使用的部分
  for (const kw of ['人形', '载具', '枪械', '建筑']) ok(orient.includes(kw), `判据表覆盖：${kw}`)

  const visual = read('skills/asset-visual-qa/SKILL.md')
  ok(/编译通过 != 验证完成|编译通过 ≠ 验证完成/.test(visual), '保留「编译通过≠验证完成」')
  ok(/结构检查.*视觉可用|不是视觉可用/.test(visual), '保留「结构≠视觉」')
  ok(/build.*launch.*录|录一小段|证据视频/.test(visual), '保留「必须真的玩并录像」的闭环')
  for (const kw of ['朝向', '穿模', '光照', '可玩性', '风格匹配']) ok(visual.includes(kw), `复核维度覆盖：${kw}`)

  const gate = read('skills/asset-visual-qa/references/acceptance-gate.md')
  ok(/白盒/.test(gate), '验收门槛里区分了白盒阶段')
  ok(/不算.*验证|都不算/.test(gate), '列明哪些行为不算验证')
  ok(/能力不足|如实说|做不到/.test(gate), '保留「能力不足要如实说」')
}

console.log('\n[4] agent 守则里真的提到了这两个技能（否则等于没接上）')
{
  const idx = read('index.js')
  ok(/asset-orientation-qa/.test(idx), 'system prompt 提到 asset-orientation-qa')
  ok(/asset-visual-qa/.test(idx), 'system prompt 提到 asset-visual-qa')
  ok(/acceptance-gate\.md/.test(idx), 'system prompt 指向验收门槛文档')
}

console.log('\n[5] 没有把引擎专属代码搬进来')
{
  // 硬搬 UE5/Unity/Godot 的 API 会让 agent 调用不存在的接口，比没有更糟。
  const orient = read('skills/asset-orientation-qa/SKILL.md')
  const visual = read('skills/asset-visual-qa/SKILL.md')
  for (const [name, text] of [['orientation-qa', orient], ['visual-qa', visual]]) {
    ok(!/three\.assets\.set_orientation/.test(text), `${name} 没有搬运 three.js 专属 API 调用`)
    ok(!/set_orientation\(/.test(text), `${name} 没有搬运 three.js 的 set_orientation 调用`)
    ok(!/python pipeline\/assets_gen/.test(text), `${name} 没有搬运其 pipeline 命令行`)
  }
  // 但应当指向本插件自己的技能
  ok(/taptap-maker/.test(orient + visual), '指向本插件自己的 taptap-maker-* 技能')
}

console.log('\n[6] 不给出空指引 / 不误导（本轮修复）')
{
  const orient = read('skills/asset-orientation-qa/SKILL.md')

  // ❌ 曾经写「查 taptap-maker-core 里的轴向约定」—— 但那个技能里并没有这条，
  //    等于让 agent 白查一趟。现在必须明确说"本插件没有记录，需要自己实测"。
  ok(!/查 .{0,20}taptap-maker-core.{0,20}关于 Node 变换/.test(orient), '不再指向不存在的轴向文档')
  ok(/目前没有记录 UrhoX 的轴向约定/.test(orient), '如实说明本插件没有轴向约定记录')
  ok(/实测方法/.test(orient), '给出可执行的实测方法（而不是只让 agent 去查）')

  // ❌ 曾经说「写进资产自己的元数据（.meta）」—— 但 .meta 由 Maker 自动维护、
  //    只含 uuid，手改会被覆盖。必须明确排除 .meta。
  ok(!/写进\*\*资产自己的元数据\*\*（`\.meta`/.test(orient), '不再建议写进 .meta')
  ok(/不要写进 \.meta/.test(orient), '明确排除 .meta（引擎自动维护、只含 uuid）')
  ok(/assets-manifest\.json|GAME_RULES\.md/.test(orient), '给出正确的记录位置')

  // 拿多视角图必须有 Maker 里可执行的办法（原仓库有现成渲染工具，我们没有）
  ok(/在 TapTap Maker 里怎么拿到这些图/.test(orient), '补了 Maker 语境下的取图办法')
  ok(/orthoSize/.test(orient), '提醒四个视角要用同一 orthoSize（横向可比）')
  ok(/外部查看器/.test(orient) && /最终朝向结论必须在 Maker 里复核/.test(orient),
    '说明外部查看器的轴向可能不同，结论必须回 Maker 复核')

  // 动画名 / Root Motion 不能用来推断朝向（这是原仓库明确点出的坑）
  ok(/不能用来推断模型朝向|都不能用来推断/.test(orient), '明确动画名/Root Motion 不能推断朝向')

  // 引用的技能必须真实存在（防止写成指向空气的交叉引用）
  const cited = [...orient.matchAll(/skills\/([a-z0-9-]+)(?=[`\s）)】]|$)/g)].map((m) => m[1])
  const uniq = [...new Set(cited)]
  ok(uniq.length > 0, '技能里引用了其它技能')
  for (const name of uniq) {
    ok(fs.existsSync(path.join(root, 'skills', name, 'SKILL.md')), `交叉引用的 skills/${name} 真实存在`)
  }
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
