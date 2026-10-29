#!/usr/bin/env node
/**
 * taptap-zaiduyu — 「章鱼生图」通道（pai.zaiduyu.top 积分制多模型站）。
 *
 * 这是第三方 skill `zaiduyu-imagegen`（scripts/generate.py，纯 Python 标准库）
 * 的 Node 包装层：本模块**不重新实现任何站点协议**，只负责
 *  1. 找到可用的 python 解释器（脚本只用标准库，不需要 playwright）；
 *  2. 解析站点凭据：**首选设置页保存的 zaiduyu.json**（GUI 登录），环境变量
 *     ZAIDUYU_USER / ZAIDUYU_PASS 仅作兼容兜底；缺失时只给可操作指引，
 *     绝不代填、绝不向用户索取明文、绝不回显密码 —— 命令行传密码会落进日志；
 *  3. 用 spawn 参数数组（非 shell 字符串）调脚本，规避引号注入；
 *  4. 把 stdout 的文件路径 / stderr 的预检横幅（模型、积分、余额）解析成
 *     和网页通道、中转站一致的 `{ ok, saved, ... }` 形状，接进 lanes 回退链。
 *
 * 积分语义（重要）：
 *  - 本站是**预付积分**（花钱买的），和「中转站」同属付费通道；
 *  - autoFallback 关着时绝不自动切进来，守则要求先告知用户；
 *  - 生图前必须让用户看到 `--models` 的模型清单与单张积分，由用户选模型，
 *    不要替用户挑高价模型（= 替用户决定花多少钱）。
 *
 * Usage（CLI）:
 *   node taptap-zaiduyu.mjs status
 *   node taptap-zaiduyu.mjs models
 *   node taptap-zaiduyu.mjs gen --prompt "<描述>" [--model <id>] [--ratio 16:9]
 *                               [--resolution 2K] [--size 2048x2048] [--n 2]
 *                               [--ref a.png --ref b.png] [--out <file.png>]
 *   node taptap-zaiduyu.mjs balance
 *
 * @module src/taptap-zaiduyu.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDshHome, resolveZaiduyuCredentials } from './paths.js'
import { resolveAssetDir } from './assets.mjs'
import { splitTokens, flagOf, looksLikeFlag } from './tokens.mjs'

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 随插件分发的第三方 skill 目录（generate.py 的真身）。 */
export function zaiduyuSkillDir() {
  return path.join(PKG_DIR, '..', 'skills', 'zaiduyu-imagegen')
}

export function zaiduyuScriptPath() {
  return path.join(zaiduyuSkillDir(), 'scripts', 'generate.py')
}

/**
 * 站点凭据：设置页 zaiduyu.json > 环境变量（兼容旧配置）。
 * ⚠️ 密码只在内存里流转到子进程 env，不进 argv（argv 会进进程列表/命令日志）、
 *    不回显给界面、不写进任何输出文件。
 */
export function zaiduyuCredentials(dshHome) {
  return resolveZaiduyuCredentials(dshHome ?? resolveDshHome())
}

/** 凭据是否齐（账号 + 密码任缺其一都算不可用）。 */
export function zaiduyuCredentialsReady(dshHome) {
  return zaiduyuCredentials(dshHome).usable
}

/* ------------------------------------------------------------------------- *
 * python 探测（标准库脚本，不要求 playwright）
 * ------------------------------------------------------------------------- */

let pyCache
/**
 * 找一个能跑标准库脚本的 python。
 * ⚠️ Windows 上 `python` 可能解析到 Microsoft Store 的 stub（非交互时弹商店、
 *    退出码非 0 或卡住），所以要真跑一条 `-c` 验证。结果缓存。
 */
