// 章鱼生图「设置页登录」路由的离线自测（不扣积分、不碰真实凭据）。
//
// ⚠️ 诚实说明：**[5] 会真的联网一次** —— 用一组明显的假凭据去撞站点登录，
// 验证「登录被拒时绝不落盘」。假凭据不产生任何费用（不扣积分、不生图、不签到）。
// 站点不可达时该用例依然通过（kind 会是 network，断言只要求三种 kind 之一），
// 所以不会 flaky，只是慢一点。其余用例全程离线。
//
// 为什么值得单独测：这批路由只有真实请求时才会暴露问题（忘 import → 500、
// 掩码串被当成真密码存进去 → 通道当场坏掉、验证失败却仍落盘 → 用户以为配好了）。
// 全部用临时 DSH_HOME + 假 ctx，凭据是明显的假值。
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zaiduyu-'))
console.log(`临时 DSH_HOME：${home}`)

const mod = await import('../index.js')
let routeHandler = null
const noop = () => () => {}
const ctx = {
  logger: { info() {}, warn() {} },
  effect: (fn) => { try { fn() } catch { /* ignore */ } },
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

const server = http.createServer((req, res) => {
  routeHandler(req, res).catch((e) => {
    res.writeHead(500, { 'content-type': 'application/json' })
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
  try { json = JSON.parse(text) } catch { json = { __raw: text.slice(0, 240) } }
  return { status: r.status, json, text }
}

// 关键：确保测试进程里没有 zaiduyu 环境变量残留，否则 env 兜底会让状态变绿。
delete process.env.ZAIDUYU_USER
delete process.env.ZAIDUYU_PASS

console.log('\n[1] GET /zaiduyu 初始状态：未配置，且绝不回显密码')
{
  const g = await req('GET', 'zaiduyu')
  ok(g.status === 200 && g.json.ok === true, 'GET /zaiduyu 正常')
  ok(g.json.hasCredentials === false, '初始未配置站点账号')
  ok(g.json.source === 'none', '来源标为 none')
  ok(g.json.password === '(unset)', '未配置时密码位是 (unset) 而不是空或明文')
  ok(!JSON.stringify(g.json).includes('ZAIDUYU_PASS'), '响应里不带环境变量名以外的密码线索')
  ok(typeof g.json.file === 'string' && g.json.file.endsWith('zaiduyu.json'), '回配置文件路径')
}

console.log('\n[2] POST：只填一半 → 拒绝，不落盘')
{
  const half = await req('POST', 'zaiduyu', { identifier: 'only_user', password: '' })
  ok(half.status === 400 && half.json.ok === false, '半截凭据被拒（400）', `status=${half.status}`)
  const g = await req('GET', 'zaiduyu')
  ok(g.json.hasCredentials === false, '半截凭据没有被保存')
}

console.log('\n[3] POST：换账号但没重填密码 → 拦下并说明原因')
{
  // 先塞一组「看起来已保存」的凭据（直接写文件，绕开验证）。
  fs.mkdirSync(path.join(home, 'taptap-maker-dev'), { recursive: true })
  fs.writeFileSync(path.join(home, 'taptap-maker-dev', 'zaiduyu.json'),
    JSON.stringify({ identifier: 'old_user', password: 'old_pw_123456' }), 'utf8')
  const swapped = await req('POST', 'zaiduyu', { identifier: 'new_user', password: '' })
  ok(swapped.status === 400 && /换了账号/.test(swapped.json.error ?? ''), '换号未填新密码被拦下', JSON.stringify(swapped.json))
  ok(fs.readFileSync(path.join(home, 'taptap-maker-dev', 'zaiduyu.json'), 'utf8').includes('old_user'), '被拦下时文件没被改动')
}

console.log('\n[4] POST：掩码串原样回传 → 识别为「未修改」，不把掩码当密码存')
{
  const g = await req('GET', 'zaiduyu')
  const masked = g.json.password
  ok(typeof masked === 'string' && masked.includes('…'), `GET 回的是掩码（${masked}）`)
  // 环境未就绪时验证会失败（kind=environment），但**掩码必须已被归一化为不修改**，
  // 而不是把 `ol…3456` 这种掩码串写进 password 字段。
  await req('POST', 'zaiduyu', { identifier: 'old_user', password: masked })
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'taptap-maker-dev', 'zaiduyu.json'), 'utf8'))
  ok(raw.password === 'old_pw_123456', '掩码回传没有覆盖掉真密码', `实际=${raw.password}`)
  ok(!String(raw.password).includes('…'), '文件里没有掩码串')
}

console.log('\n[5] POST 登录：环境未就绪 → 503 + kind=environment，且不落盘')
{
  // 假凭据 + 本机没装脚本所依赖的东西时，必须归为「环境问题」而不是「密码错」。
  // 这台机器上 python 与脚本都在，所以真会联网：用明显假的凭据，让它走到
  // 站点拒绝的分支 —— 但仍要断言它**没有**被保存。
  const bad = await req('POST', 'zaiduyu', { identifier: 'obviously_fake_user', password: 'obviously_fake_pw' })
  ok(bad.status === 401 || bad.status === 503, `验证不过时不落盘（实际 ${bad.status}）`)
  ok(bad.json.ok === false && bad.json.verified === false, '明确报 verified=false')
  ok(['auth', 'network', 'environment'].includes(bad.json.kind), `失败有可分诊的 kind（${bad.json.kind}）`)
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'taptap-maker-dev', 'zaiduyu.json'), 'utf8'))
  ok(raw.identifier === 'old_user', '失败的假凭据没有被写进文件')
  ok(!JSON.stringify(raw).includes('obviously_fake'), '假凭据完全没落盘')
}

