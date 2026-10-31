/** Safe, intentionally narrow projection of the audited historical MIT model.
 * No upstream CLI/editor/runtime, unaudited XML dependency, asset download or
 * native project write. Python's installed stdlib decodes XML; unknown FairyGUI
 * features are rejected rather than flattened into a misleading screenshot. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readUiModel, findComponent } from './lgui-model-adapter.mjs'
import { assertUiDocument, UI_FORMAT, UI_VERSION } from './ui-document.mjs'
import { safeUiPath, verifyLguiVendor, LGUI_COMMIT, LGUI_REPOSITORY, UiWorkflowError } from './ui-workflow.mjs'

const SCRIPT = fileURLToPath(new URL('./ui-xml-bridge.py', import.meta.url))
const fail = (code, message, details) => { throw new UiWorkflowError(code, message, details) }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const FGUI_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_XML = 1_000_000
const MAX_PROJECT_XML = 8_000_000
const MAX_FILES = 256
const sid = key => 'fgui-' + hash(key).slice(0, 24)
const walk = (node, callback) => { callback(node); for (const child of node.children) walk(child, callback) }

export function decodeLguiXml(text, { python = process.env.TAPTAP_UI_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_XML) fail('UI_XML_LIMIT', 'XML 大小超过 1 MB 预算。')
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) fail('UI_XML_DTD', 'XML 不允许 DTD 或实体声明。')
  const result = spawnSync(python, ['-I', '-S', '-X', 'utf8', SCRIPT], { input: text, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4_000_000 })
  if (result.error) {
    const code = result.error.code
    fail(code === 'ENOENT' ? 'UI_PYTHON_MISSING' : 'UI_XML_PROCESS', code === 'ENOENT' ? '未找到已安装 Python；仅 XML 导入需要 Python，不自动下载或安装。' : `XML 解码进程未完成（${code}）；未安装依赖或自动重试。`)
  }
  let parsed
  try { parsed = JSON.parse(result.stdout) } catch { fail('UI_XML_PROTOCOL', 'XML 解码器没有返回有效的受限数据。') }
  if (result.status !== 0 || parsed.ok !== true) fail(/^UI_XML/.test(parsed.code) ? parsed.code : 'UI_XML_SYNTAX', parsed.error || 'XML 解码失败。')
  const root = parsed.root
  let nodes = 0
  function validate(node, depth = 0) {
    if (!node || typeof node.tag !== 'string' || !node.attrs || typeof node.attrs !== 'object' || Array.isArray(node.attrs) || !Array.isArray(node.children) || /[{:]/.test(node.tag) || depth > 32 || ++nodes > 2048) fail('UI_XML_SCHEMA', 'XML 解码结果不符合受限元素树。')
    for (const [key, value] of Object.entries(node.attrs)) if (typeof value !== 'string' || /[{:]/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('UI_XML_SCHEMA', 'XML 属性必须为安全字符串。')
    for (const child of node.children) validate(child, depth + 1)
  }
  validate(root)
  // Retain the historical ID-based source line heuristic. This is NOT an
  // exact parser position or proof that duplicate IDs are valid.
  const lines = text.split('\n')
  walk(root, node => {
    const index = node.attrs.id ? lines.findIndex(line => line.includes(`id="${node.attrs.id}"`)) : -1
    if (index >= 0) node.line = index + 1
  })
  return root
}

function boundedXmlFile(root, relative, budget, options) {
  let file
  try { file = safeUiPath(root, relative) } catch { fail('UI_IMPORT_PATH', 'FairyGUI 路径不能越界或包含符号链接。') }
  let stat
  try { stat = fs.lstatSync(file) } catch { fail('UI_IMPORT_RESOURCE', 'FairyGUI 引用的 XML 文件缺失。', { relative }) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_XML) fail('UI_IMPORT_RESOURCE', 'FairyGUI XML 必须是大小受限的普通文件。', { relative })
  if (++budget.files > MAX_FILES || (budget.bytes += stat.size) > MAX_PROJECT_XML) fail('UI_IMPORT_LIMIT', 'FairyGUI 工程 XML 总量超过首版导入预算。')
  const bytes = fs.readFileSync(file)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('UI_XML_SYNTAX', 'XML 只接受有效 UTF-8，不替换无效字节。')
  return { file, text, sha256: hash(bytes), root: decodeLguiXml(text, options) }
}
function resourcePath(pkgDirectory, attrs) {
  const name = attrs.name ?? ''; const raw = attrs.path ?? '/'
  if (!name || /[\\/:\0]/.test(name) || name === '.' || name === '..' || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) || /[\\:\0]/.test(raw) || raw.startsWith('//')) fail('UI_IMPORT_PATH', '资源路径含 Windows 设备、绝对路径、UNC 或越界文件名。')
  const relative = raw.replace(/^\//, '').replace(/\/$/, '')
  if (relative.split('/').some(part => part === '..' || part === '.')) fail('UI_IMPORT_PATH', 'FairyGUI 资源路径不能包含 .. 或 . 段。')
  try { return safeUiPath(pkgDirectory, relative ? `${relative}/${name}` : name) } catch { fail('UI_IMPORT_PATH', 'FairyGUI 资源不能越出所属包或经过符号链接。') }
}

export function readLguiModel(fairyPath, options = {}) {
  if (!verifyLguiVendor().ok) fail('UI_LGUI_INTEGRITY', '固定 MIT 原文件完整性检查未通过，不执行改编模型。')
  if (typeof fairyPath !== 'string' || path.extname(fairyPath).toLowerCase() !== '.fairy') fail('UI_IMPORT_PATH', '请明确指定本地 UI.fairy 文件。')
  const fairy = path.resolve(fairyPath); const uiDirectory = path.dirname(fairy)
  const budget = { files: 0, bytes: 0 }; const cache = new Map(); const packageIds = new Set()
  const project = boundedXmlFile(uiDirectory, path.basename(fairy), budget, options)
  if (project.root.tag !== 'project') fail('UI_IMPORT_SCHEMA', 'UI.fairy 根元素必须为 project。')
  let assets
  try { assets = safeUiPath(uiDirectory, 'assets'); if (!fs.statSync(assets).isDirectory()) throw new Error() } catch { fail('UI_IMPORT_SCHEMA', 'UI.fairy 旁边没有有效 assets 包目录。') }
  const entries = fs.readdirSync(assets, { withFileTypes: true })
  if (entries.length > 128) fail('UI_IMPORT_LIMIT', 'FairyGUI 包目录超过首版预算。')
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail('UI_IMPORT_PATH', 'FairyGUI assets 包目录不能是符号链接。')
    if (!entry.isDirectory()) continue
    const pkgDirectory = safeUiPath(assets, entry.name)
    if (!fs.existsSync(path.join(pkgDirectory, 'package.xml'))) continue
    const descriptor = boundedXmlFile(pkgDirectory, 'package.xml', budget, options)
    if (descriptor.root.tag !== 'packageDescription' || !FGUI_ID.test(descriptor.root.attrs.id ?? '')) fail('UI_IMPORT_SCHEMA', 'package.xml 根或 package ID 无效。')
    if (packageIds.has(descriptor.root.attrs.id)) fail('UI_IMPORT_DUPLICATE', 'FairyGUI package ID 重复，不能覆盖 Map。')
    packageIds.add(descriptor.root.attrs.id); cache.set(descriptor.file, descriptor)
    const resources = descriptor.root.children.find(node => node.tag === 'resources')?.children ?? []
    const resourceIds = new Set()
    for (const resource of resources) {
      if (!FGUI_ID.test(resource.attrs.id ?? '')) fail('UI_IMPORT_SCHEMA', 'FairyGUI resource ID 缺失或无效。')
      if (resourceIds.has(resource.attrs.id)) fail('UI_IMPORT_DUPLICATE', 'FairyGUI resource ID 重复。')
      resourceIds.add(resource.attrs.id)
      const file = resourcePath(pkgDirectory, resource.attrs)
      if (resource.tag !== 'component') continue
      if (path.extname(file).toLowerCase() !== '.xml') fail('UI_IMPORT_SCHEMA', 'component 必须引用普通 .xml 文件。')
      const component = boundedXmlFile(pkgDirectory, path.relative(pkgDirectory, file), budget, options)
      if (component.root.tag !== 'component') fail('UI_IMPORT_SCHEMA', '组件 XML 根必须为 component。')
      const elementIds = new Set()
      walk(component.root, node => {
        if (!node.attrs.id) return
        if (elementIds.has(node.attrs.id)) fail('UI_IMPORT_DUPLICATE', '组件内 element ID 重复，不能混淆绑定。')
        elementIds.add(node.attrs.id)
      })
      cache.set(component.file, component)
    }
  }
  if (!packageIds.size) fail('UI_IMPORT_SCHEMA', '没有找到合法 FairyGUI package.xml。')
  const cached = file => {
    const known = cache.get(path.resolve(file))
    if (!known) fail('UI_IMPORT_PATH', '模型访问了未预检的组件 XML。')
    return known
  }
  const model = readUiModel(fairy, {
    readXml: file => ({ root: structuredClone(cached(file).root), file }),
    findLine: (file, needle) => { const index = cached(file).text.split('\n').findIndex(line => line.includes(needle)); return index < 0 ? undefined : index + 1 },
  })
  const expectedComponents = [...cache.values()].filter(item => item.root.tag === 'component').length
  if (model.packages.reduce((sum, pkg) => sum + pkg.components.length, 0) !== expectedComponents) fail('UI_IMPORT_RESOURCE', '预检后组件发生变动，未返回不完整模型。')
  for (const pkg of model.packages) for (const component of pkg.components) for (const child of component.children) {
    if (child.tag === 'component' && !child.ref) fail('UI_IMPORT_REFERENCE', '组件引用未解析，不能静默跳过。', { component: component.fullName, id: child.id })
    if (['list', 'tree'].includes(child.tag) && child.attrs.defaultItem?.startsWith('ui://') && !child.ref) fail('UI_IMPORT_REFERENCE', '列表/树的 defaultItem 引用不存在。')
  }
  model.sourceFiles = [...cache.values()].map(item => ({ file: item.file, sha256: item.sha256 }))
  return model
}

const BASE_ATTRIBUTES = ['id', 'name', 'xy', 'size', 'visible', 'alpha', 'touchable']
const TEXT_ATTRIBUTES = ['text', 'fontSize', 'color', 'bold', 'align', 'singleLine', 'autoSize']
const GRAPH_ATTRIBUTES = ['type', 'fillColor', 'lineColor', 'lineSize', 'cornerRadius']
function unsupported(message, details) { fail('UI_IMPORT_UNSUPPORTED', message, details) }
function attributes(node, extra = []) {
  for (const key of Object.keys(node.attrs)) if (![...BASE_ATTRIBUTES, ...extra].includes(key)) unsupported(`尚未映射的 FairyGUI 属性 ${key}；没有自动降级。`, { id: node.attrs.id, tag: node.tag })
  if (node.attrs.autoSize && node.attrs.autoSize !== 'none') unsupported('首版只支持显式绝对尺寸，不支持 autoSize。')
  if (node.attrs.singleLine && node.attrs.singleLine !== 'true') unsupported('多行排版需要单独映射，不静默丢弃 singleLine。')
  for (const key of ['visible', 'touchable', 'bold']) if (node.attrs[key] && !['true', 'false'].includes(node.attrs[key])) unsupported(`无效布尔属性：${key}。`)
}
function number(value, fallback, field) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(parsed)) unsupported(`FairyGUI ${field} 不是有限数字。`)
  return parsed
}
function pair(text, field, fallback) {
  if (text === undefined && fallback) return [...fallback]
  const parts = String(text ?? '').split(',').map(Number)
  if (parts.length !== 2 || parts.some(value => !Number.isFinite(value))) unsupported(`FairyGUI ${field} 必须为两项有限数字。`)
  return parts
}
function bounds(attrs, fallbackSize) {
  const [x, y] = pair(attrs.xy, 'xy', [0, 0]); const [width, height] = pair(attrs.size, 'size', fallbackSize)
  return { x, y, width, height }
}
function common(attrs) {
  const props = {}
  if (attrs.visible !== undefined) props.visible = attrs.visible === 'true'
  if (attrs.touchable !== undefined) props.enabled = attrs.touchable === 'true'
  if (attrs.alpha !== undefined) props.opacity = number(attrs.alpha, 1, 'alpha')
  return props
}
function textProps(attrs) {
  return { ...common(attrs), text: attrs.text ?? '', fontSize: number(attrs.fontSize, 18, 'fontSize'), color: attrs.color ?? '#FFFFFF', fontWeight: attrs.bold === 'true' ? 'bold' : 'normal', align: attrs.align ?? 'left' }
}
function graphProps(attrs) {
  if (attrs.type !== 'rect') unsupported('首版 graph 只支持已声明 rect，不转制圆形/复杂图形截图。')
  const props = { ...common(attrs), backgroundColor: attrs.fillColor ?? '#00000000' }
  if (attrs.lineColor) props.borderColor = attrs.lineColor
  if (attrs.lineSize !== undefined) props.borderWidth = number(attrs.lineSize, 0, 'lineSize')
  if (attrs.cornerRadius !== undefined) {
    const radii = attrs.cornerRadius.split(',').map(Number)
    if (radii.some(value => !Number.isFinite(value)) || radii.some(value => value !== radii[0])) unsupported('首版只支持统一圆角，不丢弃分角信息。')
    props.borderRadius = radii[0]
  }
  return props
}
function simpleComponent(component) {
  for (const key of Object.keys(component.root.attrs)) if (!['size', 'extention', 'extension'].includes(key)) unsupported(`组件根属性 ${key} 尚未映射。`)
  for (const child of component.root.children) if (!['displayList', 'Button'].includes(child.tag)) unsupported(`组件 ${child.tag} 尚未映射；控制器/关系/动效不会被静默扁平化。`)
  if (component.controllers.length || component.transitions.length) unsupported('首版不自动展开 controller / transition。')
}

export function importLguiComponent(fairyPath, fullName, options = {}) {
  const model = readLguiModel(fairyPath, options)
  const selected = findComponent(model, fullName)
  if (!selected) fail('UI_IMPORT_COMPONENT', '没有找到指定 包名/组件名。')
  if (selected.extension) unsupported('请选择普通 Panel 根组件；扩展根组件需二期宿主映射。')
  const [width, height] = pair(selected.size, 'design size')
  const document = { format: UI_FORMAT, version: UI_VERSION, name: fullName, design: { width, height, orientation: width >= height ? 'landscape' : 'portrait' }, nodes: [], assets: [], state: {}, actions: [], events: [], bindings: [], source: { kind: 'fairygui-historical-mit', repository: LGUI_REPOSITORY, commit: LGUI_COMMIT, component: fullName, parser: 'python-stdlib-xml', layoutCoordinates: 'parent-relative', sourceFiles: model.sourceFiles.map(item => ({ path: path.relative(path.dirname(fairyPath), item.file).split(path.sep).join('/'), sha256: item.sha256 })), compatibility: 'static-explicit-layout-only' } }
  const assetsToCopy = []; const assetsByResource = new Map()
  function addImage(node, component, nodeKey, parent) {
    attributes(node, ['src', 'pkg'])
    if (node.children.length) unsupported('image 子配置尚未映射。')
    const pkg = model.byId.get(node.attrs.pkg ?? component.pkg.id)
    const resource = pkg?.resources.find(resource => resource.id === node.attrs.src && resource.type === 'image')
    if (!resource) fail('UI_IMPORT_REFERENCE', 'image 资源引用无效。')
    const resourceKey = `${pkg.id}/${resource.id}`
    let asset = assetsByResource.get(resourceKey)
    if (!asset) {
      const rights = options.assetRights?.[resourceKey]
      if (!rights?.license || !/^[a-f\d]{64}$/i.test(rights.sha256 ?? '') || !rights.license.verifiedAt || Number.isNaN(Date.parse(rights.license.verifiedAt))) fail('UI_IMPORT_LICENSE', 'image 需要对应包/资源 ID 的明确授权记录、核验时间和 SHA256；LGUI 示例许可不适用于素材。', { resource: resourceKey })
      const file = resourcePath(pkg.dir, resource.attrs)
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > 10_000_000 || !/\.(png|jpe?g|webp)$/i.test(file)) fail('UI_IMPORT_RESOURCE', 'image 必须为 ≤10 MB 的普通 PNG/JPEG/WebP。')
      const sha256 = hash(fs.readFileSync(file))
      if (sha256 !== rights.sha256.toLowerCase()) fail('UI_IMPORT_LICENSE', '授权记录的素材 SHA256 与真实文件不符。')
      const id = sid('asset/' + resourceKey)
      asset = { id, path: `assets/images/${id}${path.extname(file).toLowerCase()}`, sha256, license: structuredClone(rights.license) }
      document.assets.push(asset); assetsByResource.set(resourceKey, asset)
      assetsToCopy.push({ ...asset, file })
    }
    document.nodes.push({ id: sid(nodeKey), type: 'image', parent, layout: bounds(node.attrs), props: { ...common(node.attrs), asset: asset.id, imageFit: 'stretch' } })
  }
  function addChildren(component, parent, instanceKey, stack) {
    simpleComponent(component)
    if (stack.includes(component.fullName)) unsupported('递归组件不能展开为 UI 文档。')
    const nextStack = [...stack, component.fullName]
    for (const node of component.children) {
      const nodeKey = `${instanceKey}/${node.id ?? node.name}`; const id = sid(nodeKey)
      if (!node.id) unsupported('displayList 节点必须有稳定 element ID。')
      if (node.tag === 'image') { addImage(node, component, nodeKey, parent); continue }
      if (node.tag === 'text' || node.tag === 'graph') {
        attributes(node, node.tag === 'text' ? TEXT_ATTRIBUTES : GRAPH_ATTRIBUTES)
        if (node.children.length) unsupported('文字/图形嵌套 relation/gear 尚未映射。')
        document.nodes.push({ id, type: node.tag === 'text' ? 'label' : 'panel', parent, layout: bounds(node.attrs), props: node.tag === 'text' ? textProps(node.attrs) : graphProps(node.attrs) })
        continue
      }
      if (node.tag !== 'component' || !node.ref) unsupported(`首版不支持 ${node.tag}，未转制截图或虚假静态列表。`)
      attributes(node, ['src', 'pkg'])
      simpleComponent(node.ref)
      const layout = bounds(node.attrs, pair(node.ref.size, 'component size'))
      if (!node.ref.extension) {
        if (node.children.length) unsupported('普通组件的实例覆盖/控制器尚未映射。')
        const originalSize = pair(node.ref.size, 'component size')
        if (layout.width !== originalSize[0] || layout.height !== originalSize[1]) unsupported('组件缩放需要关系/比例映射，首版不静默伸缩 children。')
        document.nodes.push({ id, type: 'panel', parent, layout, props: common(node.attrs) })
        addChildren(node.ref, id, nodeKey, nextStack)
        continue
      }
      if (node.ref.extension !== 'Button' || node.ref.buttonMode !== 'Common') unsupported('只支持 Common Button；Check/Radio/Slider 等尚未映射。')
      const labels = node.ref.children.filter(child => child.tag === 'text'); const graphs = node.ref.children.filter(child => child.tag === 'graph')
      if (labels.length !== 1 || graphs.length > 1 || labels.length + graphs.length !== node.ref.children.length) unsupported('Button 首版仅支持一个文字和可选全尺寸矩形背景。')
      const definitionSize = pair(node.ref.size, 'Button size')
      if (layout.width !== definitionSize[0] || layout.height !== definitionSize[1]) unsupported('Button 实例缩放尚未映射。')
      for (const child of [...labels, ...graphs]) {
        attributes(child, child.tag === 'text' ? TEXT_ATTRIBUTES : GRAPH_ATTRIBUTES)
        if (child.children.length) unsupported('Button relation/gear 尚未映射。')
        const box = bounds(child.attrs)
        if (box.x !== 0 || box.y !== 0 || box.width !== layout.width || box.height !== layout.height) unsupported('Button 子布局不是全尺寸，不能假装中心文字原样兼容。')
      }
      const props = { ...textProps(labels[0].attrs), align: labels[0].attrs.align ?? 'center', backgroundColor: '#00000000', borderWidth: 0, borderRadius: 0, ...(graphs[0] ? graphProps(graphs[0].attrs) : {}), ...common(node.attrs) }
      if (props.align !== 'center') unsupported('首版 Button 只支持 center，与目标真实 Button 绘制对齐。')
      for (const override of node.children) {
        if (override.tag !== 'Button' || Object.keys(override.attrs).some(key => key !== 'title') || override.children.length) unsupported('Button 实例仅支持 title 文字覆盖。')
        if (override.attrs.title !== undefined) props.text = override.attrs.title
      }
      document.nodes.push({ id, type: 'button', parent, layout, props })
    }
  }
  const rootId = sid(selected.fullName)
  document.nodes.push({ id: rootId, type: 'panel', parent: null, layout: { x: 0, y: 0, width, height }, props: {} })
  addChildren(selected, rootId, selected.fullName, [])
  assertUiDocument(document)
  return { document, assetsToCopy, warnings: [{ code: 'UI_IMPORT_STATIC_ONLY', message: '仅导入明确的静态绝对布局；事件/控制器/动态列表不自动搬运。' }, { code: 'UI_IMPORT_FONT_NATIVE_UNVERIFIED', message: '保留作者字号数值作为 IR px，原字体与目标引擎字形仍须单独映射和验收。' }] }
}
