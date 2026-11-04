/**
 * 统一的「生成通道」排序 + 开关模型。
 *
 * 为什么要有这一层：三条链路（生图 / 视频 / 音乐）过去各自决定「走哪条」，
 * 用户既看不见顺序也关不掉某条 —— 而且**任何一条都不会在额度不足时自动换到
 * 下一条**。这里把「有哪些通道、按什么顺序、哪些开着、失败要不要自动换」
 * 收敛成一份可排序的列表，三条链路共用同一套语义。
 *
 * 落盘：$DSH_HOME/game-forge/lanes.json
 *   {
 *     "v": 2,                          // 配置版本（见 normalizeConfig 的迁移逻辑）
 *     "groups": {
 *       "image":  { "order": ["zaiduyu", "gptWeb", "relayImage"], "enabled": { ... }, "autoFallback": true  },
 *       "video":  { "order": ["relay", "minimax", "local"],       "enabled": { ... }, "autoFallback": false },
 *       "audio":  { "order": ["bgmWeb"],                          "enabled": { ... }, "autoFallback": false }
 *     }
 *   }
 *
 * 「按顺序回退」是**每个模块各自一个开关**（2026-11 用户要求）：生图一条顺序、
 * 视频一条顺序、BGM 一条顺序，各自决定「不可用时要不要往下换」。旧版只有一个
 * 全局 autoFallback，读旧文件时按 migrate 规则换算（见 readLanes）。
 *
 * ⚠️ 三条重要不变量：
 *  1. **local 通道永远可跑**（本地视频，零额度），但它是「用户主动挂文件」，
 *     不是「自动生成」——所以它参与排序、默认开启，却永远不会被自动回退选中
 *     （回退只处理额度/失败，不该把用户拖进一个需要手动挑文件的动作）。
 *  2. **开关永远不能把所有通道关成空集**：至少保留一个启用项，否则用户会
 *     把自己锁在「所有生图都不可用」的状态且界面很难看出原因。
 *  3. **顺序 = 使用顺序**。不可用（没配置 / 没账号 / 额度不足 / 跑不起来）就往
 *     下一条走；全部不可用才提示用户去补配置 —— 提示只在「退无可退」时出现，
 *     不要每走一步都问一遍。
 *
 * @module src/lanes.mjs
 */
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
 *
 * `lanes` 里的**数组顺序就是默认使用顺序**（defaultOrder 直接取它）。
 *  - 生图默认：章鱼生图 → ChatGPT 网页 → 中转站（用户在 2026-11 明确要求的顺序）。
 *  - autoFallbackDefault：该组「不可用时是否自动换下一条」的默认值。
 *    生图默认 **开**（用户明确要多优先级回退）；视频 / BGM 默认 **关** ——
 *    视频按秒计费、BGM 花的是订阅额度，「少问一句就多花一次钱」不值得。
 */
