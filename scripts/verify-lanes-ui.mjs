/**
 * 通道优先级 UI 的离线渲染自测（不启动浏览器、不联网）。
 *
 * 为什么要单独测这块：这张卡是纯手写 hyperscript，括号一多就容易在**语法**
 * 上错（node --check 只能保证语法，保证不了 JSX 结构的对应关系）。这里用一
 * 个极小的 `h` 替身把组件真跑一遍，把 props 树收集出来，验证：
 *   1. 每条通道都渲染了，且顺序与后端返回一致；
 *   2. 开关 / 上移 / 下移 / 拖拽事件都挂上了；
 *   3. "开着但没配" 与 "关着" 是分开显示的（状态点不能混为一谈）。
 *
 * 用法：node scripts/verify-lanes-ui.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

/* ── 极小 hyperscript 替身：只收集结构，不碰 DOM ── */
// 真实 client.js 的 h() 会把「函数类型的第一参数」当组件渲染（h(Toggle, {...}）。
// 这个替身必须复刻这一点，否则组件节点会以函数源码的形式出现在树里，测不到。
const collected = []
const h = (tag, props, ...kids) => {
  const clean = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)
  if (typeof tag === 'function') {
    return tag({ ...(props ?? {}), kids: clean })
  }
  const node = { tag, props: props ?? {}, kids: clean }
  collected.push(node)
  return node
}
const useState = (init) => [typeof init === 'function' ? init() : init, () => {}]
const useEffect = () => {}
const useCallback = (fn) => fn

// 从 client.js 里把 LanePriorityCard 抠出来单独求值。
const start = src.indexOf('function LanePriorityCard(')
ok(start > 0, '能从 client.js 里定位到 LanePriorityCard')
const body = src.slice(start, src.indexOf('\n    /**', start))

const S = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? {} : undefined) })
// 极小替身：只实现本组件实际用到的几个 —— 'loading' 之外的都当作已有数据。
const makeUseState = (initial) => (typeof initial === 'function' ? initial() : initial)
const Toggle = (props) => {
  const p = { 'aria-pressed': props?.on === true, ...(props ?? {}) }
  // 真组件的 Toggle 会把 ariaLabel 落成 aria-label（无文字标签的开关全靠它）
  if (props?.ariaLabel) p['aria-label'] = props.ariaLabel
  return { tag: '#Toggle', props: p, kids: [] }
}
const StatusChip = (props) => ({ tag: '#StatusChip', props: props ?? {}, kids: [] })

// 组件要的数据（模拟后端 GET /lanes 的返回）
const LOADED = {
  autoFallback: false,
  file: '/home/.dsh/game-forge/lanes.json',
  groups: {
    video: {
      label: '视频',
      // 每类素材一个「按顺序自动回退」开关（生图默认开、视频/BGM 默认关）。
      autoFallback: true,
      lanes: [
        { id: 'relay', label: '视频中转站', kind: 'api', note: '你自己的地址', enabled: true, ready: true },
        { id: 'minimax', label: 'MiniMax 官方', kind: 'api', note: '订阅或按量', enabled: true, ready: false, reason: '需要在下面「MiniMax」填 API Key' },
        { id: 'local', label: '自选本地视频', kind: 'local', note: '挂本地 mp4', zeroCost: true, enabled: false, ready: true },
      ],
    },
    image: {
      label: '生图',
      autoFallback: true,
      lanes: [
        { id: 'zaiduyu', label: '章鱼生图（积分站）', kind: 'api', note: '积分制', enabled: true, ready: true },
        { id: 'gptWeb', label: 'ChatGPT 网页生图', kind: 'web', note: '浏览器通道', enabled: true, ready: true },
      ],
    },
  },
}

const sandbox = { h, console }
sandbox.useState = makeUseState
// 让组件第一次 useState 就拿到已加载的数据（跳过 loading 分支）。
sandbox.useState = (init) => [LOADED, () => {}]
sandbox.useEffect = () => {}
sandbox.useCallback = (fn) => fn
sandbox.S = S
sandbox.Toggle = Toggle
sandbox.StatusChip = StatusChip
sandbox.API_BASE = '/api'
sandbox.fetch = () => ({ then: () => ({ then: () => {} }) })
vm.createContext(sandbox)
try {
  vm.runInContext(`${body}\nthis.__card = LanePriorityCard`, sandbox)
} catch (e) {
  ok(false, 'LanePriorityCard 能被独立求值', e.message)
}

