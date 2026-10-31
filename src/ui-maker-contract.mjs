/** Read-only, source-pinned Maker export preflight. A ready plan only permits
 * an isolated static review package; it never establishes native acceptance. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { assertUiDocument } from './ui-document.mjs'
import { inspectMakerProject, readUiJson, safeUiPath, UiWorkflowError } from './ui-workflow.mjs'

export const AUDITED_MAKER_FILES = Object.freeze({
  'init.lua': '41a44475e29a1172bca0f415f1608ae5e8260e4d7337fa72ea6bdc5caa13c58c',
  'Core/UI.lua': '71f48aaa663adbce0b3b12c7d0753da4c7642383dcb03ec965bc9c3c829865e5',
  'Core/UILoader.lua': '9bb93883e134058220702d490c7b07375d5d4f471e58b6dd4a135ad522e11447',
  'Core/UISerializer.lua': '3f71dc2d3135f38a2e1ad115af01220ca9e9d87b1e14dcef861b090fc449c9cd',
  'Core/Widget.lua': 'aa4f6e9b667f0681ccb9c0df4a7e727c1ac204afb5f8fb4ec6eeb57f62e4128d',
  'Core/Style.lua': '7ace494a67f881d98886e58d1219aef3a482a7cb22dcd4a13798d9ef6ca086bd',
  'Core/Theme.lua': '311c3fb128a90a838a7e951baa3968bf720f030721adbc3bbec7bcd9896bc2a4',
  'Widgets/Panel.lua': '0519b7b27605210069735a2a07530b7d74fc02ae6cca45e888e59aa09b1f4e26',
  'Widgets/Label.lua': 'c04904aae6257963685b94b273f23ce343848d92b85252002c653475ed25cc03',
  'Widgets/Button.lua': '4841a1871db8ef78c557b2ee65d0c5f3c3fe877bc92f82feb7842d67c7bac6ef',
  'Widgets/SafeAreaView.lua': '22c0f9a9cc706e57c6c5366598c64bb24b42344780a957dad9c23a7bdf407472',
})
const deepFreeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child)
  return Object.freeze(value)
}
export const AUDITED_MAKER_CONTRACT = deepFreeze({
  format: 'taptap-maker-static-ui-contract', version: 1,
  sdk: 'dev-kit20260922-133551', mcpDocs: '0.0.39',
  evidence: 'Matching SHA256 of eleven local source files in three read-only SDK trees; not pristine ZIP authentication.',
  engine: 'UrhoX + Lua / urhox-libs/UI (Yoga + NanoVG)',
  allowedTypes: ['Panel', 'Label', 'Button'],
  json: 'One flat type/props/children root. No props object, actions, events, callbacks or editor fields.',
  coordinates: 'IR x/y are already parent-relative; emit left/top without subtracting the parent again.',
  font: { requiredChoice: true, supportedMethod: 'pixel', char: 'blocked: no proven px equivalence', scaleRange: [0.1, 4], pxToPt: 'px / ((96 / 72) * fontScale)', hostScaleSetter: 'UI.Theme.SetFontScale', defaultIRSizePx: 16, fontResources: 'host-owned, not bundled' },
  mappings: {
    panel: 'Panel', label: 'Label: fontColor/textAlign/verticalAlign and string fontWeight',
    button: 'Button: textColor and string fontWeight via Theme.FontFace; audited renderer fixes text at center/middle. Face aliases/resources remain host-owned.',
    image: 'Panel.backgroundImage/backgroundFit; stretch -> fill; backgroundSlice=[top,right,bottom,left]',
    list: 'Fixed-content Panel, not VirtualList', modal: 'Custom Panel overlay with instance-local button blocking, not native Modal',
  },
  bindings: 'UI.LoadJSON -> Instance:GetRoot/Find; OnEvent(click,handler)/OffEvent(click,samehandler); SetText/SetVisible/SetDisabled.',
  safety: 'Explicit project/config/orientation; source fingerprints; no target writes, imports, UUID generation, entry edits, builds or pushes.',
  metadata: { status: 'pending', nextAction: '官方generate_resource_meta', suffix: 'main.ui.json.meta (complete resource suffix)' },
  stagedOnly: true, nativeVerified: false,
})
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_NOTICE_BYTES = 1_000_000
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const problem = (code, message, details) => ({ code, message, ...(details ? { details } : {}) })
const fail = (code, message, details) => { throw new UiWorkflowError(code, message, details) }
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)))

/** Shared validation, not a fallback font mode. The browser may restrict scale
 * to one; explicit API callers may choose 0.1..4 and must match their host. */
