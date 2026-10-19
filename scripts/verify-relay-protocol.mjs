/**
 * 中转站 /videos 协议的本地仿真测试（不联网、不花额度）。
 *
 * 起一个本地 mock 中转站，**按公共 /videos 约定实现**：
 *   - `POST /reference-assets`：文件原始字节 + 真实 Content-Type，返回 `url`
 *   - `POST /v1/videos`：顶层 model/prompt/seconds，型号选项进 `metadata`，
 *     必须带 `Idempotency-Key`；按 `metadata.mode` 校验首尾帧字段
 *   - `GET /v1/videos/{id}`：queued → in_progress → delivering → completed
 *   - `GET /v1/videos/{id}/content`：要鉴权，返回 video/mp4 字节
 *
 * 断言重点是**我们发出去的请求本身对不对**（这类错误线上只表现为 400，
 * 在此之前没有任何反馈），以及状态机里几个容易错的边界：
 * delivering 不能当完成、cancelled 没有 error 字段、下载要校验容器。
 *
 * 用法：node scripts/verify-relay-protocol.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { ffmpegPath } from '../src/video-media.mjs'
import { normalizeRelayConfig, relayUploadAsset, relaySubmit, relayQuery, relayDownload, looksLikeVideo } from '../src/video-relay.mjs'
import { createJob, saveJob } from '../src/video-sequence.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const scratch = mkdtempSyncDir()
function mkdtempSyncDir() {
  const d = path.join(os.tmpdir(), `dsh-relay-${Date.now()}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const KEY = 'xp-test-key-123'

// ── 造一段真 mp4 当"成片" ──
const videoFile = path.join(scratch, 'out.mp4')
execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00b000:s=128x128:d=1:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '1', videoFile])
const videoBytes = fs.readFileSync(videoFile)

// ── 造两张 png 当首尾帧 ──
const frameA = path.join(scratch, 'a.png')
const frameB = path.join(scratch, 'b.png')
for (const f of [frameA, frameB]) {
  execFileSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00b000:s=64x64', '-frames:v', '1', f])
}

// ── mock 中转站 ──
const received = { uploads: [], creates: [], polls: 0, downloads: 0 }
let pollCount = 0
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const auth = req.headers.authorization
  const unauthorized = () => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } })) }

  if (url.pathname === '/reference-assets' && req.method === 'POST') {
    if (auth !== `Bearer ${KEY}`) return unauthorized()
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      received.uploads.push({ contentType: req.headers['content-type'], bytes: body.length, isPng: body.subarray(0, 4).toString('hex') === '89504e47' })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ url: `https://cdn.example.com/${received.uploads.length}.png`, expires_at: Math.floor(Date.now() / 1000) + 86400 }))
    })
    return
  }

  if (url.pathname === '/v1/videos' && req.method === 'POST') {
    if (auth !== `Bearer ${KEY}`) return unauthorized()
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.creates.push({ body, idempotencyKey: req.headers['idempotency-key'] })
      // 按指南校验：首尾帧模式不能同时带普通素材数组；只给尾帧非法。
      const md = body.metadata || {}
      if (md.mode === 'frames' && md.image_urls) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: '首尾帧不要同时发送普通素材数组' } }))
      }
      if (md.mode === 'frames' && !md.first_frame_url) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'H3 不允许只提供尾帧' } }))
      }
      pollCount = 0
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'task_abc', model: body.model, status: 'queued', progress: 0 }))
    })
    return
  }

  const m = /^\/v1\/videos\/([^/]+)(\/content)?$/.exec(url.pathname)
  if (m) {
    if (auth !== `Bearer ${KEY}`) return unauthorized()
    if (m[2] === '/content') {
      received.downloads += 1
      res.writeHead(200, { 'Content-Type': 'video/mp4' })
      return res.end(videoBytes)
    }
    received.polls += 1
    pollCount += 1
    // queued → in_progress(99% + delivering) → completed/ready
    let payload
    if (pollCount <= 1) payload = { id: m[1], status: 'queued', progress: 0 }
    else if (pollCount <= 2) payload = { id: m[1], status: 'in_progress', progress: 99, delivery_status: 'delivering' }
    else payload = { id: m[1], status: 'completed', progress: 100, delivery_status: 'ready', download_expires_at: Math.floor(Date.now() / 1000) + 86400 }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(payload))
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'not found' } }))
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`  // 常见的 /v1 前缀
const cfg = normalizeRelayConfig({ enabled: true, protocol: 'openai', baseURL, apiKey: KEY, model: 'test-video-model', assetUploadPath: '/reference-assets' })

console.log(`mock 中转站：${baseURL}\n`)

console.log('[0] Base URL 规整（/v1 必须保留）')
{
  const a = normalizeRelayConfig({ baseURL: 'https://relay.example.com/v1/' })
  ok(a.baseURL === 'https://relay.example.com/v1', `/v1 保留（${a.baseURL}）`)
  const b = normalizeRelayConfig({ baseURL: 'https://relay.example.com/v1/videos' })
  ok(b.baseURL === 'https://relay.example.com/v1', `粘了整条 /videos 也收敛到 /v1（${b.baseURL}）`)
  const c = normalizeRelayConfig({ baseURL: 'https://h.com/v1/videos/task_1' })
  ok(c.baseURL === 'https://h.com/v1', `粘了带任务 id 的地址也能收敛（${c.baseURL}）`)
  const d = normalizeRelayConfig({ baseURL: 'https://h.com' })
  ok(d.baseURL === 'https://h.com', '裸域名保持裸域名（有些中转站就没有 /v1）')
}

console.log('[1] 参考素材上传（原始字节 + 真实 Content-Type）')
{
  const a = await relayUploadAsset(cfg, frameA, 'image/png')
  ok(/^https:\/\/cdn\.example\.com\//.test(a.url), `拿到公网 url（${a.url}）`)
  ok(typeof a.expiresAt === 'number', '读到了 expires_at')
  ok(received.uploads[0].contentType === 'image/png', `Content-Type 是 image/png（实际 ${received.uploads[0].contentType}）`)
  ok(received.uploads[0].isPng, '发的是文件原始字节（开头是 PNG 魔数），不是 JSON/Base64')
}

console.log('\n[2] 首尾帧提交（metadata.mode=frames + 首尾帧 url）')
{
  const up = await relayUploadAsset(cfg, frameA, 'image/png')
  const lp = await relayUploadAsset(cfg, frameB, 'image/png')
  const sub = await relaySubmit(cfg, {
    prompt: '角色原地走三步，绿幕背景',
    firstFrameImage: up.url,
    lastFrameImage: lp.url,
    seconds: 4,
    assetFiles: { firstFrame: { path: frameA, mime: 'image/png' }, lastFrame: { path: frameB, mime: 'image/png' } },
    ratio: '16:9',
  })
  const sent = received.creates.at(-1)
  ok(sub.taskId === 'task_abc', `拿到任务 id（${sub.taskId}）`)
  ok(typeof sub.idempotencyKey === 'string' && sub.idempotencyKey.length >= 32, '带了 Idempotency-Key（24 小时防重复扣费）')
  ok(sent.body.model === 'test-video-model', 'model 原样透传')
  ok(sent.body.seconds === 4 && typeof sent.body.seconds === 'number', 'seconds 是整数 4')
  ok(sent.body.prompt === '角色原地走三步，绿幕背景', 'prompt 原样透传')
  ok(sent.body.metadata.mode === 'frames', 'metadata.mode = frames')
  ok(typeof sent.body.metadata.first_frame_url === 'string', 'first_frame_url 是 url')
  ok(typeof sent.body.metadata.last_frame_url === 'string', 'last_frame_url 是 url')
  ok(sent.body.metadata.ratio === '16:9', 'metadata.ratio = 16:9')
  ok(sent.body.metadata.image_urls === undefined, '首尾帧模式没有混发 image_urls')
  ok(sent.body.size === undefined, '没发 size（清晰度由型号决定，不能升降档）')
  ok(sent.body.input_reference === undefined, '没有发旧的 input_reference 字段')
}

console.log('\n[3] 只给首帧（H3 允许，SD 也要求成对时要能报出来）')
{
  const up = await relayUploadAsset(cfg, frameA, 'image/png')
  await relaySubmit(cfg, { prompt: 'x', firstFrameImage: up.url, seconds: 4, assetFiles: { firstFrame: { path: frameA, mime: 'image/png' } }, ratio: '16:9' })
  const sent = received.creates.at(-1)
  ok(sent.body.metadata.mode === 'frames' && sent.body.metadata.first_frame_url && !sent.body.metadata.last_frame_url, '只发首帧时 mode=frames 且无尾帧')
}

console.log('\n[4] 只给尾帧：不做本地特判，由平台报错并如实回显')
{
  let msg = ''
  try {
    await relaySubmit(cfg, { prompt: 'x', lastFrameImage: 'https://x/y.png', seconds: 4, ratio: '16:9' })
  } catch (e) { msg = e.message }
  // 不内置「H3 不允许只给尾帧」这类规则 —— 各家中转站可能不一样。
  // 但平台拒绝时，错误原文必须完整传回来（不能吞成「失败」）。
  ok(/HTTP 400/.test(msg) && /尾帧/.test(msg), '平台 400 的原文完整回显', msg)
}

console.log('\n[5] input_reference 风格（另一种公共约定）')
{
  await relaySubmit(cfg, {
    prompt: 'x',
    firstFrameImage: 'https://a/1.png',
    lastFrameImage: 'https://a/2.png',
    seconds: 4,
    ratio: '9:16',
    referenceStyle: 'input_reference',
  })
  const sent = received.creates.at(-1)
  ok(Array.isArray(sent.body.input_reference) && sent.body.input_reference.length === 2, '两张图进 input_reference 数组')
  ok(sent.body.input_reference[0].type === 'first_frame', '第一张标 first_frame')
  ok(sent.body.metadata.first_frame_url === undefined, '没有混用 metadata 首帧字段')
}

console.log('\n[6] 查询状态机：delivering 不能当完成')
{
  pollCount = 0
  const q1 = await relayQuery(cfg, 'task_abc')
  ok(q1.status === 'running' && q1.remoteStatus.includes('queued'), `queued → running（${q1.remoteStatus}）`)
  const q2 = await relayQuery(cfg, 'task_abc')
  ok(q2.status === 'running', `in_progress/99%/delivering 仍然 running（${q2.remoteStatus}）`)
  ok(q2.progress === 99, '透出 progress=99')
  const q3 = await relayQuery(cfg, 'task_abc')
  ok(q3.status === 'succeeded', `completed/ready → succeeded（${q3.remoteStatus}）`)
}

console.log('\n[7] 下载：带鉴权 + 校验容器')
{
  const q = { contentUrl: `${baseURL}/videos/task_abc/content` }
  const bytes = await relayDownload(cfg, 'task_abc', q, 30000)
  ok(looksLikeVideo(bytes), `下回来的确实是视频（${bytes.length} 字节，ftyp 容器）`)
  ok(received.downloads === 1, '走的是 /content 端点')

  // 把 JSON 当视频下回来必须被拒
  let msg = ''
  try {
    await relayDownload(cfg, 'task_abc', { contentUrl: `${baseURL}/videos/task_abc` }, 30000)
  } catch (e) { msg = e.message }
  ok(/不是视频/.test(msg), 'JSON 响应不会被当成成片', msg)
}

console.log('\n[8] 不内置任何型号能力表')
{
  // 导出里不该再有型号表 / 校验函数 —— 各家中转站不一样，写死一家会误导其他家。
  const mod = await import('../src/video-relay.mjs')
  ok(mod.RELAY_MODEL_CAPS === undefined, '没有 RELAY_MODEL_CAPS 导出')
  ok(mod.relayModelWarning === undefined, '没有 relayModelWarning 导出')
  ok(mod.relayKnownModels === undefined, '没有 relayKnownModels 导出')
  // 但 /models 的获取能力还在（这是通用能力，不依赖任何一家的型号表）。
  ok(typeof mod.relayListModels === 'function', 'relayListModels 仍然可用（走中转站自己的 /models）')
}

console.log('\n[9] 作业层：本地图片自动上传后提交')
{
  const home = scratch
  const job = createJob(home, '中转站首尾帧')
  saveJob(home, job.id, { prompt: '角色原地走三步', settings: { backend: 'relay', duration: 4, relayRatio: '16:9' } })
  // 直接把两张图塞进 refs（跳过 setReference 的尺寸探测，这里只关心上传链路）
  const jobFile = path.join(home, 'taptap-maker-dev', 'video-jobs', job.id, 'job.json')
  const raw = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
  fs.copyFileSync(frameA, path.join(home, 'taptap-maker-dev', 'video-jobs', job.id, 'refs', 'firstFrame-a.png'))
  fs.copyFileSync(frameB, path.join(home, 'taptap-maker-dev', 'video-jobs', job.id, 'refs', 'lastFrame-b.png'))
  raw.refs = {
    firstFrame: { file: 'refs/firstFrame-a.png', name: 'a.png' },
    lastFrame: { file: 'refs/lastFrame-b.png', name: 'b.png' },
  }
  fs.writeFileSync(jobFile, JSON.stringify(raw))
  const before = received.uploads.length
  const cfgFromJob = { ...cfg, model: 'test-video-model' }
  const { submitJobVideo } = await import('../src/video-sequence.mjs')
  const res = await submitJobVideo(home, job.id, { apiKey: '', baseURL: '', model: '', relay: cfgFromJob })
  ok(received.uploads.length === before + 2, `提交时自动上传了 2 张图（${received.uploads.length - before}）`)
  ok(res.backend === 'relay', '走的是 relay 后端')
  const sent = received.creates.at(-1)
  ok(sent.body.metadata.mode === 'frames' && sent.body.metadata.last_frame_url, '首尾帧字段都到了请求体里')
}

server.close()

console.log('\n[10] 没配上传路径时的行为')
{
  const noUploadCfg = normalizeRelayConfig({ enabled: true, protocol: 'openai', baseURL, apiKey: KEY, model: 'test-video-model' })
  ok(noUploadCfg.assetUploadPath === '', 'assetUploadPath 默认空（不预设）')
  let msg = ''
  try {
    await relaySubmit(noUploadCfg, { prompt: 'x', firstFrameImage: 'data:image/png;base64,AA', seconds: 4, assetFiles: { firstFrame: { path: frameA, mime: 'image/png' } } })
  } catch (e) { msg = e.message }
  ok(/没有设置素材上传路径/.test(msg), '没配上传路径 + 本地图片 → 明确报错', msg)

  // 没传 assetFiles + firstFrameImage 是 data URI 时也应该报「需要上传路径」
  // （不是悄悄接受 data URI 当作公网 URL）。
  let msg2 = ''
  try {
    await relaySubmit(noUploadCfg, { prompt: 'x', firstFrameImage: 'data:image/png;base64,AA', seconds: 4 })
  } catch (e) { msg2 = e.message }
  ok(/需要上传/.test(msg2) || /需要先上传/.test(msg2), 'data URI 不会被静默接受为公网 URL', msg2)
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1






