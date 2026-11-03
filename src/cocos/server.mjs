#!/usr/bin/env node
/**
 * `cocos` MCP 服务（stdio）—— 插件暴露给 agent 的唯一入口。
 *
 * 为什么是「一个服务 + project 参数」，而不是「每个项目一个服务」：
 *  - DSH 的 MCP 客户端用 `serverName` 做命名空间，同一个作用域里重名会加载失败；
 *    项目一多就得反复改配置并重启。
 *  - 每个服务都会把自己全部工具的 schema 塞进每次请求；三个项目 = 三倍 token。
 *  - 项目是动态的（随时开关），端口也是动态的；把它们做成「配置」等于给自己找麻烦。
 *
 * 协议面：MCP stdio（NDJSON，兼容 Content-Length 帧）；
 * 只实现 tools / resources / prompts 里我们真正提供的那部分。
 *
 * @module src/cocos/server.mjs
 */
import readline from 'node:readline'
import { TOOL_INDEX, toolSchemas } from './tools.mjs'
import { projectOverview } from './router.mjs'
import { resolveDshHome } from '../paths.js'
import { clipText, errorText } from './util.mjs'

const SERVER_INFO = { name: 'cocos', version: '1.0.0' }
const DEFAULT_PROTOCOL = '2026-07-28'
const SUPPORTED_PROTOCOLS = ['2026-07-28', '2025-06-18', '2025-03-26']

function parseArgs(argv) {
  const out = { home: '', buildSlots: 1 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home' && argv[i + 1]) out.home = argv[++i]
    else if (arg === '--build-slots' && argv[i + 1]) out.buildSlots = Math.max(1, Number(argv[++i]) || 1)
  }
  return out
}

const cliArgs = parseArgs(process.argv.slice(2))
const dshHome = resolveDshHome(cliArgs.home || process.env.DSH_HOME)
const config = { buildSlots: cliArgs.buildSlots }

/** 会话标识：同一 DSH 进程里的多个会话共用一个 server 进程时，用来区分锁的持有者。 */
const sessionId = String(process.env.DSH_SESSION_ID || '')

function log(message) {
  try {
    process.stderr.write(`[cocos-mcp] ${message}\n`)
  } catch { /* stderr 关了就算了 */ }
}

function send(payload) {
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  } catch (error) {
    log(`写响应失败：${errorText(error)}`)
  }
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function rpcError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

/** 工具结果：文本内容 + 结构化副本（structuredContent 便于程序化消费）。 */
function toolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return {
    content: [{ type: 'text', text: clipText(text, 40000) }],
    structuredContent: typeof value === 'object' && value !== null ? value : { value },
    isError: false,
  }
}

function toolError(error) {
  const code = error?.code ? ` [${error.code}]` : ''
  return {
    content: [{ type: 'text', text: `${errorText(error)}${code}` }],
    isError: true,
  }
}

/**
 * 按工具声明的 inputSchema 做最小校验：必填项 + 未知顶层键。
 *
 * 为什么必须做：很多工具的 `project` 是可选的，「只有一个项目在跑」时可以省略。
 * agent 手一抖写成 `{projects: 'x'}`（多了个 s），没有校验的话这个参数会被静默
 * 丢弃 → 工具按「默认唯一项目」执行 → **改动打到没打算碰的工程里**。
 * 这正是多项目场景里最危险的静默错误，所以宁可在这里报错打断。
 */
function validateArgs(def, args) {
  const schema = def.inputSchema
  if (schema === null || typeof schema !== 'object') return null
  const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      return `缺少必填参数 "${key}"（工具 ${def.name}）。`
    }
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter((key) => !(key in properties))
    if (unknown.length > 0) {
      const known = Object.keys(properties).join('、')
      return `工具 ${def.name} 不认识参数：${unknown.map((key) => `"${key}"`).join('、')}。`
        + `可用参数：${known || '(无)'}。`
        + '注意 project 拼写（单数）—— 写错会被静默忽略，导致操作落到「默认项目」上。'
    }
  }
  return null
}

async function handleToolCall(params) {
  const name = params?.name
  const def = TOOL_INDEX.get(name)
  if (!def) {
    return toolError(new Error(`未知工具 "${name}"。可用工具：${[...TOOL_INDEX.keys()].join('、')}`))
  }
  const args = params?.arguments !== null && typeof params?.arguments === 'object' ? params.arguments : {}
  const invalid = validateArgs(def, args)
  if (invalid !== null) {
    log(`工具 ${name} 参数被拒：${invalid}`)
    return toolError(new Error(invalid))
  }
  try {
    const value = await def.handler(args, { dshHome, sessionId, config, log })
    return toolResult(value)
  } catch (error) {
    log(`工具 ${name} 失败：${errorText(error)}`)
    return toolError(error)
  }
}

