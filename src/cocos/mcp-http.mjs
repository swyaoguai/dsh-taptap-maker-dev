/**
 * 极简 MCP「Streamable HTTP」客户端 —— 只实现我们真正会用的三个方法：
 * `initialize` / `tools/list` / `tools/call`，外加通知。
 *
 * 为什么不直接引 MCP SDK：这个插件是零依赖分发（`files` 里只有源码），
 * 多一个 SDK 就等于多一份要跟着升级、要审计的第三方代码；而这里需要的
 * 协议面小到可以一眼看完 —— POST 一个 JSON-RPC，拿回 JSON 或 SSE。
 *
 * 兼容性要点（都是实测/上游源码确认过的）：
 *  - **Accept 必须带上 `text/event-stream`**：Funplay 的编辑器内服务会严格校验，
 *    缺了直接 406；返回既可能是普通 JSON，也可能是 SSE 流。
 *  - **会话 id 是可选的**：`enableSessions: false`（默认）时服务端不返回
 *    `Mcp-Session-Id`，我们也就不能凭空造一个头出来。
 *  - **`202 Accepted` 是正常响应**：通知类请求没有 body。
 *  - **身份信息在 `initialize` 的 `funplay.context` 里**：`project_id`、
 *    `project_path`、`expected_context`。写操作必须带上 `expected_context`，
 *    或者用 `/mcp/project/<project_id>/` 这种绑定项目的 URL —— 两者都做，
 *    才能保证「这一枪打在正确的工程上」。
 *
 * @module src/cocos/mcp-http.mjs
 */
import { normalizeProjectPath, stripTrailingSep, sameProjectPath } from './paths.mjs'

export class CocosMcpError extends Error {
  constructor(message, { code = null, data = null, status = null } = {}) {
    super(message)
    this.name = 'CocosMcpError'
    this.code = code
    this.data = data
    this.status = status
  }
}

/** 从 SSE 文本里取出 id 匹配的那条 JSON-RPC 响应。 */
/**
 * JSON-RPC id 是否相同。
 *
 * 不能直接用 `===`：id 允许是数字或字符串，上游把我们的 `1` 回成 `"1"`
 * 是合法的；严格比较会「匹配不到」→ 返回 null → 上层把空结果当成功。
 */
function sameId(a, b) {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  const stringish = (value) => typeof value === 'string' || typeof value === 'number'
  if (!stringish(a) || !stringish(b)) return false
  return String(a) === String(b)
}

function pickSseResponse(text, id) {
  const events = text.split(/\r?\n\r?\n/)
  const seenIds = []
  for (const event of events) {
    const dataLines = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (dataLines.length === 0) continue
    const payload = dataLines.join('\n')
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    if (parsed.id !== undefined) seenIds.push(parsed.id)
    if (sameId(parsed.id, id)) return parsed
  }
  // ⚠️ 不能「没匹配到就返回最后一条」：SSE 流里可能夹着服务端的
  // notifications/*，或者并发请求的响应；把别人的结果当成本次结果返回，
  // 上层会拿着错的 content 去写场景。
  // 但也**不能静默返回 null**：流里明明有响应却不是给我们的，说明协议层出问题了
  // （id 类型、多路复用、上游实现 bug），上层会把空结果当成功。
  throw new CocosMcpError(
    `Cocos MCP 的 SSE 响应里没有本次请求的 id（期望 ${JSON.stringify(id)}，流里看到 ${JSON.stringify(seenIds)}）。`
    + '通常是上游把 id 换了类型或复用了连接；重试一次，仍失败就用 cocos_exec 兜底。',
    { code: 'MISMATCHED_RESPONSE' },
  )
}

export class McpHttpClient {
  /**
   * @param {string} endpoint 允许带或不带尾部斜杠
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.protocolVersion]
   */
  constructor(endpoint, opts = {}) {
    this.base = String(endpoint).replace(/\/+$/, '')
    this.timeoutMs = Number(opts.timeoutMs) || 20000
    this.protocolVersion = opts.protocolVersion || null
    this.sessionId = opts.sessionId || null
    this.nextId = 1
    this.funplay = null
    this.serverInfo = null
    this.routingVersion = null
  }

