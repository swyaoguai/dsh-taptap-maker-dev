/**
 * 「不白烧额度」保护的离线自测（不联网、不花任何额度）。
 *
 * 背景：视频按秒计费。真实的坑是「提交请求其实成功了，但本地网络异常 /
 * 进程被打断，没拿到 task_id」—— 此时服务端已经在跑、额度可能已扣。看到
 * "提交失败" 就再跑一次，等于多花一份钱。这套测试守住这条线。
 *
 * 覆盖：
 *   1. 失败分类：传输层故障 = 结果未知；有 HTTP 状态码 = 服务端明确拒收
 *   2. 台账在**发请求前**就落盘（inflight），拿到 task_id 后 confirmed
 *   3. 结果未知时作业状态是 uncertain（**不是 error**），且再提交被拦
 *   4. 幂等键在同一轮重试里固定不变
 *   5. 轮询限流只提示退避，不改任务状态、不额外扣费
 *
 * 用法：node scripts/verify-no-waste.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { readSubmitLedger } from '../src/paths.js'
import { createJob, getJob, saveJob, setReference, submitJobVideo } from '../src/video-sequence.mjs'
import { ffmpegPath } from '../src/video-media.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-no-waste-'))
console.log(`临时目录：${scratch}\n`)

const src = fs.readFileSync(new URL('../src/video-sequence.mjs', import.meta.url), 'utf8')
const mmx = fs.readFileSync(new URL('../src/minimax-video.mjs', import.meta.url), 'utf8')

console.log('\n[1] 失败分类：区分「未知」与「明确拒收」')
{
  // isUncertainSubmit 是模块内私有函数，这里按源码断言它的判据。
  const body = /function isUncertainSubmit\(error\) \{[\s\S]*?\n\}/.exec(src)?.[0] ?? ''
  ok(body.length > 0, '能找到 isUncertainSubmit')
  ok(/status >= 400 && status < 600/.test(body), '有 HTTP 状态码 → 不算「未知」（服务端已明确答复）')
  for (const sig of ['fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'socket hang up']) {
    ok(body.includes(sig), `认得传输层故障：${sig}`)
  }
  // 传输层故障必须排在「有状态码」判断之后，否则 400 也会被当成未知。
  const iStatus = body.indexOf('status >= 400')
  const iFetch = body.indexOf('fetch failed')
  ok(iStatus >= 0 && iFetch > iStatus, '传输层判据在状态码判据之后（400 不会被误判为未知）')
}

console.log('\n[2] 台账 + 幂等键在代码里就位')
{
  const ledgerCalls = (src.match(/writeSubmitLedger\(/g) ?? []).length
  ok(ledgerCalls >= 2, `提交前 inflight + 失败时 failed 都记账（实测 ${ledgerCalls} 处）`)
  const wIdx = src.indexOf("state: 'inflight', jobId: id")
  const aIdx = src.indexOf('const taskId = await attempt(useBackend, idemKey)')
  ok(wIdx > 0 && aIdx > 0 && wIdx < aIdx, '台账在**发请求之前**写入（断网/进程被杀也留痕）')
  ok(/const idemKey = randomUUID\(\)/.test(src), '幂等键在重试链外生成一次')
  ok(/attempt\(useBackend, idemKey\)/.test(src), '同一次提交的所有重试复用同一个幂等键')
  ok(!/attempt\(useBackend\)/.test(src), '不存在「每次重试都换新键」的写法（那会重复扣费）')
  ok(/idempotencyKey: idemKey/.test(src), '幂等键传给了中转站')
  ok(/Idempotency-Key/.test(mmx), 'MiniMax 提交也带幂等键（以前没有）')
}

console.log('\n[3] 端到端：网络失败 → uncertain + 台账 inflight，且再提交被拦')
{
  const home = path.join(scratch, 'h1')
  const job = createJob(home, '网络异常', { model: 'MiniMax-H3' })
  const img = path.join(scratch, 'ref.png')
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=512x512:d=1', '-frames:v', '1', img])
  await setReference(home, job.id, 'firstFrame', img)
  saveJob(home, job.id, { prompt: '角色跑' })

  // baseURL 指向一个没人监听的端口 → 传输层失败（fetch failed）
  try {
    await submitJobVideo(home, job.id, { apiKey: 'sk-api-x', baseURL: 'http://127.0.0.1:9' }, { rawInput: 'run' })
    ok(false, '应该抛错')
  } catch { /* 预期 */ }

  const after = getJob(home, job.id)
  ok(after.video.status === 'uncertain', '作业状态是 uncertain，不是 error', after.video.status)
  ok(after.video.status !== 'error', '**绝不是 error**（error 会诱导用户再跑一次）')
  ok(/不要直接再跑一次 run/.test(after.video.hint ?? ''), '提示里明确劝阻重复提交')
  ok(/poll/.test(after.video.hint ?? ''), '提示里给出下一步（poll 而不是重跑）')

  const led = readSubmitLedger(home)
  ok(led?.state === 'inflight', '台账记为 inflight（结果未知）', led?.state)
  ok(typeof led?.idempotencyKey === 'string' && led.idempotencyKey.length > 10, '台账里存了幂等键')
  ok(led?.jobId === job.id, '台账关联到了这个作业')

  // 再提交必须被拦（不带 --yes）
  let msg = ''
  try {
    await submitJobVideo(home, job.id, { apiKey: 'sk-api-x', baseURL: 'http://127.0.0.1:9' }, { rawInput: 'run' })
  } catch (e) { msg = e?.message ?? '' }
  ok(/再提交一次/.test(msg), '结果未知时再提交被拦下', msg.slice(0, 60))
  ok(/--yes/.test(msg), '拦下时告诉用户怎么显式授权')
  ok(getJob(home, job.id).video.status === 'uncertain', '拦下后状态不变（没有偷偷重试）')
}

