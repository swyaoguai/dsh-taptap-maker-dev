/**
 * 把 `cocos` MCP 服务登记进 DSH 的配置层（profile patch），以及撤掉。
 *
 * 为什么走 patch 层而不是让用户手改：
 *  - DSH 的配置是「bundle 层 + profile patch + home patch + --patch 覆盖」逐层组合的，
 *    profile 的 `cordis.patch.yml` 就是给用户/插件写自己的条目的地方，而且**热加载**
 *    （保存后一两秒重新组合），不用重启桌面端。
 *  - 冒烟式地直接改 bundle 里的文件会随插件升级被覆盖，不能这么做。
 *
 * 安全约束（这块是「替用户改配置」，必须克制）：
 *  - 只增删 `id: mcp-cocos` 这一条，其它行原样保留（含注释、缩进、用户自己的条目）；
 *  - 文件不是合法条目列表（比如混了非列表内容）就**拒绝写入**并报告，不硬塞；
 *  - 已存在但被改过（serverName/命令不是我们写的）时不静默覆盖，交回用户确认。
 *
 * @module src/cocos/register.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { CocosMcpError } from './mcp-http.mjs'
import { profilePatchPath } from './paths.mjs'

export const MCP_ROW_ID = 'mcp-cocos'
export const MCP_SERVER_NAME = 'cocos'

function q(value) {
  // YAML 单引号字符串：内部的单引号写成两个。
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * 找出 patch 文件里属于我们那一行的文本块（从 `- id: mcp-cocos` 到下一个顶层条目）。
 *
 * 这里刻意做「文本级」处理而不是用 YAML 解析再回写：回写会丢掉用户的注释、
 * 顺序与格式，而这是用户自己的配置文件。
 */
export function findRowBlock(text, rowId = MCP_ROW_ID) {
  const lines = String(text).split(/\r?\n/)
  const startPattern = new RegExp(`^-\\s+id:\\s*['"]?${rowId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (startPattern.test(lines[i])) { start = i; break }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) { end = i; break }
  }
  return { start, end, lines, block: lines.slice(start, end).join('\n') }
}

/** 当前配置里是否已经登记了我们的条目。 */
export function mcpRowStatus({ dshHome } = {}) {
  const file = profilePatchPath(dshHome)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { file, exists: false, registered: false, block: null }
  }
  const found = findRowBlock(text)
  return {
    file,
    exists: true,
    registered: found !== null,
    block: found?.block ?? null,
  }
}

/** 渲染我们那一行的标准文本。 */
export function renderRow({ nodePath, hubPath, serverName = MCP_SERVER_NAME, buildSlots = 1, timeoutMs = 600000 }) {
  const lines = [
    `- id: ${MCP_ROW_ID}`,
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  # 由 dsh-game-forge 的 /game-cocos register 写入；删掉这一整条即可注销。',
    '  config:',
    `    serverName: ${serverName}`,
    '    transport: stdio',
    `    command: ${q(nodePath)}`,
    '    args:',
    `      - ${q(hubPath)}`,
    "      - '--build-slots'",
    `      - '${buildSlots}'`,
    `    toolCallTimeoutMs: ${timeoutMs}`,
    '    failOnStartupError: false',
  ]
  return lines.join('\n')
}

/**
 * 写入 / 更新登记行。
 *
 * @returns {{changed: boolean, action: string, file: string, backup?: string}}
 */
export function upsertMcpRow({ dshHome, nodePath, hubPath, serverName = MCP_SERVER_NAME, buildSlots = 1, force = false } = {}) {
  if (!nodePath || !fs.existsSync(nodePath)) {
    throw new CocosMcpError(`找不到 node 可执行文件：${nodePath || '(空)'}`, { code: 'NO_NODE' })
  }
  if (!hubPath || !fs.existsSync(hubPath)) {
    throw new CocosMcpError(`找不到 cocos MCP 服务入口：${hubPath || '(空)'}`, { code: 'NO_HUB' })
  }
  const file = profilePatchPath(dshHome)
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) {
    throw new CocosMcpError(`没有找到 DSH profile 目录：${dir}（DSH_PROFILE=${process.env.DSH_PROFILE ?? 'desktop'}）`, { code: 'NO_PROFILE' })
  }
  let text = ''
  if (fs.existsSync(file)) {
    text = fs.readFileSync(file, 'utf8')
  }

  const trimmed = text.trim()
  const looksLikeList = trimmed === '' || trimmed.startsWith('- ') || trimmed.startsWith('[]') || trimmed.startsWith('#')
  if (!looksLikeList) {
    throw new CocosMcpError(
      `${file} 不是一份合法的条目列表（应以 "- id:" 或注释开头）。为避免写坏你的配置，已中止。`,
      { code: 'PATCH_NOT_A_LIST' },
    )
  }

  const row = renderRow({ nodePath, hubPath, serverName, buildSlots })
  const found = findRowBlock(text)
  let next
  let action
  if (found !== null) {
    const ours = found.block.includes("name: '@deepseek-ai/dsh-mcp-client'")
    if (!ours && !force) {
      throw new CocosMcpError(
        `配置里已经有一个 id 为 ${MCP_ROW_ID} 的条目，但它不像是本插件写的。`
        + '为避免覆盖你手写的内容，已中止。确认要覆盖请加 --force。',
        { code: 'ROW_CONFLICT' },
      )
    }
    if (found.block.trim() === row.trim()) {
      return { changed: false, action: 'unchanged', file }
    }
    const lines = text.split(/\r?\n/)
    next = [...lines.slice(0, found.start), ...row.split('\n'), ...lines.slice(found.end)].join('\n')
    action = 'updated'
  } else if (trimmed === '' || trimmed === '[]') {
    next = `# dsh-game-forge: Cocos MCP 入口（/game-cocos register 写入）\n${row}\n`
    action = 'created'
  } else {
    const separator = text.endsWith('\n') ? '' : '\n'
    next = `${text}${separator}\n# dsh-game-forge: Cocos MCP 入口（/game-cocos register 写入）\n${row}\n`
    action = 'appended'
  }

  // 备份一次，改坏了用户可以手回滚。
  const backup = `${file}.bak-cocos-${Date.now()}`
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, backup)
  } catch { /* 备份失败不阻断，但下面写失败要报错 */ }

  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, file)
  return { changed: true, action, file, backup: fs.existsSync(backup) ? backup : undefined }
}

