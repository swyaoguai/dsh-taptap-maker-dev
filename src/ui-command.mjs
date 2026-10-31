/** Direct plugin command adapter; never shells raw user input or launches a GUI.
 * Parsing reuses the repository tokenizer. All writes are fresh UI artifacts. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { splitTokens, consumeFlags } from './tokens.mjs'
import { resolveDshHome } from './paths.js'
import { createDemoDocument, assertUiDocument, validateUiDocument } from './ui-document.mjs'
import { createUiWorkspace, listUiWorkspaces, readUiWorkspace, saveUiRevision, readUiJson, safeUiPath, writeUiFileExclusive, UiWorkflowError } from './ui-workflow.mjs'
import { getUiStatus, UI_API_PREFIX } from './ui-http.mjs'

const SPEC = Object.fromEntries(Object.entries({ root: 'root', name: 'name', id: 'workspaceId', revision: 'revisionId', base: 'baseRevision', in: 'input', fairy: 'fairy', component: 'component', rights: 'rights', project: 'projectDirectory', 'font-method': 'fontSizeMethod', 'font-scale': 'fontScale' }).map(([name, into]) => [name, { into }]))
SPEC.json = { kind: 'bool' }; SPEC.help = { kind: 'bool' }
const GLOBAL = ['root', 'json', 'help']
const ALLOWED = {
  help: [], workbench: [], status: [], list: [], demo: ['name'],
  create: ['input', 'name'], read: ['workspaceId', 'revisionId'], check: ['input', 'workspaceId', 'revisionId'],
  save: ['input', 'workspaceId', 'baseRevision'], 'import-xml': ['fairy', 'component', 'rights', 'name'],
  plan: ['input', 'workspaceId', 'revisionId', 'projectDirectory', 'fontSizeMethod', 'fontScale'],
  export: ['workspaceId', 'revisionId', 'projectDirectory', 'fontSizeMethod', 'fontScale'],
}
const HELP = `UI 工作流 · /taptap-ui（零生成额度，版本追加保存）\n\n  workbench                         当前 GUI 中打开 UI 工作台\n  status / list                     只读状态与工作区清单\n  demo [--name 名称]                 新建原创营地补给样例\n  create --in UI.json                导入规范 JSON 为新工作区\n  import-xml --fairy UI.fairy --component 包名/组件名 [--rights 授权记录.json]\n  read --id <工作区ID> [--revision <版本ID>]\n  check --in UI.json 或 --id <工作区ID>\n  save --id <工作区ID> --base <读到的版本ID> --in UI.json\n  plan --id <工作区ID> --project <只读目标> --font-method pixel [--font-scale 1]\n  export --id <工作区ID> --revision <已保存版本> --project <只读目标> --font-method pixel\n\n全局：--root <隔离UI目录>、--json。默认在DSH私有目录，不使用游戏cwd。\n首版仅Maker静态审阅包；Cocos/Godot未实现。没有生成、删除、覆盖、native导入、build/push接口。\n浏览器预览不是Maker引擎验收；字体/安全区/metadata/native须在明确工程另行验收。`
const fail = message => { throw new UiWorkflowError('UI_COMMAND', message) }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
export function uiWorkspaceRoot(dshHome) { return path.join(resolveDshHome(dshHome), 'taptap-maker-dev', 'ui-workspaces') }
export function parseUiCommand(input) {
  const tokens = Array.isArray(input) ? [...input].map(String) : splitTokens(input)
  if (tokens.some(token => token.includes('\0'))) fail('UI 参数不能包含 NUL。')
  const command = tokens[0] && !tokens[0].startsWith('-') ? tokens.shift() : 'help'
  const consumed = consumeFlags(tokens, SPEC)
  if (consumed.missing.length || consumed.prompt) fail(`UI 参数缺失或不支持：${[...consumed.missing, consumed.prompt].filter(Boolean).join(' ')}。`)
  const flags = { ...consumed.values }
  for (const [name, value] of Object.entries(consumed.bools)) {
    if (![true, 'true', 'false'].includes(value)) fail(`--${name} 需要布尔开关。`)
    flags[name] = value === true || value === 'true'
  }
  if (!Object.hasOwn(ALLOWED, command)) fail(`不支持 UI 命令 ${command}；没有删除/重置/生成/其它引擎的隐式回退。`)
  for (const key of Object.keys(flags)) if (![...GLOBAL, ...ALLOWED[command]].includes(key)) fail(`${command} 不接受 ${key} 参数，未静默忽略。`)
  return { command: flags.help ? 'help' : command, flags }
}
function required(flags, names) { for (const name of names) if (typeof flags[name] !== 'string' || !flags[name].trim()) fail(`此操作需要明确 ${name} 参数。`) }
function inputDocument(file) {
  if (path.extname(file).toLowerCase() !== '.json') fail('UI 文档只接受明确的 .json 文件。')
  const absolute = safeUiPath(path.dirname(path.resolve(file)), path.basename(file))
  const document = readUiJson(absolute); assertUiDocument(document)
  return { document, assetRoot: path.dirname(absolute) }
}
function materializeNotices(document, assetRoot, existingDirectory) {
  let total = 0
  for (const asset of document.assets) {
    const license = asset.license
    if (!['MIT', 'OFL'].includes(license.kind)) continue
    const notice = license.notice
    // One-line filename references are read now, before copying any bitmap.
    // Multiline/literal notices stay verbatim in the immutable UI document.
    const pathLike = typeof notice === 'string' && !/[\r\n]/.test(notice) && (/\.(txt|md|license)$/i.test(notice) || /(^|\/)(license|copying)(\.[^/]*)?$/i.test(notice))
    if (!pathLike) {
      if (typeof notice !== 'string' || !notice.trim() || Buffer.byteLength(notice) > 1_000_000) throw new UiWorkflowError('UI_ASSET_LICENSE', 'MIT/OFL 通知文本缺失或过大。')
      continue
    }
    try {
      const input = safeUiPath(assetRoot, notice)
      const file = existingDirectory && !fs.existsSync(input) ? safeUiPath(existingDirectory, notice) : input
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000 || (total += stat.size) > 1_000_000) throw new Error('notice budget')
      const bytes = fs.readFileSync(file); const text = bytes.toString('utf8')
      if (bytes.length > 1_000_000 || !Buffer.from(text, 'utf8').equals(bytes) || !text.trim() || text.includes('\0')) throw new Error('notice encoding')
      license.notice = text
    } catch { throw new UiWorkflowError('UI_ASSET_LICENSE', 'MIT/OFL 本地通知文件缺失、越界、链接或超预算；未复制任何图片。') }
  }
  assertUiDocument(document)
}
function resources(document, assetRoot, existingDirectory) {
  materializeNotices(document, assetRoot, existingDirectory)
  const prepared = new Map(); let total = 0
  for (const asset of document.assets) {
    if (!asset.license.verifiedAt || Number.isNaN(Date.parse(asset.license.verifiedAt))) throw new UiWorkflowError('UI_ASSET_LICENSE', '素材必须记录核验时间；本工具不能用许可名称替代人工来源核验。')
    let file
    if (existingDirectory) {
      const existing = safeUiPath(existingDirectory, asset.path)
      if (fs.existsSync(existing)) {
        const bytes = fs.readFileSync(existing)
        if (hash(bytes) !== asset.sha256.toLowerCase()) throw new UiWorkflowError('UI_ASSET_CONFLICT', '工作区同名素材与新文档哈希冲突；不会覆盖已有素材。')
        continue
      }
    }
    file = safeUiPath(assetRoot, asset.path)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10_000_000 || (total += stat.size) > 50_000_000) throw new UiWorkflowError('UI_ASSET_LIMIT', '只复制已核验、普通且预算内的图片。')
    const bytes = fs.readFileSync(file)
    if (hash(bytes) !== asset.sha256.toLowerCase()) throw new UiWorkflowError('UI_ASSET_INTEGRITY', '素材 SHA256 与文档授权记录不符。')
    if (prepared.has(asset.path) && hash(prepared.get(asset.path)) !== hash(bytes)) throw new UiWorkflowError('UI_ASSET_CONFLICT', '重复素材路径的内容冲突。')
    const caseAlias = [...prepared.keys()].find(item => item !== asset.path && item.toLowerCase() === asset.path.toLowerCase())
    if (caseAlias) throw new UiWorkflowError('UI_ASSET_CONFLICT', '大小写相同的素材路径在 Windows 下冲突。')
    prepared.set(asset.path, bytes)
  }
  return prepared
}
function copyPrepared(directory, prepared) { for (const [relative, bytes] of prepared) writeUiFileExclusive(directory, relative, bytes) }

export async function runUiCommand(input, context = {}) {
  const { command, flags } = parseUiCommand(input)
  const root = path.resolve(flags.root || context.root || uiWorkspaceRoot(context.dshHome))
  if (command === 'help') return { ok: true, help: HELP, root }
  if (command === 'workbench') return { ok: true, url: `${UI_API_PREFIX}/workbench`, root, message: '使用现有 GUI 的 UI 工作台；没有启动另外的服务器。' }
  if (command === 'status') return getUiStatus(root)
  if (command === 'list') return { ok: true, root, workspaces: listUiWorkspaces(root) }
  if (command === 'demo') {
    const document = createDemoDocument(); if (flags.name) document.name = flags.name
    return { ok: true, ...createUiWorkspace(root, { name: document.name, document }) }
  }
  if (command === 'create') {
    required(flags, ['input'])
    const { document, assetRoot } = inputDocument(flags.input)
    if (flags.name) document.name = flags.name
    const prepared = resources(document, assetRoot)
    const workspace = createUiWorkspace(root, { name: document.name, document })
    copyPrepared(workspace.directory, prepared)
    return { ok: true, ...workspace, assetCount: prepared.size }
  }
  if (command === 'read') {
    required(flags, ['workspaceId'])
    return { ok: true, ...readUiWorkspace(root, flags.workspaceId, flags.revisionId) }
  }
  if (command === 'check') {
    if (!flags.workspaceId && !flags.input) fail('check 需要 --in 或 --id，不猜测文档。')
    if (flags.workspaceId && flags.input) fail('check 请只选 --in 或 --id。')
    const document = flags.workspaceId ? readUiWorkspace(root, flags.workspaceId, flags.revisionId).document : inputDocument(flags.input).document
    return { ...validateUiDocument(document), nativeVerified: false }
  }
  if (command === 'save') {
    required(flags, ['workspaceId', 'baseRevision', 'input'])
    const current = readUiWorkspace(root, flags.workspaceId)
    if (current.revisionId !== flags.baseRevision) throw new UiWorkflowError('UI_REVISION_CONFLICT', '版本已变化，请重读合并；未写入新素材或版本。')
    const { document, assetRoot } = inputDocument(flags.input)
    const prepared = resources(document, assetRoot, current.directory)
    copyPrepared(current.directory, prepared)
    return { ok: true, ...saveUiRevision(root, flags.workspaceId, document, { baseRevision: flags.baseRevision }) }
  }
  if (command === 'import-xml') {
    required(flags, ['fairy', 'component'])
    const { importLguiComponent } = await import('./lgui-import.mjs')
    const assetRights = flags.rights ? readUiJson(safeUiPath(path.dirname(path.resolve(flags.rights)), path.basename(flags.rights))) : undefined
    const imported = importLguiComponent(flags.fairy, flags.component, { assetRights })
    if (flags.name) imported.document.name = flags.name
    materializeNotices(imported.document, path.dirname(path.resolve(flags.rights ?? flags.fairy)))
    // All source assets are read/hash-checked BEFORE a new workspace is made.
    const prepared = new Map(imported.assetsToCopy.map(asset => {
      const bytes = fs.readFileSync(safeUiPath(path.dirname(asset.file), path.basename(asset.file)))
      if (hash(bytes) !== asset.sha256) throw new UiWorkflowError('UI_ASSET_INTEGRITY', '导入前素材内容已变化。')
      return [asset.path, bytes]
    }))
    const workspace = createUiWorkspace(root, { name: imported.document.name, document: imported.document })
    copyPrepared(workspace.directory, prepared)
    return { ok: true, ...workspace, assetCount: prepared.size, warnings: imported.warnings }
  }
  const native = await import('./ui-maker-export.mjs')
  const options = { fontSizeMethod: flags.fontSizeMethod, fontScale: flags.fontScale === undefined ? 1 : Number(flags.fontScale) }
  if (command === 'plan') {
    if (!flags.workspaceId && !flags.input) fail('plan 需要 --id 或 --in。')
    if (flags.workspaceId && flags.input) fail('plan 请只选 --id 或 --in。')
    const selected = flags.workspaceId ? readUiWorkspace(root, flags.workspaceId, flags.revisionId) : inputDocument(flags.input)
    if (selected.document.assets.length) options.assetRoot = selected.directory ?? selected.assetRoot
    return native.planMakerExport(selected.document, flags.projectDirectory, options)
  }
  required(flags, ['workspaceId', 'revisionId', 'projectDirectory', 'fontSizeMethod'])
  const selected = readUiWorkspace(root, flags.workspaceId, flags.revisionId)
  if (selected.document.assets.length) options.assetRoot = selected.directory
  return native.createMakerReview(root, flags.workspaceId, flags.revisionId, flags.projectDirectory, options)
}

export async function handleUiSlashInput(raw, context = {}) {
  try {
    const result = await runUiCommand(raw, context)
    if (result.help) return { kind: 'success', text: result.help }
    if (result.url) return { kind: 'success', text: `[打开 UI 工作台](${result.url})\n\n${result.message}\n也可点击输入框旁的 UI 挂件。浏览器预览不是 Maker 引擎验收。` }
    const name = result.name ?? result.document?.name ?? result.workspace?.name ?? ''
    const heading = result.status === 'staged' ? '已生成审阅包（未导入游戏 / 未 native 验收）' : result.workspaceId ? `UI 工作区：${String(name).replace(/[<>`\r\n]/g, ' ') || result.workspaceId}` : 'UI 工作流结果'
    const links = [result.file ? `[UI 文档](<${result.file}>)` : '', result.directory ? `[新工作区/审阅目录](<${result.directory}>)` : ''].filter(Boolean).join(' · ')
    return { kind: result.ok === false ? 'error' : 'success', text: `${heading}\n${links}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`` }
  } catch (error) { return { kind: 'error', text: `${error.code ?? 'UI_ERROR'}：${error.message}\n未更换通道、覆盖旧版或自动重试。` } }
}
