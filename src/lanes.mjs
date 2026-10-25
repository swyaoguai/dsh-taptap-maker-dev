/**
 * 统一的「生成通道」排序 + 开关模型。
 *
 * 为什么要有这一层：三条链路（生图 / 视频 / 音乐）过去各自决定「走哪条」，
 * 用户既看不见顺序也关不掉某条 —— 而且**任何一条都不会在额度不足时自动换到
 * 下一条**。这里把「有哪些通道、按什么顺序、哪些开着、失败要不要自动换」
 * 收敛成一份可排序的列表，三条链路共用同一套语义。
 *
 * 落盘：$DSH_HOME/taptap-maker-dev/lanes.json
 *   {
 *     "autoFallback": true,          // 全局：额度不足时是否自动换下一条通道
 *     "groups": {
 *       "image":  { "order": ["gptWeb", "relayImage"], "enabled": { ... } },
 *       "video":  { "order": ["relay", "minimax", "local"], "enabled": { ... } },
 *       "audio":  { "order": ["bgmWeb"],        "enabled": { ... } }
 *     }
 *   }
 *
 * ⚠️ 两条重要不变量：
 *  1. **local 通道永远可跑**（本地视频，零额度），但它是「用户主动挂文件」，
 *     不是「自动生成」——所以它参与排序、默认开启，却永远不会被自动回退选中
 *     （回退只处理额度/失败，不该把用户拖进一个需要手动挑文件的动作）。
 *  2. **开关永远不能把所有通道关成空集**：至少保留一个启用项，否则用户会
 *     把自己锁在「所有生图都不可用」的状态且界面很难看出原因。
 *
 * @module src/lanes.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, readJson, writeJson } from './paths.js'

/* ------------------------------------------------------------------------- *
 * 通道清单 —— 唯一的真相来源
 * ------------------------------------------------------------------------- */

/**
 * 每一组通道的静态定义。
 *  - id:     代码里用它分派，绝不改名（改名会让老配置丢通道）
 *  - label:  设置页显示名
 *  - kind:   'web' = 走真实浏览器/网页登录态；'api' = 走 HTTP 接口；'local' = 本地文件
 *  - zeroCost: 真·零成本（不需要任何额度），用于界面提示
 *  - ready:  判断该通道**当前**能不能用（配置齐不齐），由调用方注入以避免循环依赖
 */
export const LANE_GROUPS = {
  image: {
    label: '生图',
    lanes: [
      { id: 'gptWeb', label: 'ChatGPT 网页生图', kind: 'web', note: '真实浏览器通道，多账号轮换' },
      { id: 'relayImage', label: '中转站生图', kind: 'api', note: 'OpenAI 兼容 /images' },
    ],
  },
  video: {
    label: '视频',
    lanes: [
      { id: 'relay', label: '视频中转站', kind: 'api', note: '你自己的地址 / Key / 模型' },
      { id: 'minimax', label: 'MiniMax 官方', kind: 'api', note: '订阅 Key 或按量 Key' },
      { id: 'local', label: '自选本地视频', kind: 'local', zeroCost: true, note: '挂本地 mp4，零额度' },
    ],
  },
  audio: {
    label: '背景音乐',
    lanes: [
      { id: 'bgmWeb', label: 'MiniMax 网页 BGM', kind: 'web', note: '需登录，多账号轮换' },
    ],
  },
}

/** 三组键名。 */
export const GROUPS = ['image', 'video', 'audio']

/** 组 id → 通道 id 列表（按默认顺序）。 */
const defaultOrder = (group) => LANE_GROUPS[group].lanes.map((l) => l.id)

/** 组 id → 通道定义表。 */
const laneTable = (group) => new Map(LANE_GROUPS[group].lanes.map((l) => [l.id, l]))

/** 某通道是否参与自动回退（本地文件通道不参与 —— 见文件头不变量 1）。 */
function autoFallbackEligible(group, laneId) {
  return laneTable(group).get(laneId)?.kind !== 'local'
}

/* ------------------------------------------------------------------------- *
 * 落盘读写
 * ------------------------------------------------------------------------- */

export function lanesConfigPath(dshHome) {
  return path.join(dataDir(dshHome), 'lanes.json')
}