export function findPlainPython() {
  if (pyCache !== undefined) return pyCache
  for (const bin of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(bin, ['-c', 'import sys; print(sys.version_info[0])'], {
        // 探测超时给短一点：这个函数会被设置页 GET /lanes 的 readiness 同步调用，
        // 没有 python 的机器上三个候选要快速失败，不能各等 15 秒卡住路由。
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      })
      if (r.status === 0 && (r.stdout ?? '').trim() === '3') { pyCache = bin; return bin }
    } catch { /* try next */ }
  }
  pyCache = null
  return null
}

/**
 * 这条通道此刻整体能不能用（不含用户开关）。
 * @param {object} [opts]
 * @param {string} [opts.dshHome] 配置根（缺省取宿主 env / 默认路径）。
 * @param {boolean} [opts.probe=true] 是否真的 spawn 探测 python。
 *   设置页 GET /lanes 的 readiness **必须传 false**：那个路由是同步的，
 *   在没有 python 的机器上探测要等超时 → 每次打开设置页卡十几秒。
 *   非探测模式下 Python 按「乐观可用」处理，真正生图时 CLI 会再完整探测
 *   并如实报错 —— 状态点宁可短暂乐观，绝不能拖死路由。
 */
export function zaiduyuLaneUsable({ dshHome, probe = true } = {}) {
  const python = probe ? findPlainPython() : peekPython()
  const pythonOk = probe ? python !== null : true // 乐观模式不判 python
  const creds = zaiduyuCredentials(dshHome)
  return {
    usable: zaiduyuScriptExists() && creds.usable && pythonOk,
    python: probe ? python : null,
    script: zaiduyuScriptExists(),
    credentials: creds.usable,
    // 凭据来源如实回给界面：file=设置页保存过，env=只靠环境变量撑着。
    credentialsSource: creds.source,
    identifier: creds.identifier,
  }
}

/** 不 spawn：只是给状态行占个位；乐观模式的可用性由 usable 单独算。 */
function peekPython() {
  return pyCache ?? null
}

export function zaiduyuScriptExists() {
  try { return fs.statSync(zaiduyuScriptPath()).isFile() } catch { return false }
}

/**
 * 展开 `~` / `~/x`，对齐上游 generate.py 的规则（它用 Path.expanduser()）。
 *
 * 为什么必须做：上游支持 `~/Desktop/角色.png` 这种写法，而 Node 的
 * fs.existsSync 不认 `~` —— 不展开就直接判「文件不存在」，会把**合法输入误杀**，
 * 用户看到的是我们报的错，根本想不到是自己的写法没问题。
 * 只展开 `~` 与 `~/`、`~\`；`~user` 形式上游在 Windows 上也拿不到，保持原样
 * 交给上游报错，比我们瞎猜一个 home 更诚实。
 */
export function expandUser(raw) {
  const value = String(raw ?? '')
  if (value !== '~' && !/^~[\\/]/.test(value)) return value
  const homeDir = os.homedir()
  if (!homeDir) return value
  if (value === '~') return homeDir
  return path.join(homeDir, value.slice(2))
}

/**
 * 跑一次 generate.py。返回 { code, stdout, stderr }（UTF-8）。
 * 超时给足：单张同步实测 60 秒起步，多张按批累加。
 *
 * 凭据注入规则（重要）：
 *  - 默认从解析链（zaiduyu.json > env）取凭据，注入**子进程 env**。
 *    绝不拼进 argv —— argv 会出现在进程列表、宿主命令日志与 audit-log 里。
 *  - `credentials` 显式传一组凭据时**完全接管**注入：同时把继承来的
 *    ZAIDUYU_* 从子进程 env 里剥掉。登录验证必须走这条路 —— 否则旧 env /
 *    旧文件的值会替新填的账号「作弊」，验过的和存的不是同一组凭据。
 *  - 传 `env: {}` 即彻底剥掉继承 env（不带任何凭据跑只读子命令）。
 */
