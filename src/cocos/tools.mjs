/**
 * 工具目录：agent 看到的 `cocos_*` 工具，以及每个工具的落地实现。
 *
 * 设计原则（针对「同时开 2~3 个项目」这个前提）：
 *  - **一个命名空间 + `project` 参数**，而不是「每个项目注册一个 MCP server」。
 *    后者的工具数量会随项目数线性膨胀（每个 server 几十个工具），
 *    每次请求都要为这些 schema 付 token；而且 DSH 的 MCP 客户端不允许同名
 *    server，动态增删项目就等于反复改配置 + 重启。
 *  - **工具按意图合并**（`cocos_scene` 里的 `action`），不做「一个上游工具一个我们的工具」，
 *    这样上游从 39 个涨到 106 个工具时，我们的表面积不用跟着涨。
 *  - 上游没有的能力，用 `cocos_exec` 在场景/编辑器里跑 JS 兜底 ——
 *    这也是上游自己的推荐路径。
 *
 * @module src/cocos/tools.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CocosMcpError } from './mcp-http.mjs'
import { connectTarget, projectOverview, readProjectMeta, resolveTarget } from './router.mjs'
import { upsertProject } from './registry.mjs'
import { acquireFileLock, acquireBuildSlot, makeOwner, projectLockPath, releaseBuildSlot, releaseFileLock, touchFileLock, withProjectLock } from './locks.mjs'
import { creatorVersionFromExe, discoverLive, findCreatorExecutables, invalidateDiscoveryCache, pickCreatorExecutable } from './discover.mjs'
import { sleep } from './util.mjs'
import { sameProjectPath, shotsDir } from './paths.mjs'

/** 上游工具清单缓存：同一端点 30 秒内不重复拉。 */
const toolListCache = new Map()
const TOOL_LIST_TTL_MS = 30000

/** 定期清掉过期项，编辑器反复重启也不会积累。 */
function pruneToolListCache() {
  const now = Date.now()
  for (const [key, value] of toolListCache) {
    if (now - value.at >= TOOL_LIST_TTL_MS) toolListCache.delete(key)
  }
}

async function upstreamTools(target, { timeoutMs = 15000 } = {}) {
  const { client, identity } = await connectTarget(target, { timeoutMs })
  const key = `${identity.projectId}:${identity.instanceId}`
  const cached = toolListCache.get(key)
  if (cached && Date.now() - cached.at < TOOL_LIST_TTL_MS) return { client, identity, tools: cached.tools }
  const tools = await client.toolsList()
  if (toolListCache.size > 64) pruneToolListCache()
  toolListCache.set(key, { at: Date.now(), tools })
  return { client, identity, tools }
}

/** 上游没这个工具时，给出「为什么 + 相似名字」而不是干巴巴的 not found。 */
function missingToolError(name, tools) {
  const lower = String(name).toLowerCase()
  const near = tools
    .map((tool) => String(tool.name))
    .filter((toolName) => toolName.includes(lower.slice(0, 4)) || lower.includes(toolName.slice(0, 4)))
    .slice(0, 12)
  return new CocosMcpError(
    `当前 Cocos MCP 没有工具 "${name}"。可能你用的是 core 工具档（只暴露一部分）；`
    + '可以在 Cocos 的 Funplay > MCP Settings 里切到 full，或直接用 cocos_exec 跑一段 JS 达成同样目的。'
    + (near.length > 0 ? `相近的工具：${near.join('、')}` : ''),
    { code: 'UPSTREAM_TOOL_MISSING' },
  )
}

/**
 * 统一的上游调用：先确认工具存在，再决定是否需要写锁。
 *
 * ⚠️ 写操作**必须**走 withProjectLock：以前锁只在（无人调用的）callProjectTool
 * 里，主路径的 cocos_exec / 场景保存 / 资源刷新全是裸调用 ——
 * 「同一项目写操作串行」这个承诺实际是空的，两个会话可以同时改一个场景。
 */
async function invoke({ dshHome, project, tool, args, mutating, sessionId, timeoutMs, discovery, signal }) {
  const target = await resolveTarget({ dshHome, project, requireLive: true, discovery })
  const run = async () => {
    const { client, identity, tools } = await upstreamTools(target, { timeoutMs: Math.min(timeoutMs ?? 20000, 30000) })
    if (!tools.some((item) => item.name === tool)) throw missingToolError(tool, tools)
    const result = await client.toolsCall(tool, args, {
      // 只有写操作才带身份令牌：上游对只读工具会原样透传参数，
      // 多塞一个参数在别的实现上可能被 schema 校验拒绝。
      expectedContext: mutating ? identity.expectedContext : '',
      timeoutMs: timeoutMs ?? 60000,
      // 取消信号一路传到 fetch：客户端取消后，正在等上游响应的大调用
      // （cocos_exec 可能等到 120s）会立刻中断，而不是继续跑满超时。
      signal: signal ?? null,
    })
    return { result, identity, target }
  }
  if (!mutating) return run()
  const owner = makeOwner(`tool:${tool}${sessionId ? `@${sessionId}` : ''}`)
  return withProjectLock(dshHome, target.entry.slug, owner, run, {
    waitMs: 0,
    note: `${target.entry.name || target.entry.slug} ← ${tool}`,
  })
}

