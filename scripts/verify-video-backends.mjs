/**
 * 视频中转站 / 订阅 / 后端选择的离线自测（不联网、不花额度）。
 *
 * 覆盖三块新能力：
 *   1. 中转站配置规整（把整条路径粘进 Base URL 也能收敛到根、协议默认值）；
 *   2. 点路径取值（generic 协议靠它从任意响应形状里取 taskId / 状态 / 地址）；
 *   3. 后端选择（auto 的优先级、显式选择、配错时报什么）；
 *   4. 订阅 Key 与按量 Key 的识别；
 *   5. 本地视频挂载（零额度路径）—— 用 ffmpeg 现造一段视频走完整条链路。
 *
 * 用法：node scripts/verify-video-backends.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ffmpegPath } from '../src/video-media.mjs'
import { detectKeyKind, describeKey } from '../src/minimax-video.mjs'
import { normalizeRelayConfig, pickPath, relayReady, RELAY_PROTOCOLS } from '../src/video-relay.mjs'
import {
  createJob, extractJobFrames, getJob, resolveBackend, saveJob, useLocalVideo,
} from '../src/video-sequence.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-video-backends-'))
console.log(`临时目录：${scratch}`)

console.log('\n[1] 中转站配置规整')
{
  const c = normalizeRelayConfig({ baseURL: 'https://relay.example.com/v1/videos', apiKey: 'k', model: 'veo-like' })
  // /v1 必须保留：星盘这类中转站的接口就在 /v1/videos 下，剥掉会 404。
  ok(c.baseURL === 'https://relay.example.com/v1', `只剥掉整条 /videos，保留 /v1（${c.baseURL}）`)
  ok(c.protocol === 'openai', '默认协议是 openai')
  // size 默认留空：清晰度由型号决定，不能靠 size 升降档。
  ok(c.seconds === 4 && c.size === '', '默认 4 秒、不下发 size')
  ok(c.ratio === '16:9', '默认画幅 16:9')
  ok(relayReady(c) === false, '没启用时 relayReady 为 false')
  ok(relayReady({ ...c, enabled: true }) === true, '启用且四要素齐 → ready')
  const g = normalizeRelayConfig({ enabled: true, protocol: 'generic', baseURL: 'https://g.example.com', apiKey: 'k', model: 'm' })
  ok(g.protocol === 'generic' && g.submitPath === '/videos' && g.queryPath === '/videos/{taskId}', 'generic 协议有可用的默认路径')
  ok(Array.isArray(g.doneValues) && g.doneValues.length === 3, 'doneValues 字符串被拆成数组')
  const bad = normalizeRelayConfig({ protocol: 'nonsense' })
  ok(bad.protocol === 'openai', '未知协议回落到 openai 而不是崩掉')
  ok(RELAY_PROTOCOLS.join(',') === 'openai,minimax,generic', '协议列表完整')
}

console.log('\n[2] 点路径取值（generic 协议靠它读任意响应）')
{
  ok(pickPath({ id: 'x' }, 'id') === 'x', '顶层字段')
  ok(pickPath({ data: { output: { url: 'u' } } }, 'data.output.url') === 'u', '嵌套字段')
  ok(pickPath({ result: [{ video_url: 'v' }] }, 'result[0].video_url') === 'v', '数组下标（[] 写法）')
  ok(pickPath({ result: [{ video_url: 'v' }] }, 'result.0.video_url') === 'v', '数组下标（点写法）')
  ok(pickPath({ a: null }, 'a.b.c') === undefined, '中途为 null 时不抛异常')
  ok(pickPath({ a: 1 }, '') === undefined, '空路径返回 undefined')
}

console.log('\n[3] 订阅 Key / 按量 Key 识别')
{
  ok(detectKeyKind('sk-cp-abc') === 'subscription', 'sk-cp- → 订阅')
  ok(detectKeyKind('sk-api-abc') === 'api', 'sk-api- → 按量')
  ok(detectKeyKind('') === 'none', '空 → none')
  ok(/Go 档/.test(describeKey('sk-cp-x')), '订阅 Key 的说明里点明 Go 档限制')
  ok(/余额/.test(describeKey('sk-api-x')), '按量 Key 的说明里说明扣余额')
}

console.log('\n[4] 后端选择')
{
  const relayOn = { enabled: true, protocol: 'openai', baseURL: 'https://r', apiKey: 'k', model: 'm' }
  const none = { relay: normalizeRelayConfig({}), apiKey: '' }
  const onlyMmx = { relay: normalizeRelayConfig({}), apiKey: 'sk-api-x' }
  const both = { relay: normalizeRelayConfig(relayOn), apiKey: 'sk-api-x' }

  ok(resolveBackend({ settings: { backend: 'auto' } }, both) === 'relay', 'auto：配了中转站优先于 MiniMax（用户显式配的先用）')
  ok(resolveBackend({ settings: { backend: 'auto' } }, onlyMmx) === 'minimax', 'auto：只配了 MiniMax → minimax')
  ok(resolveBackend({ settings: { backend: 'auto' } }, none) === 'relay', 'auto：都没配 → 落到 relay 以给出「没配好」的明确报错')
  ok(resolveBackend({ settings: { backend: 'local' } }, none) === 'local', '显式 local 永远可用')
  ok(resolveBackend({ settings: { backend: 'minimax' } }, onlyMmx) === 'minimax', '显式 minimax 生效')

  let threw = ''
  try { resolveBackend({ settings: { backend: 'relay' } }, none) } catch (e) { threw = e.message }
  ok(/中转站没配好/.test(threw), '显式 relay 但没配好 → 明确报错', threw)
  threw = ''
  try { resolveBackend({ settings: { backend: 'minimax' } }, none) } catch (e) { threw = e.message }
  ok(/没有可用的 Key/.test(threw), '显式 minimax 但没有 Key → 明确报错', threw)
}

console.log('\n[5] 本地视频（零额度路径）')
{
  const home = scratch
  const job = createJob(home, '本地视频测试')
  const video = path.join(scratch, 'local.mp4')
  execFileSync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x00b000:s=256x256:d=2:r=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '2', video,
  ], { stdio: 'inherit' })

  const used = await useLocalVideo(home, job.id, video)
  ok(used.video.status === 'ready', '本地视频被标记为就绪')
  ok(used.video.backend === 'local', '后端记为 local')
  ok(used.video.width === 256 && used.video.height === 256, `读出了尺寸（${used.video.width}×${used.video.height}）`)
  ok(used.video.duration > 1.5 && used.video.duration < 2.5, `读出了时长（${used.video.duration.toFixed(2)}s）`)

  saveJob(home, job.id, { settings: { frameCount: 4, longEdge: 256, cellWidth: 64, cellHeight: 64 } })
  const framed = await extractJobFrames(home, job.id)
  ok(framed.frames.count === 4, `本地视频能正常抽帧（${framed.frames.count} 张）`)

  // 非视频文件必须被拒（不能靠扩展名骗过去）
  let rejected = ''
  const notVideo = path.join(scratch, 'notvideo.mp4')
  execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(notVideo)}, 'hello')`])
  try { await useLocalVideo(home, job.id, notVideo) } catch (e) { rejected = e.message }
  ok(/不是一段能解码的视频/.test(rejected), '伪装成 .mp4 的文本被拒', rejected)

  // 作业仍停留在上次的 ready 状态，不能被坏文件污染
  ok(getJob(home, job.id).video.status === 'ready', '拒绝坏文件后作业状态没被破坏')
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
