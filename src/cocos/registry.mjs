/**
 * 已知 Cocos 项目注册表（$DSH_HOME/game-forge/cocos/projects.json）。
 *
 * 为什么需要注册表，而不是每次现场扫进程：
 *  - 「哪些项目归这个插件管」是**用户的意图**，进程扫描只能看到「此刻开着什么」。
 *    不落盘的话，编辑器一关，agent 就再也分不清哪个目录是 `wxzj-cocos`。
 *  - 端口、扩展版本、上次身份、备注这些也要跨会话保留，否则每次都要重新探。
 *
 * 并发安全：
 *  - 读：容忍文件缺失/损坏（返回空表），绝不让注册表把工具调用搞挂；
 *  - 写：先写临时文件再 rename（同目录，原子替换），并用进程内串行队列 +
 *    文件锁，避免「两个会话同时读-改-写」把对方的改动覆盖掉。
 *
 * @module src/cocos/registry.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  cocosRoot, normalizeProjectPath, projectSlug, registryPath, sameProjectPath, stripTrailingSep,
} from './paths.mjs'
import { acquireFileLock, makeOwner, releaseFileLock } from './locks.mjs'
import { locksDir } from './paths.mjs'

const EMPTY = Object.freeze({ version: 1, projects: {} })

/** 进程内写队列：注册表读-改-写必须串行，否则并发 upsert 会丢更新。 */
let writeChain = Promise.resolve()

function emptyRegistry() {
  return { version: 1, projects: {} }
}

/** 读取注册表；文件缺失或损坏都退回空表（并保留损坏文件副本以便排查）。 */
export function readRegistry(dshHome) {
  const file = registryPath(dshHome)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return emptyRegistry()
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    const projects = parsed.projects !== null && typeof parsed.projects === 'object' && !Array.isArray(parsed.projects)
      ? parsed.projects
      : {}
    return { version: 1, projects, ...(parsed.updatedAt ? { updatedAt: parsed.updatedAt } : {}) }
  } catch {
    // 损坏：别删用户数据，留个副本再重建。
    try {
      fs.writeFileSync(`${file}.corrupt-${Date.now()}`, text)
    } catch { /* 复制失败就算了 */ }
    return emptyRegistry()
  }
}

