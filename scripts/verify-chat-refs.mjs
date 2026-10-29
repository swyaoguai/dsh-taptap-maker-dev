/**
 * 对话入口的图生图参数验证：调用真实解析器，不联网、不生成。
 * 网页与中转站只消费各自支持的参数，不把未知参数偷偷当成设置。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSlashGenArgs } from '../src/taptap-gpt.mjs'
import { parseSlashArgs } from '../src/taptap-image.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

console.log('\n[1] 同一份参考图传到网页和中转站（入口契约）')
{
  const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  // Follow the binding instead of assuming the pre-refactor gen/genRefs names.
  const refs = /const\s+(\w+)\s*=\s*genArgs\.refs/.exec(src)?.[1]
  ok(Boolean(refs), '命令层使用真实解析器的 refs')
  ok(Boolean(refs) && new RegExp(`gptOpts:\\s*\\{[\\s\\S]{0,350}?references:\\s*${refs}\\b`).test(src), '网页通道传递同一份 refs')
  ok(Boolean(refs) && new RegExp(`relayOpts:\\s*\\{[\\s\\S]{0,400}?in:\\s*${refs}\\[0\\]`).test(src), '中转站单图传递第一张')
  ok(Boolean(refs) && new RegExp(`relayOpts:\\s*\\{[\\s\\S]{0,450}?in:\\s*${refs}\\s*\\}`).test(src), '中转站多图传递完整数组')
}

console.log('\n[2] 网页参考图解析：重复、逗号、引号路径')
{
  const refs = (raw) => parseSlashGenArgs(raw).refs
  ok(refs('画猫 --ref a.png').join('|') === 'a.png', '单个 --ref')
  ok(refs('画猫 --ref a.png --ref b.png').join('|') === 'a.png|b.png', '重复 --ref')
  ok(refs('画猫 --ref a.png,b.png').join('|') === 'a.png|b.png', '逗号分隔')
  ok(refs('画猫 --reference x.png y.png').join('|') === 'x.png', '--reference 只消费紧随的值')
  ok(refs('画猫 --ref "C:/a b/x.png"').join('|') === 'C:/a b/x.png', '带空格的引号路径')
  ok(refs('画猫 -r a.png').join('|') === 'a.png', '短开关 -r')
  ok(refs('画猫').length === 0, '未指定参考图为空')
  ok(refs('画猫 --reference x.png,y.png,z.png').join('|') === 'x.png|y.png|z.png', '长名支持多值')
  ok(refs('画猫 --ref a.png --size 512x512').join('|') === 'a.png', '其他参数不影响参考图')
}

console.log('\n[3] 支持的参数必须从对应通道提示词里剥离')
{
  const webPrompt = (raw) => parseSlashGenArgs(raw).prompt
  ok(webPrompt('改成水彩风 --ref a.png') === '改成水彩风', '--ref 不混入提示词')
  ok(webPrompt('改成水彩风 --ref "C:/a b/x.png"') === '改成水彩风', '引号路径也正确剥离')
  ok(!webPrompt('画猫 --downscale 128x128').includes('--downscale'), '网页消费 --downscale')
  ok(!webPrompt('画猫 --account acc1').includes('--account'), '网页消费 --account')
  ok(webPrompt('画猫 -r a.png -d 64x64') === '画猫', '短开关组合剥离')
  const relayPrompt = (raw) => parseSlashArgs(raw).prompt
  ok(!relayPrompt('图标 --transparent').includes('--transparent'), '中转站消费 --transparent')
  ok(!relayPrompt('图标 --multi-ref').includes('--multi-ref'), '中转站消费 --multi-ref')
  ok(!relayPrompt('图标 --single-ref').includes('--single-ref'), '中转站消费 --single-ref')
  ok(!relayPrompt('图标 --size foo').includes('foo'), '中转站尺寸值不混入提示词')
  ok(webPrompt('图标 --size foo').includes('--size'), '网页未知参数原样保留，不擅自猜测')
}

console.log('\n[4] 空提示词给出明确错误')
{
  const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  ok(/请给一句图片描述/.test(src), '命令层拒绝空描述')
  ok(/图生图：\/taptap-gpt/.test(src), '错误附带图生图示例')
}

console.log('\n[5] 中转站真实解析器导出参考图、布尔开关与漏值')
{
  const parse = parseSlashArgs
  const ref = parse('改成赛博朋克风 --ref 角色.png')
  ok(ref.refs.length === 1 && ref.refs[0] === '角色.png', '参考图已收集')
  ok(ref.prompt.includes('赛博朋克'), '描述未被吞掉')
  ok(parse('图标 --multi-ref').multiRef === true, '多图开关为布尔')
  ok(parse('图标 --single-ref').singleRef === true, '单图开关为布尔')
  ok(!parse('图标').multiRef && !parse('图标').singleRef, '未指定的开关关闭')
  ok(parse('图标 --transparent').transparent === true, '透明开关为布尔')
  ok(!parse('图标').transparent, '未指定透明开关关闭')
  const missing = parse('改成风格 --ref --size 512x512')
  ok(missing.missing.includes('--ref'), '漏值已报告')
  ok(!missing.prompt.includes('512x512'), '其他参数的值未泄漏')
  const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  ok(/parseImageSlashArgs\(descRaw\)/.test(src), '命令使用真实共享解析器')
  ok(/relayParsed\.missing\.length > 0/.test(src), '命令消费漏值并停止')
  ok(/relayParsed\.refs/.test(src), '命令消费参考图数组')
}

console.log('\n[6] 尺寸格式与命令层漏值保护')
{
  // Do not detach RegExp.prototype.test from its receiver.
  const sizeValid = (value) => /^(\d+)x(\d+)$/.test(value)
  for (const value of ['foo', '1024', 'x512', '1024x512x768']) {
    ok(!sizeValid(value), `非法格式 ${value} 不被接受`)
  }
  ok(sizeValid('1024x1024'), '合法尺寸格式通过')
  const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  ok(/参数「.*」后面没有值/.test(src) || /missing-value/.test(src), '命令层明确报告漏值')
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
