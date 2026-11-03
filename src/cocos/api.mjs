/**
 * 设置页用到的 Cocos 接口实现（host 侧）。
 *
 * 为什么单独一层：index.js 里的 `/api/game-forge` 路由已经很长了，
 * 这里把「读状态 / 登记 / 装扩展」三件事收拢，UI 只认这三个动作。
 * 路由层只做参数校验和 HTTP 状态码，业务与错误文案都在这。
 *
 * @module src/cocos/api.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installExtension } from './install.mjs'
import { mcpRowStatus, removeMcpRow, resolveNodeBin, upsertMcpRow } from './register.mjs'
import { projectOverview, readProjectMeta } from './router.mjs'
import { normalizeProjectPath } from './paths.mjs'

/** `cocos` MCP 服务入口（登记到 DSH 配置里就是它）。 */
export const COCOS_HUB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs')

/** 设置页「Cocos」卡片的数据源：注册表 + 实时进程 + 登记状态。 */
export async function cocosStatus({ dshHome, buildSlots = 1 } = {}) {
  const overview = await projectOverview({ dshHome, cacheMs: 0, buildSlotLimit: buildSlots })
  const row = mcpRowStatus({ dshHome })
  return {
    registered: row.registered,
    patchFile: row.file,
    patchExists: row.exists,
    hubPath: COCOS_HUB_PATH,
    buildSlotLimit: Math.max(1, Number(buildSlots) || 1),
    buildSlots: overview.buildSlots,
    projects: overview.projects,
    platform: overview.platform,
    probedAt: overview.probedAt,
  }
}

/**
 * 登记 / 撤销 `cocos` MCP 服务。
 *
 * 这是「替用户改配置」，所以：
 *  - 只在用户点按钮时调用（UI 上有明确文案说明会写哪个文件）；
 *  - 写入前由 register.mjs 做格式校验与备份，冲突不静默覆盖。
 *
 * @returns {{registered: boolean, changed: boolean, action: string, file: string, backup?: string, note: string}}
 */
export function cocosSetRegistration({ dshHome, enabled = true, buildSlots = 1 } = {}) {
  if (enabled === false) {
    const result = removeMcpRow({ dshHome })
    return {
      registered: false,
      changed: result.changed,
      action: result.action,
      file: result.file,
      backup: result.backup,
      note: result.changed ? '已撤销登记（DSH 需要重启一次才会真正卸载工具）。' : '本来就没有登记行。',
    }
  }
  const result = upsertMcpRow({
    dshHome,
    nodePath: resolveNodeBin(),
    hubPath: COCOS_HUB_PATH,
    buildSlots: Math.max(1, Number(buildSlots) || 1),
  })
  return {
    registered: true,
    changed: result.changed,
    action: result.action,
    file: result.file,
    backup: result.backup,
    note: result.changed
      ? '已写入配置。桌面端通常需要重启一次才会出现 cocos_* 工具。'
      : '配置已是最新。',
  }
}

/**
 * 给某个 Cocos 工程装 MCP 扩展。
 *
 * `--yes` 的等价物是 UI 上的确认按钮（会明确写出「下载 + 解压到哪」），
 * 所以这里只做参数校验，不做二次询问。
 */
export async function cocosInstall({ dshHome, projectPath, global = false, force = false } = {}) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    const error = new Error('请填写 Cocos 工程目录')
    error.statusCode = 400
    throw error
  }
  const normal = normalizeProjectPath(projectPath.trim())
  if (!fs.existsSync(normal)) {
    const error = new Error(`目录不存在：${normal}`)
    error.statusCode = 400
    throw error
  }
  const meta = readProjectMeta(normal)
  if (meta === null) {
    const error = new Error(`${normal} 不是 Cocos 工程（缺 package.json 或 assets/）`)
    error.statusCode = 400
    throw error
  }
  const result = await installExtension({ projectPath: normal, dshHome, global, force })
  return result
}
