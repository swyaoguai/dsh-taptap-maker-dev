/**
 * Engine-independent, versioned UI authoring document. No IO, network, eval,
 * engine callbacks or generation providers. The preview and host share this
 * exact validator/action interpreter; Maker bindings stay in generated Lua.
 * Independently authored by this plugin, not a copy of the LGUI runtime.
 */
export const UI_FORMAT = 'taptap-ui'
export const UI_VERSION = 1
export const UI_LIMITS = Object.freeze({ bytes: 1_000_000, nodes: 1000, actions: 200, steps: 32 })
export const UI_NODE_TYPES = Object.freeze(['panel', 'label', 'button', 'image', 'list', 'modal'])
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const COLOR = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])
const COMMON_PROPS = ['backgroundColor', 'borderColor', 'borderWidth', 'borderRadius', 'visible', 'enabled', 'opacity']
const PROPS = {
  panel: COMMON_PROPS,
  modal: COMMON_PROPS,
  label: [...COMMON_PROPS, 'text', 'fontSize', 'fontWeight', 'color', 'align'],
  button: [...COMMON_PROPS, 'text', 'fontSize', 'fontWeight', 'color', 'align'],
  image: [...COMMON_PROPS, 'asset', 'imageFit', 'slice'],
  list: [...COMMON_PROPS, 'static'],
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const scalar = value => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const safeId = value => typeof value === 'string' && ID.test(value) && !FORBIDDEN.has(value)
const templateKeys = value => [...String(value).matchAll(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g)].map(match => match[1])

export function validateUiDocument(document) {
  const errors = []; const warnings = []
  const error = (code, message, pointer) => errors.push({ code, message, path: pointer })
  const keys = (value, allowed, pointer) => {
    if (!record(value)) { error('UI_SCHEMA', '应为普通对象。', pointer); return false }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN.has(key) || !allowed.includes(key)) error('UI_UNSUPPORTED', `不支持的字段：${key}。`, `${pointer}/${key}`)
    }
    return true
  }
  if (!record(document)) return { ok: false, errors: [{ code: 'UI_SCHEMA', message: '需要 UI 文档对象。', path: '/' }], warnings, nodeCount: 0, assetCount: 0 }
  let serialized
  try { serialized = JSON.stringify(document) } catch { error('UI_SCHEMA', '文档不可序列化；不能含循环或函数。', '/') }
  if (serialized && (serialized.length > UI_LIMITS.bytes || new TextEncoder().encode(serialized).byteLength > UI_LIMITS.bytes)) {
    error('UI_LIMIT', 'UI 文档超过 1 MB。', '/')
    return { ok: false, errors, warnings, nodeCount: 0, assetCount: 0 }
  }
  keys(document, ['format', 'version', 'name', 'design', 'nodes', 'assets', 'state', 'actions', 'events', 'bindings', 'source'], '')
  if (document.format !== UI_FORMAT || document.version !== UI_VERSION) error('UI_VERSION', '只支持 taptap-ui version 1；不自动猜测或升级。', '/version')
  if (typeof document.name !== 'string' || !document.name.trim() || document.name.length > 120) error('UI_SCHEMA', '文档名称须为 1–120 个字符。', '/name')
  if (keys(document.design, ['width', 'height', 'orientation'], '/design')) {
    if (!finite(document.design.width, 64, 8192) || !finite(document.design.height, 64, 8192)) error('UI_LAYOUT', '设计尺寸须在 64–8192 像素范围内。', '/design')
    if (!['landscape', 'portrait'].includes(document.design.orientation)) error('UI_LAYOUT', '必须显式声明 landscape 或 portrait。', '/design/orientation')
    if ((document.design.orientation === 'landscape' && document.design.width < document.design.height) || (document.design.orientation === 'portrait' && document.design.width > document.design.height)) error('UI_LAYOUT', '设计尺寸与声明方向不符。', '/design')
  }
  const nodes = Array.isArray(document.nodes) ? document.nodes : []
  if (!Array.isArray(document.nodes) || !nodes.length) error('UI_SCHEMA', 'nodes 不能为空。', '/nodes')
  if (nodes.length > UI_LIMITS.nodes) error('UI_LIMIT', '最多支持 1000 个节点。', '/nodes')
  const byId = new Map(); const roots = []
  for (const [index, node] of nodes.slice(0, UI_LIMITS.nodes + 1).entries()) {
    const pointer = `/nodes/${index}`
    if (!keys(node, ['id', 'type', 'parent', 'layout', 'props'], pointer)) continue
    if (!safeId(node.id)) error('UI_ID', '节点 ID 只能使用字母开头的字母、数字、横线和下划线。', `${pointer}/id`)
    if (byId.has(node.id)) error('UI_DUPLICATE_ID', `重复节点 ID：${node.id}。`, `${pointer}/id`)
    byId.set(node.id, node)
    if (!UI_NODE_TYPES.includes(node.type)) error('UI_UNSUPPORTED', `不支持的控件类型：${node.type}。`, `${pointer}/type`)
    if (node.parent === null) roots.push(node)
    else if (!safeId(node.parent)) error('UI_PARENT', '必须显式指定父节点 ID，根节点使用 null。', `${pointer}/parent`)
    if (keys(node.layout, ['x', 'y', 'width', 'height'], `${pointer}/layout`)) {
      for (const axis of ['x', 'y']) if (!finite(node.layout[axis], -8192, 8192)) error('UI_LAYOUT', `${axis} 不是有效坐标。`, `${pointer}/layout/${axis}`)
      for (const axis of ['width', 'height']) if (!finite(node.layout[axis], 0, 8192)) error('UI_LAYOUT', `${axis} 不是有效尺寸。`, `${pointer}/layout/${axis}`)
    }
    if (keys(node.props, PROPS[node.type] ?? [], `${pointer}/props`)) {
      for (const [key, value] of Object.entries(node.props)) {
        const at = `${pointer}/props/${key}`
        if (/Color$/.test(key) || key === 'color') { if (typeof value !== 'string' || !COLOR.test(value)) error('UI_PROP', '颜色必须为十六进制颜色。', at) }
        if (['borderWidth', 'borderRadius', 'fontSize'].includes(key) && !finite(value, 0, 512)) error('UI_PROP', '数值属性超出范围。', at)
        if (key === 'opacity' && !finite(value, 0, 1)) error('UI_PROP', '透明度范围为 0–1。', at)
        if (['visible', 'enabled', 'static'].includes(key) && typeof value !== 'boolean') error('UI_PROP', '此属性必须为布尔值。', at)
        if (key === 'text' && (typeof value !== 'string' || value.length > 8192)) error('UI_PROP', '文字须为不超过 8192 字符的字符串。', at)
        if (key === 'fontWeight' && !['normal', 'bold'].includes(value)) error('UI_PROP', '只支持 normal 或 bold。', at)
        if (key === 'align' && !['left', 'center', 'right'].includes(value)) error('UI_PROP', '只支持 left、center 或 right。', at)
        if (key === 'imageFit' && !['contain', 'cover', 'stretch', 'sliced'].includes(value)) error('UI_PROP', '不支持的图片填充方式。', at)
        if (key === 'slice' && (!Array.isArray(value) || value.length !== 4 || value.some(part => !finite(part, 0, 4096)))) error('UI_PROP', '九宫格须显式给出 [上,右,下,左]。', at)
        if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') error('UI_PROP', '不能序列化可执行值。', at)
      }
      if (node.type === 'list' && node.props.static !== true) error('UI_UNSUPPORTED', '本版本仅支持显式 static=true 的固定列表；动态/虚拟列表未实现。', `${pointer}/props/static`)
      if (node.type === 'image' && !safeId(node.props.asset)) error('UI_ASSET', '图片须绑定明确的 asset ID。', `${pointer}/props/asset`)
      if (node.props.imageFit === 'sliced' && !node.props.slice) error('UI_PROP', 'sliced 图片必须有明确九宫格参数。', `${pointer}/props/slice`)
    }
  }
  if (roots.length !== 1 || roots[0]?.type !== 'panel') error('UI_PARENT', '必须有且只有一个 Panel 根节点。', '/nodes')
  for (const node of nodes) {
    if (!record(node)) continue
    if (node.parent !== null && !byId.has(node.parent)) error('UI_PARENT', `父节点不存在：${node.parent}。`, `/nodes/${node.id}/parent`)
    const seen = new Set([node.id]); let parent = byId.get(node.parent)
    while (parent) {
      if (seen.has(parent.id)) { error('UI_CYCLE', `节点父子关系包含循环：${node.id}。`, `/nodes/${node.id}/parent`); break }
      seen.add(parent.id); parent = byId.get(parent.parent)
    }
  }
  if (roots[0]?.layout && record(document.design) && (roots[0].layout.width !== document.design.width || roots[0].layout.height !== document.design.height)) error('UI_LAYOUT', '根节点尺寸必须等于明确的设计尺寸。', '/nodes/root/layout')
  const assets = Array.isArray(document.assets) ? document.assets : []
  if (!Array.isArray(document.assets)) error('UI_SCHEMA', 'assets 必须为数组。', '/assets')
  const assetIds = new Set()
  for (const [index, asset] of assets.entries()) {
    const pointer = `/assets/${index}`
    if (!keys(asset, ['id', 'path', 'sha256', 'license'], pointer)) continue
    if (!safeId(asset.id) || assetIds.has(asset.id)) error('UI_ASSET', '素材 ID 无效或重复。', `${pointer}/id`)
    assetIds.add(asset.id)
    if (typeof asset.path !== 'string' || asset.path.length > 240 || asset.path.includes('\\') || asset.path.includes(':') || asset.path.startsWith('/') || asset.path.split('/').some(part => !part || part === '.' || part === '..') || !/\.(png|jpe?g|webp)$/i.test(asset.path)) error('UI_ASSET', '素材必须为工作区内的 PNG/JPEG/WebP 相对路径，不能为 URL 或越界路径。', `${pointer}/path`)
    if (typeof asset.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(asset.sha256)) error('UI_ASSET', '素材须有 SHA256。', `${pointer}/sha256`)
    if (keys(asset.license, ['kind', 'author', 'source', 'notice', 'verifiedAt'], `${pointer}/license`)) {
      if (!['own', 'CC0', 'MIT', 'OFL'].includes(asset.license.kind)) error('UI_LICENSE', '素材许可必须经过核验；unknown、付费、NC/ND 不可导出。', `${pointer}/license/kind`)
      if (typeof asset.license.author !== 'string' || !asset.license.author.trim() || typeof asset.license.source !== 'string' || !asset.license.source.trim()) error('UI_LICENSE', '必须记录原作者和授权来源。', `${pointer}/license`)
      if (['MIT', 'OFL'].includes(asset.license.kind) && (typeof asset.license.notice !== 'string' || !asset.license.notice.trim())) error('UI_LICENSE', 'MIT/OFL 资源须保留通知文本或其本地路径。', `${pointer}/license/notice`)
    }
  }
  for (const node of nodes) if (node?.type === 'image' && !assetIds.has(node.props?.asset)) error('UI_ASSET', `图片素材不存在：${node.props?.asset}。`, `/nodes/${node.id}/props/asset`)
  const state = record(document.state) ? document.state : {}
  if (!record(document.state)) error('UI_SCHEMA', 'state 须为普通对象。', '/state')
  for (const [key, value] of Object.entries(state)) {
    if (!safeId(key) || !scalar(value)) error('UI_STATE', '状态只能是已声明的标量键值，不能包含原型、对象或函数。', `/state/${key}`)
  }
  const actions = Array.isArray(document.actions) ? document.actions : []
  if (!Array.isArray(document.actions) || actions.length > UI_LIMITS.actions) error('UI_LIMIT', 'actions 必须为最多 200 个动作的数组。', '/actions')
  const actionIds = new Set()
  for (const [index, action] of actions.entries()) {
    const pointer = `/actions/${index}`
    if (!keys(action, ['id', 'when', 'otherwiseToast', 'steps'], pointer)) continue
    if (!safeId(action.id) || actionIds.has(action.id)) error('UI_ACTION', '动作 ID 无效或重复。', `${pointer}/id`)
    actionIds.add(action.id)
    if (action.when !== undefined && keys(action.when, ['key', 'op', 'value'], `${pointer}/when`)) {
      if (!Object.hasOwn(state, action.when.key) || !['gte', 'gt', 'lte', 'lt', 'eq', 'ne'].includes(action.when.op) || !scalar(action.when.value)) error('UI_ACTION', '动作条件必须引用已声明状态及有限比较操作。', `${pointer}/when`)
      if (['gte', 'gt', 'lte', 'lt'].includes(action.when.op) && (typeof state[action.when.key] !== 'number' || typeof action.when.value !== 'number')) error('UI_ACTION', '范围比较只允许数字。', `${pointer}/when`)
    }
    if (action.otherwiseToast !== undefined && (typeof action.otherwiseToast !== 'string' || action.otherwiseToast.length > 1000)) error('UI_ACTION', '提示文字无效。', `${pointer}/otherwiseToast`)
    if (!Array.isArray(action.steps) || action.steps.length > UI_LIMITS.steps) { error('UI_LIMIT', '每个动作最多 32 个步骤。', `${pointer}/steps`); continue }
    for (const [stepIndex, step] of action.steps.entries()) {
      const at = `${pointer}/steps/${stepIndex}`
      if (!keys(step, ['type', 'key', 'value', 'node', 'text'], at)) continue
      if (!['increment', 'set', 'show', 'hide', 'toggle', 'toast'].includes(step.type)) error('UI_ACTION', `未实现的动作步骤：${step.type}。`, `${at}/type`)
      if (['increment', 'set'].includes(step.type) && (!Object.hasOwn(state, step.key) || !scalar(step.value))) error('UI_ACTION', '不能更新未声明状态。', at)
      if (step.type === 'increment' && (typeof state[step.key] !== 'number' || !finite(step.value, -1e9, 1e9))) error('UI_ACTION', 'increment 仅允许有限数字。', at)
      if (['show', 'hide', 'toggle'].includes(step.type) && !byId.has(step.node)) error('UI_ACTION', '显隐动作必须引用已存在节点。', at)
      if (step.type === 'toast' && (typeof step.text !== 'string' || step.text.length > 1000)) error('UI_ACTION', '提示文字无效。', at)
    }
  }
  const bindings = Array.isArray(document.bindings) ? document.bindings : []
  if (!Array.isArray(document.bindings)) error('UI_SCHEMA', 'bindings 必须为数组。', '/bindings')
  for (const [index, binding] of bindings.entries()) {
    const pointer = `/bindings/${index}`
    if (!keys(binding, ['node', 'property', 'template'], pointer)) continue
    if (!['label', 'button'].includes(byId.get(binding.node)?.type) || binding.property !== 'text' || typeof binding.template !== 'string' || binding.template.length > 8192 || templateKeys(binding.template).some(key => !Object.hasOwn(state, key))) error('UI_BINDING', '文字绑定必须引用文字/按钮节点与已声明状态键。', pointer)
  }
  const events = Array.isArray(document.events) ? document.events : []
  if (!Array.isArray(document.events)) error('UI_SCHEMA', 'events 必须为数组。', '/events')
  const eventKeys = new Set()
  for (const [index, event] of events.entries()) {
    const pointer = `/events/${index}`
    if (!keys(event, ['node', 'event', 'action'], pointer)) continue
    if (byId.get(event.node)?.type !== 'button' || event.event !== 'click' || !actionIds.has(event.action) || eventKeys.has(`${event.node}:${event.event}`)) error('UI_EVENT', '事件必须唯一绑定 Button click 与已声明动作。', pointer)
    eventKeys.add(`${event.node}:${event.event}`)
  }
  if (nodes.some(node => node?.type === 'list')) warnings.push({ code: 'UI_STATIC_LIST', message: '本版本列表是固定内容容器，不包含虚拟化或存档驱动的动态列表。', path: '/nodes' })
  if (document.source !== undefined && !record(document.source)) error('UI_SCHEMA', 'source 必须为来源记录对象。', '/source')
  return { ok: errors.length === 0, errors, warnings, nodeCount: nodes.length, assetCount: assets.length }
}

