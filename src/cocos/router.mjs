/**
 * 路由层：把「项目」这个参数解析成一个已经验明正身的 MCP 连接。
 *
 * 这一层是多项目并发的核心闸门，规则只有三条，但每条都不能省：
 *
 *  1. **不做默认猜测。** 只有一个项目在跑时可以用默认值；一旦有两个以上，
 *     缺 `project` 就直接报错并列出候选。给个「最近用过的」看起来贴心，
 *     实际是把改动打到错误工程的最快路径。
 *  2. **连接后必须验身份。** 端口会说谎（被别的实例占用、编辑器重启后端口变化、
 *     旧配置指到回退端口），`initialize` 回来的 `project_path` 才是身份。
 *     路径对不上就**断开并报错**，绝不放行。
 *  3. **写操作加项目锁。** 同一项目同一时间只有一个写操作；锁的持有者会写进
 *     错误信息里，让并发的另一个会话知道该等谁。
 *
 * @module src/cocos/router.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { CocosMcpError, McpHttpClient } from './mcp-http.mjs'
import { discoverLive, findRunningProject, groupByProject } from './discover.mjs'
import { listProjects, resolveProjectRef, upsertProject } from './registry.mjs'
import { makeOwner, withProjectLock, buildSlotsStatus } from './locks.mjs'
import { normalizeProjectPath, projectSlug, sameProjectPath } from './paths.mjs'

/** 读工程元信息（name / creator 版本）；不是 Cocos 工程返回 null。 */
export function readProjectMeta(projectPath) {
  const normal = normalizeProjectPath(projectPath)
  const pkgFile = path.join(normal, 'package.json')
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  } catch {
    return null
  }
  if (pkg === null || typeof pkg !== 'object') return null
  const hasAssets = fs.existsSync(path.join(normal, 'assets'))
  const creatorVersion = typeof pkg.creator?.version === 'string' ? pkg.creator.version : ''
  if (!hasAssets && creatorVersion === '') return null
  return {
    path: normal,
    name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : path.basename(normal),
    creatorVersion,
    uuid: typeof pkg.uuid === 'string' ? pkg.uuid : '',
    hasAssets,
  }
}

/** 从若干候选里挑一个「正在运行且带 MCP」的健康端点；优先交互实例。 */
function pickHealth(group) {
  if (!group || group.healths.length === 0) return null
  // 交互实例优先：命令行构建实例（--build）不该成为交互目标。
  const interactivePid = group.interactivePid
  const owned = group.instances
    .filter((instance) => instance.pid === interactivePid)
    .flatMap((instance) => instance.mcpHealths)
  if (owned.length > 0) return owned[0]
  return group.healths[0]
}

/**
 * 解析目标项目。
 *
 * @param {object} opts
 * @param {string} [opts.dshHome]
 * @param {string} [opts.project] slug / 目录名 / 路径
 * @param {boolean} [opts.requireLive] 是否要求编辑器正在运行
 * @param {number} [opts.cacheMs]
 */
