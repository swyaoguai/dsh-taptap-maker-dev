/**
 * 多图参考（/images/edits image[]）形状验证 —— 本地 mock 端点，不联网、不花钱。
 *
 * 重点验证：
 *  1. 单图仍用 `image` 字段（不破坏老模型/老中转站）
 *  2. 多图用 `image[]` 重复字段（OpenAI 标准形态）
 *  3. 单图模型遇到多图 → 明确拒绝（不发请求，不白花）
 *  4. --single-ref / --multi-ref 覆盖
 *  5. 逗号分隔与重复 --in 等价
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-multiref-'))
const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const a = path.join(scratch, 'a.png')
const b = path.join(scratch, 'b.png')
fs.writeFileSync(a, Buffer.from(pngB64, 'base64'))
fs.writeFileSync(b, Buffer.from(pngB64, 'base64'))

// mock 端点：记录 multipart 里出现了哪些 image 字段名
let seen = []
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end('{}'); return }
  const ctype = String(req.headers['content-type'] ?? '')
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    if (ctype.startsWith('multipart/form-data')) {
      const text = body.toString('latin1')
      const names = []
      for (const m of text.matchAll(/name="(image\[\]|image|images)"/g)) names.push(m[1])
      seen.push({ kind: 'multipart', fieldNames: names })
    } else {
      let keys = []
      try { keys = Object.keys(JSON.parse(body.toString('utf8'))) } catch { /* ignore */ }
      seen.push({ kind: 'json', keys })
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: pngB64 }] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const env = {
  ...process.env,
  DSH_HOME: path.join(scratch, 'home'),
  TAPTAP_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1`,
  TAPTAP_IMAGE_API_KEY: 'sk-test',
  TAPTAP_IMAGE_MODEL: 'gpt-image-1',
}
const cli = path.resolve('src/taptap-image.mjs')
const run = async (args, extraEnv = {}) => {
  try {
    const { stdout } = await execFileAsync('node', [cli, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8' })
    return { ok: true, out: JSON.parse(stdout) }
  } catch (e) {
    return { ok: false, stderr: String(e.stderr ?? e.message), stdout: String(e.stdout ?? '') }
  }
}

console.log('\n[1] 单图：仍用 image 字段（向后兼容）')
{
  seen = []
  const r = await run(['edit', '--in', a, '--prompt', 'x', '--out', path.join(scratch, 'o1.png')])
  ok(r.ok === true, '单图调用成功', r.stderr?.slice(0, 80))
  ok(seen.length === 1, '只发一次请求', `seen=${seen.length}`)
  ok(seen[0]?.fieldNames?.join(',') === 'image', 'multipart 用 image 字段（不是 image[]）', JSON.stringify(seen[0]))
  ok(r.out?.inputCount === 1, '返回 inputCount=1')
}

console.log('\n[2] 多图：用 image[] 重复字段（OpenAI 标准）')
{
  seen = []
  const r = await run(['edit', '--in', a, '--in', b, '--prompt', 'x', '--out', path.join(scratch, 'o2.png')])
  ok(r.ok === true, '多图调用成功', r.stderr?.slice(0, 80))
  const names = seen[0]?.fieldNames ?? []
  ok(names.length === 2 && names.every((n) => n === 'image[]'), '传了两个 image[] 字段', JSON.stringify(names))
  ok(r.out?.inputCount === 2, '返回 inputCount=2')
}

console.log('\n[3] 逗号分隔与重复 --in 等价')
{
  seen = []
  const r = await run(['edit', '--in', `${a},${b}`, '--prompt', 'x', '--out', path.join(scratch, 'o3.png')])
  ok(r.ok === true, '逗号分隔可用')
  ok((seen[0]?.fieldNames ?? []).length === 2, '同样传了两张', JSON.stringify(seen[0]))
}

console.log('\n[4] 单图模型 + 多图 → 拒绝，不发请求')
{
  seen = []
  const r = await run(['edit', '--in', a, '--in', b, '--prompt', 'x', '--out', path.join(scratch, 'o4.png')], {
    TAPTAP_IMAGE_MODEL: 'dall-e-3',
  })
  ok(r.ok === false, '被拒绝（非 0 退出）')
  ok(/只支持单图参考/.test(r.stderr), '说明是单图模型', r.stderr?.slice(0, 60))
  ok(seen.length === 0, '没有发出任何请求（不白花）', `seen=${seen.length}`)
}

console.log('\n[5] --multi-ref 覆盖单图判断；--single-ref 只传第一张')
{
  seen = []
  const r1 = await run(['edit', '--in', a, '--in', b, '--prompt', 'x', '--multi-ref', '--out', path.join(scratch, 'o5.png')], {
    TAPTAP_IMAGE_MODEL: 'dall-e-3',
  })
  ok(r1.ok === true, '--multi-ref 允许单图模型发多图', r1.stderr?.slice(0, 80))

  seen = []
  const r2 = await run(['edit', '--in', a, '--in', b, '--prompt', 'x', '--single-ref', '--out', path.join(scratch, 'o6.png')])
  ok(r2.ok === true, '--single-ref 可用')
  ok((seen[0]?.fieldNames ?? []).length === 1, '--single-ref 只传一张', JSON.stringify(seen[0]))
  ok(/只传第 1 张/.test((r2.out?.notes ?? []).join(' ')), '返回里说明忽略了其余')
}

console.log('\n[6] 不存在的参考图 → 明确报错')
{
  const r = await run(['edit', '--in', path.join(scratch, 'nope.png'), '--prompt', 'x', '--out', path.join(scratch, 'o7.png')])
  ok(r.ok === false, '报错退出')
  ok(/不存在/.test(r.stderr), '说明文件不存在', r.stderr?.slice(0, 60))
}

server.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