export function assertUiDocument(document) {
  const result = validateUiDocument(document)
  if (!result.ok) {
    const error = new Error(`UI 文档检查未通过：${result.errors[0]?.message}`)
    error.code = 'UI_DOCUMENT'; error.details = result
    throw error
  }
  return result
}

export function resolveUiBindings(document, state = document.state) {
  const resolved = Object.create(null)
  for (const binding of document.bindings) {
    const text = binding.template.replace(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g, (_, key) => String(state[key] ?? ''))
    ;(resolved[binding.node] ??= Object.create(null))[binding.property] = text
  }
  return resolved
}

export function applyUiAction(document, state, actionId) {
  assertUiDocument(document)
  const action = document.actions.find(item => item.id === actionId)
  if (!action) throw new Error(`未声明的动作 action：${actionId}`)
  const next = { ...state }; const visibility = {}; let toast = ''
  for (const key of Object.keys(document.state)) if (!scalar(next[key])) throw new Error(`动作状态无效：${key}`)
  if (action.when) {
    const a = next[action.when.key]; const b = action.when.value
    const passes = { gte: () => a >= b, gt: () => a > b, lte: () => a <= b, lt: () => a < b, eq: () => a === b, ne: () => a !== b }[action.when.op]()
    if (!passes) return { state: next, visibility, toast: action.otherwiseToast ?? '' }
  }
  for (const step of action.steps) {
    if (step.type === 'set') next[step.key] = step.value
    if (step.type === 'increment') {
      const value = next[step.key] + step.value
      if (!Number.isFinite(value)) throw new Error('动作数值溢出。')
      next[step.key] = value
    }
    if (step.type === 'show') visibility[step.node] = true
    if (step.type === 'hide') visibility[step.node] = false
    if (step.type === 'toggle') visibility[step.node] = !(visibility[step.node] ?? document.nodes.find(node => node.id === step.node).props.visible !== false)
    if (step.type === 'toast') toast = step.text
  }
  return { state: next, visibility, toast }
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function createDemoDocument() {
  const nodes = []
  const add = (id, type, parent, x, y, width, height, props) => nodes.push({ id, type, parent, layout: { x, y, width, height }, props })
  add('root', 'panel', null, 0, 0, 1280, 720, { backgroundColor: '#10212C' })
  add('eyebrow', 'label', 'root', 56, 42, 900, 28, { text: 'CAMP / 营地补给站', fontSize: 18, color: '#92AAB8' })
  add('title', 'label', 'root', 56, 82, 720, 60, { text: '下一次冒险，从这里开始', fontSize: 38, fontWeight: 'bold', color: '#EEF4F2' })
  add('coins', 'label', 'root', 1000, 54, 224, 40, { text: '金币 120', fontSize: 22, fontWeight: 'bold', color: '#F3D38B', align: 'right' })
  add('intro', 'label', 'root', 56, 150, 1120, 36, { text: '选择补给，点击购买。可打开背包查看当前补给数量。', fontSize: 18, color: '#9AB0BC' })
  add('supplies', 'list', 'root', 56, 218, 1168, 326, { static: true })
  const items = [
    ['potion', '恢复药剂', '为旅途补充能量', '10 金币', '#B87752'],
    ['ration', '远行口粮', '可靠、轻便、随时出发', '15 金币', '#597B70'],
    ['torch', '探路火把', '照亮下一段未知', '20 金币', '#776C94'],
  ]
  items.forEach(([id, title, description, price, accent], index) => {
    const parent = `card-${id}`
    add(parent, 'panel', 'supplies', index * 398, 0, 372, 326, { backgroundColor: '#1A303E', borderColor: '#355260', borderWidth: 1, borderRadius: 18 })
    add(`swatch-${id}`, 'panel', parent, 24, 24, 64, 64, { backgroundColor: accent, borderRadius: 16 })
    add(`title-${id}`, 'label', parent, 24, 110, 324, 38, { text: title, fontSize: 27, fontWeight: 'bold', color: '#EEF4F2' })
    add(`description-${id}`, 'label', parent, 24, 154, 324, 34, { text: description, fontSize: 17, color: '#9AB0BC' })
    add(`price-${id}`, 'label', parent, 24, 214, 160, 40, { text: price, fontSize: 20, color: '#F3D38B' })
    add(`buy-${id}`, 'button', parent, 224, 212, 124, 52, { text: '购买', fontSize: 18, fontWeight: 'bold', color: '#13282B', backgroundColor: '#A9D9C5', borderRadius: 12 })
  })
  add('bag-button', 'button', 'root', 56, 588, 210, 56, { text: '打开背包', fontSize: 19, color: '#EEF4F2', backgroundColor: '#2B4655', borderRadius: 12 })
  add('bag-count', 'label', 'root', 292, 596, 700, 40, { text: '背包补给 0 件', fontSize: 18, color: '#9AB0BC' })
  add('footer', 'label', 'root', 56, 670, 1150, 26, { text: '原创占位界面 · 零素材下载 · 浏览器预览不等于引擎验收', fontSize: 14, color: '#728F9F' })
  add('bag-modal', 'modal', 'root', 370, 186, 540, 316, { visible: false, backgroundColor: '#243D4A', borderColor: '#5C7C88', borderWidth: 1, borderRadius: 20 })
  add('bag-modal-title', 'label', 'bag-modal', 32, 32, 476, 42, { text: '你的行囊', fontSize: 30, fontWeight: 'bold', color: '#EEF4F2' })
  add('bag-modal-count', 'label', 'bag-modal', 32, 106, 476, 44, { text: '已收集补给 0 件', fontSize: 23, color: '#A9D9C5' })
  add('bag-modal-hint', 'label', 'bag-modal', 32, 164, 476, 30, { text: '这里是本次 UI 工作流的有限状态示例。', fontSize: 16, color: '#9AB0BC' })
  add('bag-close', 'button', 'bag-modal', 322, 232, 186, 52, { text: '继续冒险', fontSize: 18, color: '#13282B', backgroundColor: '#A9D9C5', borderRadius: 12 })
  return {
    format: UI_FORMAT, version: UI_VERSION, name: '营地补给', design: { width: 1280, height: 720, orientation: 'landscape' }, nodes,
    assets: [], state: { coins: 120, bought: 0 },
    actions: [
      ...[['potion', 10], ['ration', 15], ['torch', 20]].map(([id, price]) => ({ id: `buy-${id}`, when: { key: 'coins', op: 'gte', value: price }, otherwiseToast: '金币不足，先去冒险吧。', steps: [{ type: 'increment', key: 'coins', value: -price }, { type: 'increment', key: 'bought', value: 1 }, { type: 'toast', text: '补给已加入背包。' }] })),
      { id: 'open-bag', steps: [{ type: 'show', node: 'bag-modal' }] },
      { id: 'close-bag', steps: [{ type: 'hide', node: 'bag-modal' }] },
    ],
    events: [...['potion', 'ration', 'torch'].map(id => ({ node: `buy-${id}`, event: 'click', action: `buy-${id}` })), { node: 'bag-button', event: 'click', action: 'open-bag' }, { node: 'bag-close', event: 'click', action: 'close-bag' }],
    bindings: [{ node: 'coins', property: 'text', template: '金币 {coins}' }, { node: 'bag-count', property: 'text', template: '背包补给 {bought} 件' }, { node: 'bag-modal-count', property: 'text', template: '已收集补给 {bought} 件' }],
    source: { kind: 'self-authored', notes: '程序化原创占位 UI，不包含 LGUI 示例资产、编辑器界面、字体或品牌。' },
  }
}