/** 原子写：临时文件 + rename。 */
export function writeRegistry(dshHome, data) {
  const dir = cocosRoot(dshHome)
  const file = registryPath(dshHome)
  const payload = {
    version: 1,
    projects: data.projects ?? {},
    updatedAt: new Date().toISOString(),
  }
  const tmp = path.join(dir, `.projects.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } catch (error) {
    // rename 失败时别把 tmp 留成垃圾（下次 cleanup 也难判断它属于谁）。
    try { fs.unlinkSync(tmp) } catch { /* 已经没了 */ }
    throw error
  }
  return payload
}

/**
 * 串行化的一次读-改-写。
 *
 * 两层串行：
 *  - 进程内队列（同一 host 里的并发调用）；
 *  - **跨进程文件锁**（桌面端 + 命令行 / 两个 host 同时跑时，读-改-写会互相覆盖）。
 *    只做进程内队列是不够的：DSH 桌面端与 `game-cocos` CLI 完全可能同时登记项目。
 */
export async function mutateRegistry(dshHome, mutator) {
  const run = writeChain.then(async () => {
    const owner = makeOwner('registry')
    const lock = await acquireFileLock(path.join(locksDir(dshHome), 'registry.lock'), {
      owner,
      ttlMs: 15000,
      waitMs: 10000,
      pollMs: 120,
      note: 'registry',
    })
    if (!lock.ok) {
      throw new Error('注册表被另一个进程占用超过 10 秒（registry.lock）。请稍后重试。')
    }
    try {
      const before = readRegistry(dshHome)
      const after = await mutator(before)
      if (after === null || after === undefined) return before
      return writeRegistry(dshHome, after)
    } finally {
      releaseFileLock(path.join(locksDir(dshHome), 'registry.lock'), owner)
    }
  })
  // 队列不能因为一次失败就中断后续写入。
  writeChain = run.then(() => undefined, () => undefined)
  return run
}

/** 新增或更新一个项目条目（按 slug 归并）。 */
export async function upsertProject(dshHome, project, { touch = true } = {}) {
  const normal = normalizeProjectPath(stripTrailingSep(project.path))
  const slug = project.slug || projectSlug(normal)
  return mutateRegistry(dshHome, (registry) => {
    const prev = registry.projects[slug] ?? {}
    // 注意顺序：先展开 prev/project，再写「归一化后的必填字段」。
    // 之前 `name: project.name || prev.name` 写在展开之前，会被 `...project` 里
    // 的空字符串覆盖，导致条目名变成空、UI 上显示成一行空白。
    const name = (typeof project.name === 'string' && project.name.trim() !== '')
      ? project.name
      : (typeof prev.name === 'string' && prev.name.trim() !== '' ? prev.name : path.basename(normal))
    const next = {
      ...prev,
      ...project,
      slug,
      name,
      path: normal,
      lastSeen: touch ? new Date().toISOString() : (project.lastSeen ?? prev.lastSeen ?? null),
    }
    return {
      ...registry,
      projects: { ...registry.projects, [slug]: next },
    }
  })
}

/** 删除项目条目。 */
export async function removeProject(dshHome, slug) {
  return mutateRegistry(dshHome, (registry) => {
    if (!registry.projects[slug]) return null
    const projects = { ...registry.projects }
    delete projects[slug]
    return { ...registry, projects }
  })
}

/** 列出所有已知项目（按名称排序，便于展示）。 */
export function listProjects(dshHome) {
  const registry = readRegistry(dshHome)
  return Object.values(registry.projects)
    .filter((entry) => entry && typeof entry.slug === 'string')
    .sort((a, b) => String(a.name || a.slug).localeCompare(String(b.name || b.slug), 'zh'))
}

/**
 * 把用户/agent 给的项目引用解析成一个注册表条目。
 *
 * 支持：slug、目录名、绝对/相对路径、名称，以及唯一的 slug 前缀。
 * 多个候选时**报错并列出**，绝不替用户挑一个 —— 猜错项目就是写到错误工程里去。
 */
export function resolveProjectRef(dshHome, ref) {
  const projects = listProjects(dshHome)
  if (ref === null || ref === undefined || String(ref).trim() === '') return null
  const want = String(ref).trim()
  const lower = want.toLowerCase()

  const bySlug = projects.find((entry) => entry.slug === want)
    // slug 统一是小写生成的；用户手打大写（WXZJ-xxx）也该命中。
    ?? projects.find((entry) => entry.slug.toLowerCase() === lower)
  if (bySlug) return bySlug

  if (path.isAbsolute(want) || want.includes('/') || want.includes('\\')) {
    const byPath = projects.find((entry) => sameProjectPath(entry.path, want))
    if (byPath) return byPath
  }


  const byName = projects.filter((entry) => String(entry.name || '').toLowerCase() === lower
    || path.basename(String(entry.path || '')).toLowerCase() === lower)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(`项目名 "${want}" 有多个候选，请用 slug 或完整路径区分：`
      + byName.map((entry) => `${entry.slug} (${entry.path})`).join('；'))
  }

  // slug 前缀匹配：同样要在大小写不敏感的文件系统上折叠大小写
  // （slug 本身是折叠后生成的，用户手打 `WXZJ` 应该也能命中 `wxzj-…`）。
  const byPrefix = projects.filter((entry) => entry.slug.toLowerCase().startsWith(lower))
  if (byPrefix.length === 1) return byPrefix[0]
  if (byPrefix.length > 1) {
    throw new Error(`项目前缀 "${want}" 有多个候选：${byPrefix.map((entry) => entry.slug).join('、')}`)
  }

  return null
}

/** 注册表条目 → 展示用摘要（不含内部字段）。 */
export function summarizeProject(entry) {
  return {
    slug: entry.slug,
    name: entry.name,
    path: entry.path,
    creatorVersion: entry.creatorVersion ?? null,
    port: entry.port ?? null,
    projectId: entry.projectId ?? null,
    lastSeen: entry.lastSeen ?? null,
  }
}

export { EMPTY as EMPTY_REGISTRY }
