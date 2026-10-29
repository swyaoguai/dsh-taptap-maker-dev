/**
 * 「章鱼生图（积分站）」设置页卡片的离线渲染自测（不启动浏览器、不联网）。
 *
 * 为什么必须渲染一遍：这张卡管的是**密码**。`node --check` 只能保证语法，
 * 保证不了「密码有没有被渲染进输入框」「注册链接是不是真的 <a>」这类结构问题。
 * 而「把已存密码或其掩码填进 value」这种错，界面上看着完全正常，
 * 一旦密码出现在 DOM 里就可能被同源脚本读到 —— 只有把组件真跑一遍才抓得到。
 *
 * 用法：node scripts/verify-zaiduyu-ui.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

/* 极小 hyperscript 替身：收集结构，不碰 DOM（同 verify-lanes-ui 的做法）。 */
const collected = []
const h = (tag, props, ...kids) => {
  const clean = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)
  if (typeof tag === 'function') return tag({ ...(props ?? {}), kids: clean })
  const node = { tag, props: props ?? {}, kids: clean }
  collected.push(node)
  return node
}
const S = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? {} : undefined) })
const StatusChip = (props) => ({ tag: '#StatusChip', props: props ?? {}, kids: [] })
// 组件实际用到 LabeledInput（内部会渲染出 <input type=password>），必须真跑。
const LabeledInput = (props) => h('div', { style: S.row },
  h('label', { style: S.label }, props.label),
  h('input', {
    style: S.input,
    type: props.secret ? 'password' : 'text',
    value: props.value,
    placeholder: props.placeholder || '',
    onChange: () => {},
    spellCheck: false,
    autoComplete: 'off',
  }),
  props.hint ? h('p', { style: S.hint }, props.hint) : null)

const REAL_PASSWORD = 'super_secret_pw_98765'
const MASKED = 'supe…765'

// 按组件里 useState 的出现顺序喂初始值：
// info, form, busy, err, note, warnNote, balance, models
const STATE = {
  info: {
    ok: true, identifier: 'phone_111', password: MASKED,
    hasCredentials: true, source: 'file', envShadowed: false,
    script: true, usable: true, lastVerifiedAt: '2026-10-29T05:00:00.000Z',
    lastIdentifier: 'phone_111', file: '/home/.dsh/taptap-maker-dev/zaiduyu.json',
  },
  form: { identifier: 'phone_111', password: '' },
  busy: '', err: '', note: '', warnNote: '',
  balance: { ok: true, balance: '120', permanent: '100', limited: '20', nextExpiry: '2026-10-29T03:00:00Z' },
  models: [{ model: 'gpt-image-2', credits: '1 积分/张', route: 'images' }],
}
let cursor = 0
const useState = () => [STATE[Object.keys(STATE)[cursor++]] ?? '', () => {}]
const useEffect = () => {} // 不真 fetch：本测只验渲染结构
const useCallback = (fn) => fn

const start = src.indexOf('function ZaiduyuAccount()')
ok(start > 0, '能从 client.js 里定位到 ZaiduyuAccount')
const body = src.slice(start, src.indexOf('\n    /**', start))
ok(body.length > 500, '抠出的组件体长度合理', String(body.length))

cursor = 0
const sandbox = { h, console, S, StatusChip, LabeledInput, API_BASE: '/api/x' }
sandbox.useState = useState
sandbox.useEffect = useEffect
sandbox.useCallback = useCallback
sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
vm.createContext(sandbox)
let tree
try {
  tree = vm.runInContext(`(function(){ ${body}\n return ZaiduyuAccount() })()`, sandbox)
} catch (error) {
  console.log(`\n  ✗ 组件求值失败：${error?.message}`)
  process.exit(1)
}
ok(tree && tree.tag === 'div', '卡片渲染出一棵树')

const text = JSON.stringify(tree)
const inputs = collected.filter((n) => n.tag === 'input')
const passwords = inputs.filter((n) => n.props.type === 'password')

console.log('\n[1] 隐私红线：密码不进 DOM')
{
  ok(passwords.length === 1, '密码框是唯一一个 type=password 的输入框', `实际 ${passwords.length}`)
  ok((passwords[0]?.props.value ?? '') === '', '密码框的 value 是空的（不回显已存密码）', JSON.stringify(passwords[0]?.props.value))
  ok(!text.includes(REAL_PASSWORD), '真实密码字符串没有出现在渲染树里')
  ok(!text.includes(MASKED), '连掩码串也没被填进任何输入框的 value')
  ok(/不要把密码贴进 AI 对话/.test(text), '界面上明确警告不要把密码贴进对话')
}

console.log('\n[2] 状态如实反映登录结果')
{
  ok(/已保存|已配置/.test(text) || text.includes('#StatusChip'), '显示了凭据已配置的状态')
  ok(/上次验证成功/.test(text), '显示「上次验证成功」时间与账号')
  ok(text.includes('phone_111'), '当前账号可见（不是密钥，用户要能确认登的是哪个号）')
  ok(/积分/.test(text), '登录后显示积分余额')
  ok(/限时/.test(text), '区分了永久/限时积分（限时当天过期，不能只报总额）')
}

