/**
 * 命令式输入的分词器 —— 生图、音效、视频几条链路解析 `/xxx` 参数时共用。
 *
 * 为什么要单独一层：几条链路都需要「把用户那句话切成 token，同时保住引号包住的
 * 值」。各自实现时最容易出的错是**手写 flag 白名单 + 正则剥除**：白名单漏掉哪个
 * flag，`--xxx 值` 就原样混进提示词发给模型（实测过 `-n 2`、`--seed 7`、`--size`
 * 这类污染）。把分词收在一处，配合各链路自己的「flag 表 + 剩余即提示词」消费器，
 * 才不会出现「忘了列就静默坏掉」的失败模式。
 *
 * 零依赖，只处理字符串。
 *
 * @module src/tokens.mjs
 */

/**
 * 引号感知的分词：双引号/单引号成组（引号本身不保留），其余按空白切。
 *
 * 注意与 shell 的差别：**不支持反斜杠转义**。这里喂的是宿主传进来的
 * rawInput（已经是一句话），不是 shell 命令行；加转义反而会让 Windows 路径
 * `D:\tmp` 里的 `\t` 被吃掉。要包带空格的值就用引号。
 */
export function splitTokens(text) {
  const tokens = []
  let cur = ''
  let quote = null
  let started = false
  for (const ch of String(text ?? '')) {
    if (quote) {
      if (ch === quote) { quote = null } else { cur += ch }
      started = true
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (/\s/.test(ch)) {
      if (started) { tokens.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  // 未闭合的引号：把已积累的内容照常收尾（用户漏打一个引号时，
  // 丢内容比把后半句当提示词更糟，所以这里不报错也不吞）。
  if (started) tokens.push(cur)
  return tokens
}

/**
 * 「什么算一个开关」的**唯一定义**，并解析出它的键名与内联值。
 *
 * 为什么要有这一层：之前各解析器各写一套判断（`startsWith('--')` /
 * `/-{1,2}[a-zA-Z]/` / `value.startsWith('-')`），同一个输入在几条链路上
 * 行为不同。实测：`--seed -1` 在 CLI 上把 `-1` 当值（与 Python argparse
 * 一致），在斜杠命令上把 `-1` 当 flag → 参数被丢、`--seed -1` **整段混进
 * 提示词发给模型**。这类"同一句话两种结果"是最难查的 bug，所以收成一个函数。
 *
 * 规则对齐 Python argparse：
 *  - `-s` / `--steps` / `--no-lowvram` → 开关；
 *  - `-1` / `-2.5` → **不是**开关（负数当值，即 argparse 的
 *    `_negative_number_matcher` 行为；我们的参数表里没有数字形状的开关名，
 *    所以这条可以无条件成立）；
 *  - 单独的 `-` → 不是开关（stdin 的习惯写法）；
 *  - `--` → 不是开关，是「后面全是位置参数」的分隔符，由调用方处理。
 *
 * 返回 `{ raw, name, inline }`，不是开关时返回 null：
 *  - `name`：去掉前导 `-` 的键名（`--no-lowvram` → `no-lowvram`）；
 *  - `inline`：`--key=value` 中等号后面的**原样值**，没有等号时 null。
 *    这份信息必须留着 —— argparse 明确允许用等号形式塞「看起来像开关」的值
 *    （`--model=-fast`），只按空格判断就会把参数丢掉。
 *  - 短开关 `-m=value` 同样支持；值里可再含 `=`（只切第一个）。
 */
export function flagOf(token) {
  const raw = String(token ?? '')
  const m = /^(--?)([A-Za-z][\w-]*)(?:=([\s\S]*))?$/.exec(raw)
  if (m === null) return null
  return { raw, prefix: m[1], name: m[2], inline: m[3] === undefined ? null : m[3] }
}

/** 这个 token 看起来是不是一个开关（`--` 与 `-` 和负数都不算）。 */
export function looksLikeFlag(token) {
  return flagOf(token) !== null
}

/**
 * 通用 flag 消费器：把 token 流按 spec 表摘成「值 + 提示词 + 漏值报告」。
 *
 * 为什么要有它：各链路原本各写一套判断（`startsWith('--')`、
 * `/-{1,2}[a-zA-Z]/`、`value.startsWith('-')`、正则白名单），于是同一族缺陷
 * 反复出现、修一处漏三处 —— 实测过的真实后果包括：
 *   - `--ref` 漏值时把**下一个 flag 名**当参考图，其值泄漏进发给模型的提示词；
 *   - `--size=512x512` 等号连写整段留在提示词里、参数值丢失；
 *   - `--seed -1` 的负数在一条链路上是值、在另一条上是 flag。
 * 收成一个函数后，flag 语义只有一份，新增参数只改一处表。
 *
 * spec 形状：`{ <flag名(不含前导-)>: { into, kind?, list? } }`
 *  - `into`     落点字段名；特殊值 `'@rest'` 表示「值并进提示词」（--prompt）。
 *  - `kind:'bool'` 无值开关（`--lowvram`）。
 *  - `list:true`  按逗号展开并**追加**到数组（参考图：`--ref a,b`）。
 *  未列出的 flag 原样留在提示词里（交给下游报错），不猜含义也不偷偷丢 token。
 *
 * 值来源优先等号内联（`--model=-fast` 的 `-fast` 是合法值），否则取下一个
 * 非 flag token；`--` 之后一律按提示词处理（对齐 Python argparse）。
 * 写了 flag 却没给值 → 记进 `missing` 交调用方拒绝提交：静默用默认参数在
 * 付费/长耗时链路上比报错糟得多（用户以为指定生效了，实际按别的计费）。
 */
export function consumeFlags(tokens, spec) {
  const values = {}
  const bools = {}
  const lists = {}
  const missing = []
  const leftovers = []
  const list = tokens ?? []
  const pushList = (key, value) => {
    const arr = lists[key] ?? []
    for (const part of String(value).split(',')) {
      const p = part.trim()
      if (p.length > 0) arr.push(p)
    }
    lists[key] = arr
  }
  for (let i = 0; i < list.length; i += 1) {
    const t = String(list[i])
    if (t === '--') { leftovers.push(...list.slice(i + 1).map(String)); break }
    const f = flagOf(t)
    if (f === null) { leftovers.push(t); continue }
    const rule = spec[f.name]
    if (rule === undefined) {
      leftovers.push(t)
      if (f.inline !== null) leftovers.push(String(f.inline))
      continue
    }
    if (rule.kind === 'bool') {
      bools[f.name] = f.inline === null ? true : f.inline
      continue
    }
    let value = f.inline
    if (value === null) {
      const next = list[i + 1]
      if (next !== undefined && !looksLikeFlag(next)) { value = String(next); i += 1 }
    }
    if (value === null) { missing.push(t); continue }
    if (rule.into === '@rest') { leftovers.push(value); continue }
    if (rule.list) { pushList(rule.into, value); continue }
    // 重复出现的普通 flag：后者覆盖（与各链路既有行为一致）。
    values[rule.into] = value
  }
  return { prompt: leftovers.join(' ').trim(), values, bools, lists, missing }
}

/** 从 consumeFlags 结果里取字符串字段（没给过时回空串）。 */
export function flagValue(res, key) {
  return typeof res?.values?.[key] === 'string' ? res.values[key] : ''
}

/** 取列表字段（没给过时回空数组）。 */
export function flagList(res, key) {
  return Array.isArray(res?.lists?.[key]) ? res.lists[key] : []
}
/**
 * 把 `--key=value` / `-k=value` 连写展开成 `['--key', 'value']`。
 *
 * ⚠️ 展开出来的是**键名部分**（`--key`），不是原始 token。
 * 曾经这里 push 的是 `f.raw`（即 `--prompt=x` 整串），结果消费端
 * `token.slice(2)` 得到的键名成了 `prompt=x`、值才是 `x` —— 参数名整个错掉，
 * 而且因为"看起来有值"不会报错，属于最隐蔽的一类失败（实测抓到）。
 *
 * 为什么必须做：下游 Python argparse **原生支持** `--ratio=16:9`，用户从站点
 * 文档或命令行习惯里这么写完全合法。JS 解析层不认的话有两个后果：
 *   1. 宿主消费器把它当普通文本 → `--ratio=16:9` **原样混进提示词**发给模型；
 *   2. CLI 的 parseArgs 产出 `{"ref=a.png": true}` 这种垃圾键，值彻底丢失。
 * 这与「flag 白名单漏项」是同一族缺陷：都是「合法输入没人认领」。
 *
 * ⚠️ 展开后就看不出这个值是从 `=` 来的了（`--model=-fast` 的 `-fast` 会被
 * 当成另一个 flag）。需要精确复现 argparse 的调用方应直接用 {@link flagOf}。
 */
export function normalizeEquals(tokens) {
  const out = []
  for (const token of tokens ?? []) {
    const f = flagOf(token)
    if (f && f.inline !== null) { out.push(f.prefix + f.name, f.inline); continue }
    out.push(String(token))
  }
  return out
}