export async function resolveTarget({ dshHome, project, requireLive = true, cacheMs } = {}) {
  const discovery = await discoverLive({ cacheMs })
  const groups = groupByProject(discovery)
  const projects = listProjects(dshHome)

  let entry = null
  if (project !== null && project !== undefined && String(project).trim() !== '') {
    entry = resolveProjectRef(dshHome, project)
    if (entry === null) {
      // 用户可能直接给了个路径：能读成 Cocos 工程就自动登记，省一步。
      // 已登记过的（路径一致）直接复用，避免每条调用都过一次跨进程锁。
      const meta = readProjectMeta(String(project))
      if (meta !== null) {
        const known = projects.find((item) => sameProjectPath(item.path, meta.path))
        entry = known ?? (await upsertProject(dshHome, {
          slug: projectSlug(meta.path),
          name: meta.name,
          path: meta.path,
          creatorVersion: meta.creatorVersion,
        })).projects[projectSlug(meta.path)]
      } else {
        throw new CocosMcpError(
          `不认识项目 "${project}"。已登记的项目：${projects.length > 0 ? projects.map((item) => item.slug).join('、') : '(空)'}。`
          + '请用 /game-cocos list 查看，或传一个含 assets/ 的 Cocos 工程目录。',
          { code: 'UNKNOWN_PROJECT' },
        )
      }
    }
  }

  if (entry === null) {
    if (groups.length === 0) {
      throw new CocosMcpError(
        '当前没有正在运行的 Cocos Creator 实例。请先打开编辑器（或用 cocos_open 启动），再调用需要项目的工具。',
        { code: 'NO_EDITOR' },
      )
    }
    if (groups.length > 1) {
      const list = groups
        .map((group) => `${projectSlug(group.projectPath)} → ${group.projectPath}`)
        .join('；')
      throw new CocosMcpError(
        `同时有 ${groups.length} 个 Cocos 项目在运行，必须显式指定 project（不会替你猜）：${list}`,
        { code: 'AMBIGUOUS_PROJECT' },
      )
    }
    const only = groups[0]
    // 已经登记过就不要每次都写一遍注册表：注册表写入现在带跨进程锁，
    // 每条工具调用都写一次 = 每条调用多一次加锁 + 落盘（而且毫无信息增量）。
    const known = projects.find((item) => sameProjectPath(item.path, only.projectPath))
    if (known) {
      entry = known
    } else {
      const meta = readProjectMeta(only.projectPath)
      const slug = projectSlug(only.projectPath)
      const saved = await upsertProject(dshHome, {
        slug,
        name: meta?.name ?? path.basename(only.projectPath),
        path: only.projectPath,
        creatorVersion: meta?.creatorVersion ?? '',
      })
      entry = saved.projects[slug]
    }
  }

  const group = findRunningProject(discovery, entry.path)
  if (requireLive) {
    if (group === null || pickHealth(group) === null) {
      throw new CocosMcpError(
        `项目 ${entry.slug}（${entry.path}）没有可用的 Cocos MCP 端点。`
        + '可能原因：编辑器没开、Cocos MCP 扩展没装/没启动、或端口被别的进程占用。'
        + '可以用 /game-cocos status 看详情，/game-cocos install 装扩展。',
        { code: 'NO_ENDPOINT' },
      )
    }
  }
  return { entry, group, health: group === null ? null : pickHealth(group), discovery }
}

/**
 * 建立并验证连接。
 *
 * @returns {Promise<{client: McpHttpClient, identity: object, endpoint: string}>}
 */
export async function connectTarget(target, { timeoutMs = 20000 } = {}) {
  const health = target.health
  if (health === null) throw new CocosMcpError('没有可用的 MCP 端点', { code: 'NO_ENDPOINT' })
  // 绑定项目的 scoped URL：上游会用它做路由保护，比裸 `/` 更保险。
  const scoped = health.projectId !== ''
    ? `http://127.0.0.1:${health.port}/mcp/project/${encodeURIComponent(health.projectId)}/`
    : `http://127.0.0.1:${health.port}/`
  const client = new McpHttpClient(scoped, { timeoutMs })
  try {
    await client.initialize()
  } catch (error) {
    // scoped URL 不被老版本支持时退回根端点（身份校验仍会做）。
    if (scoped.endsWith('/') && health.projectId !== '') {
      const fallback = new McpHttpClient(`http://127.0.0.1:${health.port}/`, { timeoutMs })
      await fallback.initialize()
      return verifyIdentity(fallback, target, `http://127.0.0.1:${health.port}/`)
    }
    throw error
  }
  return verifyIdentity(client, target, scoped)
}

/** 身份校验：路径必须指向同一个项目；project_id 若双方都有也必须一致。 */
function verifyIdentity(client, target, endpoint) {
  const identity = client.identity()
  const expectedPath = target.entry.path
  if (identity.projectPath !== '' && !sameProjectPath(identity.projectPath, expectedPath)) {
    throw new CocosMcpError(
      `端口 ${target.health?.port ?? '?'} 上的 Cocos MCP 属于另一个项目：`
      + `它自报 ${identity.projectPath}，但你要操作的是 ${expectedPath}。已中止（防止写错工程）。`
      + '请检查是否有多个编辑器实例占用了同一端口，或端口回退后配置没有更新。',
      { code: 'PROJECT_MISMATCH' },
    )
  }
  if (identity.projectPath === '') {
    throw new CocosMcpError(
      `无法确认端口 ${target.health?.port ?? '?'} 上的服务属于哪个项目（initialize 没有返回 project_path）。`
      + '为避免写错工程，已中止。请确认安装的是支持项目身份上报的 Cocos MCP 扩展。',
      { code: 'UNVERIFIED_IDENTITY' },
    )
  }
  if (identity.projectId !== '' && target.health?.projectId !== ''
    && identity.projectId !== target.health.projectId) {
    throw new CocosMcpError(
      `项目身份令牌不一致（端口上报 ${target.health.projectId}，握手返回 ${identity.projectId}）。`
      + '编辑器可能刚重启过，请重试或重新运行发现。',
      { code: 'PROJECT_MISMATCH' },
    )
  }
  return { client, identity, endpoint }
}