console.log('\n[6] POST clear：清除本机凭据（env 兜底时如实警告）')
{
  const c = await req('POST', 'zaiduyu', { clear: true })
  ok(c.status === 200 && c.json.ok === true, 'clear 返回 200')
  ok(c.json.credentials === false, '清除后状态为未配置')
  ok(!fs.existsSync(path.join(home, 'taptap-maker-dev', 'zaiduyu.json')), '凭据文件已删除')
  const g = await req('GET', 'zaiduyu')
  ok(g.json.hasCredentials === false && g.json.password === '(unset)', 'GET 如实反映已清除')

  // 回归护栏：只有文件在、env 也有一组时，删文件**不等于退登**，
  // 必须把「env 仍在兜底」说出来，否则用户以为退出了、实际还在花那个号的积分。
  fs.writeFileSync(path.join(home, 'taptap-maker-dev', 'zaiduyu.json'),
    JSON.stringify({ identifier: 'file_u', password: 'file_p' }), 'utf8')
  process.env.ZAIDUYU_USER = 'env_u'
  process.env.ZAIDUYU_PASS = 'env_p'
  try {
    const c2 = await req('POST', 'zaiduyu', { clear: true })
    ok(c2.json.credentials === true, 'env 有凭据时清除文件后仍然可用（事实如此）')
    ok(/并没有真正退登|兜底生效/.test(c2.json.warn ?? ''), '并如实警告没有真正退登', c2.json.warn ?? '(无 warn)')
  } finally {
    delete process.env.ZAIDUYU_USER
    delete process.env.ZAIDUYU_PASS
  }
}

console.log('\n[7] 只读辅助路由在没有凭据时干净失败（不 500、不联网瞎试）')
{
  const b = await req('POST', 'zaiduyu/balance', {})
  ok(b.status === 200 || b.status === 502 || b.status === 503, `balance 不炸宿主（${b.status}）`)
  ok(b.json.ok === false, '没有凭据时 balance 如实报失败')
  ok(typeof b.json.error === 'string' && b.json.error.length > 0, '给出可读原因')
  ok(!JSON.stringify(b.json).includes('Traceback'), '不把 Python 栈糊到界面上')
}

console.log('\n[8] 通道状态点跟着登录结果变（GET /lanes 的 zaiduyu 就绪）')
{
  const before = await req('GET', 'lanes')
  const lb = before.json.groups.image.lanes.find((l) => l.id === 'zaiduyu')
  ok(lb && lb.ready === false, '未登录时状态点为未配置')
  ok(/设置页|章鱼生图/.test(lb.reason || ''), '未配置时指引去设置页（不再是环境变量口径）', lb.reason)
  // 直接写一组凭据（模拟登录成功后的落盘），状态点应当亮起来。
  fs.writeFileSync(path.join(home, 'taptap-maker-dev', 'zaiduyu.json'),
    JSON.stringify({ identifier: 'u', password: 'p', _comment: 'x' }), 'utf8')
  const after = await req('GET', 'lanes')
  const la = after.json.groups.image.lanes.find((l) => l.id === 'zaiduyu')
  ok(la && la.ready === true, '登录保存后状态点立刻变绿（无需重开宿主）')
}

server.close()
fs.rmSync(home, { recursive: true, force: true })
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