/** 撤掉登记行（整块删除，其它内容不动）。 */
export function removeMcpRow({ dshHome } = {}) {
  const file = profilePatchPath(dshHome)
  if (!fs.existsSync(file)) return { changed: false, action: 'missing', file }
  const text = fs.readFileSync(file, 'utf8')
  const found = findRowBlock(text)
  if (found === null) return { changed: false, action: 'absent', file }
  const lines = text.split(/\r?\n/)
  const next = [...lines.slice(0, found.start), ...lines.slice(found.end)].join('\n')
  const backup = `${file}.bak-cocos-${Date.now()}`
  try { fs.copyFileSync(file, backup) } catch { /* 忽略 */ }
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, file)
  return { changed: true, action: 'removed', file, backup }
}

/**
 * 解析一个真实的 node 可执行文件。
 *
 * `process.execPath` 在 Electron 宿主里是 app 的 exe（不是 node），直接拿它当
 * stdio MCP 的 command 会得到一个「启动即退出」的服务 —— 而报错信息通常只有
 * "connection closed"，很难查。所以这里显式挑 node。
 */
export function resolveNodeBin() {
  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !candidates.includes(value)) candidates.push(value)
  }
  push(process.env.DSH_NODE_BIN)
  push(process.env.NODE_BINARY)
  if (/^node(\.exe)?$/i.test(path.basename(process.execPath))) push(process.execPath)
  if (process.platform === 'win32') {
    push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'))
    const where = spawnSync('where', ['node'], { encoding: 'utf8' })
    if (where.status === 0) {
      for (const line of String(where.stdout ?? '').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.toLowerCase().endsWith('node.exe')) push(trimmed)
      }
    }
  } else {
    const which = spawnSync('which', ['node'], { encoding: 'utf8' })
    if (which.status === 0) push(String(which.stdout ?? '').trim())
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch { /* 继续找 */ }
  }
  throw new CocosMcpError(
    '找不到 node 可执行文件。请在环境变量里设置 DSH_NODE_BIN 指向 node（例如 C:\\Program Files\\nodejs\\node.exe）。',
    { code: 'NO_NODE' },
  )
}
