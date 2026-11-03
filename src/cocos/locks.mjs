/**
 * 并发护栏：每项目写锁 + 全局构建信号量。
 *
 * 要解决的具体事故（不夸张，都是真会发生的）：
 *  1. 两个会话（或一个会话的并行子任务）同时往同一个 Cocos 场景里加节点 ——
 *     两边各自 `get_hierarchy` 后 `create_node`，场景 JSON 后写的覆盖先写的；
 *  2. 「交互编辑器开着」+「agent 用 `--build` 起了一次无头构建」同时跑，
 *     两个进程写同一个 `library/`、`temp/` 与 `build/`，构建产物可能半残；
 *  3. 三个不同项目同时构建 —— 端口不冲突了，但 CPU/内存被抢空，
 *     每个构建都变慢，还容易踩到 Cocos 自己的缓存锁。
 *
 * 所以分成两层：
 *  - **每项目互斥锁**：同一项目的「写操作」串行；读操作不加锁（够快、也不改状态）。
 *  - **全局构建槽位**：构建这种重活全机串行（默认 1，可配），与项目数量无关。
 *
 * 锁文件用 `wx` 独占创建，内容带 pid/host/过期时间：
 *  - 进程崩了留下的锁，会在 TTL 到期或 pid 确认死亡后被回收，不会永久卡死；
 *  - 释放时校验 owner，避免 A 超时后 B 拿到锁、A 结束时把 B 的锁删掉。
 *
 * @module src/cocos/locks.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locksDir } from './paths.mjs'

const DEFAULT_TTL_MS = 10 * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 进程是否还活着（跨平台，Windows 上 EPERM 也算活着）。 */
export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readLock(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/** 锁文件「多久没被改过」。读不到就当成很旧（可回收）。 */
function lockFileAgeMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * 判断锁是否是残留。
 *
 * ⚠️ 这里有个容易写错的竞态：`writeFileSync(..., {flag:'wx'})` 是「先创建、
 * 再写入」，另一个进程完全可能在「文件已存在、内容还没写完」的瞬间读到一个
 * 空文件/半截 JSON。如果把它当成「解析失败 = 残留」直接删掉，两个进程就会同时
 * 认为自己拿到了锁 —— 写锁形同虚设。
 * 所以：**解析不出内容时，先看文件年龄**，刚出现（<5s）的当作「有人正在写」，
 * 只有当它又旧又读不出内容时，才认定为残留。
 */
function isStale(record, now, file) {
  if (!record) return lockFileAgeMs(file) > 5000
  const expiresAt = Number(record.expiresAt) || 0
  if (expiresAt > 0 && now > expiresAt) return true
  // 同机 + 进程已死 → 立刻可回收，不必等 TTL。
  // ⚠️ pid 复用防护：record.ts 记录的是拿锁时刻；如果那个 pid 已经轮转给了
  // 别的进程，现在「活着」不代表原来拿锁的进程还活着。保守做法：拿锁时刻
  // 早于本进程启动时间的 pid 存活检查仍然可信（Linux pid 回绕通常在 32k+），
  // 所以这里只在「进程死了」时回收，「活着」不区分是不是同一个进程 —— 宁可
  // 等 TTL，也不误删别人的锁。
  const host = String(record.host || '')
  if (host !== '' && host === os.hostname() && !pidAlive(record.pid)) return true
  return false
}

/** 生成一个稳定的 owner 描述（写进锁文件，用来判断「是不是我持有的」）。 */
export function makeOwner(label = 'tool') {
  return {
    key: `${label}@${process.pid}:${Date.now().toString(36)}`,
    label,
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
  }
}

/**
 * 尝试获取一个独占文件锁。
 *
 * @param {string} file 锁文件路径
 * @param {object} opts
 * @param {object} opts.owner makeOwner() 的结果
 * @param {number} [opts.ttlMs] 过期时间（默认 10 分钟）
 * @param {number} [opts.waitMs] 最多等待多久（0 = 立刻返回失败）
 * @param {number} [opts.pollMs] 轮询间隔
 * @param {string} [opts.note] 附加说明（项目名、工具名等）
 * @returns {Promise<{ok: boolean, holder?: object, waitedMs: number}>}
 */
export async function acquireFileLock(file, {
  owner, ttlMs = DEFAULT_TTL_MS, waitMs = 0, pollMs = 250, note = '',
} = {}) {
  const started = Date.now()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (;;) {
    const now = Date.now()
    const payload = {
      ...owner,
      note,
      ts: now,
      expiresAt: now + ttlMs,
    }
    try {
      fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { flag: 'wx' })
      return { ok: true, holder: payload, waitedMs: Date.now() - started }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const holder = readLock(file)
    if (isStale(holder, now, file)) {
      try {
        fs.unlinkSync(file)
      } catch { /* 别人先删了：下一轮重试 */ }
      continue
    }
    if (Date.now() - started >= waitMs) {
      return { ok: false, holder, waitedMs: Date.now() - started }
    }
    await sleep(Math.min(pollMs, Math.max(50, waitMs - (Date.now() - started))))
  }
}

/** 续期（长操作期间保活）。只有 owner 匹配才续。 */
export function touchFileLock(file, owner, ttlMs = DEFAULT_TTL_MS) {
  const holder = readLock(file)
  if (!holder || holder.key !== owner.key) return false
  const now = Date.now()
  try {
    fs.writeFileSync(file, `${JSON.stringify({ ...holder, ts: now, expiresAt: now + ttlMs })}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * 释放锁。
 *
 * ⚠️ `owner` **必填**。以前的判断是 `if (owner && holder.key !== owner.key) return false`
 * —— owner 缺失时直接跳过校验、把锁删掉。也就是说任何忘记传 owner 的调用点都能
 * 删掉别人的锁，而写锁的意义就是「只有持有者能放」。这种 API 形态必须堵死：
 * 拿不出 owner 就拒绝释放（返回 false），由调用方修正。
 */
export function releaseFileLock(file, owner) {
  if (owner === null || owner === undefined || typeof owner.key !== 'string' || owner.key === '') {
    return false
  }
  const holder = readLock(file)
  if (!holder) return false
  if (holder.key !== owner.key) return false
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** 读当前持有者（用于给 agent 一个「谁占着」的明确答复）。 */
export function peekLock(file) {
  const holder = readLock(file)
  if (holder === null) {
    // 文件存在但内容还读不出来：刚被别人创建、正在写。别报告成「空闲」。
    return lockFileAgeMs(file) <= 5000 ? { label: '(正在写入锁)', ts: Date.now(), pid: null } : null
  }
  if (isStale(holder, Date.now(), file)) return null
  return holder
}

/** 项目写锁路径。 */
export function projectLockPath(dshHome, slug) {
  return path.join(locksDir(dshHome), `${slug}.write.lock`)
}

/**
 * 在项目写锁保护下执行 fn；拿不到锁时抛出可读错误（带当前持有者信息）。
 */
export async function withProjectLock(dshHome, slug, owner, fn, opts = {}) {
  const file = projectLockPath(dshHome, slug)
  const ttlMs = Number(opts.ttlMs) || DEFAULT_TTL_MS
  const acquired = await acquireFileLock(file, { owner, ttlMs, waitMs: opts.waitMs ?? 0, note: opts.note ?? slug })
  if (!acquired.ok) {
    const holder = acquired.holder ?? {}
    const held = holder.startedAt ? `${holder.startedAt}（${Math.round((Date.now() - (Number(holder.ts) || Date.now())) / 1000)}s 前）` : '未知时间'
    throw new Error(
      `项目 ${slug} 正在被另一个写操作占用（${holder.label || 'unknown'}，pid ${holder.pid || '?'}，${held}）。`
      + '同一个 Cocos 项目同一时间只允许一个写操作：请等它结束，或用 cocos_status 查看持有者。',
    )
  }
  const heartbeat = setInterval(
    () => { touchFileLock(file, owner, ttlMs) },
    // 心跳必须明显快于 TTL：以前固定下限 5s，如果 ttlMs 被传成 3s（测试或
    // 短操作场景），心跳比 TTL 还慢，锁会在操作中途过期被别人抢走。
    Math.max(500, Math.floor(ttlMs / 3)),
  )
  heartbeat.unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    releaseFileLock(file, owner)
  }
}

/**
 * 全局构建槽位：构建这种重活全机串行。
 *
 * 用「编号槽位文件」而不是单个互斥锁，是为了让上限可配置（想并行 2 个就开 2 个槽）。
 */
export async function acquireBuildSlot(dshHome, owner, { max = 1, waitMs = 0, ttlMs = 60 * 60 * 1000 } = {}) {
  const dir = path.join(locksDir(dshHome), 'build-slots')
  fs.mkdirSync(dir, { recursive: true })
  const limit = Math.max(1, Number(max) || 1)
  const started = Date.now()
  for (;;) {
    // 每轮重新采一遍占用情况：跨轮累积会把早已释放的槽位也算进错误信息里。
    const holders = []
    for (let i = 1; i <= limit; i += 1) {
      const file = path.join(dir, `slot-${i}.lock`)
      const acquired = await acquireFileLock(file, { owner, ttlMs, waitMs: 0, note: 'build' })
      if (acquired.ok) return { ok: true, slot: i, file }
      holders.push({ slot: i, holder: acquired.holder })
    }
    if (Date.now() - started >= waitMs) return { ok: false, holders }
    await sleep(500)
  }
}

/** 释放构建槽位。 */
export function releaseBuildSlot(file, owner) {
  if (!file) return false
  return releaseFileLock(file, owner)
}

/** 当前构建槽位的占用情况（给 status 用）。 */
export function buildSlotsStatus(dshHome, max = 1) {
  const dir = path.join(locksDir(dshHome), 'build-slots')
  const out = []
  for (let i = 1; i <= Math.max(1, Number(max) || 1); i += 1) {
    const file = path.join(dir, `slot-${i}.lock`)
    const holder = peekLock(file)
    if (holder) out.push({ slot: i, holder })
  }
  return out
}