export const LANE_GROUPS = {
  image: {
    label: '生图',
    autoFallbackDefault: true,
    lanes: [
      // 章鱼生图：pai.zaiduyu.top 积分制多模型站（第三方 skill 整合）。
      // 积分是**预付的**（花钱买的），所以它在顺序里排第一是用户的明确选择，
      // 不是插件替他做的决定：界面上写着「顺序 = 使用顺序」，随时可拖。
      { id: 'zaiduyu', label: '章鱼生图（积分站）', kind: 'api', note: 'pai.zaiduyu.top 多模型，积分制，需站点账号' },
      { id: 'gptWeb', label: 'ChatGPT 网页生图', kind: 'web', note: '真实浏览器通道，多账号轮换' },
      { id: 'relayImage', label: '中转站生图', kind: 'api', note: 'OpenAI 兼容 /images' },
    ],
  },
  video: {
    label: '视频',
    autoFallbackDefault: false,
    lanes: [
      { id: 'relay', label: '视频中转站', kind: 'api', note: '你自己的地址 / Key / 模型' },
      { id: 'minimax', label: 'MiniMax 官方', kind: 'api', note: '订阅 Key 或按量 Key' },
      { id: 'local', label: '自选本地视频', kind: 'local', zeroCost: true, note: '挂本地 mp4，零额度' },
    ],
  },
  audio: {
    label: '背景音乐',
    autoFallbackDefault: false,
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

/** 配置版本：2 = 「按顺序回退」从全局开关改成每组一个开关（2026-11）。 */
export const CONFIG_VERSION = 2

/*
 * 默认值不单独存一份：`normalizeGroup` 在「没写过」时就地取 lanes 数组顺序 +
 * 该组 autoFallbackDefault。曾经这里有一个 defaults()，但它和归一化逻辑各写
 * 一遍默认值，改顺序时要改两处（漏一处就是"界面显示新顺序、执行还是老顺序"）。
 */

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

  // 每组的「按顺序回退」开关。规则（老文件也能得到合理行为）：
  //  1) 该组自己写了布尔值 → 用它（v2 之后的正常路径）；
  //  2) 旧版文件（无 v 字段）里全局 autoFallback === true → 三类都算开
  //     （用户当时的选择是"要自动换"，不该被这次改版悄悄收回）；
  //  3) 其余情况 → 用该组的默认值（生图开、视频/BGM 关）。
  // 注意 2) 与 3) 的顺序：旧文件里全局是 **false** 时，生图仍按新默认开 ——
  // 因为"生图要按顺序回退"是用户在 2026-11 明确提出的需求，界面上也会直接
  // 显示这个开关的状态，用户可以一键关掉。
  const fallbackDefault = LANE_GROUPS[group].autoFallbackDefault === true
  let autoFallback = fallbackDefault
  if (typeof raw?.autoFallback === 'boolean') autoFallback = raw.autoFallback
  else if (raw?.legacyGlobalFallback === true) autoFallback = true

  return { order, enabled, autoFallback }
}

/**
 * 读取完整配置（已归一化）。
 *
 * @param {string} dshHome
 * @returns {{v: number, autoFallback: boolean,
 *   groups: Record<string, {order: string[], enabled: Record<string, boolean>, autoFallback: boolean}>}}
 *   `autoFallback`（顶层）是**兼容用的镜像**：只有三类全开才为 true，
 *   语义以 groups[*].autoFallback 为准。
 */
export function readLanes(dshHome) {
  const raw = readJson(lanesConfigPath(dshHome)) ?? {}
  // 旧版（无 v）只有一个全局 autoFallback：把它当作"用户意图"传给各组，
  // 但每组自己的值优先（见 normalizeGroup 的规则）。
  const legacyGlobalFallback = Number(raw.v) === CONFIG_VERSION ? undefined : raw.autoFallback === true
  const out = { v: CONFIG_VERSION, autoFallback: false, groups: {} }
  for (const group of GROUPS) {
    const gRaw = raw?.groups?.[group]
    out.groups[group] = normalizeGroup(group, { ...(gRaw ?? {}), legacyGlobalFallback })
  }
  out.autoFallback = GROUPS.every((g) => out.groups[g].autoFallback === true)
  return out
}

/**
 * 写入（partial patch）。支持：
 *   { enabled: { relay: false } }              —— 只改这几条，其余保持
 *   { order: ['minimax', 'relay'] }            —— 直接给定顺序
 *   { autoFallback: true }                     —— 只改该组「按顺序回退」
 *   { autoFallback: true }（顶层，旧写法）      —— 三类一起改（保留给老调用方）
 * 返回归一化后的完整配置。
 */
export function writeLanes(dshHome, patch = {}) {
  const current = readLanes(dshHome)
  const next = { v: CONFIG_VERSION, groups: {} }
  // 旧的顶层 autoFallback 继续可用：含义是"三类都设成这个值"。
  const globalPatch = typeof patch.autoFallback === 'boolean' ? patch.autoFallback : undefined

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
    let autoFallback = cur.autoFallback
    if (typeof gPatch.autoFallback === 'boolean') autoFallback = gPatch.autoFallback
    else if (globalPatch !== undefined) autoFallback = globalPatch
    next.groups[group] = normalizeGroup(group, { order, enabled, autoFallback })
  }
  const mirror = GROUPS.every((g) => next.groups[g].autoFallback === true)
  // 顶层 autoFallback 是**兼容镜像**：v2 之前的宿主进程只认这一个字段。
  // 升级后宿主没重启的那段时间里，旧代码仍能读到"三类都开着"这个事实，
  // 而不是因为字段消失就把回退全关掉。新代码完全不依赖它（各组自己的值优先）。
  next.autoFallback = mirror
  writeJson(lanesConfigPath(dshHome), next)
  return { ...next, autoFallback: mirror }
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
  const cfg = readLanes(dshHome).groups[group]
  if (!cfg || cfg.autoFallback !== true) return []
  return cfg.order
    .filter((id) => cfg.enabled[id])
    .filter((id) => autoFallbackEligible(group, id))
    .filter((id) => {
      try { return readyFn(id) } catch { return false }
    })
}

/**
 * 一次生成该按什么顺序试哪几条通道 —— 三条链路共用的**唯一**决策函数。
 *
 * 与 fallbackCandidates 的区别：这个函数把「顺序 / 开关 / 就绪 / 是否自动回退」
 * 一次性解开，并且**永远保留第一条可用的通道**。这样调用方拿到的语义是确定的：
 *
 *   attempts  按顺序真正要试的通道（至少 1 条，除非一条都用不了）
 *   ready     顺序里配好了的通道（用于告诉用户"其实还有 X 可以用"）
 *   unready   顺序里没配好的通道（跳过它们不算失败，也不必打扰用户）
 *   deferred  「自动回退」关着时被压在后面的可用通道（失败后要怎么提示用户）
 *
 * @param {string} dshHome
 * @param {'image'|'video'|'audio'} group
 * @param {(laneId: string) => boolean} readyFn 该通道此刻能不能用
 */
export function resolveLanePlan(dshHome, group, readyFn = () => true) {
  const cfg = readLanes(dshHome).groups[group]
  const isReady = (id) => {
    try { return Boolean(readyFn(id)) } catch { return false }
  }
  const empty = { group, autoFallback: false, order: [], enabled: [], ready: [], unready: [], attempts: [], deferred: [] }
  if (!cfg) return empty

  const enabled = cfg.order.filter((id) => cfg.enabled[id])
  const ready = enabled.filter((id) => isReady(id))
  const unready = enabled.filter((id) => !isReady(id))
  // 本地文件通道（挂 mp4）不算"自动生成"的候选（不变量 1），但用户手排的顺序里
  // 它仍然是一条通道 —— 顺序里它是第一条时也不该被静默丢弃，所以只在
  // 「自动回退」生效时才把它排除。
  const usable = cfg.autoFallback ? ready.filter((id) => autoFallbackEligible(group, id)) : ready
  const attempts = cfg.autoFallback ? usable : usable.slice(0, 1)
  return {
    group,
    autoFallback: cfg.autoFallback === true,
    order: cfg.order,
    enabled,
    ready: usable,
    unready,
    attempts,
    deferred: usable.slice(attempts.length),
  }
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