/**
 * 配置安全的离线自测（不联网、不花额度）。
 *
 * 这一组盯的是「配置会不会莫名其妙丢」——这类问题平时看不见，一旦发生用户
 * 往往完全无从查起（Key 没了、通道顺序没了、文件读不出来）。三条主线：
 *
 *   1. 原子写：崩溃/并发不会留下半截 JSON
 *   2. 损坏留证：读失败时留一份 .corrupt 现场，而不是静默吞掉
 *   3. 空串 = 不修改：设置页不回显明文 Key，表单里那项恒为空；
 *      如果把空串当值写回去，用户「只改个 model」就会把 Key 抹掉
 *
 * 用法：node scripts/verify-config-safety.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  readGptDownloadDir, readImageConfigRaw, readJson, writeGptDownloadDir,
  writeImageConfigPatch, writeJson,
} from '../src/paths.js'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cfg-safety-'))
console.log(`临时目录：${scratch}\n`)

console.log('\n[1] 原子写：不会留下半截文件')
{
  const dir = path.join(scratch, 'atomic')
  const f = path.join(dir, 'cfg.json')
  writeJson(f, { a: 1, note: 'hello' })
  ok(JSON.stringify(readJson(f)) === '{"a":1,"note":"hello"}', '正常写入可读回')
  ok(fs.readdirSync(dir).every((x) => !x.includes('.tmp')), '写完不留 .tmp 残留')

  const src = fs.readFileSync(new URL('../src/paths.js', import.meta.url), 'utf8')
  const fn = /export function writeJson\(file, value\) \{[\s\S]*?\n\}/.exec(src)?.[0] ?? ''
  ok(fn.includes('renameSync'), '用 rename 做最终替换（原子）')
  ok(/const tmp = /.test(fn), '先写临时文件')
  const iTmp = fn.indexOf('writeFileSync(tmp')
  const iRename = fn.indexOf('renameSync(tmp, file)')
  ok(iTmp >= 0 && iRename > iTmp, '顺序是「先写 tmp 再 rename」')
  ok(/rmSync\(tmp/.test(fn), '失败时清理临时文件')
}

console.log('\n[2] 损坏的配置文件：留证据而不是静默吞掉')
{
  const dir = path.join(scratch, 'corrupt')
  const f = path.join(dir, 'cfg.json')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(f, '{ 半个 JSON')
  ok(readJson(f) === undefined, '损坏时返回 undefined（调用方不会崩）')
  ok(fs.readdirSync(dir).some((x) => x.includes('.corrupt-')), '损坏文件被另存为 .corrupt-<ts>，留现场')
  const kept = fs.readdirSync(dir).find((x) => x.includes('.corrupt-'))
  ok(fs.readFileSync(path.join(dir, kept), 'utf8') === '{ 半个 JSON', '备份内容与原文件一致')

  const before = fs.readdirSync(dir).length
  ok(readJson(path.join(dir, 'missing.json')) === undefined, '读不存在的文件返回 undefined')
  ok(fs.readdirSync(dir).length === before, '「文件不存在」是正常情况，不产生 .corrupt 垃圾')
}

console.log('\n[3] 空串 = 不修改（设置页只改一项不该抹掉其他项）')
{
  const home = path.join(scratch, 'h1')
  writeImageConfigPatch(home, { baseURL: 'https://api.example.com/v1', apiKey: 'sk-precious', model: 'gpt-image' })

  // 设置页 GET 不回显 Key → 表单里 apiKey 恒为 '' → 用户只改 model 后保存
  writeImageConfigPatch(home, { baseURL: 'https://api.example.com/v1', apiKey: '', model: 'gpt-image-2.5' })
  const after = readImageConfigRaw(home)
  ok(after.apiKey === 'sk-precious', '只改 model 时 apiKey 保住（这正是修复前的数据丢失 bug）', after.apiKey)
  ok(after.model === 'gpt-image-2.5', 'model 确实被更新')
  ok(after.baseURL === 'https://api.example.com/v1', 'baseURL 未受影响')

  // 显式 clear 仍然能真清空（不能把「清空」功能一起堵死）
  writeImageConfigPatch(home, { apiKey: '', clear: true })
  ok(readImageConfigRaw(home).apiKey === '', 'clear:true 仍能真正清空 Key（没有把功能堵死）')
}

console.log('\n[4] 目录配置：空串在这里是**合法值**（reset 用）')
{
  const home = path.join(scratch, 'h2')
  writeGptDownloadDir(home, '/custom/img')
  ok(readGptDownloadDir(home) === '/custom/img', '图片目录写入正常')

  // ⚠️ 这里跟 image.json 的规则**故意不同**：`/taptap-gpt dir --reset`
  // 就是靠传空串来「恢复跟随项目」的，所以不能把空串拦成「不修改」。
  writeGptDownloadDir(home, '')
  ok(readGptDownloadDir(home) === '', '空串在此处表示「恢复默认」（reset 的既有语义，不能改）')

  const src = fs.readFileSync(new URL('../src/taptap-gpt.mjs', import.meta.url), 'utf8')
  ok(/writeGptDownloadDir\(home, ''\)/.test(src), 'reset 走的是显式传空串，与其它配置区分开')
}

console.log('\n[5] 同一套规则覆盖到视频中转站配置')
{
  const src = fs.readFileSync(new URL('../src/paths.js', import.meta.url), 'utf8')
  const fn = /export function writeVideoRelayConfigPatch[\s\S]*?return merged\n\}/.exec(src)?.[0] ?? ''
  ok(fn.length > 0, '能找到 writeVideoRelayConfigPatch')
  ok(/patch\[key\]\.trim\(\) === ''/.test(fn), '中转站配置也把空串视为「不修改」')
  ok(/patch\.clear === true/.test(fn), '支持 clear:true 显式清空')
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)