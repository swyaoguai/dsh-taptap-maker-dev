#!/usr/bin/env node
/**
 * `game-cocos` 命令行：不依赖 agent 也能管这套 Cocos 集成。
 *
 * 所有子命令在插件里都有对应的 `/game-cocos ...` 入口；命令行版本主要是给
 * 「设置页还没做 / agent 不可用 / CI 里跑体检」准备的。
 *
 * @module src/cocos/cli.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '../paths.js'
import { doctor, installExtension } from './install.mjs'
import { MCP_ROW_ID, mcpRowStatus, removeMcpRow, resolveNodeBin, upsertMcpRow } from './register.mjs'
import { projectOverview, resolveTarget } from './router.mjs'
import { TOOL_INDEX } from './tools.mjs'
import { errorText } from './util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HUB_PATH = path.join(HERE, 'server.mjs')

/**
 * 只吃「有没有」、不吃值的开关。
 *
 * ⚠️ 以前没有这份名单：解析器默认每个 `--flag` 都可能带值，于是
 * `game-cocos install --global D:\proj` 会把 **路径当成 --global 的值**吞掉，
 * 位置参数为空 → 安装目标回落到 `process.cwd()`（装错工程）。
 * `--yes` 同理：`--yes D:\proj` 会让 `flags.yes !== true` 成立而拒绝执行，
 * 看起来像是「确认无效」。
 */
const BOOLEAN_FLAGS = new Set(['yes', 'json', 'force', 'global', 'help', 'h'])

/** 显式给值的开关（其余未知 `--x` 仍然按「可能带值」处理，保持兼容）。 */
const VALUE_FLAGS = new Set(['home', 'build-slots', 'platform', 'wait', 'code', 'context', 'out'])

function toBoolean(value) {
  if (value === true) return true
  const text = String(value).toLowerCase()
  return text === 'true' || text === '1' || text === 'yes' || text === 'on'
}

function parse(argv) {
  const args = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args.push(token)
      continue
    }
    const [key, inline] = token.slice(2).split('=')
    if (BOOLEAN_FLAGS.has(key)) {
      // `--yes=false` 这类显式写法照样认，但绝不吞掉后面的位置参数。
      flags[key] = inline === undefined ? true : toBoolean(inline)
      continue
    }
    if (inline !== undefined) {
      flags[key] = inline
    } else if (VALUE_FLAGS.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      flags[key] = argv[++i]
    } else if (VALUE_FLAGS.has(key)) {
      flags[key] = true
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && looksLikeFlagValue(argv[i + 1])) {
      // 未知开关：只有在下一个 token 明显不是路径/子命令时才当值吃，
      // 否则保留给位置参数（宁可少解析一个值，也不能吞掉工程路径）。
      flags[key] = argv[++i]
    } else {
      flags[key] = true
    }
  }
  return { args, flags }
}

/** 下一个 token 像不像某一行的「值」（而不是工程路径或子命令）。 */
function looksLikeFlagValue(token) {
  if (token === '') return false
  if (token.startsWith('-')) return false
  // 路径特征：盘符、分隔符、点开头，或已存在的路径
  if (/^[a-zA-Z]:[\\/]/.test(token)) return false
  if (token.includes('/') || token.includes('\\')) return false
  if (token.startsWith('.')) return false
  try {
    if (fs.existsSync(token)) return false
  } catch {
    return true
  }
  return true
}

function out(value, flags) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (typeof value === 'string') process.stdout.write(`${value}\n`)
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function usage() {
  return [
    'game-cocos —— Cocos Creator MCP 集成（多项目安全）',
    '',
    '用法：',
    '  game-cocos list [--json]                列出已登记/正在运行的项目',
    '  game-cocos status [项目] [--json]        单个项目详细状态',
    '  game-cocos open <项目目录> [--wait ms]   启动编辑器并等 MCP 就绪',
    '  game-cocos install [项目目录] [--global] [--force] [--yes]',
    '                                          安装 Cocos MCP 扩展（默认装到工程的 extensions/）',
    '  game-cocos doctor [项目目录] [--json]    体检：工程/扩展/配置/端口策略',
    '  game-cocos register [--yes] [--build-slots n]',
    '                                          把 cocos MCP 服务登记进 DSH 配置（写 profile patch）',
    '  game-cocos unregister [--yes]            撤销登记',
    '  game-cocos build <项目> [--platform web-mobile] [--debug] [--wait ms]',
    '  game-cocos exec <项目> --code "..." [--context scene|editor]',
    '  game-cocos hub                           直接跑 stdio MCP 服务（DSH 配置里调用的就是它）',
    '',
    '说明：同时开多个项目时，所有操作都必须带项目参数；不带时只有「唯一在跑的项目」才会被采用。',
  ].join('\n')
}

