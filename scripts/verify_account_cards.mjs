/**
 * 设置页账号卡片的回归测试（渲染级，不启动浏览器）。
 *
 * 背景（2026-10-23 用户反馈 + 截图）：
 *   - 卡片里常驻一行「主账号」，它的「登录」按钮和下面「添加并登录」并排摆着，
 *     但两者职责完全不同：前者只是登默认 profile，**不会新建账号**。
 *     两个入口长得像 → 用户点错，以为「添加并登录」才是添加新账号的按钮。
 *   - 截图里还自相矛盾：顶部「已登录」，主账号那行却写「未登录」——
 *     因为顶部的「已登录」是 `info.loggedIn || pool.loggedIn > 0`（任一账号登录即算），
 *     而每行只显示该账号自己的状态。
 *
 * 现在：删掉主账号行（唯一新增入口是「添加并登录」，常驻输入框+醒目主按钮），
 * 顶部改成「N / M 个账号已登录」，与每行状态一致。
 *
 * 用法：node scripts/verify-account-cards.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log('  ✓ ' + label) }
  else { failed += 1; console.log('  ✗ ' + label + (extra ? ' — ' + extra : '')) }
}

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const h = (tag, props, ...kids) => {
  const node = { tag, props: props ?? {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false) }
  return typeof tag === 'function' ? tag(props ?? {}) : node
}
const S = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? {} : undefined) })
const noop = () => ({})

const textsOf = (node) => {
  const out = []
  const walk = (n) => {
    if (typeof n === 'string') { out.push(n); return }
    if (n && Array.isArray(n.kids)) n.kids.forEach(walk)
  }
  walk(node)
  return out
}

const renderCard = (fnName, info) => {
  const start = src.indexOf('function ' + fnName + '(')
  if (start < 0) return null
  const end = src.indexOf('\n    function ', start + 10)
  const body = src.slice(start, end < 0 ? src.length : end)
  const ctx = {
    h, S, API_BASE: '/api', console,
    useEffect: noop, useCallback: (fn) => fn,
    setInterval: () => 0, clearInterval: noop, setTimeout: noop, clearTimeout: noop,
    StatusChip: (p) => ({ tag: '#Chip', props: p, kids: [] }),
    Toggle: (p) => ({ tag: '#Toggle', props: p, kids: [] }),
    LabeledInput: (p) => ({ tag: '#Input', props: p, kids: [] }),
    fetch: () => ({ then: () => ({ then: () => {}, catch: () => {} }), catch: () => ({ then: () => {} }) }),
  }
  let used = false
  ctx.useState = (init) => {
    const v = typeof init === 'function' ? init() : init
    if (!used) { used = true; return [info, noop] }
    return [v, noop]
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(body + '\nthis.__c = ' + fnName, ctx)
  return textsOf(ctx.__c())
}

console.log('\n[1] ChatGPT 生图卡')
{
  // 复现截图里的矛盾场景：主 profile 未登录，池里两个账号已登录
  const info = {
    loggedIn: false,
    laneEnabled: true,
    pool: {
      total: 2, loggedIn: 2, autoRotate: true, cooling: 0, banned: 0,
      accounts: [
        { id: '520', label: '520', loggedIn: true, status: 'ok' },
        { id: '2026aaa', label: '2026aaa', loggedIn: true, status: 'ok' },
      ],
    },
  }
  const texts = renderCard('GptAccount', info)
  ok(Array.isArray(texts), '卡片可渲染')
  const all = texts.join(' | ')
  ok(!texts.includes('主账号'), '不再有「主账号」这一行')
  ok(texts.includes('520') && texts.includes('2026aaa'), '池里的账号都还在')
  ok(/2 \/ 2 个账号已登录/.test(all), '顶部显示「2 / 2 个账号已登录」，与每行一致')
  ok(!/^已登录，可生成图片。$/.test(all.trim()), '不再是笼统的「已登录，可生成图片。」')
  ok(texts.includes('添加并登录'), '「添加并登录」存在')
  ok(!texts.includes('+ 添加账号'), '不再需要先点「+ 添加账号」展开')
  ok(!texts.includes('取消'), '没有「取消」（输入框常驻）')
  ok(src.includes('新账号短名，如 a2'), '输入框 placeholder 表明这是新增账号')

  // 池子为空时也要有引导，而不是一块空白
  const empty = { loggedIn: false, laneEnabled: true, pool: { total: 0, loggedIn: 0, autoRotate: true, cooling: 0, banned: 0, accounts: [] } }
  const emptyTexts = renderCard('GptAccount', empty)
  ok(emptyTexts !== null, '空账号池也能渲染')
  const emptyAll = (emptyTexts || []).join(' | ')
  ok(/还没有账号/.test(emptyAll), '空账号池给出引导文案')
  ok((emptyTexts || []).includes('添加并登录'), '空账号池仍能添加')
}

console.log('\n[2] BGM 账号卡（同样结构，一并修）')
{
  const info = {
    hasCookies: false,
    site: null,
    pool: {
      total: 1, loggedIn: 1, autoRotate: true, cooling: 0, banned: 0,
      accounts: [{ id: 'b2', label: 'b2', hasCookies: true, status: 'ok' }],
    },
  }
  const texts = renderCard('BgmAccount', info)
  ok(Array.isArray(texts), 'BGM 卡片可渲染')
  const all = (texts || []).join(' | ')
  ok(!(texts || []).includes('主账号'), 'BGM 卡也不再显示「主账号」行')
  ok(/1 \/ 1 个账号已登录/.test(all), 'BGM 顶部同样是「N / M」口径', all.slice(0, 160))
  ok((texts || []).includes('添加并登录'), 'BGM 也有「添加并登录」')
}

console.log('\n[3] 源码里不再有主账号入口')
{
  ok(!src.includes('isMain: true'), '没有构造 isMain 的主账号行')
  ok(!src.includes('showAdd'), '旧的「+ 添加账号」展开状态已移除')
  ok(!src.includes('busyKey'), 'busyKey 辅助函数已移除')
  const activeLines = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l))
  ok(!activeLines.some((l) => l.includes('主账号')), '代码（不含注释）里不再提到「主账号」')
}

console.log('\n结果：' + passed + ' 项通过，' + failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)