export function runZaiduyu(argv, { timeoutMs = 3600000, cwd, dshHome, env, credentials } = {}) {
  const py = findPlainPython()
  if (py === null) {
    return Promise.resolve({ code: -1, stdout: '', stderr: '未找到可用的 Python 3（脚本只用标准库，装一个 python 3.10+ 即可）。' })
  }
  if (!zaiduyuScriptExists()) {
    return Promise.resolve({ code: -1, stdout: '', stderr: `找不到脚本：${zaiduyuScriptPath()}` })
  }
  const creds = credentials ?? (env === undefined ? zaiduyuCredentials(dshHome) : null)
  const childEnv = {
    ...(env ?? process.env),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  if (credentials !== undefined) {
    // 显式接管：剥掉继承值，再按传入的这组（可为空 = 不注入）重建。
    delete childEnv.ZAIDUYU_USER
    delete childEnv.ZAIDUYU_PASS
    if (credentials.identifier) childEnv.ZAIDUYU_USER = String(credentials.identifier)
    if (credentials.password) childEnv.ZAIDUYU_PASS = String(credentials.password)
  }
  if (creds && credentials === undefined) {
    // 半截凭据（只有账号没有密码）不要注入 env 去撞上游的 SystemExit，
    // 直接在这里给出可操作的错误 —— 上游的提示还停留在环境变量口径。
    if (!creds.usable) {
      return Promise.resolve({ code: -1, stdout: '', stderr: '缺少站点账号凭据：请在设置页「生成通道」→「章鱼生图（积分站）」卡里填写账号密码并点「登录并保存」（通过验证后即时生效）。' })
    }
    childEnv.ZAIDUYU_USER = creds.identifier
    childEnv.ZAIDUYU_PASS = creds.password
  }
  return new Promise((resolve) => {
    const child = spawn(py, [zaiduyuScriptPath(), ...argv], {
      cwd: cwd ?? process.cwd(),
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* gone */ }
      resolve({ code: -2, stdout, stderr: `${stderr}\n（超时 ${Math.round(timeoutMs / 1000)} 秒，已终止。生图可能仍在服务端进行，可用 balance/history 查询，不要盲目重跑。）` })
    }, timeoutMs)
    child.stdout.on('data', (b) => { stdout += b.toString('utf8') })
    child.stderr.on('data', (b) => { stderr += b.toString('utf8') })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -3, stdout: '', stderr: String(err?.message ?? err) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -4, stdout, stderr })
    })
  })
}

/** 解析预检横幅（脚本把「模型/单张消耗/…」写到 stderr）。 */
export function parsePreflight(stderrText) {
  const pick = (label) => {
    const m = new RegExp(`${label}：([^\\r\\n]+)`).exec(stderrText)
    return m ? m[1].trim() : undefined
  }
  const out = {}
  const model = pick('模型'); if (model) out.model = model
  const price = pick('单张消耗'); if (price) out.creditPerImage = price
  const total = pick('预计总消耗'); if (total) out.totalCredits = total
  const balance = pick('当前总积分'); if (balance) out.balance = balance
  const remain = pick('预计剩余'); if (remain) out.remaining = remain
  const route = pick('调用接口'); if (route) out.route = route
  const size = pick('画面尺寸'); if (size) out.size = size
  const refs = pick('参考图'); if (refs) out.references = refs
  return out
}

/** stderr 里是否出现积分/额度类失败（lanes.quotaSignal 用同一套关键词）。 */
export function zaiduyuQuotaHit(text) {
  return /积分不足|余额不足|当前总积分不足|额度不足|积分已用完/.test(String(text ?? ''))
}

/**
 * 生成（文生图 / 参考图编辑）。形状对齐 generateImage 统一入口：
 * 失败时抛 Error（让 runWithFallback 记下原因、能往下换通道）。
 */