/** 把上游返回的 content 数组压成可读文本（图片单独处理）。 */
function contentToText(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') parts.push('[image]')
    else if (block !== null && block !== undefined) parts.push(JSON.stringify(block))
  }
  return parts.join('\n')
}

/**
 * 从上游结果里捞出图片（base64），落盘并返回路径。
 *
 * 落盘而不是塞进返回值：一张截图 base64 动辄几百 KB~几 MB，进对话上下文
 * 会直接把窗口撑爆（而且 agent 也读不了 base64）。这里只给路径。
 */
function persistImages(result, { dshHome, slug, scope }) {
  const content = Array.isArray(result?.content) ? result.content : []
  const out = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  content.forEach((block, index) => {
    if (block?.type !== 'image' || typeof block.data !== 'string') return
    const mime = String(block.mimeType || 'image/png')
    const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
    const file = path.join(shotsDir(dshHome), `${slug}-${scope}-${stamp}-${index}.${ext}`)
    try {
      fs.writeFileSync(file, Buffer.from(block.data, 'base64'))
      out.push(file)
    } catch { /* 写不进去就不报路径，绝不给假路径 */ }
  })
  if (out.length > 0) {
    // 截图是诊断产物：agent 反复「改一下看一眼」能产出几百张，不清理会一直涨。
    // 只删我们自己命名的截图，保留更大的上限（用户可能还要回看最近几张）。
    const shotDir = shotsDir(dshHome)
    pruneArtifacts(shotDir, { keep: 120, match: /-(scene|game|preview)-\d{4}-.*\.(png|jpg|webp)$/ })
  }
  return out
}

/** 日志/截图目录保留上限：这些是诊断产物，不清理会无限增长。 */
const ARTIFACT_KEEP = 40

