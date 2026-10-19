/**
 * 宿主 API 路由的离线自测（不联网、不花额度、不需要 DSH 宿主）。
 *
 * 为什么要有这个脚本：设置页依赖的这批路由**只有在真实请求时才会暴露问题**
 * （比如 `writeMinimaxConfigPatch` 忘了 import → 500、回显写死 → 绿点永远是亮的）。
 * 之前这些是靠临时脚本手工验的，验完就没了；这里固化下来。
 *
 * 做法：用假 ctx 调 `apply()` 拿到 webServer 注册的 handler，挂到真的
 * http.createServer 上，用真的 fetch 请求 —— 请求体、状态码、JSON 往返
 * 全部走真实路径，只有「宿主」是假的。
 *
 * 用法：node scripts/verify-host-routes.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-routes-'))
console.log(`临时 DSH_HOME：${home}\n`)

const mod = await import('../index.js')
let routeHandler = null
const noop = () => () => {}
const ctx = {
  logger: { info() {}, warn() {} },
  // effect 在宿主里是「注册后立即执行一次注册函数」；这里如实模拟。
  effect: (fn) => { try { fn() } catch { /* 某些 effect 依赖真宿主 */ } },
  inject(_names, fn) {
    fn({
      effect: (f) => { try { f() } catch { /* ignore */ } },
      webServer: { register: (r) => { routeHandler = r.handler; return () => {} } },
      systemPrompt: { section: noop },
      skills: { registerProvider: noop },
      commands: { register: noop },
    })
  },
}

mod.apply(ctx, { dshHome: home, skills: { autoUpdate: false } })
ok(typeof routeHandler === 'function', 'apply() 注册了 webServer 路由')

const server = http.createServer((req, res) => {
  routeHandler(req, res).catch((e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}/api/taptap-maker-dev`

const req = async (method, sub, body) => {
  const r = await fetch(`${BASE}/${sub}`, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { __raw: text.slice(0, 200) } }
  return { status: r.status, json }
}

console.log('\n[1] 既有路由没被改坏')
{
  const p = await req('GET', 'policy')
  ok(p.status === 200 && typeof p.json.blockCreditTools === 'boolean', 'GET /policy 正常')
  const i = await req('GET', 'image')
  ok(i.status === 200 && typeof i.json.baseURL === 'string', 'GET /image 正常')
}

console.log('\n[2] POST /video-minimax（设置页 MiniMax 配置卡）')
{
  const a = await req('POST', 'video-minimax', { apiKey: 'sk-cp-demo', baseURL: 'https://api.minimax.io', model: 'MiniMax-H3-Max' })
  ok(a.status === 200, '保存返回 200', JSON.stringify(a.json).slice(0, 200))
  ok(a.json.hasApiKey === true, 'hasApiKey = true')
  ok(a.json.keyKind === 'subscription', `识别出订阅 Key（${a.json.keyKind}）`)
  ok(a.json.baseURL === 'https://api.minimax.io', '站点已保存')
  ok(a.json.model === 'MiniMax-H3-Max', '模型已保存')
  ok(!JSON.stringify(a.json).includes('sk-cp-demo'), 'Key 明文没有回显给前端')

  const clr = await req('POST', 'video-minimax', { clear: true })
  ok(clr.status === 200 && clr.json.hasApiKey === false, 'clear:true 能真的清掉 Key')
  const fileRaw = JSON.parse(fs.readFileSync(path.join(home, 'taptap-maker-dev', 'minimax.json'), 'utf8'))
  ok(fileRaw.apiKey === undefined || fileRaw.apiKey === '', '磁盘上的 Key 确实被删了（不是只清了界面）')
  ok(clr.json.baseURL === 'https://api.minimax.io', '清 Key 不会顺手把站点清掉')

  const g = await req('GET', 'video-minimax')
  ok(g.status === 200 && Array.isArray(g.json.models) && g.json.models.length >= 3, `GET 返回模型表（${(g.json.models || []).length} 个）`)
}

console.log('\n[3] 视频中转站路由')
{
  const e = await req('GET', 'video-relay')
  ok(e.status === 200 && e.json.relay, 'GET /video-relay 正常')
  ok(e.json.backends && typeof e.json.backends.relay === 'boolean', '返回三后端可用性')

  const s = await req('POST', 'video-relay', {
    enabled: true, protocol: 'openai', baseURL: 'https://relay.example.com/v1/videos',
    apiKey: 'sk-relay-demo', model: 'vid-model',
  })
  ok(s.status === 200, '保存中转站 200')
  ok(s.json.relay.baseURL === 'https://relay.example.com', '把整条 /v1/videos 收敛到根')
  ok(s.json.backends.relay === true, '启用后 relay 可用')
  ok(s.json.backends.minimax === false, '没配 MiniMax 时 minimax 绿点必须为 false（不能写死）')

  const p = await req('GET', 'video-relay')
  ok(p.json.relay.enabled === true && p.json.relay.model === 'vid-model', '配置已持久化')

  const g = await req('POST', 'video-relay', { protocol: 'generic', doneValues: 'ok,done,finished' })
  ok(g.status === 200 && g.json.relay.protocol === 'generic', '切换到 generic 协议')
  ok(Array.isArray(g.json.relay.doneValues) && g.json.relay.doneValues.length === 3, '完成状态值被拆成数组')

  const off = await req('POST', 'video-relay', { enabled: false })
  ok(off.json.backends.relay === false, '关掉后 relay 绿点变灰')
}

console.log('\n[4] 未知路由仍然 404（没有把用户页面挂死）')
{
  const n = await req('GET', 'nope')
  ok(n.status === 404, `未知子路径返回 404（实际 ${n.status}）`)
}

server.close()
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