export async function generate(dshHome, prompt, {
  model, ratio, size, resolution, quality, n, references = [], out, description, projectDir, timeoutMs,
} = {}) {
  const status = zaiduyuLaneUsable({ dshHome })
  // ⚠️ 参数校验必须在环境/凭据校验**之前**：用户写错 `--n 99` 时，
  //    先报「请先登录」会让人去配凭据、配完才发现还是错 —— 白折腾一轮。
  //    输入本身不合法就该当场说清楚，跟本机有没有 Python、有没有账号无关。
  // 1) 值不能是 `true`：`--model` 漏写值时 parseArgs 给的是布尔 true，
  //    而 String(true) === "true" 会被当成**模型名**提交给上游（实测）。
  //    站点认不出这个模型时可能报错、也可能回落到默认模型 —— 后者等于
  //    用户指定了便宜模型、实际按另一个计费，积分通道里这比直接失败糟得多。
  const truthy = (v) => v === true || v === 'true'
  for (const [name, value] of [['--model', model], ['--ratio', ratio], ['--size', size],
    ['--resolution', resolution], ['--quality', quality], ['--description', description]]) {
    if (truthy(value)) {
      const e = new Error(`参数 ${name} 后面没有值（收到「true」）。值带空格请加引号，或写成 ${name}=值。`)
      e.code = 'missing_value'
      throw e
    }
  }
  // 2) --n 必须显式落在 1~12：静默钳制会让 `--n 99` 出 12 张（= 12 倍花费）
  //    而用户以为只出 1 张。写错了就拒绝提交，不要替他改参数。
  if (n !== undefined && n !== null && n !== '' && n !== true) {
    const v = Number(n)
    if (!Number.isInteger(v) || v < 1 || v > 12) {
      const e = new Error(`张数需要 1~12 的整数，收到「${n}」，未提交（不会扣积分）。`)
      e.code = 'invalid_count'
      throw e
    }
  }

  if (!status.script) throw new Error(`章鱼生图脚本缺失：${zaiduyuScriptPath()}`)
  if (status.python === null) throw new Error('未找到可用的 Python 3，章鱼生图通道不可用（脚本只用标准库，装 python 3.10+ 即可）')
  if (!status.credentials) {
    const e = new Error('章鱼生图缺少站点账号：请在设置页「章鱼生图（积分站）」卡里填写账号密码，点「登录并保存」验证通过后即可使用。')
    e.code = 'no_credentials'
    throw e
  }

  // 落点对齐其它生图通道：<项目>/sucai/images/，避免污染工程与 C 盘。
  const dir = resolveAssetDir(dshHome, 'image', { projectDir })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const target = out || path.join(dir.dir, `zaiduyu-${stamp}.png`)

  const argv = []
  if (typeof prompt === 'string' && prompt.length > 0) argv.push('--prompt', prompt)
  if (model) argv.push('--model', String(model))
  // --ratio / --size / --resolution 三选一，尊重调用方的显式冲突检查：
  // 优先 ratio，其次 size，最后 resolution。
  if (ratio) argv.push('--ratio', String(ratio))
  else if (size) argv.push('--size', String(size))
  else if (resolution) argv.push('--resolution', String(resolution))
  if (quality) argv.push('--quality', String(quality))
  if (n && Number(n) > 1) argv.push('--n', String(n))
  if (description) argv.push('--description', String(description).slice(0, 10))
  // 上游 --image 是 `action=append, nargs='+'`：重复传或空格分隔都收。
  // ⚠️ 先校验存在性：调用方可能是 CLI 之外的 agent，传进来的路径完全可能写错。
  // 带着不存在的图提交，会白等一轮网络往返再收到上游含糊的报错。
  // 路径要先按上游的规则展开 `~`（Python 用 Path.expanduser()）——
  // 直接 fs.existsSync('~/Desktop/a.png') 永远为 false，会把**合法输入误杀**。
  const missing = references.filter((r) => !fs.existsSync(expandUser(String(r))))
  if (missing.length > 0) {
    const e = new Error(`参考图不存在：${missing.join('、')}`)
    e.code = 'missing_reference'
    throw e
  }
  for (const ref of references) argv.push('--image', String(ref))
  argv.push('--out', target)

  const r = await runZaiduyu(argv, { timeoutMs, dshHome })
  const preflight = parsePreflight(r.stderr)
  const savedLines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && fs.existsSync(l))

  if (r.code !== 0 || savedLines.length === 0) {
    const reason = (r.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') || `exit ${r.code}`
    const e = new Error(reason)
    e.preflight = preflight
    if (zaiduyuQuotaHit(r.stderr)) e.quota = true
    throw e
  }
  return {
    ok: true,
    saved: savedLines[0],
    outputs: savedLines,
    via: 'zaiduyu',
    preflight,
  }
}