  /** 用于展示/日志的端点字符串。 */
  get endpoint() {
    return this.base
  }

  async #post(body, { timeoutMs = this.timeoutMs, signal = null } = {}) {
    const url = this.base === '' ? '' : `${this.base}/`
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId

    const controller = new AbortController()
    // 区分「超时」与「调用方取消」：两者都会 abort，但错误码完全不同 ——
    // 把用户取消报成 TIMEOUT 会让人以为编辑器卡了。
    let abortedByCaller = false
    const onCallerAbort = () => { abortedByCaller = true; controller.abort() }
    if (signal !== null && signal !== undefined) {
      if (signal.aborted) onCallerAbort()
      else signal.addEventListener?.('abort', onCallerAbort, { once: true })
    }
    // 超时必须**连读 body 一起覆盖**：只给 fetch() 挂 abort，服务端也可能
    // 先把响应头吐回来、body 一直不结束（SSE 尤其容易），那样调用会永久挂着。
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (error?.name === 'AbortError') {
          if (abortedByCaller) throw new CocosMcpError('Cocos MCP 调用已被取消', { code: 'CANCELLED' })
          throw new CocosMcpError(`Cocos MCP 请求超时（${timeoutMs}ms）：${url}`, { code: 'TIMEOUT' })
        }
        throw new CocosMcpError(`连不上 Cocos MCP（${url}）：${error?.message ?? error}`, { code: 'UNREACHABLE' })
      }

      const sid = response.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
      const negotiated = response.headers.get('mcp-protocol-version')
      if (negotiated) this.protocolVersion = negotiated

      if (response.status === 202) return null

      const contentType = String(response.headers.get('content-type') || '')
      let text
      try {
        text = await response.text()
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new CocosMcpError(`Cocos MCP 响应读取超时（${timeoutMs}ms）：${url}`, { code: 'TIMEOUT' })
        }
        throw new CocosMcpError(`读取 Cocos MCP 响应失败：${error?.message ?? error}`, { code: 'BAD_BODY' })
      }

      if (!response.ok) {
        throw new CocosMcpError(`Cocos MCP HTTP ${response.status}：${text.slice(0, 400) || '(no body)'}`, {
          status: response.status,
          code: `HTTP_${response.status}`,
        })
      }
      if (text.trim() === '') return null
      if (contentType.includes('text/event-stream')) {
        return pickSseResponse(text, body.id)
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new CocosMcpError(`Cocos MCP 返回了非 JSON 内容：${text.slice(0, 200)}`, { code: 'BAD_BODY' })
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onCallerAbort)
    }
  }

  async #rpc(method, params, opts = {}) {
    const id = this.nextId
    this.nextId += 1
    const envelope = await this.#post({ jsonrpc: '2.0', id, method, params }, opts)
    if (envelope === null) return null
    if (envelope.error) {
      const message = envelope.error.message || 'MCP error'
      throw new CocosMcpError(`Cocos MCP ${method} 失败：${message}`, {
        code: envelope.error.code ?? null,
        data: envelope.error.data ?? null,
      })
    }
    return envelope.result ?? null
  }

  async #notify(method, params) {
    try {
      await this.#post({ jsonrpc: '2.0', method, params })
    } catch {
      // 通知失败不影响主流程（有些实现直接回 404/405）。
    }
  }

  /**
   * 握手并缓存身份信息。返回 `{serverInfo, funplay}`。
   *
   * `opts.signal` 可取消：握手是「编辑器卡住时最久的一次等待」，
   * 用户按停止后不该继续等到超时。
   */
  async initialize({ signal = null } = {}) {
    const result = await this.#rpc('initialize', {
      protocolVersion: this.protocolVersion || '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'dsh-game-forge-cocos', version: '1.0.0' },
    }, { signal })
    this.serverInfo = result?.serverInfo ?? null
    this.funplay = result?.funplay ?? null
    this.routingVersion = this.funplay?.routingVersion ?? null
    if (result?.protocolVersion) this.protocolVersion = result.protocolVersion
    await this.#notify('notifications/initialized', {})
    return { serverInfo: this.serverInfo, funplay: this.funplay }
  }

  /** 从握手结果里抽出项目身份。 */
  identity() {
    const context = this.funplay?.context ?? {}
    return {
      projectId: String(context.project_id ?? this.funplay?.projectIdentity ?? ''),
      instanceId: String(context.instance_id ?? ''),
      projectPath: String(context.project_path ?? ''),
      expectedContext: String(context.expected_context ?? ''),
      projectName: String(this.funplay?.projectName ?? ''),
      serverName: String(this.serverInfo?.name ?? ''),
      serverVersion: String(this.serverInfo?.version ?? ''),
    }
  }

  /** `tools/list`，返回原始工具数组。 */
  /**
   * 列出上游工具。
   *
   * MCP 允许分页（`nextCursor`）。只取第一页的实现看起来「能用」，但只要上游
   * 的工具多到翻页，后面的工具就永远看不到 —— 表现为「明明装了 full 档，
   * 却报某个工具不存在」，而错误提示还会让人去切档位，越查越偏。
   */
  async toolsList({ maxPages = 20 } = {}) {
    const all = []
    let cursor = null
    for (let page = 0; page < maxPages; page += 1) {
      const params = cursor === null ? {} : { cursor }
      const result = await this.#rpc('tools/list', params)
      const tools = Array.isArray(result?.tools) ? result.tools : []
      all.push(...tools)
      const next = result?.nextCursor
      if (typeof next !== 'string' || next === '' || next === cursor) break
      cursor = next
    }
    return all
  }

  /**
   * `tools/call`。
   *
   * @param {string} name
   * @param {object} args
   * @param {{expectedContext?: string, timeoutMs?: number}} [opts]
   */
  async toolsCall(name, args = {}, opts = {}) {
    const payload = { ...args }
    // 写操作要带身份令牌；上游会把同名参数删掉，不会污染工具自己的参数。
    if (opts.expectedContext) payload.expected_context = opts.expectedContext
    const result = await this.#rpc('tools/call', { name, arguments: payload }, {
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      signal: opts.signal ?? null,
    })
    // MCP 的「工具执行失败」不是 JSON-RPC error，而是 `result.isError = true`
    // 加一段解释性 content。不在这里拦住，上层会把错误文案当成正常结果，
    // agent 就会以为「场景已经改好了」。
    if (result !== null && typeof result === 'object' && result.isError === true) {
      const text = (Array.isArray(result.content) ? result.content : [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      throw new CocosMcpError(`Cocos 工具 ${name} 执行失败：${text || '(上游没有给出原因)'}`, {
        code: 'UPSTREAM_TOOL_ERROR',
        data: result,
      })
    }
    return result
  }
}