export function makerFontOptions(options = {}, { assetPaths = false } = {}) {
  const blockers = []
  const permitted = new Set(['fontSizeMethod', 'fontScale', 'assetRoot', ...(assetPaths ? ['assetPaths'] : [])])
  if (!record(options) || Object.keys(options).some(key => !permitted.has(key))) blockers.push(problem('MAKER_OPTION_UNSUPPORTED', '只接受明确的字号方法、字号倍率与工作区素材根；不接受自动导入/构建等选项。'))
  const fontSizeMethod = record(options) ? options.fontSizeMethod : undefined
  if (!fontSizeMethod) blockers.push(problem('MAKER_FONT_METHOD_REQUIRED', '需要用户明确选择 fontSizeMethod；不猜测游戏初始化方式。'))
  else if (fontSizeMethod === 'char') blockers.push(problem('MAKER_CHAR_FONT_UNVERIFIED', '首版不支持 char：点数透传不是已验证的 IR 像素等价。请选择 pixel 或继续专项核验。'))
  else if (fontSizeMethod !== 'pixel') blockers.push(problem('MAKER_FONT_METHOD_INVALID', '字号方法只接受明确的 pixel / char；当前只核验 pixel。'))
  const fontScale = record(options) && Object.hasOwn(options, 'fontScale') ? options.fontScale : 1
  if (typeof fontScale !== 'number' || !Number.isFinite(fontScale) || fontScale < 0.1 || fontScale > 4) blockers.push(problem('MAKER_FONT_SCALE_INVALID', 'fontScale 必须是 0.1 到 4 的有限数字。'))
  return { fontSizeMethod, fontScale, blockers }
}
export function makerNodeBlockers(document) {
  return document.nodes.filter(node => node.type === 'button' && node.props.align !== undefined && node.props.align !== 'center').map(node => problem('MAKER_BUTTON_ALIGNMENT_UNSUPPORTED', `Button ${node.id} 的文字仅支持已核验的水平居中；不伪造 textAlign。`, { node: node.id }))
}
export function makerPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

