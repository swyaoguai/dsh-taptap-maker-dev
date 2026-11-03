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

async function handleToolCall(params) {
  const name = params?.name
  const def = TOOL_INDEX.get(name)
  if (!def) {
    return toolError(new Error(`未知工具 "${name}"。可用工具：${[...TOOL_INDEX.keys()].join('、')}`))
  }
  const args = params?.arguments !== null && typeof params?.arguments === 'object' ? params.arguments : {}
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
      const requested = String(params?.protocolVersion ?? '')
      result(id, {
        protocolVersion: requested || DEFAULT_PROTOCOL,
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
  log(`未捕获异常：${errorText(error)}`)
})
process.on('unhandledRejection', (error) => {
  log(`未处理的 Promise 拒绝：${errorText(error)}`)
})

log(`已启动（home=${dshHome}, buildSlots=${config.buildSlots}）`)
