/**
 * Cocos 集成用到的路径与「项目标识」规则。
 *
 * 设计要点（多项目并发的地基）：
 *  - 所有状态都落在 $DSH_HOME/game-forge/cocos/ 下，**不写进 Cocos 工程**：
 *    工程目录会被 Cocos 编辑器 import、被用户 git 提交，插件状态混进去只会添乱。
 *  - 每个项目一个稳定 slug（目录名 + 路径哈希）：同名目录放在不同路径也区分得开，
 *    这样锁文件、注册表键、日志名都不会互相踩。
 *  - 路径比较统一走 realpath + Windows 大小写不敏感，否则 `D:\a` 与 `d:\A\` 会被
 *    当成两个项目，锁就形同虚设。
 *
 * @module src/cocos/paths.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { dataDir, resolveDshHome } from '../paths.js'

/** Cocos 集成的私有数据目录（自动创建）。 */
export function cocosRoot(dshHome) {
  const dir = path.join(dataDir(dshHome), 'cocos')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 已知项目注册表。 */
export function registryPath(dshHome) {
  return path.join(cocosRoot(dshHome), 'projects.json')
}

/** 每项目写锁目录。 */
export function locksDir(dshHome) {
  const dir = path.join(cocosRoot(dshHome), 'locks')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 截图落盘目录。 */
export function shotsDir(dshHome) {
  const dir = path.join(cocosRoot(dshHome), 'shots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 扩展安装包的下载缓存。 */
export function downloadDir(dshHome) {
  const dir = path.join(cocosRoot(dshHome), 'downloads')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 规范化项目路径：绝对路径 + realpath（解符号链接/短路径）。
 * 失败时退回 resolve 结果 —— 项目可能还没创建，不能因此抛错。
 */
export function normalizeProjectPath(input) {
  const abs = path.resolve(String(input))
  try {
    return fs.realpathSync.native(abs)
  } catch {
    return abs
  }
}

/** 去掉末尾分隔符（`D:\foo\` → `D:\foo`），根路径除外。 */
export function stripTrailingSep(value) {
  const s = String(value)
  if (s.length <= 3) return s
  return s.replace(/[\\/]+$/, '')
}

/** 两个路径是否指同一个项目（Windows 大小写不敏感）。 */
export function sameProjectPath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  const na = normalizeProjectPath(stripTrailingSep(a))
  const nb = normalizeProjectPath(stripTrailingSep(b))
  if (process.platform === 'win32') return na.toLowerCase() === nb.toLowerCase()
  return na === nb
}

/** 目录名 → 可读 slug 片段（ASCII 安全，非 ASCII 目录名退回 project）。 */
function slugStem(projectPath) {
  const normal = normalizeProjectPath(projectPath)
  const base = path.basename(normal) || 'project'
  const ascii = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
  return ascii || 'project'
}

/**
 * 稳定的项目 slug：`wxzj-cocos-1a2b3c`。
 *
 * 哈希输入是「规范化后的全路径小写」，所以：
 *  - 同目录名、不同路径 → 不同 slug（不会在锁/注册表里串）；
 *  - 同一个项目从不同写法（大小写、末尾斜杠、符号链接）进来 → 同一个 slug。
 */
export function projectSlug(projectPath) {
  const normal = normalizeProjectPath(stripTrailingSep(projectPath))
  const hash = crypto.createHash('sha1').update(normal.toLowerCase()).digest('hex').slice(0, 6)
  return `${slugStem(normal)}-${hash}`
}

/** 当前 DSH profile 的用户 patch 层（MCP 配置行写在这里）。 */
export function profilePatchPath(dshHome) {
  const home = resolveDshHome(dshHome)
  const profile = String(process.env.DSH_PROFILE || 'desktop')
  return path.join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** 当前 profile 目录。 */
export function profileDir(dshHome) {
  return path.dirname(profilePatchPath(dshHome))
}

/** 本机 Cocos 用户数据目录（全局扩展、日志、profile 都在这里）。 */
export function cocosUserDir() {
  return process.env.COCOS_USER_DIR || path.join(os.homedir(), '.CocosCreator')
}
