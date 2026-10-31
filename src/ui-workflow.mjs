/** Isolated append-only UI workspaces. Never overwrite assets, delete jobs, or
 * modify a game entry/config. Native project detection does not use Assets/. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assertUiDocument, UI_LIMITS } from './ui-document.mjs'
export * from './ui-document.mjs'

export const LGUI_COMMIT = 'e962aa3617aaad5a2fd5ddf2c80ace4bb1551240'
export const LGUI_REPOSITORY = 'https://github.com/LumioGames/LGUI'
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VENDOR_ROOT = path.join(PACKAGE_ROOT, 'third_party', 'LGUI-MIT')
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
export class UiWorkflowError extends Error {
  constructor(code, message, details) { super(message); this.name = 'UiWorkflowError'; this.code = code; this.details = details }
}
const fail = (code, message, details) => { throw new UiWorkflowError(code, message, details) }
const timestamp = () => new Date().toISOString().replace(/[-:.Z]/g, '')
const newId = prefix => `${prefix}-${timestamp()}-${crypto.randomBytes(6).toString('hex')}`
const asJson = value => JSON.stringify(value, null, 2) + '\n'

export function safeUiPath(root, relative) {
  if (typeof root !== 'string' || !root.trim() || typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) fail('UI_PATH', '需要明确的工作区根目录和相对路径。')
  const resolvedRoot = path.resolve(root); const resolved = path.resolve(resolvedRoot, relative)
  const inside = path.relative(resolvedRoot, resolved)
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) fail('UI_PATH', '路径不能越出 UI 工作区。')
  // Check every existing ancestor, not just the final file. Junctions/symlinks
  // must not redirect a reviewed asset or immutable revision to private data.
  let current = resolved
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('UI_PATH', 'UI 路径包含符号链接或目录联接；请使用明确的真实路径。')
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolved
}
function workspaceDirectory(root, id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) fail('UI_PATH', '无效的 UI 工作区 ID。')
  return safeUiPath(root, id)
}
export function readUiJson(file, limit = UI_LIMITS.bytes) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('UI_PATH', '只允许读取大小受限的普通 JSON 文件。')
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { if (error instanceof UiWorkflowError) throw error; fail('UI_JSON', 'JSON 文件无法解析。', { file }) }
}
export function writeUiFileExclusive(root, relative, contents) {
  const file = safeUiPath(root, relative)
  const directory = safeUiPath(root, path.relative(path.resolve(root), path.dirname(file)))
  fs.mkdirSync(directory, { recursive: true })
  let fd
  try {
    fd = fs.openSync(file, 'wx')
    fs.writeFileSync(fd, contents)
    fs.fsyncSync(fd)
  } catch (error) {
    if (error.code === 'EEXIST') fail('UI_EXISTS', '目标文件已存在；本工作流禁止覆盖。', { file })
    throw error
  } finally { if (fd !== undefined) fs.closeSync(fd) }
  return file
}
function revisionInfo(directory, revisionId) {
  if (typeof revisionId !== 'string' || !SAFE_ID.test(revisionId)) fail('UI_PATH', '无效的 UI revision ID。')
  const relative = `revisions/${revisionId}`
  const record = readUiJson(safeUiPath(directory, `${relative}/revision.json`))
  if (record.revisionId !== revisionId || !/^[a-f\d]{64}$/.test(record.sha256)) fail('UI_INTEGRITY', 'UI revision 提交记录无效。')
  const file = safeUiPath(directory, `${relative}/document.json`)
  const bytes = fs.readFileSync(file)
  if (bytes.length > UI_LIMITS.bytes || digest(bytes) !== record.sha256) fail('UI_INTEGRITY', '已保存 UI 文档哈希不符，未覆盖或自动修复。', { file, revisionId })
  const document = readUiJson(file)
  assertUiDocument(document)
  return { ...record, file, document }
}
function revisionIds(directory) {
  const revisions = safeUiPath(directory, 'revisions')
  if (!fs.existsSync(revisions)) return []
  return fs.readdirSync(revisions, { withFileTypes: true }).filter(entry => entry.isDirectory() && SAFE_ID.test(entry.name)).map(entry => entry.name).sort()
}
function latestRevision(directory) {
  const ids = revisionIds(directory)
  const failures = []
  for (const id of ids.reverse()) {
    try { return { ...revisionInfo(directory, id), incompleteRevisions: failures } } catch (error) { failures.push({ revisionId: id, code: error.code ?? 'UI_INCOMPLETE' }) }
  }
  fail('UI_INCOMPLETE', '工作区没有完整提交的 UI revision；已有中间文件原样保留。', { incompleteRevisions: failures })
}
function appendRevision(directory, document, baseRevision = null) {
  const revisionId = newId('rev')
  const relative = `revisions/${revisionId}`
  const bytes = Buffer.from(asJson(document))
  const file = writeUiFileExclusive(directory, `${relative}/document.json`, bytes)
  const info = { revisionId, baseRevision, sha256: digest(bytes), createdAt: new Date().toISOString(), name: document.name }
  // A commit record is written LAST. Incomplete new revisions are retained,
  // diagnosed and ignored for latest selection; old ready revisions remain.
  writeUiFileExclusive(directory, `${relative}/revision.json`, asJson(info))
  return { ...info, file, directory }
}
export function createUiWorkspace(root, { name, document } = {}) {
  assertUiDocument(document)
  if (typeof name !== 'string' || !name.trim() || name.length > 120) fail('UI_NAME', '请输入工作区名称。')
  const workspaceId = newId('ui')
  const directory = workspaceDirectory(root, workspaceId)
  fs.mkdirSync(path.resolve(root), { recursive: true })
  fs.mkdirSync(directory, { recursive: false })
  writeUiFileExclusive(directory, '.gitignore', '*\n!.gitignore\n')
  writeUiFileExclusive(directory, 'workspace.json', asJson({ format: 'taptap-ui-workspace', version: 1, workspaceId, name, createdAt: new Date().toISOString() }))
  return { workspaceId, ...appendRevision(directory, document) }
}
export function readUiWorkspace(root, workspaceId, revisionId) {
  const directory = workspaceDirectory(root, workspaceId)
  const workspace = readUiJson(safeUiPath(directory, 'workspace.json'))
  if (workspace.format !== 'taptap-ui-workspace' || workspace.version !== 1 || workspace.workspaceId !== workspaceId) fail('UI_INTEGRITY', 'UI 工作区记录不符。')
  const revision = revisionId ? revisionInfo(directory, revisionId) : latestRevision(directory)
  return { workspaceId, directory, workspace, ...revision }
}
export function saveUiRevision(root, workspaceId, document, { baseRevision } = {}) {
  assertUiDocument(document)
  const current = readUiWorkspace(root, workspaceId)
  if (typeof baseRevision !== 'string' || baseRevision !== current.revisionId) fail('UI_REVISION_CONFLICT', '保存版本发生冲突；请重读并合并，不强制覆盖。', { currentRevision: current.revisionId })
  // Immutable compare-and-swap claim: two processes cannot consume the same
  // base revision. No unlink/cleanup is needed or performed. A crashed claim
  // is reported rather than deleting a lock or overwriting unknown work.
  try { writeUiFileExclusive(current.directory, `claims/${baseRevision}.json`, asJson({ baseRevision, claimedAt: new Date().toISOString() })) } catch (error) {
    if (error.code === 'UI_EXISTS') fail('UI_REVISION_CONFLICT', '此 revision 已被另一保存请求使用；请重读，未覆盖。')
    throw error
  }
  return { workspaceId, ...appendRevision(current.directory, document, baseRevision) }
}
export function listUiWorkspaces(root) {
  if (!fs.existsSync(path.resolve(root))) return []
  const directory = safeUiPath(root, '')
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && SAFE_ID.test(entry.name) && entry.name.startsWith('ui-')).slice(0, 200).map(entry => {
    try {
      const item = readUiWorkspace(root, entry.name)
      return { workspaceId: item.workspaceId, revisionId: item.revisionId, name: item.document.name, directory: item.directory, createdAt: item.createdAt, nodeCount: item.document.nodes.length, assetCount: item.document.assets.length, warnings: item.incompleteRevisions ?? [] }
    } catch (error) { return { workspaceId: entry.name, name: entry.name, error: error.code ?? 'UI_INCOMPLETE' } }
  }).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}

export function verifyLguiVendor() {
  const base = { commit: LGUI_COMMIT, repository: LGUI_REPOSITORY, license: 'MIT', files: [] }
  try {
    const manifest = readUiJson(path.join(VENDOR_ROOT, 'provenance.json'))
    if (manifest.commit !== LGUI_COMMIT || manifest.repository !== LGUI_REPOSITORY || manifest.license !== 'MIT' || !Array.isArray(manifest.files) || !manifest.files.length) return { ...base, ok: false, error: 'LGUI_PROVENANCE' }
    const files = manifest.files.map(item => {
      const file = safeUiPath(VENDOR_ROOT, item.path)
      const sha256 = digest(fs.readFileSync(file))
      return { path: item.path, sha256, ok: sha256 === item.sha256 }
    })
    return { ...base, ok: files.every(item => item.ok), files, parser: 'python-stdlib-adapter', updates: 'pinned-no-auto-update' }
  } catch (error) { return { ...base, ok: false, error: error.code ?? 'LGUI_PROVENANCE' } }
}

export function inspectMakerProject(projectDirectory, { expectedFiles } = {}) {
  const blockers = []; const files = []
  if (typeof projectDirectory !== 'string' || !projectDirectory.trim()) return { ready: false, orientation: null, blockers: [{ code: 'MAKER_PROJECT_MISSING', message: '需要用户明确指定已初始化 Maker 游戏工程；插件目录不能代替游戏工程。' }], files }
  const directory = path.resolve(projectDirectory)
  let project; let settings
  try {
    project = readUiJson(safeUiPath(directory, '.project/project.json'))
    settings = readUiJson(safeUiPath(directory, '.project/settings.json'))
    if (!fs.statSync(safeUiPath(directory, 'assets')).isDirectory()) throw new Error('assets missing')
  } catch { blockers.push({ code: 'MAKER_PROJECT_MISSING', message: '未找到完整 Maker 主配置与 assets；仅有 Assets/ 不算 Maker 工程。' }) }
  const orientation = project?.taptap_publish?.screen_orientation ?? null
  if (!['landscape', 'portrait'].includes(orientation)) blockers.push({ code: 'MAKER_ORIENTATION_MISSING', message: '工程横竖屏配置缺失或无效；不自动猜测或更改。' })
  const required = ['init.lua', 'Core/UI.lua', 'Core/UILoader.lua', 'Core/UISerializer.lua', 'Core/Widget.lua', 'Core/Style.lua', 'Widgets/Panel.lua', 'Widgets/Label.lua', 'Widgets/Button.lua', 'Widgets/SafeAreaView.lua']
  for (const relative of required) {
    try {
      const file = safeUiPath(directory, `urhox-libs/UI/${relative}`)
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > 1_000_000) throw new Error('not a bounded regular source file')
      const sha256 = digest(fs.readFileSync(file))
      files.push({ path: `urhox-libs/UI/${relative}`, sha256 })
      if (expectedFiles && expectedFiles[relative] !== sha256) blockers.push({ code: 'MAKER_UI_VERSION_UNVERIFIED', message: `UI 源码版本未核验：${relative}。` })
    } catch { blockers.push({ code: 'MAKER_UI_SOURCE_MISSING', message: `缺少真实 UI 源码：${relative}。` }) }
  }
  if (!expectedFiles && files.length === required.length) blockers.push({ code: 'MAKER_UI_VERSION_UNVERIFIED', message: '需要已审计的 SDK 指纹，不能仅凭函数名推断兼容。' })
  // Readiness is for the export adapter only, not authentication, remote build,
  // metadata completion, active game-entry ownership or visual acceptance.
  return { ready: blockers.length === 0, directory, orientation, hasSettings: Boolean(settings), blockers, files }
}
