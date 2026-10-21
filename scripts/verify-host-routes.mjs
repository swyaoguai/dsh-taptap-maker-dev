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

console.log('\n[1b] 设置页改一项，不该抹掉其它项（Key 被静默清空的老 bug）')
{
  const a = await req('POST', 'image', {
    baseURL: 'https://api.example.com/v1', apiKey: 'sk-precious-key', model: 'gpt-image', size: '1024x1024',
  })
  ok(a.status === 200 && a.json.hasApiKey === true, '先写入一份含 Key 的配置')
  ok(!JSON.stringify(a.json).includes('sk-precious-key'), 'GET/POST 都不回显 Key 明文')

  // 设置页 GET 不回显 Key → 表单里 apiKey 恒为 '' → 用户只改 model 就保存
  const b = await req('POST', 'image', {
    baseURL: 'https://api.example.com/v1', apiKey: '', model: 'gpt-image-2.5', size: '1024x1024',
  })
  ok(b.json.hasApiKey === true, '只改 model 时 Key 仍在（修复前会被清空）')
  ok(b.json.model === 'gpt-image-2.5', 'model 已更新')

  const raw = JSON.parse(fs.readFileSync(path.join(home, 'taptap-maker-dev', 'image.json'), 'utf8'))
  ok(raw.apiKey === 'sk-precious-key', '磁盘上的 Key 没被空串覆盖')
  ok(raw.baseURL === 'https://api.example.com/v1', 'baseURL 未受影响')

  // 中转站同样受保护
  const c = await req('POST', 'video-relay', {
    enabled: true, protocol: 'openai', baseURL: 'https://relay.example.com/v1',
    apiKey: 'sk-relay-keep', model: 'vid-1',
  })
  ok(c.status === 200, '先写入中转站配置')
  const d = await req('POST', 'video-relay', { apiKey: '', model: 'vid-2' })
  const relayRaw = JSON.parse(fs.readFileSync(path.join(home, 'taptap-maker-dev', 'video-relay.json'), 'utf8'))
  ok(relayRaw.apiKey === 'sk-relay-keep', '只改 model 时中转站 Key 没被清空', relayRaw.apiKey)
  ok(relayRaw.model === 'vid-2', '中转站 model 已更新')
  ok(d.status === 200, '保存返回 200')
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
  ok(s.json.relay.baseURL === 'https://relay.example.com/v1', '只剥掉 /videos，保留 /v1')
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

console.log('\n[4] 通道优先级 / 开关路由')
{
  const g0 = await req('GET', 'lanes')
  ok(g0.status === 200, 'GET /lanes 正常')
  ok(g0.json.autoFallback === false, '自动回退默认关')
  const v = g0.json.groups?.video
  ok(v && Array.isArray(v.lanes) && v.lanes.length === 3, '视频返回 3 条通道')
  ok(v.lanes[0].id === 'relay', '默认第一条是中转站（与改造前行为一致）', v.lanes[0].id)
  // 没有配任何东西时，只有 local 是天然就绪的 —— 绿点必须如实反映。
  ok(v.lanes.every((l) => l.enabled === true), '默认全部启用')
  ok(v.lanes.find((l) => l.id === 'minimax').ready === false, '没配 Key 时 minimax 状态点为「未配置」')
  ok(/填 API Key/.test(v.lanes.find((l) => l.id === 'minimax').reason || ''), '未配置时给出「该做什么」的提示')
  ok(v.lanes.find((l) => l.id === 'local').ready === true, '本地视频永远就绪')

  const o = await req('POST', 'lanes', { groups: { video: { order: ['minimax', 'relay', 'local'] } } })
  ok(o.status === 200 && o.json.groups.video.lanes[0].id === 'minimax', '重排生效（POST 回与 GET 同形状）')
  const g1 = await req('GET', 'lanes')
  ok(g1.json.groups.video.lanes[0].id === 'minimax', '重排已持久化')

  const d = await req('POST', 'lanes', { groups: { video: { enabled: { minimax: false } } } })
  ok(d.json.groups.video.lanes.find((l) => l.id === 'minimax').enabled === false, '开关生效')
  const g2 = await req('GET', 'lanes')
  ok(g2.json.groups.video.lanes.find((l) => l.id === 'minimax').enabled === false, '开关已持久化')
  ok(g2.json.groups.video.lanes[0].id === 'minimax', '关掉后仍留在列表里（只是不参与）')

  const f = await req('POST', 'lanes', { autoFallback: true })
  ok(f.json.autoFallback === true, '自动回退总开关生效')
  ok((await req('GET', 'lanes')).json.autoFallback === true, '总开关已持久化')

  // 脏数据：全关 / 未知通道 / 非布尔
  const junk = await req('POST', 'lanes', {
    autoFallback: 'yes', // 非布尔 → 该字段保持原值（true），不被这个脏值打开
    groups: {
      video: { order: ['不存在的', 'relay'], enabled: { relay: false, minimax: false, local: false } },
      image: null,
    },
  })
  ok(junk.json.autoFallback === true, '非布尔值不会误开/误关总开关（保持原值）')
  // 直接写坏文件，验证读取端对非布尔的处理
  fs.writeFileSync(path.join(home, 'taptap-maker-dev', 'lanes.json'),
    JSON.stringify({ autoFallback: 'yes', groups: {} }), 'utf8')
  ok((await req('GET', 'lanes')).json.autoFallback === false, '磁盘上的非布尔值按「关」处理')

  const junk2 = await req('POST', 'lanes', {
    groups: {
      video: { order: ['不存在的', 'relay'], enabled: { relay: false, minimax: false, local: false } },
      image: null,
    },
  })
  const jv = junk2.json.groups.video.lanes.map((l) => l.id)
  ok(!jv.includes('不存在的'), '未知通道被丢弃', jv.join(','))
  ok(jv.length === 3, '缺失通道被补回', jv.join(','))
  ok(junk2.json.groups.video.lanes.some((l) => l.enabled), '不会全关（保留一条，避免锁死）')
  ok(Array.isArray(junk2.json.groups.image.lanes) && junk2.json.groups.image.lanes.length === 2, 'image 组为 null 时回落到默认')
}

console.log('\n[5] 素材落点随项目（GET /lanes 与 /asset-dirs 都返回真实路径）')
{
  const g = await req('GET', 'lanes')
  ok(g.json.dirs && g.json.dirs.image && g.json.dirs.video && g.json.dirs.bgm, 'GET /lanes 带回三类素材目录')
  ok(typeof g.json.dirs.image.dir === 'string' && g.json.dirs.image.dir.length > 0, '图片目录非空', g.json.dirs.image.dir)
  // 这个测试不在 Maker 工程里跑，所以三类都该退回 $DSH_HOME。
  ok(g.json.dirs.image.source === 'default', '不在项目里 → source=default', g.json.dirs.image.source)
  ok(g.json.dirs.image.dir.startsWith(path.join(home, 'taptap-maker-dev')), '图片目录在 $DSH_HOME 下', g.json.dirs.image.dir)
  ok(g.json.dirs.video.dir.includes('video-jobs'), '视频目录退回 video-jobs', g.json.dirs.video.dir)
  ok(g.json.dirs.bgm.dir.includes('bgm-downloads'), 'BGM 目录退回 bgm-downloads', g.json.dirs.bgm.dir)

  const a = await req('GET', 'asset-dirs')
  ok(a.status === 200 && Boolean(a.json.dirs?.video?.dir), 'GET /asset-dirs 正常')
  ok(a.json.dirs.image.dir === g.json.dirs.image.dir, '两个接口给的图片目录一致')

  const p = await req('POST', 'lanes', { autoFallback: false })
  ok(Boolean(p.json.dirs?.video?.dir), 'POST /lanes 也回目录（界面保存后不用再拉一次）')
}

console.log('\n[6] 未知路由仍然 404（没有把用户页面挂死）')
{
  const n = await req('GET', 'nope')
  ok(n.status === 404, `未知子路径返回 404（实际 ${n.status}）`)
}

server.close()
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1