// 读 / 写统一走 paths.js 的 readJson / writeJson：
//  - 写是原子的（先 tmp 再 rename）：进程被杀或并发调用不会留下半截 JSON。
//    以前直接 writeFileSync，一旦留下半截文件，下次读就解析失败 —— 而
//    readRaw 又把异常吞掉返回 {}，表现为「用户排的通道顺序悄悄变回默认」。
//  - 读失败会另存 .corrupt-<时间戳> 留现场，事后能找回用户亲手排的顺序。

/**
 * 默认值 —— 刻意**沿用改造前的实际行为**，这样升级后行为不突变：
 *  - 视频顺序 relay > minimax（旧的 resolveBackend 就是这个优先级）
 *  - 生图网页优先（2026-10 的主通道改动）
 *  - autoFallback 默认 **false**：自动切换会动用付费通道，不该替用户默认打开
 */
function defaults() {
  return {
    autoFallback: false,
    groups: {
      image: { order: defaultOrder('image'), enabled: { gptWeb: true, relayImage: true } },
      video: { order: defaultOrder('video'), enabled: { relay: true, minimax: true, local: true } },
      audio: { order: defaultOrder('audio'), enabled: { bgmWeb: true } },
    },
  }
}

/**
 * 归一化：任何外部输入（磁盘上的旧文件、POST 来的脏数据）都要过这里。
 * 保证返回的 order 只含**已知的**通道 id（去重、补齐缺失的新通道）。
 */
function normalizeGroup(group, raw) {
  const table = laneTable(group)
  const fallbackOrder = defaultOrder(group)
  const seen = new Set()
  const order = []
  // 先放用户排过的（只认已知的）
  const incoming = Array.isArray(raw?.order) ? raw.order : []
  for (const id of incoming) {
    if (typeof id === 'string' && table.has(id) && !seen.has(id)) {
      seen.add(id)
      order.push(id)
    }
  }
  // 再补上新增的通道，追加在末尾（老用户不会因为新增通道而"看不见它"）
  for (const id of fallbackOrder) if (!seen.has(id)) order.push(id)

  const enabledIn = raw?.enabled && typeof raw.enabled === 'object' ? raw.enabled : {}
  const enabled = {}
  for (const id of order) enabled[id] = enabledIn[id] !== false // 默认开

  // 不变量 2：绝不允许全关
  if (!order.some((id) => enabled[id])) enabled[order[0]] = true

  return { order, enabled }
}

/**
 * 读取完整配置（已归一化）。
 * @param {string} dshHome
 * @returns {{autoFallback: boolean, groups: Record<string, {order: string[], enabled: Record<string, boolean>}>}}
 */
export function readLanes(dshHome) {
  const raw = readJson(lanesConfigPath(dshHome)) ?? {}
  // 只有显式写了 true 才算开启「额度不足自动换通道」—— 默认不动用户的付费通道。
  const out = { autoFallback: raw.autoFallback === true, groups: {} }
  for (const group of GROUPS) {
    out.groups[group] = normalizeGroup(group, raw?.groups?.[group])
  }
  return out
}

/**
 * 写入（partial patch）。开启状态支持两种写法：
 *   { enabled: { relay: false } }              —— 只改这几条，其余保持
 *   { order: ['minimax', 'relay'] }            —— 直接给定顺序
 * 返回归一化后的完整配置。
 */
export function writeLanes(dshHome, patch = {}) {
  const current = readLanes(dshHome)
  const next = { autoFallback: current.autoFallback, groups: {} }
  if (typeof patch.autoFallback === 'boolean') next.autoFallback = patch.autoFallback

  for (const group of GROUPS) {
    const gPatch = patch.groups?.[group] ?? patch[group] ?? {}
    const cur = current.groups[group]
    let order = cur.order
    if (Array.isArray(gPatch.order)) order = gPatch.order
    const enabled = { ...cur.enabled }
    if (gPatch.enabled && typeof gPatch.enabled === 'object') {
      for (const [id, v] of Object.entries(gPatch.enabled)) {
        if (typeof v === 'boolean' && laneTable(group).has(id)) enabled[id] = v
      }
    }
    next.groups[group] = normalizeGroup(group, { order, enabled })
  }
  writeJson(lanesConfigPath(dshHome), next)
  return next
}