/**
 * 把 `--models` 的自由文本解析成结构化列表 + 余额。
 * 导出是为了能拿真实样本测（解析文本的正则留在路由里，一旦上游改行格式，
 * 界面只会显示空表，没人知道是格式变了还是网络坏了）。
 * 上游行格式：`- <model> | <单价> | <链路>`（未标价显示「未标价」）。
 */
export function parseModelsText(text) {
  const t = String(text ?? '')
  const models = (t.match(/^-\s.*$/gm) ?? []).map((line) => {
    const cols = line.replace(/^-\s*/, '').split('|').map((s) => s.trim())
    return { model: cols[0] ?? '', credits: cols[1] ?? '', route: cols[2] ?? '' }
  }).filter((m) => m.model.length > 0)
  const balance = (/(?:当前总积分|总积分)：\s*([\d.]+)/.exec(t) ?? [])[1]
  return { models, balance: balance ?? null }
}

/**
 * 只读辅助：模型清单 / 余额（给用户看，不产生费用、不扣积分）。
 * 这些调用同样走凭据解析链，所以设置页保存后**立刻**能验，不需要重开宿主。
 */
export async function models(dshHome) {
  const r = await runZaiduyu(['--models'], { timeoutMs: 60000, dshHome })
  return { ok: r.code === 0, text: (r.stdout || r.stderr || '').trim() }
}
export async function balance(dshHome) {
  const r = await runZaiduyu(['--balance'], { timeoutMs: 60000, dshHome })
  return { ok: r.code === 0, text: (r.stdout || r.stderr || '').trim() }
}
export async function plan(prompt, opts = {}) {
  const argv = ['--plan']
  if (opts.model) argv.push('--model', String(opts.model))
  if (typeof prompt === 'string' && prompt.length > 0) argv.push('--prompt', prompt)
  const r = await runZaiduyu(argv, { timeoutMs: 60000, dshHome: opts.dshHome })
  return { ok: r.code === 0, text: (r.stdout + r.stderr).trim(), preflight: parsePreflight(r.stderr) }
}

/**
 * 登录验证：拿**表单里刚填的这组**凭据去站点跑一次只读的积分查询。
 *
 * 为什么用子进程而不是自己发 HTTP：上游 generate.py 的登录含站点自己的
 * Cookie 处理与安全校验（同源限制、重定向剥离敏感头）。自己照抄一份协议
 * 迟早和上游漂移 —— 复用脚本是唯一不会过期的做法。
 *
 * 为什么必须 `credentials` 显式接管：不接管的话旧 env / 旧文件里的凭据会
 * 替新填的账号作弊，验证通过的和最终保存的可能是两组不同的凭据。
 *
 * ⚠️ 只读：--balance 不生图、不扣积分、不签到。
 */
