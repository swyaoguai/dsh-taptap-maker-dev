/**
 * taptap-image edit（/images/edits 图生图）的本地仿真测试（不联网、不花额度）。
 *
 * 起一个 mock OpenAI 兼容端点：
 *   - POST /v1/images/edits（multipart）：校验 Authorization、image 文件字段、
 *     prompt/model；返回一张真 PNG（b64_json）。
 *   - 拒绝模式（?rejectMultipart=1）：对 multipart 回 400 提示 json，
 *     验证客户端会回退到 JSON+base64 再成功。
 *
 * 断言重点是我们发出去的请求本身对不对（鉴权头、文件真的带上了、
 * 回退路径真的走了），这类错误线上只表现为 400。
 *
 * 用法：node scripts/verify-image-edit.mjs
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const scratch = path.join(os.tmpdir(), `dsh-imgedit-${Date.now()}`)
fs.mkdirSync(scratch, { recursive: true })

// 造一张 64x64 真 PNG 当输入（ffmpeg 生成，与其它 verify 同套路）
const inPng = path.join(scratch, 'in.png')
try {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x3366aa:s=64x64', '-frames:v', '1', inPng], { stdio: 'ignore' })
} catch {
  // ffmpeg 不在也没关系：手写最小 PNG（1x1 蓝点）
  fs.writeFileSync(inPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
}
const inputBytes = fs.readFileSync(inPng)

const received = { requests: [] }
let rejectMultipart = false
let businessReject = false
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname !== '/v1/images/edits' || req.method !== 'POST') {
    res.writeHead(404); res.end('{}'); return
  }
  const auth = req.headers.authorization ?? ''
  const ctype = String(req.headers['content-type'] ?? '')
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const isMultipart = ctype.startsWith('multipart/form-data')
    const isJson = ctype.includes('application/json')
    // PNG 魔数比对用 latin1（binary）：Buffer.includes(string) 按 utf8 解码，
    // 多字节序列在 multipart 边界噪声里会误伤/漏判。
    const magic = inputBytes.subarray(0, 8).toString('latin1')
    const hasImage = isMultipart
      ? body.includes('name="image"') && body.includes(Buffer.from(magic, 'latin1'))
      : isJson && body.includes('base64,')
    const rec = { auth, isMultipart, isJson, hasImage, bytes: body.length }
    received.requests.push(rec)
    if (auth !== 'Bearer test-key-edit') {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } })); return
    }
    if (rejectMultipart && isMultipart) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unexpected content type: use JSON with base64 image' } }))
      return
    }
    // 业务 400：正文含 image 一词但与请求格式无关（如 prompt 违规）。
    if (businessReject && isMultipart) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid request: image prompt violates policy' } }))
      return
    }
    if (!hasImage) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'missing image field' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: inputBytes.toString('base64') }] }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const cli = path.resolve('src/taptap-image.mjs')
const env = {
  ...process.env,
  TAPTAP_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1`,
  TAPTAP_IMAGE_API_KEY: 'test-key-edit',
  TAPTAP_IMAGE_MODEL: 'gpt-image-test',
}
const run = async (args) => {
  // 必须用异步 execFile：execFileSync 会阻塞父进程事件循环，mock server
  // 就永远没法响应子进程的请求（第一次跑就死锁到双方超时）。
  const { stdout } = await execFileAsync('node', [cli, ...args], { env, encoding: 'utf8' })
  return JSON.parse(stdout)
}

console.log('\n[1] edit：multipart 请求形状')
{
  const outPng = path.join(scratch, 'out1.png')
  const r = await run(['edit', '--in', inPng, '--prompt', '换成红色', '--out', outPng])
  ok(r.ok === true, '返回 ok', JSON.stringify(r).slice(0, 120))
  ok(received.requests.length === 1, '只发了一次请求（无多余重试）')
  const rec = received.requests[0]
  ok(rec.auth === 'Bearer test-key-edit', '带 Bearer 鉴权头')
  ok(rec.isMultipart, '默认走 multipart/form-data')
  ok(rec.hasImage, 'image 文件字段带了真实 PNG 字节')
  ok(fs.existsSync(outPng), '输出文件落盘')
  ok(fs.readFileSync(outPng).equals(inputBytes), '输出内容 = 端点返回的 b64 解码')
}

console.log('\n[2] edit：multipart 被拒 → 回退 JSON+base64')
{
  rejectMultipart = true
  received.requests.length = 0
  const outPng = path.join(scratch, 'out2.png')
  const r = await run(['edit', '--in', inPng, '--prompt', '换成红色', '--out', outPng])
  ok(r.ok === true, '回退后成功')
  ok(received.requests.length === 2, '恰好两次请求（multipart + json 回退）')
  ok(received.requests[0].isMultipart && received.requests[1].isJson, '先 multipart 后 JSON')
  ok(received.requests[1].hasImage, 'JSON 回退也带了 base64 图')
  ok(Array.isArray(r.notes) && r.notes.length > 0 && /JSON\+base64/.test(r.notes[0]), 'notes 里如实说明走了回退')
  rejectMultipart = false
}

console.log('\n[3] 业务 400 不触发格式回退（不多烧请求）')
{
  // 从实现源码里提取真实回退正则（手抄副本会在实现改动后静默失效）
  const src = fs.readFileSync(new URL('../src/taptap-image.mjs', import.meta.url), 'utf8')
  const reSrc = /const bodyFormatRejected = first\.status === 400\s*&&\s*\/(.+?)\/i/.exec(src)?.[1]
  ok(reSrc !== undefined, '能从源码提取回退正则（实现与测试不再漂移）')
  const re = new RegExp(reSrc, 'i')
  const businessText = 'invalid request: image prompt violates policy'
  ok(!re.test(businessText), '业务 400 文案（含 image 字样）不匹配回退条件')
  const formatText = 'unexpected content type: use JSON with base64 image'
  ok(re.test(formatText), '格式 400 文案仍匹配回退条件')

  // 端到端：mock 对 multipart 回「业务 400」→ 客户端不得发第二次请求
  businessReject = true
  received.requests.length = 0
  let err = null
  try {
    await run(['edit', '--in', inPng, '--prompt', 'x', '--out', path.join(scratch, 'out3.png')])
  } catch (e) {
    err = e
  }
  ok(err !== null, '业务 400 如实报错（不假装成功）')
  ok(received.requests.length === 1, `只发一次请求，未按格式回退重发（实际 ${received.requests.length}）`)
  ok(received.requests[0]?.isMultipart, '那次请求是 multipart')
  businessReject = false
}

console.log('\n[4] 参数校验')
{
  received.requests.length = 0
  let code = 0
  let stderr = ''
  try {
    await execFileAsync('node', [cli, 'edit', '--prompt', 'x', '--out', path.join(scratch, 'x.png')], { env, encoding: 'utf8' })
  } catch (e) {
    code = e.code ?? e.status ?? 1; stderr = e.stderr ?? ''
  }
  ok(code === 2 && /--in/.test(stderr), '缺 --in 时报用法并退出 2')
  ok(received.requests.length === 0, '参数不齐不发请求')
}

server.close()
try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
