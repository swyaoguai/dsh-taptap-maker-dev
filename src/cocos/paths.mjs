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

/** 大小写不敏感的文件系统（Windows 默认、macOS 默认）。 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/** 两个路径是否指同一个项目。 */
export function sameProjectPath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  const na = normalizeProjectPath(stripTrailingSep(a))
  const nb = normalizeProjectPath(stripTrailingSep(b))
  if (CASE_INSENSITIVE_FS) return na.toLowerCase() === nb.toLowerCase()
  return na === nb
}

/** 目录名 → 可读 slug 片段（保留中文等字母，其余非字母数字折成 `-`）。 */
function slugStem(projectPath) {
  const normal = normalizeProjectPath(projectPath)
  const base = path.basename(normal) || 'project'
  // 用 \p{L}\p{N} 而不是 [a-z0-9]：中文目录名以前会被整段抹成 "project"，
  // 三个中文工程在列表里全叫 project-xxxxxx，只能靠哈希分辨。
  const ascii = String(base)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return ascii || 'project'
}

/**
 * 稳定的项目 slug：`wxzj-cocos-1a2b3c`。
 *
 * 哈希输入是「规范化后的全路径」：
 *  - 同目录名、不同路径 → 不同 slug（不会在锁/注册表里串）；
 *  - 同一个项目从不同写法（末尾斜杠、符号链接）进来 → 同一个 slug；
 *  - **大小写只在大小写不敏感的文件系统上折叠**：Linux 上 `/Home/App` 与
 *    `/home/app` 是两个不同目录，以前统一 toLowerCase 会让它们撞成同一个 slug，
 *    于是锁和注册表条目互相覆盖。
 */
export function projectSlug(projectPath) {
  const normal = normalizeProjectPath(stripTrailingSep(projectPath))
  const key = CASE_INSENSITIVE_FS ? normal.toLowerCase() : normal
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 6)
  return `${slugStem(normal)}-${hash}`
}

/**
 * 当前 profile 的用户 patch 层（MCP 配置行写在这里）。
 *
 * 用 `DSH_PROFILE` 指定 profile；命令行里没这个变量时默认 desktop。
 * 如果该 profile 目录并不存在（比如用户在别的 profile/纯 CLI 下跑），
 * 回落到 home 级 patch（`$DSH_HOME/cordis.patch.yml`）—— 它同样会在启动时应用，
 * 总比往一个不存在的目录里写要好。
 */
export function profilePatchPath(dshHome) {
  const home = resolveDshHome(dshHome)
  const profile = String(process.env.DSH_PROFILE || 'desktop')
  const profilePatch = path.join(home, 'profiles', profile, 'cordis.patch.yml')
  if (fs.existsSync(path.dirname(profilePatch))) return profilePatch
  return path.join(home, 'cordis.patch.yml')
}

/** 当前 profile 目录。 */
export function profileDir(dshHome) {
  return path.dirname(profilePatchPath(dshHome))
}

/** 本机 Cocos 用户数据目录（全局扩展、日志、profile 都在这里）。 */
export function cocosUserDir() {
  return process.env.COCOS_USER_DIR || path.join(os.homedir(), '.CocosCreator')
}