export async function loginProbe(identifier, password) {
  const user = String(identifier ?? '').trim()
  const pass = String(password ?? '')
  if (user.length === 0 || pass.length === 0) {
    return { ok: false, kind: 'input', error: '账号和密码都要填上' }
  }
  // 环境问题要在提交凭据之前拦：缺 Python / 缺脚本时子进程根本跑不起来，
  // 那种失败和「密码错了」是两件事，混报会把用户推向反复改密码的死路。
  if (!zaiduyuScriptExists()) {
    return { ok: false, kind: 'environment', error: `脚本缺失：${zaiduyuScriptPath()}` }
  }
  if (findPlainPython() === null) {
    return { ok: false, kind: 'environment', error: '本机未找到可用的 Python 3（该通道需要它跑站点脚本；只用标准库，无需第三方包）' }
  }
  const r = await runZaiduyu(['--balance'], {
    timeoutMs: 90000,
    credentials: { identifier: user, password: pass },
  })
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim()
  if (r.code !== 0) {
    // 上游把失败原因写进 stderr；这里只取可读的一行，绝不回显密码。
    const line = (r.stderr || r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() ?? `退出码 ${r.code}`
    // 上游缺凭据时会 SystemExit 打印配置指引（退出码 1）。显式接管凭据后
    // 不该再走到那支，真走到了说明注入没生效 —— 归为环境问题而不是骗用户改密码。
    const low = line
    let kind = 'auth'
    if (/网络请求失败|网络连接中断|超时|timed? ?out|unreachable|getaddrinfo|Connection/i.test(low)) kind = 'network'
    else if (/缺少账号配置|ZAIDUYU_USER|Traceback|ImportError|未找到可用的 Python/i.test(low)) kind = 'environment'
    return { ok: false, kind, error: low.slice(0, 300), raw: text.slice(0, 600) }
  }
  const balance = (/(?:总积分|当前总积分)：\s*([\d.]+)/.exec(text) ?? [])[1]
  const permanent = (/永久积分：\s*([\d.]+)/.exec(text) ?? [])[1]
  const limited = (/限时积分：\s*([\d.]+)/.exec(text) ?? [])[1]
  return {
    ok: true,
    identifier: user,
    balance: balance ?? null,
    permanent: permanent ?? null,
    limited: limited ?? null,
    text,
  }
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

/**
 * 把解析结果里的参考图键收成扁平数组（重复传 / 逗号分隔都吃）。
 * 导出是为了让测试能直接打真实实现 —— 复刻一份收集器等于没测。
 */
export function collectReferences(args, keys = ['ref', 'refs', 'image', 'images']) {
  const out = []
  for (const key of keys) {
    const v = args?.[key]
    if (v === undefined || v === true) continue
    const list = Array.isArray(v) ? v : [v]
    for (const item of list) {
      if (typeof item !== 'string') continue
      for (const part of item.split(',')) {
        const p = part.trim()
        if (p.length > 0) out.push(p)
      }
    }
  }
  return out
}

/**
 * 从命令式输入里摘掉已知参数，剩下的就是提示词。
 *
 * ⚠️ 为什么不再用「手写正则剥 flag」：那份清单是**人工维护的白名单**，
 * 漏掉哪个 flag，`--xxx 值` 就会原样混进用户给的中文提示词发给模型
 * （实测过同一类 bug：`-n 2`、`--seed 7` 漏进英文提示词）。
 * 上游 generate.py 支持的参数有 model/ratio/size/resolution/quality/n/
 * description/image，少写一个就是静默污染提示词 —— 分词器 + 完整 flag 表
 * 才不会出现这种「忘了列就坏」的失败模式。
 * 未知 flag 保留在提示词里交给上游报错，比这里瞎猜或偷偷丢掉都诚实。
 */
export function extractGenArgs(text) {
  const out = {
    prompt: '', model: '', ratio: '', size: '', resolution: '',
    quality: '', n: '', description: '', references: [], missing: [],
  }
  // 只分词、**不**预先展开 `--key=value`：下面用 flagOf 直接读内联值。
  // 先展开的话 `--model=-fast` 的 `-fast` 会被当成另一个 flag 丢掉 ——
  // 等号形式的意义恰恰是「这个值看起来像 flag」（实测踩过）。
  const tokens = splitTokens(text)
  const leftovers = []
  const pushRefs = (value) => {
    for (const part of String(value).split(',')) {
      const p = part.trim()
      if (p.length > 0) out.references.push(p)
    }
  }
  // flag 名 → 落点字段。REF/PROMPT 是特殊落点。
  // ⚠️ 漏列一个就是「合法参数没人认领」：值原样混进中文提示词发给模型，
  //    而用户以为生效了（本轮修过的真实缺陷，测试里有一条专门锁全表）。
  const KEYS = {
    model: 'model', m: 'model',
    ratio: 'ratio', size: 'size', resolution: 'resolution',
    quality: 'quality', n: 'n', description: 'description',
    ref: 'REF', refs: 'REF', reference: 'REF', references: 'REF', image: 'REF',
    prompt: 'PROMPT', p: 'PROMPT',
  }
  const list = tokens ?? []
  for (let i = 0; i < list.length; i += 1) {
    const t = String(list[i])
    // `--` 之后全是提示词文本（与 argparse 一致）：用户想写「-- 号」这种描述时不会被吃掉。
    if (t === '--') { leftovers.push(...list.slice(i + 1).map(String)); break }
    const f = flagOf(t)
    if (f === null) { leftovers.push(t); continue }
    const field = KEYS[f.name]
    if (field === undefined) {
      // 未知 flag：原样留在提示词里交给上游 argparse 报错，
      // 比在这里猜一个含义或偷偷丢掉都诚实。
      leftovers.push(t)
      if (f.inline !== null) leftovers.push(String(f.inline))
      continue
    }
    // 值优先取等号内联形式；否则取下一个 token，且它不能是另一个 flag。
    // ⚠️ 不能用 `startsWith('-')` 判：那样 `--n -1` 的负数会被当 flag，
    //    整段 `--n -1` 漏进提示词（与 CLI 结果还不一致，实测过）。
    let value = f.inline
    if (value === null) {
      const next = list[i + 1]
      if (next !== undefined && !looksLikeFlag(next)) { value = String(next); i += 1 }
    }
    if (value === null) {
      // 写了 flag 却没给值（漏参数 / 漏引号）：**必须报告**，不能装没事。
      // 这条链路是积分制 —— 例如 `--model` 漏值会静默回落到站点默认模型，
      // 用户指定的便宜模型没生效、积分照扣（比报错更糟的失败模式）。
      out.missing.push(t)
      continue
    }
    if (field === 'REF') { pushRefs(value); continue }
    if (field === 'PROMPT') { leftovers.push(value); continue }
    out[field] = value
  }
  out.prompt = leftovers.join(' ').trim()
  return out
}

/** 只有这些键允许重复累积；其余仍按「后者覆盖前者」处理。 */
const REPEATABLE_KEYS = new Set(['ref', 'refs', 'image', 'images'])

/** 导出以便测试能直接打真实实现（复刻一份解析器就等于没测）。 */
export function parseArgs(argv) {
  // 与 sfx / gpt / image 共用 flagOf / looksLikeFlag 一套语义（对齐 Python argparse）：
  //  - 旧写法只认 `startsWith('--')`，**短开关 `-m gpt-image-2` 整个不被识别**，
  //    键掉进位置参数、值被当描述 —— 结果是「用户指定了便宜模型，实际用站点
  //    默认模型出图」，静默花掉不一样的钱（积分通道的后果比报错更糟）。
  //  - `--key=value` 内联值直接认（不预先展开：展开后 `--model=-fast` 的
  //    `-fast` 会被当成另一个 flag 丢掉，而等号形式正是为这种值准备的）。
  //  - `--seed -1` 的负数是值；`--` 之后全是位置参数。
  const args = { _: [] }
  const list = argv ?? []
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i])
    if (token === '--') { args._.push(...list.slice(i + 1).map(String)); break }
    const f = flagOf(token)
    if (f === null) { args._.push(token); continue }
    // ⚠️ 只有「吃了下一个 token」才推进 i。曾经这里写成
    //   `if (value !== true) i += 1`，于是 `--ref=a.png` 这种**内联值**
    //   也被当成"消耗了一个 token"，把紧跟其后的参数直接跳过 ——
    //   实测 `-m=zap --ref=a.png` 只剩 m，`--ref` 整条消失（静默丢参考图）。
    let value
    if (f.inline !== null) value = f.inline
    else {
      const next = list[i + 1]
      if (next === undefined || looksLikeFlag(next)) value = true
      else { value = String(next); i += 1 }
    }
    // ⚠️ 参考图必须累积：`--ref a.png --ref b.png` 是文档承诺的用法，
    // 而 `args[key] = value` 会让后面的覆盖前面的 —— 用户以为传了 3 张，
    // 实际只有最后 1 张进上游（**静默丢图**，出的图与预期完全不符）。
    // 其它键保持覆盖语义（重复传 --prompt 之类收成数组会破坏下游）。
    if (REPEATABLE_KEYS.has(f.name)) {
      args[f.name] = args[f.name] === undefined
        ? value
        : (Array.isArray(args[f.name]) ? [...args[f.name], value] : [args[f.name], value])
    } else {
      args[f.name] = value
    }
    // Keep args.m for existing callers, but normalize into the field consumed
    // by gen/plan. Processing in order preserves last-selection-wins semantics.
    if (f.name === 'm') args.model = value
  }
  return args
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const cmd = args._[0] ?? 'status'
  const home = resolveDshHome()

  if (cmd === 'status') {
    const u = zaiduyuLaneUsable({ dshHome: home })
    process.stdout.write(`${JSON.stringify({
      ok: true,
      lane: 'zaiduyu',
      skillDir: zaiduyuSkillDir(),
      ...u,
      hint: u.usable ? '' : [
        u.script ? null : '脚本缺失：确认 skills/zaiduyu-imagegen/scripts/generate.py 在插件目录里',
        u.credentials ? null : '缺少站点账号：请在设置页「生成通道」→「章鱼生图（积分站）」卡里填账号密码并点「登录并保存」'
          + '（插件会先连站点只读验证，通过才保存，即时生效、无需重开宿主）。\n'
          + '  没有账号可注册：https://pai.zaiduyu.top/#/auth?ref=B7F529987DBF（邀请码 +50 张额度）\n'
          + '  本通道不提供命令行登录：环境变量只是兼容兜底，且不要把密码写进命令 —— 那会落进对话记录与本机日志。',
        u.python ? null : '未找到 Python 3（脚本只用标准库，无需第三方包）',
      ].filter(Boolean).join('\n'),
    }, null, 2)}\n`)
    return
  }
  if (cmd === 'models') {
    const r = await models(home)
    process.stdout.write(`${r.text}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (cmd === 'balance') {
    const r = await balance(home)
    process.stdout.write(`${r.text}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }
  if (cmd === 'plan') {
    const r = await plan(args.prompt, { model: args.model, dshHome: home })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    return
  }
  if (cmd === 'gen' || cmd === 'generate') {
    // 与 generate() 内部同一套收集口径：这里以前还列着 image/images，
    // 而那个键在消费端是**死代码**（generate() 自己会先把 --image 转成
    // argv 里的 --image 再交给 Python），列在收集表里只会让人误以为
    // 「CLI 转发的 --image 会走参考图通道」这种并不存在的语义。
    const refs = collectReferences(args)
    try {
      const r = await generate(home, args.prompt, {
        model: args.model, ratio: args.ratio, size: args.size, resolution: args.resolution,
        quality: args.quality, n: args.n ? Number(args.n) : undefined,
        references: refs, out: args.out, description: args.description,
      })
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message ?? err), ...(err?.preflight ? { preflight: err.preflight } : {}) }, null, 2)}\n`)
      process.exitCode = 1
    }
    return
  }
  process.stderr.write('usage: taptap-zaiduyu status | models | balance | plan --prompt "…" | gen --prompt "…" [--model ID] [--ratio 16:9] [--resolution 2K] [--n 2] [--ref 图1 --ref 图2] [--out file.png]\n')
  process.exitCode = 2
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack ?? err)}\n`)
    process.exitCode = 1
  })
}
