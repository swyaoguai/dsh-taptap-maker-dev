/**
 * `/game-cocos` 斜杠命令的实现（放在这里而不是塞进 index.js，方便单独测）。
 *
 * 约定与插件里其它命令一致：返回 `{kind: 'success'|'error', text, refresh?}`。
 * `refresh: true` 表示「系统提示里的 Cocos 守则段落要重建」（登记/注销后需要）。
 *
 * @module src/cocos/command.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctor, installExtension } from './install.mjs'
import { mcpRowStatus, removeMcpRow, resolveNodeBin, upsertMcpRow } from './register.mjs'
import { projectOverview } from './router.mjs'
import { TOOL_INDEX } from './tools.mjs'
import { errorText } from './util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HUB_PATH = path.join(HERE, 'server.mjs')

/** 把命令行走廊拆成 token（支持引号包住的路径）。 */
export function tokenize(raw) {
  const tokens = []
  let current = ''
  let quote = null
  for (const char of String(raw ?? '')) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/\s/.test(char)) {
      if (current !== '') { tokens.push(current); current = '' }
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

function projectLine(project) {
  const state = project.running
    ? (project.mcp ? `运行中（pid ${project.interactivePid ?? '?'}，端口 ${project.port}）` : '运行中，但没探到 MCP 端点')
    : '未运行'
  return `  ${project.slug}\n    ${project.path}\n    ${state}${project.registered ? '' : '  · 未登记'}`
}

/** 这些 flag 后面跟一个值（`--platform web-mobile`）；其余 flag 是开关。 */
const FLAGS_WITH_VALUE = new Set(['platform', 'wait'])

/**
 * 把 tokens 拆成位置参数与 flag。
 *
 * 之前用「tokens.indexOf('--wait') + 1」取值，一旦用户把 flag 写在项目名前面
 * （`/game-cocos build --wait 30 myproj`），`positional[0]` 会变成 '30'，
 * **构建就打到错误的项目上**。这里集中解析，位置参数只收真正的位置 token。
 */
export function parseTokens(tokens) {
  const flags = new Set()
  const values = new Map()
  const positional = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      if (FLAGS_WITH_VALUE.has(key) && i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        values.set(key, tokens[i + 1])
        i += 1
      } else {
        flags.add(key)
      }
      continue
    }
    positional.push(token)
  }
  return { flags, values, positional }
}

function usageText() {
  return [
    'Cocos 集成（多项目安全）：',
    '',
    '  /game-cocos                     显示本帮助（不扫描进程）',
    '  /game-cocos list                列出已登记 / 正在运行的项目',
    '  /game-cocos status <项目>        单个项目详情（端口、身份、锁、构建槽位）',
    '  /game-cocos install <项目目录> [--global] [--yes]',
    '                                  安装 Cocos MCP 扩展（默认装到工程的 extensions/）',
    '  /game-cocos doctor <项目目录>    体检：工程 / 扩展 / 端口策略',
    '  /game-cocos register [--yes]     把 cocos MCP 服务登记进 DSH（写 profile patch，热加载）',
    '  /game-cocos unregister [--yes]   撤销登记',
    '  /game-cocos open <项目目录>      启动编辑器并等 MCP 就绪',
    '  /game-cocos build <项目> [--platform web-mobile] [--wait 秒]',
    '',
    '多个项目同时开时，所有操作都必须带项目参数（slug / 目录名 / 完整路径）。',
  ].join('\n')
}

/**
 * 执行一条 `/game-cocos ...`。
 *
 * @param {string} raw 命令后面的原始输入
 * @param {{home: string, config?: object, sessionId?: string}} ctx
 */