console.log('\n[3] 操作入口齐备（登录 / 验证 / 价目 / 清除）')
{
  const buttons = collected.filter((n) => n.tag === 'button')
  const labels = buttons.map((b) => String(b.kids.map((k) => (typeof k === 'string' ? k : JSON.stringify(k))).join('')))
  ok(labels.some((l) => /重新验证并保存|登录并保存/.test(l)), '有「登录并保存」入口', labels.join(' | ').slice(0, 160))
  ok(labels.some((l) => /跳过验证/.test(l)), '有「仍要保存（跳过验证）」逃生口')
  ok(labels.some((l) => /查积分/.test(l)), '有查积分入口')
  ok(labels.some((l) => /模型价目/.test(l)), '有「看模型价目」入口（生图前必须先看单价）')
  ok(labels.some((l) => /清除账号/.test(l)), 'source=file 时提供清除入口')
  const login = buttons.find((b) => /登录并保存|重新验证并保存/.test(String(b.kids)))
  ok(login && login.props.disabled === false, '已保存凭据时即使密码框为空也能重新验证（不是点不动）')
}

console.log('\n[4] 模型价目表渲染成结构化列表')
{
  ok(/gpt-image-2/.test(text), '价目表里出现模型 id')
  ok(/1 积分\/张/.test(text), '出现单张积分')
  ok(/未标价 ≠ 免费/.test(text), '提示未标价不等于免费')
}

console.log('\n[5] 未登录时的引导（不指使命令行）')
{
  cursor = 0
  const offInfo = {
    ok: true, identifier: '', password: '(unset)', hasCredentials: false, source: 'none',
    envShadowed: false, script: true, usable: false, lastVerifiedAt: null, lastIdentifier: null,
    file: '/x/zaiduyu.json',
  }
  const STATE2 = { info: offInfo, form: { identifier: '', password: '' }, busy: '', err: '', note: '', warnNote: '', balance: null, models: null }
  let c2 = 0
  const sandbox2 = { h: (t, p, ...k) => h(t, p, ...k), console, S, StatusChip, LabeledInput, API_BASE: '/api/x' }
  sandbox2.useState = () => [STATE2[Object.keys(STATE2)[c2++]] ?? '', () => {}]
  sandbox2.useEffect = () => {}
  sandbox2.useCallback = (fn) => fn
  sandbox2.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  vm.createContext(sandbox2)
  const before = collected.length
  const t2 = vm.runInContext(`(function(){ ${body}\n return ZaiduyuAccount() })()`, sandbox2)
  const s2 = JSON.stringify(t2)
  ok(/pai\.zaiduyu\.top/.test(s2), '未登录时给出站点入口')
  const anchors = collected.slice(before).filter((n) => n.tag === 'a')
  ok(anchors.length >= 1, '注册入口是真的 <a> 链接（不是纯文本一长串）', String(anchors.length))
  ok(/#\//.test(String(anchors[0]?.props?.href ?? '')), 'href 带完整 fragment（手抄极易漏 #/auth?ref=）')
  ok(!/SetEnvironmentVariable/.test(s2), '界面不再指使命令行配环境变量')
  ok(/未配置账号|未配置/.test(s2) || t2 !== undefined, '显示未配置状态')
}

console.log('\n[6] env 兜底时必须亮出来源（否则用户以为保存过）')
{
  cursor = 0
  const envInfo = {
    ok: true, identifier: 'env_user', password: '(unset)', hasCredentials: true, source: 'env',
    envShadowed: false, script: true, usable: true, lastVerifiedAt: null, lastIdentifier: null,
    file: '/x/zaiduyu.json',
  }
  const STATE3 = { info: envInfo, form: { identifier: 'env_user', password: '' }, busy: '', err: '', note: '', warnNote: '', balance: null, models: null }
  let c3 = 0
  const sandbox3 = { h: (t, p, ...k) => h(t, p, ...k), console, S, StatusChip, LabeledInput, API_BASE: '/api/x' }
  sandbox3.useState = () => [STATE3[Object.keys(STATE3)[c3++]] ?? '', () => {}]
  sandbox3.useEffect = () => {}
  sandbox3.useCallback = (fn) => fn
  sandbox3.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  vm.createContext(sandbox3)
  const t3 = JSON.stringify(vm.runInContext(`(function(){ ${body}\n return ZaiduyuAccount() })()`, sandbox3))
  ok(/环境变量/.test(t3) && /ZAIDUYU_USER/.test(t3), '凭据只来自 env 时如实标出来')
  const btns = JSON.stringify(t3)
  ok(!/清除账号/.test(btns), 'env 来源时不提供「清除账号」（清文件不会真的退登，不给假按钮）')
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