/* ------------------------------------------------------------------------- *
 * 供执行层使用
 * ------------------------------------------------------------------------- */

/**
 * 这一组里**按顺序排好的、用户启用了的**通道 id。
 * @param {string} dshHome
 * @param {'image'|'video'|'audio'} group
 */
export function laneOrder(dshHome, group) {
  const cfg = readLanes(dshHome).groups[group]
  if (!cfg) return []
  return cfg.order.filter((id) => cfg.enabled[id])
}

/** 某通道此刻是否被用户启用。 */
export function laneEnabled(dshHome, group, laneId) {
  const cfg = readLanes(dshHome).groups[group]
  return Boolean(cfg?.enabled?.[laneId])
}

/**
 * 真正参与「自动回退」的候选序列：用户启用的、且不是本地文件通道。
 *
 * 返回值是**有向顺序**：调用方应当按序尝试，遇到额度/失败就往下走一格。
 * 全部失败后由调用方汇总报错（把每条通道的失败原因带上）。
 */
export function fallbackCandidates(dshHome, group, readyFn = () => true) {
  if (!readLanes(dshHome).autoFallback) return []
  return laneOrder(dshHome, group)
    .filter((id) => autoFallbackEligible(group, id))
    .filter((id) => {
      try { return readyFn(id) } catch { return false }
    })
}

/**
 * 额度/余额类错误的统一识别。
 *
 * 为什么集中在这里：三条链路的原始报错文本完全不同 —— MiniMax 是
 * `status_code:1008` / `insufficient_balance`，网页通道是中文的「达到上限 /
 * 积分不足」，中转站则五花八门。只有**统一识别**才能保证"额度不足自动换
 * 下一条"在三条链路上行为一致。
 *
 * @returns {string|null} 命中的信号；null 表示这不是额度问题
 */
export function quotaSignal(err) {
  const status = Number(err?.status ?? err?.statusCode ?? 0)
  if (status === 402) return 'insufficient_balance'
  const text = String(err?.message ?? err?.raw ?? err ?? '')
  const signals = [
    [/1008/, 'minimax_1008'],
    [/insufficient[_ ]?balance/i, 'insufficient_balance'],
    // 「今日免费额度已用完」是 ChatGPT 网页免费档的准确横幅文案（2026-10-24
    // 用户实测报障）：之前的关键词表只有「达到上限」，完全匹配不上 → 统一的
    // quotaSignal 认不出来，回退逻辑永远不会被触发。
    [/积分不足|余额不足|额度不足|积分已用完|额度已用完|余额已用完|积分不够|免费额度已用完|今日额度/, 'credit_exhausted'],
    [/达到上限|已达上限|用量已达上限|limit reached|quota/i, 'quota_reached'],
    [/rate[\s_-]?limit|too many requests|1002/i, 'rate_limited'],
  ]
  for (const [re, name] of signals) if (re.test(text)) return name
  return null
}

/**
 * 回退执行器。
 *
 * 刻意做成一个通用小工具而不是把逻辑抄进三处 —— 回退的**语义**（哪些错误算
 * 可回退、失败怎么汇总、要不要提示）必须三处完全一致，否则用户会遇到"生图会
 * 自动换、视频不会"这种极难解释的不一致。
 *
 * @param {string[]} candidates  顺序候选通道 id（来自 fallbackCandidates）
 * @param {(laneId: string) => Promise<any>} run  真正干活的函数，抛错即视为该通道失败
 * @param {(err: unknown) => string} describe     把错误转成一句人话（用于汇总）
 * @returns {Promise<{ok: boolean, lane?: string, value?: any, attempts?: Array<{lane: string, reason: string}>}>}
 */
export async function runWithFallback(candidates, run, describe) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, reason: 'no_lane_enabled', attempts: [] }
  }
  const attempts = []
  for (const laneId of candidates) {
    try {
      const value = await run(laneId)
      return { ok: true, lane: laneId, value, attempts }
    } catch (err) {
      attempts.push({ lane: laneId, reason: describe(err) })
    }
  }
  return { ok: false, reason: 'all_lanes_failed', attempts }
}