console.log('\n[4] nextStepOf 对 uncertain 的说法')
{
  ok(/结果未知/.test(src), 'nextStepOf 里对 uncertain 有专门文案')
  ok(/--yes/.test(src), '文案里提示需要 --yes 才能重提')
}

console.log('\n[5] 轮询限流：只提示退避，不改状态、不额外扣费')
{
  ok(/查询被限流/.test(src), '限流时给出退避提示')
  ok(/pollHint/.test(src), '限流提示写进作业（status 字段旁边）')
  ok(/if \(job\.video\?\.status !== 'running'\) return job/.test(src), '轮询失败保持 running（不会误判成失败而诱发重提）')
  ok(/单次查询失败 ≠ 任务失败/.test(src), '代码里有「查询失败 ≠ 任务失败」的注释说明')
}

console.log('\n[6] 生图链路同样不许在「结果未知」时重试')
{
  const img = fs.readFileSync(new URL('../src/taptap-image.mjs', import.meta.url), 'utf8')
  const catchBody = /} catch \(error\) \{[\s\S]{0,600}?\n {4}\}/.exec(img)?.[0] ?? ''
  ok(catchBody.length > 0, '能找到生图的 fetch catch 分支')
  ok(/重试有重复扣费的风险|重复扣费/.test(catchBody), '生图也写明了「重试可能重复扣费」')
  ok(/不要连续重发/.test(catchBody), '劝阻连续重发')
  // 关键：catch 里不能是 continue（那等于网络一抖就自动重发）
  ok(!/^\s*continue;?\s*$/m.test(catchBody), '传输层失败不再 continue 重试（修复前是 7 次重试）')
  ok(!/sleep\(5000 \+ attempt/.test(img), '移除了网络失败后的退避重试循环')
  // 业务层重试仍保留：content_policy / size / background 是服务端明确答复
  ok(/content_policy/i.test(img), '保留 content_policy 的退避重试（服务端明确答复，可安全重试）')
  ok(/snapSize\(size\)/.test(img), '保留尺寸纠正后重试一次')
}

console.log('\n[7] 「已生成但下载/写盘失败」不许换账号重生成（会双倍配额）')
{
  // 生图：图已经生成、只是本地保存失败（write_failed）。换账号重跑 = 再花
  // 一份配额去生成一张已经存在的图。write_failed 曾漏在提前退出名单外。
  const gpt = fs.readFileSync(new URL('../src/taptap-gpt.mjs', import.meta.url), 'utf8')
  const breakLine = /if \(last\?\.error === 'no_image'[\s\S]{0,200}?break/.exec(gpt)?.[0] ?? ''
  ok(breakLine.length > 0, '能找到生图轮换的提前退出判断')
  ok(breakLine.includes('write_failed'), '生图：write_failed（图已生成、仅本地写盘失败）也会停止轮换')
  ok(breakLine.includes('download_failed'), '生图：download_failed 也会停止轮换')

  // BGM：曲已经生成、只是下载失败。片段里只写 steps.download_error、error 为空，
  // 旧判定会当成普通失败走轮换 → 换账号再生成一首 = 白烧一份额度。
  const bgm = fs.readFileSync(new URL('../src/taptap-bgm-web.mjs', import.meta.url), 'utf8')
  const structural = /const structural = [\s\S]{0,500}?if \(structural\) break/.exec(bgm)?.[0] ?? ''
  ok(structural.length > 0, '能找到 BGM 的结构性失败判断')
  ok(/steps\?\.download_error/.test(structural), 'BGM：download_error（曲已生成、仅下载失败）视为结构性失败并停止轮换')
}

console.log('\n[8] 视频 running 悬空状态有出口（不会把用户锁死，也不自动重投）')
{
  // 作业停在 running 且没有 task_id（提交时进程被杀）：既不能直接重投
  // （服务端可能已扣费），也不能让用户永远无法继续 —— 必须有 --yes 出口。
  const block = /if \(job\.video\?\.status === 'running'\) \{[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? ''
  ok(block.length > 0, '能找到 running 拦截分支')
  ok(/downloadError/.test(block), '已生成仅下载失败时，提示去 poll 重试下载（而不是重投）')
  ok(/requireApproval/.test(block), '无 task_id 的悬空状态需要显式授权（--yes）才重投')
  ok(/没有拿到 task_id/.test(block), '文案说清了「停在提交中」这一悬空状态')
  ok(/taptap-video status/.test(block) || /readSubmitLedger/.test(block), '给出确认手段（看台账/status）')
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)