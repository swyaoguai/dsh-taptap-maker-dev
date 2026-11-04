/**
 * 设置页 ↔ 宿主路由的**往返**自测：真路由产出的 JSON 直接喂给客户端组件渲染。
 *
 * 为什么非要有这一个：`verify-host-routes` 只验 JSON，`verify-lanes-ui` 只验渲染
 * （数据是手写的假对象）。两张皮合起来验，才能挡住真正坑过用户的那类问题 ——
 * 服务端把 `autoFallback` 放错层级 / 字段改名后，界面照样能画出来，只是
 * **每个「按顺序自动回退」开关都显示成「关」**，用户以为功能没了（这正是
 * 2026-11 那次反馈的观感来源）。这里断的就是：服务端说什么，界面就显示什么。
 *
 * 做法：假 ctx + 真 http.createServer（同 verify-host-routes）+ vm 里跑
 * client.js 的 LanePriorityCard（同 verify-lanes-ui）。不联网、不花额度。
 *
 * 用法：node scripts/verify-lanes-roundtrip.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lanes-roundtrip-'))

/* ── 1) 起一个真的路由（宿主是假的） ── */
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
ok(typeof routeHandler === 'function', 'apply() 注册了 webServer 路由')

const server = http.createServer((req, res) => {
  routeHandler(req, res).catch((e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: e?.message ?? String(e) }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}/api/game-forge`

const req = async (method, sub, body) => {
  const r = await fetch(`${BASE}/${sub}`, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { __raw: text.slice(0, 300) } }
  return { status: r.status, json }
}

/* ── 2) 渲染客户端组件（用上一步拿到的真 JSON） ── */
const clientSrc = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const start = clientSrc.indexOf('function LanePriorityCard(')
ok(start > 0, '能从 client.js 里定位到 LanePriorityCard')
const body = clientSrc.slice(start, clientSrc.indexOf('\n    /**', start))

/** 极小的 h 替身：只收结构，不碰 DOM（组件里 h 的第一参可能是组件函数）。 */
function render(data, props) {
  const collected = []
  const h = (tag, p, ...kids) => {
    const clean = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)
    if (typeof tag === 'function') return tag({ ...(p ?? {}), kids: clean })
    const node = { tag, props: p ?? {}, kids: clean }
    collected.push(node)
    return node
  }
  const S = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? {} : undefined) })
  const Toggle = (p) => {
    const merged = { 'aria-pressed': p?.on === true, ...(p ?? {}) }
    if (p?.ariaLabel) merged['aria-label'] = p.ariaLabel
    return { tag: '#Toggle', props: merged, kids: [] }
  }
  const StatusChip = (p) => ({ tag: '#StatusChip', props: p ?? {}, kids: [] })
  const sandbox = {
    h, console, S, Toggle, StatusChip,
    API_BASE: '/api',
    // 组件 mount 时只 fetcg 一次；这里不需要它真的回数据（数据是外部喂的）。
    fetch: () => ({ then: () => ({ then: () => ({ catch: () => {} }) }) }),
    useState: () => [data, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  vm.createContext(sandbox)
  vm.runInContext(`${body}\nthis.__card = LanePriorityCard`, sandbox)
  const node = sandbox.__card(props ?? {})
  const flat = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    flat.push(n)
    ;(n.kids || []).forEach(walk)
  }
  walk(node)
  return flat
}

// 说明性文字用的是 <p>（标题用 h2、通道名用 span）——三种都要收，否则
// 「状态变了但说明没变」这类问题会被漏过去。
const TEXTTAGS = new Set(['span', 'h2', 'p', 'li'])
const texts = (flat) => flat
  .filter((n) => TEXTTAGS.has(n.tag))
  .map((n) => n.kids[0])
  .filter((x) => typeof x === 'string')

/* ── 3) 断言：服务端说什么，界面就显示什么 ── */
console.log('\n[1] 写入用户要的顺序（章鱼 → 网页 → 中转，生图回退开）')
{
  const saved = await req('POST', 'lanes', {
    groups: {
      image: { order: ['zaiduyu', 'gptWeb', 'relayImage'], autoFallback: true },
      video: { autoFallback: false },
    },
  })
  ok(saved.status === 200 && saved.json.ok === true, 'POST /lanes 成功')
  ok(saved.json.groups.image.autoFallback === true, '回包里 image.autoFallback 是「组级」布尔值（不是顶层全局）', JSON.stringify(saved.json.groups.image.autoFallback))
  ok(saved.json.groups.video.autoFallback === false, '视频组单独为 false（每类各自一个）')
  ok(saved.json.groups.image.lanes.map((l) => l.id).join('>') === 'zaiduyu>gptWeb>relayImage', '顺序写入生效', saved.json.groups.image.lanes.map((l) => l.id).join('>'))
}

console.log('\n[2] GET /lanes 的形状 → 界面渲染结果一致')
{
  const got = await req('GET', 'lanes')
  ok(got.status === 200 && got.json.ok === true, 'GET /lanes 成功')

  const flat = render(got.json, { only: 'image' })
  const all = texts(flat)
  ok(all.includes('生图通道优先级'), '「图片」页那张卡标题正确', String(all.slice(0, 3)))

  const toggles = flat.filter((n) => n.tag === '#Toggle')
  ok(toggles.length === 4, '1 个「按顺序自动回退」+ 3 条通道开关', String(toggles.length))
  ok(toggles[0].props.on === true, '界面显示回退「开」—— 与服务端一致（不是恒显示关）', String(toggles[0].props.on))
  ok(/按顺序自动回退/.test(toggles[0].props['aria-label'] ?? ''), '回退开关有 aria-label')

  const laneLabels = all.filter((x) => ['章鱼生图（积分站）', 'ChatGPT 网页生图', '中转站生图'].includes(x))
  ok(laneLabels.join('>') === '章鱼生图（积分站）>ChatGPT 网页生图>中转站生图', '三条通道按服务端顺序渲染', laneLabels.join('>'))

  // 没配好的通道（本机临时 home 里三条都没配）必须写着「会被跳过」，
  // 而不是画成可用 —— 否则用户会以为生图马上能用。
  ok(all.some((x) => /还没配好/.test(x)) || flat.some((n) => n.tag === '#StatusChip' && n.props.on === false),
    '未配置的通道被标出来（状态点 / 理由）')
}

console.log('\n[3] 在设置页把它关掉 → 下一次 GET 立刻反映为「关」')
{
  await req('POST', 'lanes', { groups: { image: { autoFallback: false } } })
  const got = await req('GET', 'lanes')
  ok(got.json.groups.image.autoFallback === false, '服务端已改为 false')

  const flat = render(got.json, { only: 'image' })
  const toggles = flat.filter((n) => n.tag === '#Toggle')
  ok(toggles[0].props.on === false, '界面同步显示「关」')
  ok(texts(flat).includes('关着：只用顺序里第一条可用的通道；它失败就停下，并把每条通道的原因列给你。'),
    '说明文字跟着状态变（不是永远同一句）')
}

console.log('\n[4] 只渲染本组：「开始」页总览卡三组都在')
{
  const got = await req('GET', 'lanes')
  const overview = texts(render(got.json))
  ok(['生图', '视频', '背景音乐'].every((x) => overview.includes(x)), '总览卡列出三类', overview.filter((x) => ['生图', '视频', '背景音乐'].includes(x)).join('>'))
  const imageOnly = texts(render(got.json, { only: 'image' }))
  ok(!imageOnly.includes('视频'), 'only: image 时不渲染视频那组')
}

console.log('\n[5] 老宿主兼容：服务端没给组级 autoFallback 时，界面要明说「重启后生效」')
{
  const got = await req('GET', 'lanes')
  const legacy = JSON.parse(JSON.stringify(got.json))
  for (const g of Object.values(legacy.groups)) delete g.autoFallback
  const flat = render(legacy, { only: 'image' })
  ok(texts(flat).some((x) => /服务端还是旧版/.test(x)), '旧形状下给出「重启 DSH 后生效」的提示')
}

await new Promise((r) => server.close(r))
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