/** 按修改时间保留最近 N 个文件，其余删除（只动我们自己的产物目录）。 */
function pruneArtifacts(dir, { keep = ARTIFACT_KEEP, match = null } = {}) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile())
  } catch {
    return 0
  }
  const files = entries
    .filter((entry) => (match === null ? true : match.test(entry.name)))
    .map((entry) => {
      const full = path.join(dir, entry.name)
      try {
        return { full, at: fs.statSync(full).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item) => item !== null)
    .sort((a, b) => b.at - a.at)
  let removed = 0
  for (const item of files.slice(keep)) {
    try {
      fs.unlinkSync(item.full)
      removed += 1
    } catch { /* 被占用就下次再说 */ }
  }
  return removed
}

/**
 * 启动一个 Cocos Creator 进程（编辑器或命令行构建）。
 *
 * ⚠️ `spawn()` 的失败是**异步**的：路径不存在/没权限时不会在这里抛错，而是稍后
 * 触发 `error` 事件。没有监听器的 EventEmitter `error` 会直接抛成未捕获异常 ——
 * 在这个 stdio MCP 进程里就是「整个服务静默死掉」。所以这里必须挂监听，
 * 并把错误交给调用方（`onError`），由它决定是报错还是继续等。
 */
function spawnCreator(exePath, args, { cwd, logFile, onError } = {}) {
  const stdoutFd = logFile ? fs.openSync(logFile, 'a') : 'ignore'
  const child = spawn(exePath, args, {
    cwd: cwd || path.dirname(exePath),
    detached: true,
    stdio: logFile ? ['ignore', stdoutFd, stdoutFd] : 'ignore',
    windowsHide: false,
  })
  child.unref()
  if (logFile) {
    try { fs.closeSync(stdoutFd) } catch { /* 已关闭 */ }
  }
  child.on('error', (error) => {
    if (typeof onError === 'function') {
      try { onError(error) } catch { /* 回调里再抛就不管了，至少不让进程死 */ }
    }
  })
  return child
}

/**
 * 找可执行文件：优先注册表里记的，其次实例自报的，最后扫常见安装位置。
 *
 * ⚠️ 「实例自报」只在**同一个项目**的实例上才可信：运行着项目 A 的编辑器的
 * exe 路径，被拿去给项目 B 构建未必错（同一台机器通常只装一个 Creator），
 * 但装了多个版本时就是错的。所以实例自报也要过版本匹配这一关。
 */
async function resolveCreatorExe({ dshHome, entry, discovery = null }) {
  if (entry?.creatorExe && fs.existsSync(entry.creatorExe)) return entry.creatorExe
  const want = entry?.creatorVersion ?? ''
  // 复用调用方已有的探测结果：cocos_open / cocos_build 进来时 resolveTarget 已经
  // 扫过一次进程表，这里再强制 cacheMs: 0 等于白扫第二遍（每次数秒）。
  const disc = discovery ?? await discoverLive()
  const hit = disc.instances.find((instance) => instance.exePath !== ''
    && (want === '' || creatorVersionFromExe(instance.exePath) === '' || creatorVersionFromExe(instance.exePath) === want))
  if (hit) return hit.exePath
  // 命令行探测带缓存：实现要递归扫 ProgramData/ProgramFiles，实测每次数秒。
  const candidates = findCreatorExecutables()
  const picked = pickCreatorExecutable(candidates, want)
  if (picked !== null) return picked
  throw new CocosMcpError(
    '找不到 CocosCreator.exe。请确认已安装 Cocos Creator，或显式传 creator_exe。',
    { code: 'NO_CREATOR_EXE' },
  )
}

const PROJECT_PARAM = {
  type: 'string',
  description: '项目标识：slug（如 wxzj-cocos-1a2b3c）、目录名或完整路径。'
    + '同时有多个项目在运行时必须显式给出；只有唯一项目时可省略。',
}

/**
 * 工具定义。`mutating` 决定是否加项目写锁；`handler` 返回可 JSON 化的值。
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'cocos_projects',
    description: '列出所有已知/正在运行的 Cocos Creator 项目（含端口、MCP 健康、是否有构建在跑）。'
      + '多项目并行时先调这个，拿到正确的 project 值再操作。',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '忽略缓存重新扫进程与端口（默认 false）', default: false },
      },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (args, ctx) => {
      const overview = await projectOverview({ dshHome: ctx.dshHome, cacheMs: args.refresh ? 0 : undefined, buildSlotLimit: ctx.config?.buildSlots, discovery: ctx.discovery })
      return {
        projects: overview.projects,
        buildSlots: overview.buildSlots,
        hint: overview.projects.length > 1
          ? '有多个项目，后续每个工具都要带 project 参数（不会替你猜）。'
          : null,
      }
    },
  },
  {
    name: 'cocos_status',
    description: '查看单个项目的详细状态：编辑器进程、MCP 端口与身份、扩展版本、写锁持有者、构建槽位。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        refresh: { type: 'boolean', description: '忽略缓存重新扫进程与端口（默认 false，用 2.5s 短缓存）', default: false },
      },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (args, ctx) => {
      // 默认走短缓存：agent 排查问题时会连着查好几次状态，
      // 每次都强制扫一遍进程表（1~3 秒）纯属白等；要最新就传 refresh: true。
      const overview = await projectOverview({
        dshHome: ctx.dshHome,
        cacheMs: args.refresh ? 0 : undefined,
        buildSlotLimit: ctx.config?.buildSlots,
        discovery: ctx.discovery,
      })
      let view = null
      if (args.project) {
        // 先用注册表解析（支持 slug / 名称 / 前缀 / 路径），再回到视图列表里取状态。
        // 这样「已登记但此刻没开编辑器」的项目也能查，而不是报「找不到项目」。
        const resolved = await resolveTarget({ dshHome: ctx.dshHome, project: args.project, requireLive: false, discovery: ctx.discovery })
        view = overview.projects.find((item) => item.slug === resolved.entry.slug) ?? null
        if (view === null) {
          return {
            ...resolved.entry,
            registered: true,
            running: false,
            mcp: null,
            port: null,
            endpoint: null,
            meta: readProjectMeta(resolved.entry.path),
            buildSlots: overview.buildSlots,
            buildSlotLimit: overview.buildSlotLimit,
          }
        }
      } else if (overview.projects.length === 1) {
        view = overview.projects[0]
      }
      if (view === null) {
        throw new CocosMcpError(
          `未指定项目且当前有 ${overview.projects.length} 个项目，请带 project 参数。`
          + `候选：${overview.projects.map((item) => item.slug).join('、') || '(无)'}`,
          { code: 'AMBIGUOUS_PROJECT' },
        )
      }
      return {
        ...view,
        meta: readProjectMeta(view.path),
        buildSlots: overview.buildSlots,
        buildSlotLimit: overview.buildSlotLimit,
      }
    },
  },
  {
    name: 'cocos_open',
    description: '启动（或复用）某个 Cocos 项目的编辑器，并等它的 MCP 端点可用后返回。'
      + '已在该项目上运行时直接返回现有实例，不会重复开。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        wait_ms: { type: 'number', description: '等 MCP 就绪的最长时间，默认 120000（毫秒）', default: 120000 },
      },
      required: ['project'],
      additionalProperties: false,
    },
    mutating: false,
    handler: async (args, ctx) => {
      const target = await resolveTarget({ dshHome: ctx.dshHome, project: args.project, requireLive: false, discovery: ctx.discovery })
      if (target.health !== null) {
        return { alreadyRunning: true, slug: target.entry.slug, port: target.health.port, path: target.entry.path }
      }
      const exe = await resolveCreatorExe({ dshHome: ctx.dshHome, entry: target.entry, discovery: ctx.discovery })
      const editorShotDir = shotsDir(ctx.dshHome)
      // 每次启动只留一份编辑器日志；产物目录整体按时间保留最近 N 个。
      pruneArtifacts(editorShotDir, { match: /-editor\.log$/ })
      const logFile = path.join(editorShotDir, `${target.entry.slug}-editor.log`)
      let spawnError = null
      spawnCreator(exe, ['--project', target.entry.path], {
        logFile,
        onError: (error) => { spawnError = error },
      })
      const deadline = Date.now() + Math.max(5000, Number(args.wait_ms) || 120000)
      while (Date.now() < deadline) {
        await sleep(1500)
        // 客户端取消（用户按停止）要能立刻退出等待，否则这条工具会一直占着
        // 这条调用链（以及它持有的任何锁）直到超时。
        if (ctx.signal?.aborted) {
          throw new CocosMcpError('等待编辑器启动已被客户端取消。', { code: 'CANCELLED' })
        }
        if (spawnError !== null) {
          throw new CocosMcpError(`启动编辑器失败：${spawnError.message ?? spawnError}（exe: ${exe}）`, { code: 'SPAWN_FAILED' })
        }
        invalidateDiscoveryCache()
        const latest = await discoverLive({ cacheMs: 0 })
        const running = latest.instances.find((instance) => sameProjectPath(instance.projectPath, target.entry.path))
        const health = running?.mcpHealths?.[0]
        if (health) {
          // 编辑器起来了就登记：下次 `cocos_projects` 能直接列出（含正确的
          // creatorVersion，之前要等下一次 status 调用才补上）。
          try {
            await upsertProject(ctx.dshHome, {
              slug: target.entry.slug,
              name: target.entry.name,
              path: target.entry.path,
              creatorVersion: creatorVersionFromExe(exe) || target.entry.creatorVersion || '',
            })
          } catch { /* 登记失败不影响「已启动」这个事实 */ }
          return {
            started: true,
            slug: target.entry.slug,
            pid: running.pid,
            port: health.port,
            endpoint: `http://127.0.0.1:${health.port}/`,
            waitedMs: deadline - Date.now(),
            note: '编辑器已启动且 MCP 可用。',
          }
        }
      }
      return {
        started: true,
        slug: target.entry.slug,
        ready: false,
        logFile,
        note: '编辑器进程已拉起，但在等待时限内没探到 MCP 端点。'
          + '常见原因：Cocos MCP 扩展没安装/没启用，或编辑器还在导入资源。',
      }
    },
  },
  {
    name: 'cocos_exec',
    description: '在目标项目的 Cocos 运行时（scene）或编辑器（editor）里执行一段 JavaScript 并返回结果。'
      + '这是最通用的控制入口：上游没有现成工具时用它。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        context: { type: 'string', enum: ['scene', 'editor'], description: 'scene=运行场景上下文；editor=编辑器/Node 上下文' },
        code: {
          type: 'string',
          description: 'JS 函数体或表达式；scene 上下文里可直接用 scene/cc/context，editor 上下文里可用 Editor/fs/path/require。返回值用 return。',
        },
        args: { type: 'object', description: '可选，注入为脚本里的 args', additionalProperties: true },
      },
      required: ['context', 'code'],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (args, ctx) => {
      const { result, identity } = await invoke({
        dshHome: ctx.dshHome,
        discovery: ctx.discovery,
        signal: ctx.signal,
        project: args.project,
        tool: 'execute_javascript',
        args: { context: args.context, code: args.code, args: args.args ?? {} },
        mutating: true,
        sessionId: ctx.sessionId,
        timeoutMs: 120000,
      })
      return {
        project: identity.projectPath,
        context: args.context,
        text: contentToText(result),
        data: result?.data ?? null,
      }
    },
  },
  {
    name: 'cocos_scene',
    description: '场景/节点操作：info 场景信息、hierarchy 层级、find 查找节点、inspect 节点详情、list 场景列表、'
      + 'open 打开场景、save 保存当前场景、create 新建场景。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        action: {
          type: 'string',
          enum: ['info', 'hierarchy', 'find', 'inspect', 'list', 'open', 'save', 'create'],
        },
        scene: { type: 'string', description: 'action=open/create 时的场景路径（db:// 或相对路径）' },
        query: { type: 'string', description: 'action=find 时的节点名/模式' },
        node: { type: 'string', description: 'action=inspect 时的节点路径或 UUID' },
        depth: { type: 'number', description: 'action=hierarchy 时的最大深度（默认上游默认值）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    mutating: false, // 由下面按 action 动态判断
    handler: async (args, ctx) => {
      const map = {
        info: { tool: 'get_scene_info', mutating: false },
        hierarchy: { tool: 'get_hierarchy', mutating: false },
        find: { tool: 'find_nodes', mutating: false },
        inspect: { tool: 'inspect_node', mutating: false },
        list: { tool: 'list_scenes', mutating: false },
        open: { tool: 'open_scene', mutating: true },
        save: { tool: 'save_current_scene', mutating: true },
        create: { tool: 'create_scene', mutating: true },
      }
      const spec = map[args.action]
      if (!spec) throw new CocosMcpError(`未知 action "${args.action}"`, { code: 'BAD_ARGS' })
      const payload = {}
      if (args.scene) {
        // 上游 open_scene / create_scene 的参数名是 target（0.7.0 实测：
        // 传 scene 会被上游当成空参数，报 "Asset uuid or path is required."）。
        if (args.action === 'open' || args.action === 'create') payload.target = args.scene
        else payload.scene = args.scene
      }
      if (args.query) payload.query = args.query
      if (args.node) payload.target = args.node
      if (typeof args.depth === 'number') payload.depth = args.depth
      const { result, identity } = await invoke({
        dshHome: ctx.dshHome,
        discovery: ctx.discovery,
        signal: ctx.signal,
        project: args.project,
        tool: spec.tool,
        args: payload,
        mutating: spec.mutating,
        sessionId: ctx.sessionId,
      })
      return { project: identity.projectPath, action: args.action, text: contentToText(result), data: result?.data ?? null }
    },
  },
  {
    name: 'cocos_asset',
    description: '资源操作：list 列表、inspect 详情、deps 依赖、validate 依赖校验、ready 导入就绪检查、refresh 刷新资源库。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        action: { type: 'string', enum: ['list', 'inspect', 'deps', 'validate', 'ready', 'refresh'] },
        target: { type: 'string', description: '资源路径（db://assets/...）或 UUID' },
        folder: { type: 'string', description: 'action=list 时的目录（db:// 路径）' },
        type: { type: 'string', description: 'action=list 时的资源类型过滤（如 cc.Prefab）' },
        wait_ms: { type: 'number', description: 'action=ready 的等待时间（0~10000）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    mutating: false,
    handler: async (args, ctx) => {
      const map = {
        list: { tool: 'list_assets', mutating: false },
        inspect: { tool: 'inspect_asset', mutating: false },
        deps: { tool: 'inspect_asset_dependencies', mutating: false },
        validate: { tool: 'validate_asset_dependencies', mutating: false },
        ready: { tool: 'check_asset_ready', mutating: false },
        refresh: { tool: 'refresh_assets', mutating: true },
      }
      const spec = map[args.action]
      if (!spec) throw new CocosMcpError(`未知 action "${args.action}"`, { code: 'BAD_ARGS' })
      const payload = {}
      if (args.target) payload.target = args.target
      if (args.folder) payload.folder = args.folder
      if (args.type) payload.type = args.type
      if (typeof args.wait_ms === 'number') payload.waitMs = args.wait_ms
      const { result, identity } = await invoke({
        dshHome: ctx.dshHome,
        discovery: ctx.discovery,
        signal: ctx.signal,
        project: args.project,
        tool: spec.tool,
        args: payload,
        mutating: spec.mutating,
        sessionId: ctx.sessionId,
      })
      return { project: identity.projectPath, action: args.action, text: contentToText(result), data: result?.data ?? null }
    },
  },
  {
    name: 'cocos_logs',
    description: '日志：recent 最近日志、search 按关键字搜索工程日志、clear 清空日志缓冲区。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        action: { type: 'string', enum: ['recent', 'search', 'clear'] },
        query: { type: 'string', description: 'action=search 的关键字' },
        limit: { type: 'number', description: '返回条数（默认 100）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    mutating: false,
    handler: async (args, ctx) => {
      const map = {
        recent: { tool: 'get_recent_logs', mutating: false },
        search: { tool: 'search_project_logs', mutating: false },
        clear: { tool: 'clear_logs', mutating: true },
      }
      const spec = map[args.action]
      if (!spec) throw new CocosMcpError(`未知 action "${args.action}"`, { code: 'BAD_ARGS' })
      const payload = {}
      if (args.query) payload.query = args.query
      if (typeof args.limit === 'number') payload.limit = args.limit
      const { result, identity } = await invoke({
        dshHome: ctx.dshHome,
        discovery: ctx.discovery,
        signal: ctx.signal,
        project: args.project,
        tool: spec.tool,
        args: payload,
        mutating: spec.mutating,
        sessionId: ctx.sessionId,
      })
      return { project: identity.projectPath, action: args.action, text: contentToText(result), data: result?.data ?? null }
    },
  },
  {
    name: 'cocos_screenshot',
    description: '截图：editor 编辑器窗口、scene 场景视图、preview 预览、game 游戏视图。'
      + '默认把图片存到 $DSH_HOME/game-forge/cocos/shots/ 并返回路径。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        scope: { type: 'string', enum: ['editor', 'scene', 'preview', 'game'], default: 'scene' },
        save: { type: 'boolean', description: '是否落盘（默认 true）', default: true },
      },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (args, ctx) => {
      const scope = args.scope ?? 'scene'
      const tool = {
        editor: 'capture_editor_screenshot',
        scene: 'capture_scene_screenshot',
        preview: 'capture_preview_screenshot',
        game: 'capture_game_screenshot',
      }[scope]
      const target = await resolveTarget({ dshHome: ctx.dshHome, project: args.project, requireLive: true, discovery: ctx.discovery })
      const { client, identity, tools } = await upstreamTools(target)
      if (!tools.some((item) => item.name === tool)) throw missingToolError(tool, tools)
      const result = await client.toolsCall(tool, {}, {
        expectedContext: identity.expectedContext,
        timeoutMs: 60000,
      })
      const save = args.save !== false
      const files = save ? persistImages(result, { dshHome: ctx.dshHome, slug: target.entry.slug, scope }) : []
      return {
        project: identity.projectPath,
        scope,
        files,
        data: result?.data ?? null,
        note: files.length === 0 && save
          ? '上游没有返回可直接落盘的图片数据（可能只给了内部路径），请看 data 字段。'
          : null,
      }
    },
  },
  {
    name: 'cocos_build',
    description: '命令行构建（CocosCreator --build）。构建默认全机串行（同一时间只跑一个），'
      + '避免多个项目同时构建把机器拖死、或抢 Cocos 自己的缓存。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        platform: { type: 'string', description: '构建平台，如 web-mobile / web-desktop / android', default: 'web-mobile' },
        debug: { type: 'boolean', description: '是否 debug 构建', default: true },
        extra: { type: 'string', description: '附加构建参数（`key=value;key2=value2` 形式）' },
        wait_ms: { type: 'number', description: '最多等待构建结束多久（默认 0 = 只启动不等待）', default: 0 },
        creator_exe: { type: 'string', description: 'CocosCreator.exe 路径（默认自动探测）' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    mutating: false,
    handler: async (args, ctx) => {
      const target = await resolveTarget({ dshHome: ctx.dshHome, project: args.project, requireLive: false, discovery: ctx.discovery })
      const exe = args.creator_exe && fs.existsSync(args.creator_exe)
        ? args.creator_exe
        : await resolveCreatorExe({ dshHome: ctx.dshHome, entry: target.entry, discovery: ctx.discovery })
      const parts = [`platform=${args.platform ?? 'web-mobile'}`, `debug=${args.debug === false ? 'false' : 'true'}`]
      if (args.extra) parts.push(String(args.extra))
      const buildArg = parts.join(';')
      const maxSlots = Number(ctx.config?.buildSlots ?? 1) || 1
      const owner = makeOwner(`build:${target.entry.slug}`)
      const waitMs = Math.max(0, Number(args.wait_ms) || 0)
      // 构建期间要持有该项目的写锁：构建和「交互改场景」并发是典型的坏组合
      // （两路同时写 library/ 与场景文件）。锁 TTL 覆盖构建等待期 + 心跳保活。
      const lockTtl = Math.max(60 * 60 * 1000, waitMs + 10 * 60 * 1000)
      const lockAcquired = await acquireFileLock(projectLockPath(ctx.dshHome, target.entry.slug), {
        owner, ttlMs: lockTtl, waitMs: 0, note: `build ${args.platform ?? 'web-mobile'}`,
      })
      if (!lockAcquired.ok) {
        const holder = lockAcquired.holder ?? {}
        throw new CocosMcpError(
          `项目 ${target.entry.slug} 有另一个写操作进行中（${holder.label ?? '?'}），构建会与它冲突，已取消。`
          + '先等该操作结束，或用 cocos_status 查看持有者。',
          { code: 'PROJECT_BUSY' },
        )
      }
      const slot = await acquireBuildSlot(ctx.dshHome, owner, {
        max: maxSlots,
        // 只启动不等待时给 30 秒排队时间，否则等构建本身的时间。
        waitMs: waitMs > 0 ? waitMs + 30000 : 30000,
        ttlMs: Math.max(60 * 60 * 1000, waitMs + 10 * 60 * 1000),
      })
      if (!slot.ok) {
        const holders = (slot.holders ?? []).map((item) => `slot${item.slot}: ${item.holder?.label ?? '?'}`).join('；')
        // 拿不到构建槽位：把上面的项目写锁还回去，否则项目会被锁死到 TTL。
        releaseFileLock(projectLockPath(ctx.dshHome, target.entry.slug), owner)
        throw new CocosMcpError(
          `构建槽位已满（上限 ${maxSlots}，全机串行）。当前占用：${holders || '未知'}。`
          + '等当前构建结束再试；这是为了避免多个项目同时构建互相拖慢、抢 Cocos 缓存。',
          { code: 'BUILD_BUSY' },
        )
      }
      const lockFile = projectLockPath(ctx.dshHome, target.entry.slug)
      // 锁续期 + 统一释放：构建可能跑几十分钟，没有心跳会被 TTL 判为残留。
      const lockHeartbeat = setInterval(() => { touchFileLock(lockFile, owner, lockTtl) }, Math.max(500, Math.floor(lockTtl / 3)))
      lockHeartbeat.unref?.()
      const releaseAll = () => {
        clearInterval(lockHeartbeat)
        releaseFileLock(lockFile, owner)
        releaseBuildSlot(slot.file, owner)
      }
      const buildShotDir = shotsDir(ctx.dshHome)
      // 每次构建留一份带时间戳的日志；目录只保留最近 N 份，否则会一直涨。
      pruneArtifacts(buildShotDir, { match: /-build-\d+\.log$/ })
      const logFile = path.join(buildShotDir, `${target.entry.slug}-build-${Date.now()}.log`)
      let buildError = null
      let child
      try {
        child = spawnCreator(exe, ['--project', target.entry.path, '--build', buildArg], {
          cwd: target.entry.path,
          logFile,
          onError: (error) => { buildError = error },
        })
      } catch (error) {
        releaseAll()
        throw error
      }
      const base = {
        project: target.entry.path,
        pid: child.pid ?? null,
        platform: args.platform ?? 'web-mobile',
        buildArg,
        logFile,
      }
      if (waitMs <= 0) {
        // 不等待：构建结束（或进程根本没起来）就释放槽位与项目锁。
        // 事件 + 兜底轮询两条路：detached 进程的 exit 事件在某些启动器上不可靠，
        // 但只靠 pid 存活判断又可能因为 pid 复用而误判。
        let timer = null
        const cleanup = () => {
          if (timer !== null) { clearInterval(timer); timer = null }
          releaseAll()
        }
        child.on('exit', cleanup)
        child.on('error', cleanup)
        timer = setInterval(() => {
          let alive = true
          try { process.kill(child.pid, 0) } catch { alive = false }
          if (!alive) cleanup()
        }, 5000)
        timer.unref?.()
        if (buildError !== null) {
          cleanup()
          throw new CocosMcpError(`启动构建失败：${buildError.message ?? buildError}（exe: ${exe}）`, { code: 'SPAWN_FAILED' })
        }
        return {
          ...base,
          waiting: false,
          note: '构建已启动；在此期间该项目被写锁占用（改场景/资源会等到构建结束），'
            + '用 cocos_status 看槽位、用日志文件跟踪进度。',
        }
      }
      const deadline = Date.now() + waitMs
      let exitCode = null
      let timedOut = false
      let cancelled = false
      await new Promise((resolve) => {
        let poll = null
        const finish = (code) => {
          exitCode = code
          if (poll !== null) clearInterval(poll)
          resolve()
        }
        child.on('exit', (code) => finish(code))
        child.on('error', () => finish(null))
        // 客户端取消：停止等待，但构建进程继续跑（它是 detached 的独立进程），
        // 锁按「超时」那条路径移交给看门狗 —— 不能在这里放锁。
        const onAbort = () => { cancelled = true; finish(null) }
        if (ctx.signal?.aborted) onAbort()
        else ctx.signal?.addEventListener?.('abort', onAbort, { once: true })
        poll = setInterval(() => {
          if (Date.now() > deadline) { timedOut = true; finish(null) }
        }, 1000)
        poll.unref?.()
      })
      if (timedOut || cancelled) {
        // 超时 ≠ 构建结束：进程还在写 build/ 与 library/。**绝不能**在这个状态
        // 放掉项目锁——那等于告诉其它会话「可以安全改场景了」，而工程此刻正被
        // 构建进程写。把锁移交给后台看门狗，进程真正退出才释放。
        releaseBuildSlot(slot.file, owner)
        clearInterval(lockHeartbeat)
        const watchdog = setInterval(() => {
          let alive = true
          try { process.kill(child.pid, 0) } catch { alive = false }
          if (!alive) {
            clearInterval(watchdog)
            releaseFileLock(lockFile, owner)
          }
        }, 5000)
        watchdog.unref?.()
        let tail = ''
        try { tail = fs.readFileSync(logFile, 'utf8').slice(-4000) } catch { /* 还没落盘 */ }
        return {
          ...base,
          waiting: true,
          timedOut,
          cancelled,
          exitCode: null,
          finished: false,
          logTail: tail,
          note: cancelled
            ? `等待已被客户端取消，但构建进程（pid ${child.pid}）还在跑。`
              + '项目写锁保留到构建真正结束；期间该项目不能改场景/资源。'
            : `等待 ${Math.round(waitMs / 1000)}s 后超时，但构建进程（pid ${child.pid}）还在跑。`
              + '项目写锁保留到构建真正结束；期间该项目不能改场景/资源。',
        }
      }
      releaseAll()
      if (buildError !== null) {
        throw new CocosMcpError(`构建进程启动失败：${buildError.message ?? buildError}（exe: ${exe}）`, { code: 'SPAWN_FAILED' })
      }
      let tail = ''
      try {
        const text = fs.readFileSync(logFile, 'utf8')
        tail = text.slice(-4000)
      } catch { /* 日志还没落盘 */ }
      return {
        ...base,
        waiting: true,
        exitCode,
        finished: exitCode !== null,
        logTail: tail,
      }
    },
  },
  {
    name: 'cocos_preview',
    description: '预览控制：run 启动预览、mode 查询当前预览模式、set_mode 切换模式（browser/gameView/simulator）。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        action: { type: 'string', enum: ['run', 'mode', 'set_mode'], default: 'run' },
        mode: { type: 'string', enum: ['browser', 'gameView', 'simulator'], description: 'action=set_mode 时的目标模式' },
      },
      additionalProperties: false,
    },
    mutating: false,
    handler: async (args, ctx) => {
      const action = args.action ?? 'run'
      const tool = action === 'mode' ? 'get_preview_mode' : action === 'set_mode' ? 'set_preview_mode' : 'run_project_preview'
      const payload = action === 'set_mode' ? { mode: args.mode, platform: args.mode } : {}
      const { result, identity } = await invoke({
        dshHome: ctx.dshHome,
        discovery: ctx.discovery,
        signal: ctx.signal,
        project: args.project,
        tool,
        args: payload,
        mutating: action === 'run',
        sessionId: ctx.sessionId,
      })
      return { project: identity.projectPath, action, text: contentToText(result), data: result?.data ?? null }
    },
  },
  {
    name: 'cocos_raw',
    description: '直接调用上游 Cocos MCP 的任意工具（高级用法）。只读工具请显式传 mutating=false，'
      + '否则默认按写操作加项目锁并带身份令牌。',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        tool: { type: 'string', description: '上游工具名，例如 check_asset_ready' },
        arguments: { type: 'object', description: '上游工具参数', additionalProperties: true },
        mutating: { type: 'boolean', description: '是否按写操作处理（默认 true）', default: true },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    mutating: false,
    handler: async (args, ctx) => {
      const { result, identity } = await invoke({
        dshHome: ctx.dshHome,
        discovery: ctx.discovery,
        signal: ctx.signal,
        project: args.project,
        tool: args.tool,
        args: args.arguments ?? {},
        mutating: args.mutating !== false,
        sessionId: ctx.sessionId,
        timeoutMs: 120000,
      })
      return { project: identity.projectPath, tool: args.tool, text: contentToText(result), data: result?.data ?? null }
    },
  },
]

/** 名字 → 定义。 */
export const TOOL_INDEX = new Map(TOOL_DEFINITIONS.map((def) => [def.name, def]))

/** 供 MCP `tools/list` 用的 schema（去掉 handler）。 */
export function toolSchemas() {
  return TOOL_DEFINITIONS.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  }))
}

export { pruneArtifacts }