/**
 * 调用上游工具（统一入口）。
 *
 * @param {object} opts
 * @param {string} [opts.dshHome]
 * @param {string} [opts.project]
 * @param {string} opts.tool 上游工具名
 * @param {object} [opts.args]
 * @param {boolean} [opts.mutating] 是否写操作（写操作加项目锁 + 带身份令牌）
 * @param {number} [opts.waitMs] 等锁的时间
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.sessionId] 会话标识（写进锁，便于排查谁占着）
 */
export async function callProjectTool({
  dshHome, project, tool, args = {}, mutating = false, waitMs = 0, timeoutMs = 60000, sessionId = '',
} = {}) {
  const target = await resolveTarget({ dshHome, project, requireLive: true })
  const run = async () => {
    const { client, identity, endpoint } = await connectTarget(target, { timeoutMs })
    const result = await client.toolsCall(tool, args, {
      // 只读调用不带令牌（见 tools.mjs 里的同一处说明）。
      expectedContext: mutating ? identity.expectedContext : '',
      timeoutMs,
    })
    return { result, identity, endpoint }
  }
  if (!mutating) return run()
  const owner = makeOwner(`tool:${tool}${sessionId ? `@${sessionId}` : ''}`)
  return withProjectLock(dshHome, target.entry.slug, owner, run, {
    waitMs,
    note: `${target.entry.name || target.entry.slug} ← ${tool}`,
  })
}

/**
 * 所有项目的合并视图（注册表 + 实时状态）。
 *
 * 这是 `cocos_projects` / `cocos_status` 的数据源，也是设置页要展示的东西。
 */
export async function projectOverview({ dshHome, cacheMs, buildSlotLimit = 1 } = {}) {
  const discovery = await discoverLive({ cacheMs })
  const groups = groupByProject(discovery)
  const registered = listProjects(dshHome)
  const seen = new Set()
  const views = []

  for (const entry of registered) {
    const group = findRunningProject(discovery, entry.path)
    const health = group === null ? null : pickHealth(group)
    seen.add(entry.slug)
    views.push({
      slug: entry.slug,
      name: entry.name,
      path: entry.path,
      creatorVersion: entry.creatorVersion || '',
      registered: true,
      running: group !== null,
      interactivePid: group?.interactivePid ?? null,
      buildPids: group?.buildPids ?? [],
      port: health?.port ?? null,
      endpoint: health === null ? null : `http://127.0.0.1:${health.port}/`,
      mcp: health === null ? null : {
        name: health.name,
        version: health.version,
        projectId: health.projectId,
        projectPath: health.projectPath,
        matchesRegistry: sameProjectPath(health.projectPath, entry.path),
      },
      lastSeen: entry.lastSeen ?? null,
    })
  }

  // 开着但没登记过的项目也列出来（不写注册表，只提示）。
  for (const group of groups) {
    const slug = projectSlug(group.projectPath)
    if (seen.has(slug)) continue
    const health = pickHealth(group)
    views.push({
      slug,
      name: path.basename(group.projectPath),
      path: group.projectPath,
      creatorVersion: '',
      registered: false,
      running: true,
      interactivePid: group.interactivePid,
      buildPids: group.buildPids,
      port: health?.port ?? null,
      endpoint: health === null ? null : `http://127.0.0.1:${health.port}/`,
      mcp: health === null ? null : {
        name: health.name,
        version: health.version,
        projectId: health.projectId,
        projectPath: health.projectPath,
        matchesRegistry: true,
      },
      lastSeen: null,
    })
  }

  return {
    projects: views.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')),
    buildSlots: buildSlotsStatus(dshHome, buildSlotLimit),
    buildSlotLimit: Math.max(1, Number(buildSlotLimit) || 1),
    probedAt: discovery.probedAt,
    platform: discovery.platform,
  }
}
