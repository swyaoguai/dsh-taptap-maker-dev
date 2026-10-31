/**
 * Original, dependency-free UI workbench. The browser imports the shared pure
 * document module from the same-origin host; Node can test this module without
 * a DOM, a server, generation credits, or a replacement GUI.
 */
export const API_BASE = '/api/taptap-maker-dev/ui'
export const VIEWPORT_PRESETS = Object.freeze([
  Object.freeze({ id: '1280x720', width: 1280, height: 720, label: '桌面' }),
  Object.freeze({ id: '844x390', width: 844, height: 390, label: '横屏' }),
  Object.freeze({ id: '390x844', width: 390, height: 844, label: '竖屏' }),
])
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const forbiddenIds = new Set(['constructor', 'prototype', '__proto__'])
const clone = value => structuredClone(value)
const signature = document => JSON.stringify(document)
const safeId = value => typeof value === 'string' && ID.test(value) && !forbiddenIds.has(value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const errorText = error => typeof error === 'string' ? error : String(error?.message ?? '操作未完成。')

export class UiWorkbenchError extends Error {
  constructor(code, message, { status = 0, details } = {}) {
    super(message); this.name = 'UiWorkbenchError'; this.code = code; this.status = status; this.details = details
  }
}
function success(result) {
  if (!record(result) || result.ok !== true) {
    const message = typeof result?.error === 'string' ? result.error : result?.error?.message ?? result?.message ?? '接口未明确确认操作成功。'
    throw new UiWorkbenchError(result?.code ?? 'UI_RESPONSE', message, { details: result?.details })
  }
  return result
}
function requireDocument(document, ui) {
  const result = ui.validateUiDocument(document)
  if (!result.ok) throw new UiWorkbenchError('UI_DOCUMENT', `文档检查未通过：${result.errors[0]?.message ?? '不符合 UI 规范。'}`, { details: result })
  return result
}

/** Fits the preset viewport, THEN contains the immutable design inside it. */
export function fitStage(design, viewport, available) {
  if (![design, viewport, available].every(size => size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0)) return null
  const viewportScale = Math.min(available.width / viewport.width, available.height / viewport.height)
  const viewportWidth = viewport.width * viewportScale; const viewportHeight = viewport.height * viewportScale
  const scale = Math.min(viewport.width / design.width, viewport.height / design.height) * viewportScale
  const width = design.width * scale; const height = design.height * scale
  return { viewportScale, viewportWidth, viewportHeight, scale, width, height, x: (viewportWidth - width) / 2, y: (viewportHeight - height) / 2 }
}
export function normalizeJsonFilename(name) {
  const stem = String(name ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 96).replace(/[-_]+$/g, '') || 'document'
  return `taptap-ui-${stem}.json`
}
export function parseLocalUiJson(text, ui, file = {}) {
  const limit = ui.UI_LIMITS?.bytes ?? 1_000_000
  if (file.name && !/\.json$/i.test(file.name)) throw new UiWorkbenchError('UI_JSON_TYPE', '仅接受本地 .json 文件；FairyGUI 先通过 CLI 导入。')
  if (file.type && !['application/json', 'text/json', 'text/plain'].includes(file.type.toLowerCase())) throw new UiWorkbenchError('UI_JSON_TYPE', '文件 MIME 类型不是 JSON / 文本。')
  if (typeof text !== 'string' || (file.size !== undefined && (!Number.isFinite(file.size) || file.size < 0 || file.size > limit)) || text.length > limit || new TextEncoder().encode(text).byteLength > limit) throw new UiWorkbenchError('UI_JSON_LIMIT', '本地 JSON 大小限制为 1 MB。')
  let document
  try { document = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new UiWorkbenchError('UI_JSON', 'JSON 无法解析；当前草稿未被替换。') }
  requireDocument(document, ui)
  return document
}

/** Fixed same-origin route allowlist; never accepts a user-supplied URL/path. */
export function createUiApi(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new TypeError('需要浏览器 fetch。')
  return { async request(path, { method = 'GET', body } = {}) {
    const reads = ['/status', '/workspaces'].includes(path) || /^\/workspaces\/[A-Za-z][A-Za-z0-9_-]{0,63}(?:\?revision=[A-Za-z][A-Za-z0-9_-]{0,63})?$/.test(path)
    const writes = ['/workspaces', '/check', '/plan', '/export'].includes(path) || /^\/workspaces\/[A-Za-z][A-Za-z0-9_-]{0,63}\/revisions$/.test(path)
    if ((method !== 'GET' || !reads) && (method !== 'POST' || !writes)) throw new UiWorkbenchError('UI_API_PATH', '拒绝非工作台 API 路径或方法。')
    if (method === 'GET' && body !== undefined) throw new UiWorkbenchError('UI_API_BODY', '只读请求不能带写入内容。')
    const options = { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' } }
    if (method === 'POST') { options.headers['content-type'] = 'application/json'; options.body = JSON.stringify(body ?? {}) }
    let response
    try { response = await fetchImpl(`${API_BASE}${path}`, options) } catch {
      throw new UiWorkbenchError('UI_API_NETWORK', '未收到接口确认回应。若保存或导出已发出，结果可能未知；不会自动重发，请先刷新列表人工核对。')
    }
    let result
    try { result = await response.json() } catch {
      throw new UiWorkbenchError('UI_API_JSON', `HTTP ${response.status} 响应不是 JSON。写入结果可能未知，不会自动重发。`, { status: response.status })
    }
    if (!response.ok) {
      const message = typeof result?.error === 'string' ? result.error : result?.error?.message ?? result?.message ?? `HTTP ${response.status}`
      throw new UiWorkbenchError(result?.code ?? 'UI_API_HTTP', message, { status: response.status, details: result?.details })
    }
    // /check can return ok=false as a structural report. HTTP 200 is NEVER
    // converted to readiness, native success, or permission to export.
    return result
  } }
}

function nodeIndex(document) { return new Map(document.nodes.map(node => [node.id, node])) }
function effectiveDocument(document, visibility) {
  return { ...document, nodes: document.nodes.map(node => Object.hasOwn(visibility, node.id) ? { ...node, props: { ...node.props, visible: visibility[node.id] } } : node) }
}
function nodeContext(node, byId, visibility = {}) {
  let current = node; let visible = true; let enabled = true; const seen = new Set()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    visible = visible && (visibility[current.id] ?? current.props.visible) !== false
    enabled = enabled && current.props.enabled !== false
    current = byId.get(current.parent)
  }
  return { visible, enabled }
}
function insideNode(id, ancestorId, byId) {
  const seen = new Set(); let current = byId.get(id)
  while (current && !seen.has(current.id)) {
    if (current.id === ancestorId) return true
    seen.add(current.id); current = byId.get(current.parent)
  }
  return false
}
function activeModal(document, visibility) {
  const byId = nodeIndex(document)
  return document.nodes.filter(node => node.type === 'modal' && nodeContext(node, byId, visibility).visible).at(-1) ?? null
}
function globalPosition(node, byId) {
  let x = 0; let y = 0; let opacity = 1; let current = node
  while (current) { x += current.layout.x; y += current.layout.y; opacity *= current.props.opacity ?? 1; current = byId.get(current.parent) }
  return { x, y, opacity }
}

/** The controller owns authored drafts separately from disposable preview state. */
export function createWorkbenchModel({ ui, api, confirmDiscard = () => false }) {
  const document = ui.createDemoDocument(); requireDocument(document, ui)
  const listeners = new Set(); const pending = new Set()
  let savedSignature = null; let draftEpoch = 0; let planSignature = null
  const data = {
    document, dirty: true, workspaceId: null, revisionId: null, directory: null,
    selectedId: document.nodes.find(node => node.type === 'label')?.id ?? document.nodes[0].id,
    mode: 'edit', previewState: clone(document.state), visibility: {}, previewToast: '',
    target: { projectDirectory: '', fontSizeMethod: '', fontScale: 1 },
    localValidation: ui.validateUiDocument(document), status: null, statusError: '', workspaces: [], workspacesError: '',
    plan: null, report: null, exported: null, error: '', conflict: false,
    notice: '先编辑或切到交互体验 CAMP。未保存样例不会自动落盘。', noticeKind: 'info',
  }
  const snapshot = () => clone({ ...data, busy: [...pending] })
  const emit = () => { if (listeners.size) { const state = snapshot(); for (const listener of listeners) listener(state) } }
  const notice = (text, kind = 'info') => { data.notice = text; data.noticeKind = kind }
  const fail = error => { data.error = errorText(error); emit(); return false }
  const writeBusy = () => pending.has('save') || pending.has('export')
  const documentKey = () => signature({ document: data.document, workspaceId: data.workspaceId, revisionId: data.revisionId, target: data.target })
  const invalidate = () => { data.plan = null; data.report = null; planSignature = null }
  const dirty = () => { data.dirty = savedSignature !== signature(data.document) }
  const canReplace = verb => {
    if (writeBusy()) return fail(new Error('保存 / 导出请求尚未结束；当前草稿已保留，请等待确认结果。'))
    if (!data.dirty) return true
    try { return confirmDiscard(`当前草稿尚未保存。${verb}将替换当前草稿，是否继续？\n可以先点击「本地 JSON 下载」保留副本。`) === true } catch { return false }
  }
  function replaceDocument(next, info = {}) {
    data.document = clone(next); draftEpoch += 1
    data.workspaceId = info.workspaceId ?? null; data.revisionId = info.revisionId ?? null; data.directory = info.directory ?? null
    savedSignature = data.workspaceId && data.revisionId ? signature(next) : null
    dirty(); data.localValidation = ui.validateUiDocument(next)
    data.previewState = clone(next.state); data.visibility = {}; data.previewToast = ''
    data.selectedId = next.nodes.find(node => node.id === 'title')?.id ?? next.nodes[0].id
    data.error = ''; data.conflict = false; data.exported = null; invalidate(); emit()
  }
  function editDocument(next) {
    let report
    try { report = requireDocument(next, ui) } catch (error) { return fail(error) }
    if (signature(next) === signature(data.document)) return true
    data.document = next; data.localValidation = report; draftEpoch += 1; dirty(); invalidate(); data.error = ''
    notice('草稿已修改，尚未保存新版本。'); emit(); return true
  }
  async function perform(name, callback) {
    if (pending.has(name)) return fail(new Error('同一请求仍在进行；未再次发送。'))
    pending.add(name); data.error = ''; emit()
    try { return await callback() } catch (error) { return fail(error) } finally { pending.delete(name); emit() }
  }
  function validateRevisionResult(result, expectedId) {
    success(result)
    if (!safeId(result.workspaceId) || !safeId(result.revisionId) || (expectedId && result.workspaceId !== expectedId)) throw new UiWorkbenchError('UI_RESPONSE', '接口返回的工作区 / 版本 ID 无效；草稿未替换。')
    return result
  }
  function rememberWorkspace(result, savedDocument) {
    const item = { workspaceId: result.workspaceId, revisionId: result.revisionId, name: savedDocument.name, directory: result.directory, nodeCount: savedDocument.nodes.length, assetCount: savedDocument.assets.length }
    data.workspaces = [item, ...data.workspaces.filter(workspace => workspace.workspaceId !== result.workspaceId)]
  }
  const model = {
    getState: snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener) },
    async initialize() { return Promise.all([model.refreshStatus(), model.refreshWorkspaces()]) },
    async refreshStatus() {
      if (pending.has('status')) return false
      pending.add('status'); emit()
      try { data.status = clone(success(await api.request('/status'))); data.statusError = ''; return true } catch (error) { data.statusError = errorText(error); return false } finally { pending.delete('status'); emit() }
    },
    async refreshWorkspaces() {
      if (pending.has('workspaces')) return false
      pending.add('workspaces'); emit()
      try {
        const result = success(await api.request('/workspaces'))
        if (!Array.isArray(result.workspaces)) throw new UiWorkbenchError('UI_RESPONSE', '工作区列表响应无效。')
        data.workspaces = clone(result.workspaces); data.workspacesError = ''; return true
      } catch (error) { data.workspacesError = errorText(error); return false } finally { pending.delete('workspaces'); emit() }
    },
    selectNode(id) {
      if (!data.document.nodes.some(node => node.id === id)) return false
      data.selectedId = id; emit(); return true
    },
    setMode(mode) {
      if (!['edit', 'interact'].includes(mode)) return fail(new Error('模式只能是 edit / interact。'))
      data.mode = mode; emit(); return true
    },
    rename(name) { return editDocument({ ...data.document, name }) },
    updateNode(id, patch) {
      const editable = ['text', 'x', 'y', 'width', 'height', 'fontSize', 'color', 'backgroundColor', 'visible']
      if (!record(patch) || Object.keys(patch).some(key => !editable.includes(key))) return fail(new Error('节点 ID 只读；只允许明确的文字、布局与样式属性。'))
      const index = data.document.nodes.findIndex(node => node.id === id)
      if (index < 0) return fail(new Error('节点不存在，未修改草稿。'))
      const next = clone(data.document); const node = next.nodes[index]
      for (const [key, value] of Object.entries(patch)) {
        if (['x', 'y', 'width', 'height'].includes(key)) node.layout[key] = value
        else if (value === '' && ['fontSize', 'color', 'backgroundColor'].includes(key)) delete node.props[key]
        else node.props[key] = value
      }
      const applied = editDocument(next)
      if (applied && Object.hasOwn(patch, 'visible')) { delete data.visibility[id]; emit() }
      return applied
    },
    clickNode(id) {
      const byId = nodeIndex(data.document); const node = byId.get(id)
      if (!node) return false
      if (data.mode === 'edit') return model.selectNode(id)
      const context = nodeContext(node, byId, data.visibility); const modal = activeModal(data.document, data.visibility)
      if (node.type !== 'button' || !context.visible || !context.enabled || (modal && !insideNode(id, modal.id, byId))) return false
      const event = data.document.events.find(event => event.node === id && event.event === 'click')
      if (!event) { notice('此按钮没有绑定已声明的 click 动作。'); emit(); return false }
      try {
        const result = ui.applyUiAction(effectiveDocument(data.document, data.visibility), data.previewState, event.action)
        data.previewState = result.state; data.visibility = { ...data.visibility, ...result.visibility }; data.previewToast = result.toast
        emit(); return true
      } catch (error) { return fail(error) }
    },
    closeModal(id) {
      const modal = activeModal(data.document, data.visibility)
      if (data.mode !== 'interact' || !modal || (id && modal.id !== id)) return false
      data.visibility = { ...data.visibility, [modal.id]: false }; emit(); return true
    },
    clearPreviewToast() { if (data.previewToast) { data.previewToast = ''; emit() } },
    newDemo() {
      if (!canReplace('新建原创样例')) return false
      replaceDocument(ui.createDemoDocument()); notice('已新建原创 CAMP 样例，只在浏览器中；尚未保存工作区。'); emit(); return true
    },
    importJson(text, file = {}) {
      let imported
      try { imported = parseLocalUiJson(text, ui, file) } catch (error) { return fail(error) }
      if (!canReplace('导入本地 JSON')) return false
      replaceDocument(imported); notice('本地 JSON 已作为新草稿载入；点击保存才会创建新工作区。'); emit(); return true
    },
    toJsonDownload() {
      requireDocument(data.document, ui)
      return { filename: normalizeJsonFilename(data.document.name), contents: JSON.stringify(data.document, null, 2) + '\n' }
    },
    async loadWorkspace(workspaceId, revisionId) {
      if (!safeId(workspaceId) || (revisionId !== undefined && !safeId(revisionId))) return fail(new Error('无效工作区 / 版本 ID；不接受服务器文件路径。'))
      if (pending.has('load')) return fail(new Error('工作区读取尚未结束；未发起另一读取。'))
      if (!canReplace('读取另一个工作区或版本')) return false
      const epoch = draftEpoch
      return perform('load', async () => {
        const path = `/workspaces/${encodeURIComponent(workspaceId)}${revisionId ? `?revision=${encodeURIComponent(revisionId)}` : ''}`
        const result = validateRevisionResult(await api.request(path), workspaceId)
        requireDocument(result.document, ui)
        if (revisionId && result.revisionId !== revisionId) throw new UiWorkbenchError('UI_RESPONSE', '返回版本与请求版本不符；未覆盖草稿。')
        if (epoch !== draftEpoch) throw new UiWorkbenchError('UI_DRAFT_CHANGED', '读取期间草稿已改变；返回的旧响应未覆盖当前草稿，请人工确认后重新读取。')
        replaceDocument(result.document, result); rememberWorkspace(result, result.document)
        notice('已读取保存版本。继续修改会形成草稿，不会覆盖旧版。'); return true
      })
    },
    async save({ asNew = false } = {}) {
      if (writeBusy() || pending.has('load')) return fail(new Error('读写请求尚未结束；未重复保存。'))
      const savedDocument = clone(data.document)
      try { requireDocument(savedDocument, ui) } catch (error) { return fail(error) }
      const workspaceId = asNew ? null : data.workspaceId; const baseRevision = data.revisionId
      return perform('save', async () => {
        let result
        try {
          result = await api.request(workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}/revisions` : '/workspaces', {
            method: 'POST', body: workspaceId ? { document: savedDocument, baseRevision } : { name: savedDocument.name, document: savedDocument },
          })
        } catch (error) {
          if (error.status === 409 || error.code === 'UI_REVISION_CONFLICT') {
            data.conflict = true
            throw new UiWorkbenchError('UI_REVISION_CONFLICT', `版本冲突。当前草稿与 baseRevision 已保留，没有重读、覆盖或自动重试。${errorText(error)}`, { status: 409, details: error.details })
          }
          throw error
        }
        validateRevisionResult(result, workspaceId)
        data.workspaceId = result.workspaceId; data.revisionId = result.revisionId; data.directory = result.directory ?? null
        savedSignature = signature(savedDocument); dirty(); invalidate(); data.conflict = false; data.error = ''
        rememberWorkspace(result, savedDocument)
        notice(data.dirty ? '保存的是请求发出时的快照；之后的修改仍是未保存草稿。' : '新版本已保存，旧版本没有被覆盖。', 'success')
        return true
      })
    },
    setTarget(patch) {
      if (!record(patch) || Object.keys(patch).some(key => !['projectDirectory', 'fontSizeMethod', 'fontScale'].includes(key))) return fail(new Error('只允许明确的 Maker 目标与字号选项。'))
      const next = { ...data.target, ...patch }
      if (typeof next.projectDirectory !== 'string' || next.projectDirectory.length > 4096 || /[\u0000\r\n]/.test(next.projectDirectory) || !['', 'pixel', 'char'].includes(next.fontSizeMethod) || next.fontScale !== 1) return fail(new Error('目标路径无效；字号方法只能选 pixel / char，本闭环 fontScale 固定为 1。'))
      if (signature(next) !== signature(data.target)) { data.target = next; data.plan = null; planSignature = null; emit() }
      return true
    },
    async checkDocument() {
      const checkedDocument = clone(data.document); const epoch = draftEpoch
      return perform('check', async () => {
        const raw = await api.request('/check', { method: 'POST', body: { document: checkedDocument } })
        const report = raw?.report ?? raw?.validation ?? raw
        if (!record(report) || typeof report.ok !== 'boolean' || !Array.isArray(report.errors)) throw new UiWorkbenchError('UI_RESPONSE', '结构校验响应无效；未转为 Maker 就绪。')
        if (epoch !== draftEpoch) throw new UiWorkbenchError('UI_DRAFT_CHANGED', '校验期间草稿已改变；旧报告未应用。')
        data.report = clone(report); notice(report.ok ? '结构校验通过。它不是浏览器视觉验收，也不是 Maker native 验收。' : '结构校验未通过；草稿已保留，未导出。', report.ok ? 'success' : 'warning')
        return report.ok
      })
    },
    async planExport() {
      const blockers = []
      if (!data.target.projectDirectory.trim()) blockers.push({ code: 'MAKER_PROJECT_MISSING', message: '请明确输入已初始化的 Maker 游戏工程；不猜路径、不用插件目录。' })
      if (!['pixel', 'char'].includes(data.target.fontSizeMethod)) blockers.push({ code: 'FONT_SIZE_METHOD_REQUIRED', message: '请由你选择 fontSizeMethod：pixel 或 char；不会更改游戏 Init / theme。' })
      if (!data.localValidation.ok) blockers.push(...data.localValidation.errors)
      if (blockers.length) { data.plan = { ok: true, ready: false, blockers, warnings: [], origin: 'browser-prerequisites' }; planSignature = null; notice('预检 blocked：尚未满足明确的目标与字号选择。'); emit(); return false }
      const key = documentKey(); const payload = { document: clone(data.document), projectDirectory: data.target.projectDirectory.trim(), options: { fontSizeMethod: data.target.fontSizeMethod, fontScale: 1 } }
      if (safeId(data.workspaceId) && safeId(data.revisionId)) { payload.workspaceId = data.workspaceId; payload.revisionId = data.revisionId }
      return perform('plan', async () => {
        const result = success(await api.request('/plan', { method: 'POST', body: payload }))
        if (key !== documentKey()) throw new UiWorkbenchError('UI_DRAFT_CHANGED', '预检期间草稿、保存版本或目标已改变；过期预检未应用。')
        const reportBlockers = Array.isArray(result.blockers) ? result.blockers : [{ code: 'UI_PLAN_FORMAT', message: '接口没有返回明确的 blockers 报告，不能授权导出。' }]
        data.plan = { ...clone(result), ready: result.ready === true && reportBlockers.length === 0, blockers: clone(reportBlockers), warnings: Array.isArray(result.warnings) ? clone(result.warnings) : [] }
        planSignature = key
        notice(data.plan.ready ? (data.dirty ? '预检 ready 仅针对当前草稿；请先保存新版本，再重做预检以生成审阅包。' : '预检 ready，仅允许为当前保存版本生成 staged 审阅包；未 native 验收。') : 'Maker 预检 blocked。检查报告；没有改动游戏工程。', data.plan.ready ? 'success' : 'warning')
        return data.plan.ready
      })
    },
    canExport() {
      return !data.dirty && safeId(data.workspaceId) && safeId(data.revisionId) && data.plan?.ok === true && data.plan.ready === true && Array.isArray(data.plan.blockers) && data.plan.blockers.length === 0 && planSignature === documentKey() && !writeBusy() && !pending.has('load')
    },
    async exportReview() {
      if (!model.canExport()) return fail(new Error('导出 blocked：必须先保存当前草稿，并对相同版本、明确目标与字号完成 ready 预检。'))
      const payload = { workspaceId: data.workspaceId, revisionId: data.revisionId, projectDirectory: data.target.projectDirectory.trim(), options: { fontSizeMethod: data.target.fontSizeMethod, fontScale: 1 } }
      return perform('export', async () => {
        const result = success(await api.request('/export', { method: 'POST', body: payload }))
        if (result.status !== 'staged') throw new UiWorkbenchError('UI_RESPONSE', '接口没有明确返回 staged 审阅包；未声称已导入或 native 验收。')
        data.exported = { ...clone(result), workspaceId: payload.workspaceId, revisionId: payload.revisionId, projectDirectory: payload.projectDirectory, options: payload.options }
        notice('新的 staged 审阅包已生成在 UI 工作区内；未覆盖素材、未导入游戏、未改入口、未构建。', 'success')
        return true
      })
    },
    reportError: fail,
  }
  return model
}

const previewMemory = new WeakMap()
/**
 * DOM-only simulation: parent-relative absolute layout and stable sibling order.
 * An active custom modal is portalled at its summed parent-relative origin so
 * even a nested/transparent parent cannot put background clicks above it.
 * This is NOT nativeModal support or an assertion of Maker engine behavior.
 */
export function renderUiPreview(host, state, { ui, dom = host.ownerDocument, onSelect = () => {}, onAction = () => {}, onDismissModal = () => {} }) {
  const document = state.document; requireDocument(document, ui)
  const byId = nodeIndex(document); const resolved = ui.resolveUiBindings(document, state.previewState)
  const modal = state.mode === 'interact' ? activeModal(document, state.visibility) : null
  const previous = previewMemory.get(host) ?? {}
  const focusedId = host.contains(dom.activeElement) ? dom.activeElement?.dataset?.uiId : null
  const returnFocusId = modal && modal.id !== previous.activeId ? focusedId : previous.returnFocusId
  if (previous.keydown) host.removeEventListener('keydown', previous.keydown)
  host.replaceChildren(); host.dataset.mode = state.mode
  const children = new Map(); const elements = new Map(); const focusable = []
  for (const node of document.nodes) { const list = children.get(node.parent) ?? []; list.push(node); children.set(node.parent, list) }
  function build(node, portal = false) {
    if (modal?.id === node.id && !portal) return null
    const element = dom.createElement(node.type === 'button' ? 'button' : 'div')
    elements.set(node.id, element)
    element.className = `preview-node${node.type === 'image' ? ' preview-placeholder' : ''}`
    element.dataset.uiId = node.id; element.dataset.nodeType = node.type; element.dataset.parentId = node.parent ?? ''; element.dataset.selected = String(state.selectedId === node.id)
    element.style.position = 'absolute'; element.style.left = `${node.layout.x}px`; element.style.top = `${node.layout.y}px`; element.style.width = `${node.layout.width}px`; element.style.height = `${node.layout.height}px`
    const props = node.props; const context = nodeContext(node, byId, state.visibility)
    element.hidden = (state.visibility[node.id] ?? props.visible) === false
    for (const key of ['backgroundColor', 'borderColor', 'color', 'fontWeight']) if (props[key] !== undefined) element.style[key] = props[key]
    for (const key of ['borderWidth', 'borderRadius', 'fontSize']) if (props[key] !== undefined) element.style[key] = `${props[key]}px`
    if (props.opacity !== undefined) element.style.opacity = String(props.opacity)
    if (node.type === 'label' || node.type === 'button') {
      element.style.textAlign = props.align ?? (node.type === 'button' ? 'center' : 'left')
      const text = dom.createElement('span'); text.className = 'preview-text'; text.textContent = resolved[node.id]?.text ?? props.text ?? ''; element.append(text)
    }
    if (node.type === 'image') element.textContent = `图片未加载 / 占位 · ${props.asset}`
    if (node.type === 'list') { element.setAttribute('role', 'list'); element.setAttribute('aria-label', `固定列表 ${node.id}（非虚拟列表）`) }
    if (byId.get(node.parent)?.type === 'list') element.setAttribute('role', 'listitem')
    if (node.type === 'modal') {
      element.setAttribute('role', 'dialog'); element.setAttribute('aria-label', `自定义覆盖层 ${node.id}（不是 nativeModal）`); element.setAttribute('aria-modal', String(modal?.id === node.id)); element.tabIndex = -1
    }
    if (node.type === 'button') {
      element.type = 'button'
      element.disabled = state.mode === 'interact' && (!context.visible || !context.enabled || (modal !== null && !insideNode(node.id, modal.id, byId)))
      element.tabIndex = element.disabled ? -1 : 0
      if (modal && insideNode(node.id, modal.id, byId) && context.visible && !element.disabled) focusable.push(element)
    }
    element.addEventListener('click', event => {
      if (state.mode === 'edit') { event.preventDefault(); event.stopPropagation(); onSelect(node.id) }
      else if (node.type === 'button') { event.stopPropagation(); if (!element.disabled) onAction(node.id) }
    })
    for (const child of children.get(node.id) ?? []) { const rendered = build(child); if (rendered) element.append(rendered) }
    return element
  }
  const root = document.nodes.find(node => node.parent === null)
  const scene = build(root)
  if (modal) { scene.inert = true; scene.setAttribute('aria-hidden', 'true') }
  host.append(scene)
  let modalElement = null
  if (modal) {
    const backdrop = dom.createElement('div'); backdrop.className = 'preview-backdrop'; backdrop.dataset.previewBackdrop = 'true'; backdrop.setAttribute('aria-hidden', 'true')
    backdrop.addEventListener('click', event => { event.preventDefault(); event.stopPropagation() })
    const layer = dom.createElement('div'); layer.className = 'preview-modal-layer'
    modalElement = build(modal, true)
    const position = globalPosition(modal, byId)
    modalElement.style.left = `${position.x}px`; modalElement.style.top = `${position.y}px`; modalElement.style.opacity = String(position.opacity)
    layer.append(modalElement); host.append(backdrop, layer)
  }
  const keydown = event => {
    if (!modalElement) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismissModal(modal.id) }
    if (event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation()
      if (!focusable.length) { modalElement.focus(); return }
      const index = focusable.indexOf(dom.activeElement)
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length
      focusable[next].focus()
    }
  }
  host.addEventListener('keydown', keydown)
  previewMemory.set(host, { activeId: modal?.id ?? null, returnFocusId, keydown })
  if (modalElement && previous.activeId !== modal.id) modalElement.focus()
  else if (!modalElement && previous.activeId && previous.returnFocusId) elements.get(previous.returnFocusId)?.focus()
  else if (focusedId && elements.has(focusedId)) elements.get(focusedId).focus()
  return { elements, activeModalId: modal?.id ?? null }
}

function textElement(dom, tag, text, className) {
  const element = dom.createElement(tag); element.textContent = String(text ?? '')
  if (className) element.className = className
  return element
}
function hierarchy(document) {
  const children = new Map()
  for (const node of document.nodes) { const siblings = children.get(node.parent) ?? []; siblings.push(node); children.set(node.parent, siblings) }
  const ordered = []
  const visit = (parent, depth) => { const siblings = children.get(parent) ?? []; siblings.forEach((node, index) => { ordered.push({ node, depth, index, count: siblings.length, hasChildren: children.has(node.id) }); visit(node.id, depth + 1) }) }
  visit(null, 0); return ordered
}

/** Read only the same-origin parent's theme. No configuration or theme writes. */
export function connectHostTheme(browser, dom) {
  const root = dom.documentElement; const observers = []; const cleanups = []
  const tokens = ['--dsh-border', '--dsh-input-bg', '--dsh-code-bg', '--dsh-accent', '--dsh-success', '--dsh-warn', '--dsh-danger']
  const luminance = color => {
    const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color ?? '')
    return match ? (.2126 * Number(match[1]) + .7152 * Number(match[2]) + .0722 * Number(match[3])) / 255 : null
  }
  function sync() {
    try {
      if (browser.parent === browser) { root.removeAttribute('data-theme'); return }
      const parent = browser.parent; const parentDom = parent.document
      const sources = []
      let ancestor = browser.frameElement
      while (ancestor) { sources.push(ancestor); ancestor = ancestor.parentElement }
      sources.push(parentDom.body, parentDom.documentElement)
      let bg = ''; let fg = ''
      const styles = sources.filter(Boolean).map(element => parent.getComputedStyle(element))
      for (const style of styles) {
        if (!bg && style.backgroundColor && !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor)) bg = style.backgroundColor
        if (!fg && style.color) fg = style.color
      }
      for (const token of tokens) {
        const value = styles.map(style => style.getPropertyValue(token).trim()).find(Boolean)
        if (value) root.style.setProperty(token, value); else root.style.removeProperty(token)
      }
      const bgLum = luminance(bg); const fgLum = luminance(fg)
      const declared = parentDom.documentElement.dataset.theme ?? parent.getComputedStyle(parentDom.documentElement).colorScheme
      const light = declared === 'light' || (declared !== 'dark' && (bgLum !== null ? bgLum > .55 : fgLum !== null ? fgLum < .5 : !browser.matchMedia('(prefers-color-scheme: dark)').matches))
      root.dataset.theme = light ? 'light' : 'dark'
      if (bgLum !== null) root.style.setProperty('--wb-bg', bg)
      if (fgLum !== null && bgLum !== null && Math.abs(fgLum - bgLum) > .35) root.style.setProperty('--wb-fg', fg)
      else root.style.removeProperty('--wb-fg')
    } catch { /* Cross-origin embedding cannot read parent; use paired CSS fallback. */ }
  }
  sync()
  try {
    if (browser.parent !== browser && browser.MutationObserver) {
      const observer = new browser.MutationObserver(sync)
      for (const element of [browser.parent.document.documentElement, browser.parent.document.body]) if (element) observer.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] })
      observers.push(observer)
    }
  } catch { /* Theme access is optional, not an API readiness signal. */ }
  const media = browser.matchMedia?.('(prefers-color-scheme: dark)')
  media?.addEventListener?.('change', sync); cleanups.push(() => media?.removeEventListener?.('change', sync))
  return () => { for (const observer of observers) observer.disconnect(); for (const cleanup of cleanups) cleanup() }
}

export function mountWorkbench({ root, ui, browser = window, dom = document, fetchImpl = browser.fetch.bind(browser) }) {
  const element = id => root.querySelector(`#${id}`)
  const model = createWorkbenchModel({ ui, api: createUiApi(fetchImpl), confirmDiscard: message => browser.confirm(message) })
  const cleanups = [connectHostTheme(browser, dom)]
  let current = model.getState(); let treeSignature = ''; let workspaceSignature = ''; let previousSelection = ''; let previewSignature = ''; let previewToastTimer = null; let toastSignature = ''
  const listen = (target, name, listener) => { target.addEventListener(name, listener); cleanups.push(() => target.removeEventListener(name, listener)) }
  const setText = (id, text) => { element(id).textContent = String(text ?? '') }
  const value = (id, next) => { const input = element(id); if (dom.activeElement !== input || previousSelection !== current.selectedId) input.value = String(next ?? '') }
  const mutedError = id => element(id).removeAttribute('aria-invalid')
  function drawTree(state) {
    const key = signature({ nodes: state.document.nodes.map(node => [node.id, node.type, node.parent, node.props.visible]), selectedId: state.selectedId })
    if (key === treeSignature) return
    treeSignature = key
    const tree = element('node-tree'); const buttons = []
    const focusedTreeId = tree.contains(dom.activeElement) ? dom.activeElement?.dataset?.treeId : null
    const glyph = { panel: 'P', label: 'T', button: 'B', image: 'I', list: 'L', modal: 'M' }
    const rows = hierarchy(state.document).map(({ node, depth, index, count, hasChildren }) => {
      const button = dom.createElement('button'); button.type = 'button'; button.className = 'tree-item'
      button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(depth + 1)); button.setAttribute('aria-posinset', String(index + 1)); button.setAttribute('aria-setsize', String(count)); button.setAttribute('aria-selected', String(state.selectedId === node.id)); if (hasChildren) button.setAttribute('aria-expanded', 'true')
      button.tabIndex = state.selectedId === node.id ? 0 : -1; button.dataset.treeId = node.id; button.dataset.hidden = String(node.props.visible === false); button.style.paddingLeft = `${5 + Math.min(depth * 11, 44)}px`
      button.append(textElement(dom, 'span', glyph[node.type], 'tree-type'), textElement(dom, 'span', node.id, 'tree-item-name'))
      if (node.props.visible === false) button.append(textElement(dom, 'span', '隐藏', 'tree-hidden'))
      button.title = `${node.id} / ${node.type}`
      button.addEventListener('click', () => { model.selectNode(node.id); if (browser.matchMedia('(max-width: 900px)').matches) element('inspector-panel').open = true })
      button.addEventListener('keydown', event => {
        const position = buttons.indexOf(button); let next = position
        if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, position + 1)
        else if (event.key === 'ArrowUp') next = Math.max(0, position - 1)
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = buttons.length - 1
        else if (event.key === 'ArrowLeft' && node.parent) next = rows.findIndex(row => row.node.id === node.parent)
        else if (event.key === 'ArrowRight' && hasChildren) next = Math.min(buttons.length - 1, position + 1)
        else return
        event.preventDefault(); buttons[Math.max(0, next)].focus()
      })
      buttons.push(button); return { node, button }
    })
    tree.replaceChildren(...rows.map(row => row.button))
    if (focusedTreeId) rows.find(row => row.node.id === focusedTreeId)?.button.focus()
  }
  function drawWorkspaces(state) {
    const key = signature({ list: state.workspaces, id: state.workspaceId, error: state.workspacesError })
    if (key === workspaceSignature) return
    workspaceSignature = key
    const list = element('workspace-list')
    if (!state.workspaces.length) { list.replaceChildren(textElement(dom, 'p', state.workspacesError || '尚无已保存工作区。样例与导入不会自动落盘。', 'empty-state')); return }
    const rows = state.workspaces.map(workspace => {
      const row = dom.createElement('div'); row.setAttribute('role', 'listitem')
      const button = dom.createElement('button'); button.type = 'button'; button.className = 'workspace-item'; button.disabled = !safeId(workspace.workspaceId) || Boolean(workspace.error)
      button.setAttribute('aria-current', String(state.workspaceId === workspace.workspaceId))
      button.append(textElement(dom, 'span', workspace.name ?? workspace.workspaceId), textElement(dom, 'small', workspace.error ? `不可读取 · ${workspace.error}` : `${workspace.nodeCount ?? '—'} 节点 · ${workspace.revisionId ?? '未读取版本'}`))
      button.addEventListener('click', () => model.loadWorkspace(workspace.workspaceId)); row.append(button); return row
    })
    if (state.workspacesError) rows.unshift(textElement(dom, 'p', state.workspacesError, 'empty-state'))
    list.replaceChildren(...rows)
  }
  function drawProperties(state) {
    const node = state.document.nodes.find(node => node.id === state.selectedId) ?? state.document.nodes[0]
    const isText = ['label', 'button'].includes(node.type)
    value('node-id', node.id); value('node-parent', node.parent ?? '(根节点)'); setText('node-type', node.type)
    value('property-text', node.props.text ?? ''); element('property-text').disabled = !isText
    for (const [id, key] of [['property-x', 'x'], ['property-y', 'y'], ['property-width', 'width'], ['property-height', 'height']]) value(id, node.layout[key])
    element('property-width').disabled = node.parent === null; element('property-height').disabled = node.parent === null; element('root-size-hint').hidden = node.parent !== null
    value('property-font-size', node.props.fontSize ?? ''); element('property-font-size').disabled = !isText
    value('property-color', node.props.color ?? ''); element('property-color').disabled = !isText
    value('property-background', node.props.backgroundColor ?? ''); element('property-visible').checked = node.props.visible !== false
    const binding = state.document.bindings.find(binding => binding.node === node.id && binding.property === 'text')
    element('binding-hint').hidden = !binding
    setText('binding-hint', binding ? `预览文字由模板「${binding.template}」绑定。编辑文字只改静态回退，不改状态模板。` : '')
    if (previousSelection !== state.selectedId) for (const id of ['property-text', 'property-x', 'property-y', 'property-width', 'property-height', 'property-font-size', 'property-color', 'property-background']) mutedError(id)
    previousSelection = state.selectedId
    setText('selection-info', `${node.id} · ${node.type} · 相对 ${node.parent ?? '设计画布'}`)
  }
  function drawReports(state) {
    setText('structure-state', state.report ? (state.report.ok ? '结构有效 · 非 native' : '结构未通过') : (state.localValidation.ok ? '本地结构有效' : '本地结构未通过'))
    const plan = state.plan
    setText('plan-state', plan ? (plan.ready ? (state.dirty ? 'ready · 待保存' : 'ready · 仅审阅包') : `blocked · ${plan.blockers?.length ?? 0} 项`) : (!state.target.projectDirectory.trim() || !state.target.fontSizeMethod ? '待选目标 / 字号' : '未预检 / 已失效'))
    const report = element('plan-report'); report.replaceChildren()
    if (plan) {
      if (plan.ready) report.append(textElement(dom, 'p', state.dirty ? '当前草稿预检通过；保存后需重新预检。' : '仅允许生成新 staged 审阅包。native 未执行。', 'plan-ready'))
      const list = dom.createElement('ul')
      for (const [kind, items] of [['blocker', plan.blockers ?? []], ['warning', plan.warnings ?? []]]) for (const item of items) {
        const entry = textElement(dom, 'li', typeof item === 'string' ? item : `${item?.code ?? kind} · ${item?.message ?? '详见报告'}`); entry.dataset.kind = kind; list.append(entry)
      }
      if (list.children.length) report.append(list)
    }
    setText('report-json', JSON.stringify({ localStructure: state.localValidation, serverStructure: state.report, makerPreflight: state.plan, nativeAcceptance: 'not-run' }, null, 2))
    const result = element('export-result'); result.hidden = !state.exported
    if (!state.exported) { setText('package-state', '未生成'); return }
    const exported = state.exported
    const same = exported.workspaceId === state.workspaceId && exported.revisionId === state.revisionId && !state.dirty && exported.projectDirectory === state.target.projectDirectory.trim() && exported.options.fontSizeMethod === state.target.fontSizeMethod
    setText('package-state', same ? 'staged · 当前版本' : 'staged · 旧快照')
    result.replaceChildren(textElement(dom, 'strong', '已生成 staged 审阅包 · 未 native 验收'), textElement(dom, 'span', `保存版本：${exported.revisionId}`), textElement(dom, 'code', exported.directory ?? '接口未返回目录'), textElement(dom, 'span', '只写入 UI 工作区的新审阅目录；不覆盖素材、不导入游戏、不改入口、不构建。'))
    const files = dom.createElement('ul')
    for (const file of exported.files ?? []) files.append(textElement(dom, 'li', typeof file === 'string' ? file : file?.path ?? file?.file ?? file?.name ?? '审阅文件'))
    result.append(files)
  }
  function fitPreview() {
    const area = element('stage-area'); const frame = element('viewport-frame'); const host = element('preview-host')
    const preset = VIEWPORT_PRESETS.find(preset => preset.id === element('viewport-preset').value) ?? VIEWPORT_PRESETS[0]
    const style = browser.getComputedStyle(area)
    const width = area.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
    const height = area.clientHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0')
    const fit = fitStage(current.document.design, preset, { width, height })
    if (!fit) return
    frame.style.width = `${fit.viewportWidth}px`; frame.style.height = `${fit.viewportHeight}px`
    host.style.width = `${current.document.design.width}px`; host.style.height = `${current.document.design.height}px`; host.style.left = `${fit.x}px`; host.style.top = `${fit.y}px`; host.style.transform = `scale(${fit.scale})`
    setText('viewport-info', `${preset.width} × ${preset.height} · contain ${Math.round(fit.scale * 100)}% · 不重排布局`)
    const overlay = element('safe-area-overlay'); overlay.hidden = !element('safe-area').checked
    const insets = preset.id === '390x844' ? { top: 44, bottom: 34, left: 16, right: 16 } : preset.id === '844x390' ? { top: 16, bottom: 16, left: 44, right: 44 } : { top: 24, bottom: 24, left: 24, right: 24 }
    overlay.style.left = `${insets.left * fit.viewportScale}px`; overlay.style.top = `${insets.top * fit.viewportScale}px`; overlay.style.width = `${(preset.width - insets.left - insets.right) * fit.viewportScale}px`; overlay.style.height = `${(preset.height - insets.top - insets.bottom) * fit.viewportScale}px`
  }
  function render(state) {
    current = state
    value('document-name', state.document.name); value('maker-project', state.target.projectDirectory); value('font-size-method', state.target.fontSizeMethod)
    setText('preview-title', state.document.name); setText('draft-status', state.dirty ? '未保存草稿' : '已保存版本'); element('draft-status').dataset.dirty = String(state.dirty)
    setText('revision-id', state.revisionId ?? '尚未保存'); element('revision-id').title = state.directory ?? ''
    setText('node-count', state.document.nodes.length); setText('design-info', `${state.document.design.width} × ${state.document.design.height} / ${state.document.design.orientation}`)
    setText('workspace-root', state.status?.root ?? (state.statusError ? '状态接口不可用；未猜测落点。' : '等待同源状态接口…'))
    element('workspace-root').title = state.status?.root ?? ''
    const audit = state.status?.sourceAudit
    setText('source-audit', audit ? (audit.ok === true ? `${audit.license ?? '许可'} · 固定来源已核验` : '来源审计未通过') : '来源审计未读取')
    element('source-audit').closest('details').dataset.ok = audit ? String(audit.ok === true) : ''
    setText('source-commit', audit?.commit ?? '未读取'); setText('source-license', audit?.license ?? '未读取'); setText('source-parser', audit?.parser ?? '未读取')
    const maker = state.status?.maker
    setText('maker-availability', !maker ? '宿主 Maker 能力未读取；可用性不是 native 验收。' : maker.available === true ? '宿主报告 Maker 能力可用；尚未启动引擎或 native 验收。' : maker.available === false ? '宿主报告 Maker 能力未就绪；未启动或替换任何 preview。' : '宿主能力信息已返回；可用性只用于预检，不等于 native 完成。')
    setText('boot-error', state.statusError ? `状态接口不可用：${state.statusError} 浏览器样例仍可编辑，但不能据此声称宿主已接入或 native 已验收。` : '')
    element('boot-error').hidden = !state.statusError
    setText('global-error', state.error); element('global-error').hidden = !state.error
    element('conflict-actions').hidden = !state.conflict
    setText('notice', state.notice); element('notice').dataset.kind = state.noticeKind
    const writing = state.busy.includes('save') || state.busy.includes('export'); const loading = state.busy.includes('load')
    for (const id of ['new-demo', 'import-json', 'save-workspace', 'save-as-new', 'reload-workspace']) element(id).disabled = writing || loading
    element('save-workspace').disabled = writing || loading || (!state.dirty && state.workspaceId !== null)
    element('save-workspace').title = state.workspaceId ? '以 baseRevision 保存新版本，旧版不覆盖' : '显式创建新工作区与首个保存版本'
    element('check-document').disabled = state.busy.includes('check'); element('plan-export').disabled = state.busy.includes('plan') || writing || loading; element('export-review').disabled = !model.canExport()
    element('refresh-workspaces').disabled = state.busy.includes('status') || state.busy.includes('workspaces')
    element('mode-edit').setAttribute('aria-pressed', String(state.mode === 'edit')); element('mode-interact').setAttribute('aria-pressed', String(state.mode === 'interact'))
    setText('mode-hint', state.mode === 'edit' ? '编辑模式：点击画布选节点；不会执行按钮动作。' : '交互模式：按钮执行有限动作。自定义弹窗遮挡背景；Escape 关闭（仅浏览器模拟）。')
    drawTree(state); drawWorkspaces(state); drawProperties(state); drawReports(state)
    const nextPreviewSignature = signature({ document: state.document, state: state.previewState, visibility: state.visibility, mode: state.mode, selectedId: state.selectedId })
    if (nextPreviewSignature !== previewSignature) {
      previewSignature = nextPreviewSignature
      renderUiPreview(element('preview-host'), state, { ui, dom, onSelect: id => { model.selectNode(id); if (browser.matchMedia('(max-width: 900px)').matches) element('inspector-panel').open = true }, onAction: id => model.clickNode(id), onDismissModal: id => model.closeModal(id) })
    }
    setText('preview-toast', state.previewToast); element('preview-toast').hidden = !state.previewToast
    const nextToastSignature = `${state.previewToast}:${JSON.stringify(state.previewState)}`
    if (nextToastSignature !== toastSignature) {
      toastSignature = nextToastSignature
      if (previewToastTimer !== null) browser.clearTimeout(previewToastTimer)
      if (state.previewToast) previewToastTimer = browser.setTimeout(() => model.clearPreviewToast(), 3000)
    }
    fitPreview()
  }
  listen(element('property-form'), 'submit', event => event.preventDefault())
  function patchProperty(id, key, { type = 'string', event = 'change' } = {}) {
    listen(element(id), event, () => {
      const input = element(id)
      const next = type === 'number' ? (input.value === '' && key === 'fontSize' ? '' : input.value === '' ? NaN : Number(input.value)) : type === 'boolean' ? input.checked : input.value
      const applied = model.updateNode(model.getState().selectedId, { [key]: next })
      if (applied) mutedError(id); else input.setAttribute('aria-invalid', 'true')
    })
  }
  patchProperty('property-text', 'text', { event: 'input' })
  for (const [id, key] of [['property-x', 'x'], ['property-y', 'y'], ['property-width', 'width'], ['property-height', 'height'], ['property-font-size', 'fontSize']]) patchProperty(id, key, { type: 'number' })
  patchProperty('property-color', 'color'); patchProperty('property-background', 'backgroundColor'); patchProperty('property-visible', 'visible', { type: 'boolean' })
  listen(element('document-name'), 'input', () => { if (model.rename(element('document-name').value)) mutedError('document-name'); else element('document-name').setAttribute('aria-invalid', 'true') })
  listen(element('maker-project'), 'input', () => { if (model.setTarget({ projectDirectory: element('maker-project').value })) mutedError('maker-project'); else element('maker-project').setAttribute('aria-invalid', 'true') })
  listen(element('font-size-method'), 'change', () => model.setTarget({ fontSizeMethod: element('font-size-method').value }))
  listen(element('new-demo'), 'click', () => model.newDemo())
  listen(element('save-workspace'), 'click', () => model.save())
  listen(element('save-as-new'), 'click', () => model.save({ asNew: true }))
  listen(element('reload-workspace'), 'click', () => { const state = model.getState(); if (state.workspaceId) model.loadWorkspace(state.workspaceId) })
  listen(element('check-document'), 'click', () => model.checkDocument())
  listen(element('plan-export'), 'click', () => model.planExport())
  listen(element('export-review'), 'click', () => model.exportReview())
  listen(element('refresh-workspaces'), 'click', () => model.initialize())
  listen(element('mode-edit'), 'click', () => model.setMode('edit'))
  listen(element('mode-interact'), 'click', () => model.setMode('interact'))
  listen(element('viewport-preset'), 'change', fitPreview); listen(element('safe-area'), 'change', fitPreview)
  listen(element('import-json'), 'click', () => element('json-file').click())
  listen(element('json-file'), 'change', () => {
    const input = element('json-file'); const file = input.files?.[0]
    if (!file) return
    const fileInfo = { name: file.name, size: file.size, type: file.type }
    if (!/\.json$/i.test(file.name) || file.size > (ui.UI_LIMITS?.bytes ?? 1_000_000)) { model.reportError(new Error('仅接受不超过 1 MB 的本地 .json 文件；没有读取服务器路径。')); input.value = ''; return }
    const reader = new browser.FileReader()
    reader.addEventListener('load', () => model.importJson(String(reader.result ?? ''), fileInfo))
    reader.addEventListener('error', () => model.reportError(new Error('本地 FileReader 读取失败；当前草稿已保留。')))
    reader.readAsText(file, 'utf-8'); input.value = ''
  })
  listen(element('download-json'), 'click', () => {
    try {
      const download = model.toJsonDownload(); const url = browser.URL.createObjectURL(new browser.Blob([download.contents], { type: 'application/json;charset=utf-8' }))
      const anchor = dom.createElement('a'); anchor.href = url; anchor.download = download.filename; anchor.rel = 'noopener'; anchor.click()
      browser.setTimeout(() => browser.URL.revokeObjectURL(url), 1000)
    } catch (error) { model.reportError(error) }
  })
  const beforeUnload = event => { if (model.getState().dirty) { event.preventDefault(); event.returnValue = '' } }
  listen(browser, 'beforeunload', beforeUnload)
  listen(dom, 'keydown', event => { if (event.key === 'Escape' && model.closeModal()) { event.preventDefault(); event.stopPropagation() } })
  const narrow = browser.matchMedia('(max-width: 900px)')
  const foldPanels = () => { element('workspace-panel').open = !narrow.matches; element('inspector-panel').open = !narrow.matches; fitPreview() }
  narrow.addEventListener('change', foldPanels); cleanups.push(() => narrow.removeEventListener('change', foldPanels))
  foldPanels()
  if (browser.ResizeObserver) { const observer = new browser.ResizeObserver(fitPreview); observer.observe(element('stage-area')); cleanups.push(() => observer.disconnect()) }
  else listen(browser, 'resize', fitPreview)
  cleanups.push(model.subscribe(render))
  model.initialize()
  return { model, dispose() { if (previewToastTimer !== null) browser.clearTimeout(previewToastTimer); for (const cleanup of cleanups) cleanup() } }
}

export async function bootstrapWorkbench({ browser = window, dom = document } = {}) {
  const root = dom.getElementById('ui-workbench')
  if (!root) return null
  try {
    const ui = await import(`${API_BASE}/document.mjs`)
    return mountWorkbench({ root, ui, browser, dom })
  } catch (error) {
    const banner = dom.getElementById('boot-error'); banner.hidden = false; banner.textContent = `工作台模块未启动：${errorText(error)}。没有保存、导出、启动引擎或执行生成。`
    return null
  }
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') bootstrapWorkbench()
