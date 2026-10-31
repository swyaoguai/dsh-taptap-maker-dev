/** Same-origin UI routes mounted UNDER the plugin's existing host prefix.
 * No new server, broad file endpoint, model/channel setting or generation tool. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUiWorkspace, readUiWorkspace, saveUiRevision, listUiWorkspaces, verifyLguiVendor, UiWorkflowError } from './ui-workflow.mjs'
import { validateUiDocument, UI_LIMITS } from './ui-document.mjs'

export const UI_API_PREFIX = '/api/taptap-maker-dev/ui'
const SRC = path.dirname(fileURLToPath(import.meta.url))
const MAX_BODY = 2_000_000
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const STATIC_FILES = new Map([
  ['workbench', ['ui-workbench.html', 'text/html; charset=utf-8']],
  ['workbench.css', ['ui-workbench.css', 'text/css; charset=utf-8']],
  ['workbench.mjs', ['ui-workbench.mjs', 'text/javascript; charset=utf-8']],
  ['document.mjs', ['ui-document.mjs', 'text/javascript; charset=utf-8']],
])
const fail = (code, message) => { throw new UiWorkflowError(code, message) }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && ID.test(value) && !['constructor', 'prototype', '__proto__'].includes(value)
function json(res, status, value, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra })
  res.end(JSON.stringify(value))
}
function requestOrigin(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || /[\s\\/@]/.test(host)) fail('UI_ORIGIN', 'UI 工作台仅接受可信本地 GUI Host。')
  let origin
  try { origin = new URL(`${req.socket?.encrypted ? 'https' : 'http'}://${host}`) } catch { fail('UI_ORIGIN', '无效的本地 GUI Host。') }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) fail('UI_ORIGIN', 'UI 工作台仅开放给本机 GUI，不接受任意域名的 DNS 回绑定。')
  const supplied = req.headers.origin
  if (supplied !== undefined) {
    let parsed
    try { parsed = new URL(supplied) } catch { fail('UI_ORIGIN', '不接受 null 或无效 Origin。') }
    if (parsed.origin !== origin.origin) fail('UI_ORIGIN', '跨站请求不能访问本地 UI 文档。')
  }
  const site = req.headers['sec-fetch-site']
  if (site && !['same-origin', 'none'].includes(site)) fail('UI_ORIGIN', '跨站请求不能访问本地 UI 文档。')
  return origin.origin
}
function fields(value, allowed) {
  if (!object(value)) fail('UI_REQUEST', '请求必须为 JSON 对象。')
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('UI_REQUEST', `不支持的请求字段：${key}。`)
  return value
}
function options(value = {}) {
  fields(value, ['fontSizeMethod', 'fontScale'])
  return value
}
function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail('UI_CONTENT_TYPE', 'UI 写入请求必须使用 application/json。')
  const length = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(length) && length > MAX_BODY) fail('UI_BODY_LIMIT', 'UI 请求体超过 2 MB 上限。')
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let settled = false
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY) { settled = true; chunks.length = 0; reject(new UiWorkflowError('UI_BODY_LIMIT', 'UI 请求体超过 2 MB 上限。')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new UiWorkflowError('UI_JSON', '请求 JSON 无法解析。')) }
    })
    req.on('error', () => { if (!settled) { settled = true; reject(new UiWorkflowError('UI_REQUEST', '请求被中断，未自动重试。')) } })
  })
}
export function getUiStatus(root) {
  return {
    ok: true, root: path.resolve(root), workspaces: listUiWorkspaces(root), sourceAudit: verifyLguiVendor(), limits: UI_LIMITS,
    maker: { available: fs.existsSync(path.join(SRC, 'ui-maker-export.mjs')), targetSelected: false, exportMode: 'staged-review-only', nativeVerified: false, reason: '需要用户明确指定真实 Maker 工程；本接口不安装、导入或运行游戏。' },
    states: { structure: 'check-required', browserPreview: 'supported', editor: 'not-tested', native: 'not-tested', metadata: 'pending-official-generator' },
  }
}
export function createUiHttpHandler({ root, nativeExporter, logger } = {}) {
  if (typeof root !== 'string' || !root.trim()) fail('UI_ROOT', '需要明确的隔离 UI 工作区根目录。')
  const getNative = async () => nativeExporter ?? await import('./ui-maker-export.mjs')
  return async (req, res) => {
    try {
      requestOrigin(req)
      const url = new URL(req.url, 'http://localhost')
      if (!(url.pathname === UI_API_PREFIX || url.pathname.startsWith(UI_API_PREFIX + '/'))) return json(res, 404, { ok: false, code: 'UI_ROUTE', error: 'not found' })
      const route = url.pathname.slice(UI_API_PREFIX.length).replace(/^\/+|\/+$/g, '')
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) return json(res, 405, { ok: false, code: 'UI_METHOD', error: '本工作流没有删除、覆盖、构建或提交接口。' }, { Allow: 'GET, HEAD, POST' })
      if (['GET', 'HEAD'].includes(req.method) && STATIC_FILES.has(route)) {
        const [name, mime] = STATIC_FILES.get(route)
        const bytes = fs.readFileSync(path.join(SRC, name))
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' })
        res.end(req.method === 'HEAD' ? undefined : bytes)
        return
      }
      if (req.method === 'GET' && (route === 'status' || route === '')) return json(res, 200, getUiStatus(root))
      if (req.method === 'GET' && route === 'workspaces') return json(res, 200, { ok: true, workspaces: listUiWorkspaces(root) })
      const workspaceRoute = /^workspaces\/([^/]+)(?:\/(revisions))?$/.exec(route)
      if (workspaceRoute && !validId(workspaceRoute[1])) fail('UI_PATH', '无效的 UI 工作区 ID。')
      const revision = url.searchParams.get('revision') ?? undefined
      if (revision !== undefined && !validId(revision)) fail('UI_PATH', '无效的 UI revision ID。')
      if (req.method === 'GET' && workspaceRoute && !workspaceRoute[2]) return json(res, 200, { ok: true, ...readUiWorkspace(root, workspaceRoute[1], revision) })
      if (req.method !== 'POST') return json(res, 404, { ok: false, code: 'UI_ROUTE', error: 'not found' })
      const body = await readBody(req)
      if (route === 'workspaces') {
        fields(body, ['name', 'document'])
        return json(res, 201, { ok: true, ...createUiWorkspace(root, body) })
      }
      if (workspaceRoute?.[2] === 'revisions') {
        fields(body, ['document', 'baseRevision'])
        return json(res, 201, { ok: true, ...saveUiRevision(root, workspaceRoute[1], body.document, { baseRevision: body.baseRevision }) })
      }
      if (route === 'check') {
        fields(body, ['document'])
        return json(res, 200, validateUiDocument(body.document))
      }
      if (route === 'plan') {
        fields(body, ['document', 'projectDirectory', 'options', 'workspaceId', 'revisionId'])
        const opts = options(body.options)
        if (body.workspaceId !== undefined) {
          if (!validId(body.workspaceId) || (body.revisionId !== undefined && !validId(body.revisionId))) fail('UI_PATH', '预检必须使用明确工作区和 revision ID。')
          opts.assetRoot = readUiWorkspace(root, body.workspaceId, body.revisionId).directory
        }
        const adapter = await getNative()
        return json(res, 200, adapter.planMakerExport(body.document, body.projectDirectory, opts))
      }
      if (route === 'export') {
        fields(body, ['workspaceId', 'revisionId', 'projectDirectory', 'options'])
        if (!validId(body.workspaceId) || !validId(body.revisionId)) fail('UI_PATH', '导出审阅包必须使用已保存工作区和 revision ID。')
        const adapter = await getNative()
        return json(res, 201, adapter.createMakerReview(root, body.workspaceId, body.revisionId, body.projectDirectory, options(body.options)))
      }
      return json(res, 404, { ok: false, code: 'UI_ROUTE', error: 'not found' })
    } catch (error) {
      const status = error.code === 'UI_ORIGIN' ? 403 : error.code === 'UI_CONTENT_TYPE' ? 415 : error.code === 'UI_BODY_LIMIT' ? 413 : error.code === 'UI_REVISION_CONFLICT' || error.code === 'UI_EXISTS' ? 409 : error.code === 'UI_DOCUMENT' || error.code === 'UI_EXPORT_BLOCKED' ? 422 : error.code === 'ENOENT' ? 404 : error instanceof UiWorkflowError ? 400 : 500
      if (status === 500) logger?.warn?.(`UI route unavailable: ${error.code ?? error.name}`)
      return json(res, status, { ok: false, code: error.code ?? 'UI_INTERNAL', error: error instanceof UiWorkflowError ? error.message : status === 404 ? '工作区或文件不存在。' : 'UI 文件操作未完成，未覆盖旧版或自动重试。', details: error.details }, status === 413 ? { Connection: 'close' } : {})
    }
  }
}