export async function runCocosCommand(raw, ctx) {
  const tokens = tokenize(raw)
  const sub = (tokens[0] ?? '').toLowerCase()
  const { flags, values, positional } = parseTokens(tokens.slice(1))
  const home = ctx.home

  // ⚠️ 不带参数（或 help）只打印用法，**不扫进程表**：
  // 以前 '' 和 'list' 走同一分支，连「帮我看看怎么用」都要先做一次进程扫描
  // （PowerShell，1~3 秒，负载高时还会超时），超时了连用法文本都看不到。
  if (sub === '' || sub === 'help' || sub === '-h' || sub === '--help') {
    return { kind: 'success', text: usageText() }
  }

  try {
    if (sub === 'list' || sub === 'status') {
      if (sub === 'status' && positional[0]) {
        const overview = await projectOverview({ dshHome: home, cacheMs: 0, buildSlotLimit: ctx.config?.cocos?.buildSlots })
        const hit = overview.projects.find((item) => item.slug === positional[0]
          || String(item.path).toLowerCase() === path.resolve(positional[0]).toLowerCase()
          || String(item.name).toLowerCase() === positional[0].toLowerCase())
        if (!hit) return { kind: 'error', text: `没有找到项目 "${positional[0]}"。可用：${overview.projects.map((item) => item.slug).join('、') || '(空)'}` }
        return {
          kind: 'success',
          text: [
            `${hit.name}（${hit.slug}）`,
            `路径：${hit.path}`,
            `运行：${hit.running ? `是（交互 pid ${hit.interactivePid ?? '?'}）` : '否'}`,
            `MCP：${hit.mcp ? `端口 ${hit.port}，身份 ${hit.mcp.projectPath}${hit.mcp.matchesRegistry ? '' : '（与登记路径不一致！）'}` : '未探测到'}`,
            `构建实例：${hit.buildPids.length > 0 ? hit.buildPids.join(', ') : '无'}`,
            `构建槽位：${overview.buildSlots.length > 0 ? overview.buildSlots.map((slot) => `slot${slot.slot} ${slot.holder.label}`).join('；') : '空闲'}`,
          ].join('\n'),
        }
      }
      const overview = await projectOverview({ dshHome: home, cacheMs: 0, buildSlotLimit: ctx.config?.cocos?.buildSlots })
      if (overview.projects.length === 0) {
        return {
          kind: 'success',
          text: [
            '目前没有已登记或正在运行的 Cocos Creator 项目。',
            '',
            '下一步：',
            '  1. /game-cocos install <项目目录> --yes   装 Cocos MCP 扩展',
            '  2. /game-cocos register --yes             把 cocos 服务登记给 DSH',
            '  3. 打开编辑器后 agent 就能用 cocos_* 工具了',
            '',
            usageText(),
          ].join('\n'),
        }
      }
      const status = mcpRowStatus({ dshHome: home })
      const lines = [
        `Cocos 项目（${overview.projects.length} 个）：`,
        ...overview.projects.map(projectLine),
        '',
        `cocos MCP 服务：${status.registered ? '已登记' : '未登记（agent 还看不到 cocos_* 工具）'}`,
        `构建槽位：${overview.buildSlots.length > 0 ? overview.buildSlots.map((slot) => `slot${slot.slot} 被 ${slot.holder.label} 占用`).join('；') : '空闲'}`,
      ]
      if (overview.projects.length > 1) {
        lines.push('', '注意：多个项目在运行时，每个操作都要显式带项目（不会替你猜）。')
      }
      return { kind: 'success', text: lines.join('\n') }
    }

    if (sub === 'install') {
      const project = positional[0] ?? process.cwd()
      if (!flags.has('yes')) {
        return {
          kind: 'success',
          text: [
            '将要执行（不会跑第三方脚本）：',
            '  1. 从 GitHub 下载 MIT 版 funplay-cocos-mcp release，并校验 SHA256；',
            `  2. 解压到 ${flags.has('global') ? '全局 builtin-extensions（同一 Creator 版本的所有项目共用）' : `${project}\\extensions\\`}；`,
            '  3. 若配置缺失，补一份 portMode="project" 的配置（端口跟项目走，多开不抢端口）。',
            '',
            '确认后加 --yes 重新执行。',
          ].join('\n'),
        }
      }
      const result = await installExtension({
        projectPath: project,
        dshHome: home,
        global: flags.has('global'),
        force: flags.has('force'),
      })
      if (result.alreadyInstalled) {
        return { kind: 'success', text: `已安装过：${result.dir}（版本 ${result.version}）。要覆盖重装加 --force。` }
      }
      return {
        kind: 'success',
        text: [
          `已安装 funplay-cocos-mcp v${result.version} → ${result.dir}`,
          `校验：${result.checksum.expected ? 'SHA256 通过' : '（release 未提供校验文件，仅记录了实际哈希）'}`,
          result.config?.written ? `已补端口配置：${result.config.file}` : '工程配置已存在，未改动。',
          '',
          '在 Cocos Creator 里重新加载扩展（或重启编辑器）后生效。',
        ].join('\n'),
      }
    }

    if (sub === 'doctor') {
      const report = await doctor({ projectPath: positional[0] ?? process.cwd(), dshHome: home })
      return {
        kind: report.problems.length === 0 ? 'success' : 'error',
        text: [
          `工程：${report.projectPath}`,
          `Cocos 工程：${report.isCocosProject ? `是（Creator ${report.creatorVersion || '?'}）` : '否'}`,
          `扩展：${report.extension.installed ? `${report.extension.scope} 级 ${report.extension.dir}（v${report.extension.version}）` : '未安装'}`,
          `端口配置：${report.config.present === false ? '缺失' : `portMode=${report.config.portMode ?? '?'}`}`,
          ...(report.problems.length > 0 ? ['', '问题：', ...report.problems.map((item) => `  · ${item}`)] : []),
          ...(report.suggestions.length > 0 ? ['', '建议：', ...report.suggestions.map((item) => `  · ${item}`)] : []),
        ].join('\n'),
      }
    }

    if (sub === 'register') {
      const status = mcpRowStatus({ dshHome: home })
      if (!flags.has('yes')) {
        return {
          kind: 'success',
          text: [
            '将往 DSH 配置层写入一条 MCP 配置：',
            `  文件：${status.file}`,
            `  条目：id: mcp-cocos → serverName: cocos → stdio → ${HUB_PATH}`,
            '',
            '只增删这一条，其它内容原样保留，并自动备份。',
            'DSH 若启用了配置热加载会直接生效；桌面端多数情况需要重启一次才会出现 cocos_* 工具。',
            '确认后加 --yes 重新执行。',
          ].join('\n'),
        }
      }
      const result = upsertMcpRow({
        dshHome: home,
        nodePath: resolveNodeBin(),
        hubPath: HUB_PATH,
        buildSlots: Math.max(1, Number(ctx.config?.cocos?.buildSlots) || 1),
      })
      return {
        kind: 'success',
        refresh: true,
        text: [
          result.changed ? `已写入（${result.action}）：${result.file}` : '配置已是最新，无需改动。',
          result.backup ? `备份：${result.backup}` : '',
          '',
          '若宿主启用了配置热加载，几秒内就会多出 cocos_* 工具；桌面端多数情况需要重启一次桌面端。',
          '之后 agent 可以用 cocos_projects / cocos_exec / cocos_scene 等工具。',
        ].filter(Boolean).join('\n'),
      }
    }

    if (sub === 'unregister') {
      if (!flags.has('yes')) {
        return { kind: 'success', text: `将从 ${mcpRowStatus({ dshHome: home }).file} 删除 id: ${'mcp-cocos'} 这一条。确认请加 --yes。` }
      }
      const result = removeMcpRow({ dshHome: home })
      return {
        kind: 'success',
        refresh: true,
        text: result.changed ? `已移除（备份：${result.backup ?? '无'}）。` : `没有找到登记行（${result.action}）。`,
      }
    }

    if (sub === 'open') {
      const project = positional[0]
      if (!project) return { kind: 'error', text: '用法：/game-cocos open <项目目录>' }
      const result = await TOOL_INDEX.get('cocos_open').handler(
        { project, wait_ms: 120000 },
        { dshHome: home, config: ctx.config ?? {}, sessionId: ctx.sessionId ?? '' },
      )
      if (result.alreadyRunning) return { kind: 'success', text: `已经在运行：${result.path}（端口 ${result.port}）` }
      if (result.ready === false) {
        return { kind: 'error', text: `编辑器进程已启动，但没等到 MCP 端点。日志：${result.logFile}\n常见原因：扩展没装/没启用，或资源正在导入。` }
      }
      return { kind: 'success', text: `已启动：${result.slug}，MCP 端口 ${result.port}。` }
    }

    if (sub === 'build') {
      const project = positional[0]
      if (!project) return { kind: 'error', text: '用法：/game-cocos build <项目> [--platform web-mobile] [--wait 秒]' }
      // parseTokens 已经把 flag 和位置参数分开：`--wait 30 myproj` 这种顺序
      // 不会再把 '30' 当成项目名（之前会，结果是构建打到错误工程）。
      const waitSeconds = Number(values.get('wait')) || 0
      const platform = values.get('platform') ?? 'web-mobile'
      const result = await TOOL_INDEX.get('cocos_build').handler(
        { project, platform, wait_ms: Math.max(0, waitSeconds) * 1000 },
        { dshHome: home, config: { buildSlots: ctx.config?.cocos?.buildSlots ?? 1 }, sessionId: ctx.sessionId ?? '' },
      )
      return {
        kind: 'success',
        text: [
          `构建已启动：${result.project}`,
          `参数：${result.buildArg}`,
          `日志：${result.logFile}`,
          result.finished ? `已结束，退出码 ${result.exitCode}` : '（未等待结束；构建槽位会在进程退出后释放）',
        ].join('\n'),
      }
    }

    return { kind: 'error', text: `未知子命令 "${sub}"。\n\n${usageText()}` }
  } catch (error) {
    return { kind: 'error', text: `Cocos 操作失败：${errorText(error)}` }
  }
}