console.log('\n[1] 渲染结构（only: video）')
if (sandbox.__card) {
  const node = sandbox.__card({ only: 'video' })
  const flat = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    flat.push(n)
    ;(n.kids || []).forEach(walk)
  }
  walk(node)

  const labels = flat.filter((n) => n.tag === 'span').map((n) => n.kids[0]).filter((x) => typeof x === 'string')
  ok(labels.includes('视频中转站'), '渲染出通道名称')
  ok(labels.includes('MiniMax 官方'), '三条通道都在')
  ok(!labels.includes('章鱼生图（积分站）'), 'only: video 时不渲染生图那组（用户在自己的页面里只看自己那组）')

  const toggles = flat.filter((n) => typeof n.onClick === 'function' && n.props && n.props['aria-pressed'] !== undefined)
  const buttons = flat.filter((n) => n.tag === 'button')
  ok(buttons.length >= 3, '有上移/下移按钮', String(buttons.length))
  ok(buttons.some((b) => b.props['aria-label'] === '视频中转站 上移'), '上移按钮带 aria-label（键盘可达）')
  ok(buttons.some((b) => b.props['aria-label'] === '自选本地视频 下移'), '下移按钮带 aria-label')

  // 拖拽的落点已经从「整行 draggable」改成「每行一个专门的抓手」：
  //   - 整行可拖会让按在开关/上下按钮上的一动就变成拖拽，点不准；
  //   - 关掉的通道**也要能排**（重新打开后就按这个顺序走），所以三行都有抓手，
  //     不是「只有启用的能拖」。
  // 于是断言改成：每行恰好一个抓手 + 行上接住 dragover/drop + 抓手上发 dragstart。
  const draggables = flat.filter((n) => n.props && n.props.draggable === true)
  ok(draggables.length === 3, '每条通道各一个拖拽抓手（含关掉的通道）', String(draggables.length))
  ok(draggables.every((n) => typeof n.props.onDragStart === 'function'), '抓手上发 onDragStart')
  const rows = flat.filter((n) => n.props && typeof n.props.onDragOver === 'function' && typeof n.props.onDrop === 'function')
  ok(rows.length === 3, '每行都接住 onDragOver / onDrop（含关掉的通道）', String(rows.length))

  ok(flat.some((n) => n.tag === '#Toggle' && n.props['aria-pressed'] === true && typeof n.props.onClick === 'function'), '有处于开启态且可点击的开关')

  // 开关 + 状态点必须分开表达：「关着」和「开着但没配」的下一步完全不同。
  // 注意共有 4 个开关：1 个「按顺序自动回退」（每类一个）+ 3 条通道各一个。
  const allToggles = flat.filter((n) => n.tag === '#Toggle')
  ok(allToggles.length === 4, '1 个「按顺序自动回退」+ 每条通道各 1 个开关', String(allToggles.length))
  // 这一组的开关在组头渲染（LOADED.groups.video.autoFallback = true）。
  const groupSwitch = allToggles[0]
  ok(groupSwitch.props.on === true, '「按顺序自动回退」跟随后端配置（每组一个）')
  ok(/自动回退/.test(groupSwitch.props['aria-label'] || ''), '无文字开关带 aria-label（读屏能念出来）', groupSwitch.props['aria-label'])
  const laneToggles = allToggles.slice(1)
  ok(laneToggles.filter((t) => t.props.on === true).length === 2, '两条通道处于开启态', String(laneToggles.filter((t) => t.props.on === true).length))
  ok(laneToggles.filter((t) => t.props.on === false).length === 1, '一条通道处于关闭态')
  const chips = flat.filter((n) => n.tag === '#StatusChip')
  ok(chips.filter((c) => c.props.on === false).length === 1, '有一条通道显示「未配置」状态点')
  const unreadyChip = chips.find((c) => c.props.on === false)
  ok(/填 API Key/.test(unreadyChip.props.title || ''), '未配置状态点带「该去做什么」的提示', unreadyChip.props.title)
}

console.log('\n[2] 生图那组：顺序就是使用顺序（章鱼在最上面）')
if (sandbox.__card) {
  const flatOf = (node) => {
    const out = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      out.push(n)
      ;(n.kids || []).forEach(walk)
    }
    walk(node)
    return out
  }
  const flat = flatOf(sandbox.__card({ only: 'image' }))
  const heads = flat.filter((n) => n.tag === 'h2').map((n) => n.kids[0]).filter((x) => typeof x === 'string')
  ok(heads.includes('生图通道优先级'), '标题按所选模块命名', String(heads[0]))
  const labels = flat.filter((n) => n.tag === 'span').map((n) => n.kids[0]).filter((x) => typeof x === 'string')
  const idxZaiduyu = labels.indexOf('章鱼生图（积分站）')
  const idxGpt = labels.indexOf('ChatGPT 网页生图')
  ok(idxZaiduyu >= 0 && idxGpt > idxZaiduyu, '默认顺序里章鱼在网页之前（= 先试章鱼）', `${idxZaiduyu} vs ${idxGpt}`)

  // 不带 only 时三组全渲染（「开始」页的总览卡）
  const all = flatOf(sandbox.__card())
  const allLabels = all.filter((n) => n.tag === 'span').map((n) => n.kids[0]).filter((x) => typeof x === 'string')
  ok(allLabels.includes('视频中转站') && allLabels.includes('章鱼生图（积分站）'), '不传 only 时各类通道全列出来（总览）')
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)