/**
 * 用 `/health` 快速探一个端口是不是 Cocos MCP。
 *
 * 返回 `null` 表示「不是」；返回对象表示命中了（含身份信息）。
 * 只做 GET，不改任何状态，适合在发现阶段批量扫。
 */
export async function probeHealth(port, { timeoutMs = 900, host = '127.0.0.1' } = {}) {
  const url = `http://${host}:${port}/health`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const body = await response.json()
    if (body === null || typeof body !== 'object') return null
    const context = body.context ?? {}
    return {
      port,
      url,
      ok: true,
      name: String(body.name ?? ''),
      version: String(body.version ?? ''),
      projectName: String(body.projectName ?? ''),
      projectId: String(body.projectIdentity ?? context.project_id ?? ''),
      instanceId: String(context.instance_id ?? ''),
      projectPath: String(context.project_path ?? ''),
      expectedContext: String(context.expected_context ?? ''),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** `/health` 的身份是否指向给定项目路径。 */
export function healthMatchesProject(health, projectPath) {
  if (!health || !health.projectPath) return false
  return sameProjectPath(health.projectPath, projectPath)
}

/** 把身份里的路径规整成一个可比较的绝对路径（探测不到就返回空串）。 */
export function healthProjectPath(health) {
  const value = health?.projectPath
  if (typeof value !== 'string' || value === '') return ''
  return normalizeProjectPath(stripTrailingSep(value))
}