async function main() {
  const { args, flags } = parse(process.argv.slice(2))
  const command = args[0] ?? 'list'
  const dshHome = resolveDshHome(flags.home)

  if (command === 'help' || command === '--help' || command === '-h') {
    out(usage(), flags)
    return 0
  }

  if (command === 'hub') {
    await import('./server.mjs')
    return null // server 自己接管 stdin
  }

  if (command === 'list') {
    const overview = await projectOverview({ dshHome, cacheMs: 0, buildSlotLimit: Math.max(1, Number(flags['build-slots']) || 1) })
    if (flags.json) {
      out(overview, flags)
      return 0
    }
    const lines = []
    if (overview.projects.length === 0) {
      lines.push('还没有登记任何 Cocos 项目。用 game-cocos open <项目目录> 打开一个，或 install 装扩展。')
    }
    for (const project of overview.projects) {
      const state = project.running
        ? (project.mcp ? `运行中 pid=${project.interactivePid} port=${project.port}` : '运行中但没探到 MCP')
        : '未运行'
      lines.push(`- ${project.slug}  ${project.name}`)
      lines.push(`    ${project.path}`)
      lines.push(`    状态：${state}${project.registered ? '' : '（未登记，只是当前开着）'}`)
    }
    if (overview.buildSlots.length > 0) {
      lines.push(`构建槽位占用：${overview.buildSlots.map((slot) => `slot${slot.slot} ${slot.holder.label}`).join('；')}`)
    }
    out(lines.join('\n'), flags)
    return 0
  }

  if (command === 'status') {
    const target = await resolveTarget({ dshHome, project: args[1], requireLive: false })
    const overview = await projectOverview({ dshHome, cacheMs: 0 })
    const view = overview.projects.find((item) => item.slug === target.entry.slug) ?? null
    out({ registry: target.entry, live: view, buildSlots: overview.buildSlots }, flags)
    return 0
  }

  if (command === 'open') {
    const project = args[1]
    if (!project) throw new Error('用法：game-cocos open <项目目录>')
    const result = await TOOL_INDEX.get('cocos_open').handler(
      { project, wait_ms: Number(flags.wait) || 120000 },
      { dshHome, config: {}, sessionId: 'cli' },
    )
    out(result, flags)
    return 0
  }

  if (command === 'install') {
    const project = path.resolve(args[1] ?? process.cwd())
    if (flags.yes !== true) {
      out([
        '这会做三件事（不会执行第三方脚本）：',
        '  1. 从 GitHub 下载 funplay-cocos-mcp 的 release（MIT）并校验 SHA256',
        `  2. 解压到 ${flags.global === true ? '全局 builtin-extensions' : path.join(project, 'extensions', 'funplay-cocos-mcp')}`,
        '  3. 若工程里没有 funplay-cocos-mcp.config.json，补一份 portMode="project" 的配置',
        '',
        '确认后请加 --yes 重新执行。',
      ].join('\n'), flags)
      return 1
    }
    const result = await installExtension({
      projectPath: project,
      dshHome,
      global: flags.global === true,
      force: flags.force === true,
      version: typeof flags.version === 'string' ? flags.version : '',
    })
    out(result, flags)
    return 0
  }

  if (command === 'doctor') {
    const report = await doctor({ projectPath: args[1] ?? process.cwd(), dshHome })
    out(report, flags)
    return report.problems.length === 0 ? 0 : 2
  }

  if (command === 'register') {
    const status = mcpRowStatus({ dshHome })
    if (flags.yes !== true) {
      out([
        `将往 profile patch 写入/更新一条 MCP 配置：`,
        `  ${status.file}`,
        `  id: ${MCP_ROW_ID}，serverName: cocos，stdio → ${HUB_PATH}`,
        '',
        '只会增删这一条，其它内容原样保留，并自动备份。加 --yes 执行。',
      ].join('\n'), flags)
      return 1
    }
    const result = upsertMcpRow({
      dshHome,
      nodePath: resolveNodeBin(),
      hubPath: HUB_PATH,
      buildSlots: Math.max(1, Number(flags['build-slots']) || 1),
      force: flags.force === true,
    })
    out({ ...result, note: '启用配置热加载的宿主会在几秒内生效；桌面端如没出现 cocos_* 工具，重启一次桌面端。' }, flags)
    return 0
  }

  if (command === 'unregister') {
    if (flags.yes !== true) {
      const status = mcpRowStatus({ dshHome })
      out(`将从 ${status.file} 删除 id: ${MCP_ROW_ID} 这一条（其它内容不动）。加 --yes 执行。`, flags)
      return 1
    }
    out(removeMcpRow({ dshHome }), flags)
    return 0
  }

  if (command === 'build') {
    const project = args[1]
    if (!project) throw new Error('用法：game-cocos build <项目> [--platform web-mobile] [--wait ms]')
    const result = await TOOL_INDEX.get('cocos_build').handler({
      project,
      platform: typeof flags.platform === 'string' ? flags.platform : 'web-mobile',
      debug: flags.debug !== false,
      wait_ms: Number(flags.wait) || 0,
    }, { dshHome, config: {}, sessionId: 'cli' })
    out(result, flags)
    return 0
  }

  if (command === 'exec') {
    const project = args[1]
    const code = typeof flags.code === 'string' ? flags.code : ''
    if (!project || code === '') throw new Error('用法：game-cocos exec <项目> --code "..." [--context scene|editor]')
    const result = await TOOL_INDEX.get('cocos_exec').handler({
      project,
      context: flags.context === 'editor' ? 'editor' : 'scene',
      code,
    }, { dshHome, config: {}, sessionId: 'cli' })
    out(result, flags)
    return 0
  }

  process.stderr.write(`未知子命令：${command}\n\n${usage()}\n`)
  return 1
}

main().then((code) => {
  if (typeof code === 'number') process.exit(code)
}).catch((error) => {
  process.stderr.write(`错误：${errorText(error)}\n`)
  process.exit(1)
})