async function handleResourcesList() {
  return {
    resources: [
      {
        uri: 'cocos://projects',
        name: 'Cocos 项目总览',
        description: '已登记与正在运行的 Cocos Creator 项目、端口、MCP 健康、构建槽位。',
        mimeType: 'application/json',
      },
    ],
  }
}

async function handleResourceRead(params) {
  const uri = String(params?.uri ?? '')
  if (uri === 'cocos://projects' || uri === 'cocos://projects/') {
    const overview = await projectOverview({ dshHome, cacheMs: 0, buildSlotLimit: config.buildSlots })
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(overview, null, 2),
      }],
    }
  }
  const match = /^cocos:\/\/project\/(.+)$/.exec(uri)
  if (match) {
    const slug = decodeURIComponent(match[1])
    const overview = await projectOverview({ dshHome, cacheMs: 0, buildSlotLimit: config.buildSlots })
    const hit = overview.projects.find((item) => item.slug === slug)
    if (!hit) throw new Error(`没有项目 ${slug}`)
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(hit, null, 2) }],
    }
  }
  throw new Error(`不支持的资源 URI：${uri}`)
}

async function dispatch(message) {
  const { id, method, params } = message
  const isNotification = id === undefined || id === null

  if (isNotification) {
    // 通知（notifications/initialized 等）不需要响应。
    return
  }

  switch (method) {
    case 'initialize': {
      // MCP 握手：客户端报它想要的版本，服务端必须回**自己支持的**版本；
      // 无脑回显客户端版本，等于承诺了一个我们没实现的协议行为。
      const requested = String(params?.protocolVersion ?? '')
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL
      result(id, {
        protocolVersion,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {}, resources: {} },
        instructions:
          '控制本机正在运行的 Cocos Creator 项目。同一台机器可能同时开着多个项目：'
          + '需要项目的工具必须显式传 project（slug/目录名/路径）；只有一个项目运行时可以省略。'
          + '写操作按项目串行（同一项目同时只允许一个写操作），构建全机串行。'
          + '不确定项目状态时先调 cocos_projects。',
      })
      return
    }
    case 'ping':
      result(id, {})
      return
    case 'tools/list':
      result(id, { tools: toolSchemas() })
      return
    case 'tools/call': {
      const outcome = await handleToolCall(params)
      result(id, outcome)
      return
    }
    case 'resources/list':
      result(id, await handleResourcesList())
      return
    case 'resources/read':
      result(id, await handleResourceRead(params))
      return
    case 'prompts/list':
      result(id, { prompts: [] })
      return
    case 'logging/setLevel':
      result(id, {})
      return
    default:
      rpcError(id, -32601, `Method not found: ${method}`)
  }
}

function processLine(line) {
  const text = line.trim()
  if (text === '') return
  // Content-Length 帧头（少数客户端会用），跳过它和空行。
  if (/^content-length:/i.test(text)) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    rpcError(null, -32700, 'Parse error')
    return
  }
  if (Array.isArray(message)) {
    for (const item of message) {
      dispatch(item).catch((error) => log(`dispatch 失败：${errorText(error)}`))
    }
    return
  }
  dispatch(message).catch((error) => {
    const id = message?.id ?? null
    if (id !== null && id !== undefined) rpcError(id, -32603, `Internal error: ${errorText(error)}`)
    else log(`通知处理失败：${errorText(error)}`)
  })
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', processLine)
rl.on('close', () => {
  log('stdin 已关闭，退出')
  process.exit(0)
})

process.on('uncaughtException', (error) => {
  // fail-fast：未捕获异常意味着「状态未知」——继续服务就等于在不确定的状态下
  // 执行写操作（改场景、放锁）。宁可死掉让客户端重连（mcp-client 有重连预算），
  // 也不要在这种状态下发号施令。
  log(`未捕获异常，进程退出：${errorText(error)}`)
  try {
    process.exit(1)
  } catch {
    process.exitCode = 1
  }
})
process.on('unhandledRejection', (error) => {
  // 未处理的 Promise 拒绝同样按 fail-fast 处理，避免「以为成功、其实没写」。
  log(`未处理的 Promise 拒绝，进程退出：${errorText(error)}`)
  try {
    process.exit(1)
  } catch {
    process.exitCode = 1
  }
})

log(`已启动（home=${dshHome}, buildSlots=${config.buildSlots}）`)