// Read at most the lstat-approved size; preserve bounded memory even if another
// local process grows a file. No-follow + fd identity and size checks narrow
// the race between ancestry inspection and opening the ordinary file.
function readOrdinary(file, maximum, code) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('MAKER_ASSET_UNSAFE', '素材或通知不是普通文件。')
  if (!stat.size || stat.size > maximum) fail(code, '素材或通知为空或超出允许大小。')
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino || opened.dev !== stat.dev) fail('MAKER_ASSET_UNSAFE', '打开的素材与核验的普通文件不一致。')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) fail('MAKER_ASSET_INTEGRITY', '素材在读取过程中发生变化。')
      offset += count
    }
    const after = fs.fstatSync(fd)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('MAKER_ASSET_INTEGRITY', '素材在读取过程中发生变化。')
    return bytes
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}
function workspaceOwner(assetRoot) {
  if (typeof assetRoot !== 'string' || !assetRoot.trim() || assetRoot.length > 4096 || /[\u0000\r\n]/.test(assetRoot)) fail('MAKER_ASSET_ROOT_UNVERIFIED', '需要明确的已保存 UI 工作区素材根。')
  let current = safeUiPath(assetRoot, '.')
  if (!fs.lstatSync(current).isDirectory()) fail('MAKER_ASSET_ROOT_UNVERIFIED', '素材根必须是已保存 UI 工作区内的真实目录。')
  while (true) {
    const manifestFile = safeUiPath(current, 'workspace.json')
    if (fs.existsSync(manifestFile)) {
      const manifest = readUiJson(manifestFile)
      if (manifest.format !== 'taptap-ui-workspace' || manifest.version !== 1 || !SAFE_ID.test(manifest.workspaceId ?? '') || manifest.workspaceId !== path.basename(current)) fail('MAKER_ASSET_ROOT_UNVERIFIED', '素材根不属于可确认的已保存 UI 工作区。')
      if (!fs.lstatSync(safeUiPath(current, 'revisions')).isDirectory()) fail('MAKER_ASSET_ROOT_UNVERIFIED', '素材根所属工作区尚无保存的修订目录。')
      return { directory: current, workspaceId: manifest.workspaceId }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  fail('MAKER_ASSET_ROOT_UNVERIFIED', '素材必须来自显式的 UI 工作区资源根；游戏 assets 或任意目录不能作为回退。')
}
function noticeFor(assetRoot, asset) {
  const notice = asset.license.notice
  if (notice === undefined) return null
  if (typeof notice !== 'string' || !notice.trim() || Buffer.byteLength(notice) > MAX_NOTICE_BYTES) fail('MAKER_ASSET_LICENSE_UNVERIFIED', '授权通知须为大小受限的非空文本或工作区本地路径。')
  // The IR permits text OR a local path. A single-line filename is a path,
  // not permission text. Never fetch URLs or follow a path outside the root.
  const looksLikePath = !/[\r\n]/.test(notice) && (/\.(txt|md|license)$/i.test(notice) || /^(?:[^\s]*\/)?(?:LICENSE|COPYING)(?:\.[^\s]+)?$/i.test(notice))
  if (!looksLikePath) return notice
  if (notice.includes('\\') || notice.includes(':') || notice.split('/').some(part => !part || part === '.' || part === '..')) fail('MAKER_ASSET_LICENSE_UNVERIFIED', '授权通知路径必须位于明确的 UI 素材根内。')
  try { return readOrdinary(safeUiPath(assetRoot, notice), MAX_NOTICE_BYTES, 'MAKER_ASSET_LICENSE_UNVERIFIED').toString('utf8') } catch (error) {
    if (error instanceof UiWorkflowError) throw error
    fail('MAKER_ASSET_LICENSE_UNVERIFIED', '授权通知本地文件缺失或不可读取。')
  }
}
function imageFormat(bytes, extension) {
  if (extension === '.png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (extension === '.webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  return false
}
/** Internal shared staging reader. includeBytes is never enabled by preflight;
 * only reviewed assets are materialized, inside a fresh export directory. */
export function readMakerAssetSet(document, assetRoot, { workspaceDirectory, includeBytes = false } = {}) {
  const blockers = []; const assets = []
  if (!document.assets.length && assetRoot === undefined) return { blockers, assets, owner: null }
  if (assetRoot === undefined || assetRoot === '') return { blockers: [problem('MAKER_ASSET_ROOT_REQUIRED', '文档图片需要明确的 UI 工作区素材根；不从游戏 assets 猜测或下载。')], assets, owner: null }
  let owner
  try {
    owner = workspaceOwner(assetRoot)
    if (workspaceDirectory && path.resolve(owner.directory) !== path.resolve(workspaceDirectory)) fail('MAKER_ASSET_WORKSPACE_MISMATCH', '素材根必须属于本次已保存的 UI 工作区，不能借用另一个工作区。')
  } catch (error) {
    blockers.push(problem(error.code === 'UI_PATH' ? 'MAKER_ASSET_UNSAFE' : (error instanceof UiWorkflowError ? error.code : 'MAKER_ASSET_ROOT_UNVERIFIED'), error.message))
    return { blockers, assets, owner: null }
  }
  for (const asset of document.assets) {
    try {
      const license = asset.license
      if (!['own', 'CC0', 'MIT', 'OFL'].includes(license.kind) || typeof license.author !== 'string' || !license.author.trim() || typeof license.source !== 'string' || !license.source.trim() || typeof license.verifiedAt !== 'string' || !Number.isFinite(Date.parse(license.verifiedAt))) fail('MAKER_ASSET_LICENSE_UNVERIFIED', `素材 ${asset.id} 缺少有效的原作者/来源/核验日期记录。`)
      if (['MIT', 'OFL'].includes(license.kind) && !license.notice?.trim()) fail('MAKER_ASSET_LICENSE_UNVERIFIED', `素材 ${asset.id} 缺少必须保留的授权通知。`)
      const file = safeUiPath(assetRoot, asset.path)
      const bytes = readOrdinary(file, MAX_IMAGE_BYTES, 'MAKER_ASSET_SIZE')
      const sha256 = digest(bytes)
      if (sha256 !== asset.sha256.toLowerCase()) fail('MAKER_ASSET_INTEGRITY', `素材 ${asset.id} 的 SHA256 与保存的记录不符。`)
      const extension = path.extname(asset.path).toLowerCase()
      if (!imageFormat(bytes, extension)) fail('MAKER_ASSET_FORMAT', `素材 ${asset.id} 的图片文件签名与扩展名不符；尚未进行原生解码或视觉验收。`)
      const noticeText = noticeFor(assetRoot, asset)
      assets.push({ id: asset.id, path: asset.path, file, extension, sha256, size: bytes.length, license: { ...license }, noticeText, ...(includeBytes ? { data: bytes } : {}) })
    } catch (error) {
      const code = error.code === 'UI_PATH' ? 'MAKER_ASSET_UNSAFE' : (error instanceof UiWorkflowError ? error.code : 'MAKER_ASSET_MISSING')
      blockers.push(problem(code, error instanceof UiWorkflowError ? error.message : `素材 ${asset.id} 缺失或不可读取。`, { asset: asset.id }))
    }
  }
  return { blockers, assets, owner }
}

export function planMakerExport(document, projectDirectory, options = {}) {
  const fonts = makerFontOptions(options)
  const blockers = [...fonts.blockers]
  let validation
  try { validation = assertUiDocument(document) } catch (error) { blockers.push(problem('UI_DOCUMENT', error.message, error.details)) }
  // This is the project's primary-config and ten-source preflight. Theme is
  // independently verified below because it defines font-unit conversion.
  const project = inspectMakerProject(projectDirectory, { expectedFiles: AUDITED_MAKER_FILES })
  blockers.push(...project.blockers)
  const sourceFiles = [...project.files]
  if (project.directory && !sourceFiles.some(file => file.path === 'urhox-libs/UI/Core/Theme.lua')) {
    try {
      const file = safeUiPath(project.directory, 'urhox-libs/UI/Core/Theme.lua')
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error('bounded source required')
      const sha256 = digest(fs.readFileSync(file))
      sourceFiles.push({ path: 'urhox-libs/UI/Core/Theme.lua', sha256 })
      if (sha256 !== AUDITED_MAKER_FILES['Core/Theme.lua']) blockers.push(problem('MAKER_UI_VERSION_UNVERIFIED', 'UI 源码版本未核验：Core/Theme.lua。'))
    } catch { blockers.push(problem('MAKER_UI_SOURCE_MISSING', '缺少真实 UI 源码：Core/Theme.lua。')) }
  }
  let assetSet = { blockers: [], assets: [], owner: null }
  const warnings = [
    problem('MAKER_NATIVE_NOT_VERIFIED', 'ready 仅表示可生成静态审阅包；未加载引擎、未截图/试玩，nativeVerified=false。'),
    problem('MAKER_HOST_CONTRACT_REQUIRED', '接入前由宿主核对真实 UI.Init(fontSizeMethod)、UI.Theme.GetFontScale、字体资源、缩放和唯一事件转发归属；不修改游戏入口。'),
    problem('MAKER_METADATA_PENDING', '资源元数据待未来明确安装授权后调用官方 generate_resource_meta；不伪造 UUID 或 .meta。'),
    problem('MAKER_FIXED_LAYOUT', '本版本是明确设计尺寸的固定布局；安全区/视口缩放/文字度量由宿主复核，不等于响应式或视觉等价。'),
  ]
  if (validation) {
    blockers.push(...makerNodeBlockers(document))
    if (['landscape', 'portrait'].includes(project.orientation) && document.design.orientation !== project.orientation) blockers.push(problem('MAKER_ORIENTATION_MISMATCH', 'IR 设计横竖屏与明确工程配置不一致；不自动改方向或交换宽高。'))
    assetSet = readMakerAssetSet(document, record(options) ? options.assetRoot : undefined)
    blockers.push(...assetSet.blockers)
    if (document.nodes.some(node => node.type === 'modal')) warnings.push(problem('MAKER_CUSTOM_MODAL', 'Modal 输出为自定义 Panel 覆盖层；仅在同一加载实例内阻挡背景 Button，不声称 native Modal/焦点捕获。'))
    if (document.nodes.some(node => node.type === 'list')) warnings.push(problem('MAKER_STATIC_LIST', 'List 输出为固定内容 Panel，不包含虚拟化、存档、网络或动态重复模板。'))
    if (document.nodes.some(node => ['label', 'button'].includes(node.type) && node.props.fontSize === undefined)) warnings.push(problem('MAKER_FONT_DEFAULT', '未指定的 IR 文字字号使用明确的 16px 发射器默认值；若需精确像素对应，请在 IR 中指定字号。'))
    if (document.actions.some(action => action.otherwiseToast || action.steps.some(step => step.type === 'toast'))) warnings.push(problem('MAKER_TOAST_HOST_REQUIRED', 'Toast 通过宿主 onToast 回调展示；缺省只记录 lastToast，不侵入宿主全局 Toast 树。'))
  }
  return {
    ok: true, ready: blockers.length === 0, blockers, warnings,
    contract: AUDITED_MAKER_CONTRACT, stagedOnly: true, nativeVerified: false,
    projectDirectory: project.directory ?? null, orientation: project.orientation ?? null,
    options: { fontSizeMethod: fonts.fontSizeMethod ?? null, fontScale: fonts.fontScale },
    sourceFiles, assets: assetSet.assets.map(({ data, noticeText, ...asset }) => ({ ...asset, hasNotice: noticeText !== null })),
    assetWorkspace: assetSet.owner,
    metadata: { ...AUDITED_MAKER_CONTRACT.metadata },
  }
}
