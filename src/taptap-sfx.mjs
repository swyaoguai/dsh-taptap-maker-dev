#!/usr/bin/env node
/**
 * taptap-sfx — 本地音效生成（Stable Audio Open 1.0），零额度、零 API 费。
 *
 * 定位：CC0 音效库（taptap-audio）找不到合适素材时的**本地兜底**。
 * 模型与 torch 都在用户自己机器上跑，不消耗任何 Maker 额度。
 *
 * 🛡️ 防呆红线（用户明确要求）：
 *  **本插件绝不自动下载模型权重**（约 5.3GB）——怕用户硬件条件不够。
 *  `guide` 只打印逐条的手动下载命令，由用户自己在终端执行；
 *  `gen` 在模型文件不全时**直接拒绝**并把用户引回 guide/verify/check，
 *  不会"顺手"替他拉一个 4GB 大文件。
 *
 * 通路（复用第三方整合的 Python 脚本，本模块只做编排与落盘）：
 *   check / verify / doctor / deps / guide  → skills/taptap-maker-local-sfx/scripts/sfx_env.py
 *   gen                                     → 同目录 generate.py（需要 venv 里的 torch）
 *
 * Usage:
 *   node taptap-sfx.mjs check
 *   node taptap-sfx.mjs guide
 *   node taptap-sfx.mjs verify [--fast]
 *   node taptap-sfx.mjs deps            # 只打印安装命令
 *   node taptap-sfx.mjs deps --yes      # 真的装 venv + torch（约 3GB 下载）
 *   node taptap-sfx.mjs doctor
 *   node taptap-sfx.mjs gen "coin pickup, bright arcade blip" [--project <dir>] [-s 3] [-n 3] [--steps 100]
 *
 * @module src/taptap-sfx.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installFile } from './taptap-audio.mjs'
import { splitTokens, flagOf, looksLikeFlag } from './tokens.mjs'

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 随插件分发的本地音效 skill 目录。 */
export function sfxSkillDir() {
  return path.join(PKG_DIR, '..', 'skills', 'taptap-maker-local-sfx')
}
export function sfxEnvScript() {
  return path.join(sfxSkillDir(), 'scripts', 'sfx_env.py')
}
export function sfxGenScript() {
  return path.join(sfxSkillDir(), 'scripts', 'generate.py')
}

/**
 * 解析可用的 python（与 zaiduyu 通道同一口径：先跑一条 -c 验活，
 * 挡掉 Microsoft Store stub）。
 */
export function findPython() {
  for (const bin of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(bin, ['-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      })
      if (r.status === 0 && (r.stdout ?? '').trim() === '3') return bin
    } catch { /* try next */ }
  }
  return null
}

/** venv 里的 python（gen 必须用它：torch/diffusers 装在 venv 内）。 */
export function sfxVenvPython(home) {
  const candidates = [
    process.env.TAPTAP_SFX_HOME,
    'D:\\stable-audio',
    path.join(process.env.LOCALAPPDATA ?? '', 'taptap-maker-sfx'),
  ].filter(Boolean)
  for (const c of candidates) {
    const p = path.join(c, 'venv', 'Scripts', 'python.exe')
    if (fs.existsSync(p)) return p
  }
  return null
}

/** 模型文件是否已就位（快速判断，不做 SHA256）。 */
export function sfxModelReady() {
  const home = sfxHome()
  if (home === null) return false
  const md = path.join(home, 'model', 'stable-audio-open-1.0')
  return [
    'model_index.json',
    path.join('transformer', 'diffusion_pytorch_model.safetensors'),
    path.join('vae', 'diffusion_pytorch_model.safetensors'),
    path.join('text_encoder', 'model.safetensors'),
  ].every((f) => fs.existsSync(path.join(md, f)))
}

/** 与 sfx_env.py 的 resolve_home 同口径：环境变量 > 已知安装 > 默认。 */
export function sfxHome() {
  const env = process.env.TAPTAP_SFX_HOME
  const sub = path.join('model', 'stable-audio-open-1.0')
  if (env && fs.existsSync(path.join(env, sub))) return env
  for (const known of [
    'D:\\stable-audio',
    path.join(process.env.LOCALAPPDATA ?? '', 'taptap-maker-sfx'),
  ]) {
    if (known && fs.existsSync(path.join(known, sub))) return known
  }
  return env ?? path.join(process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? '', 'taptap-maker-sfx')
}

/** 跑一次 sfx_env.py 子命令并把输出原样带回来。 */
export function runEnv(subcommand, extra = [], { timeoutMs = 300000 } = {}) {
  const py = findPython()
  if (py === null) {
    return { code: -1, stdout: '', stderr: '未找到可用的 Python 3（本功能需要 python 3.10+）' }
  }
  const r = spawnSync(py, [sfxEnvScript(), subcommand, ...extra], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * runEnv 的异步版：给宿主（index.js）用。
 * 同步版最长会占住宿主事件循环到 timeoutMs（verify 要哈希 5.3GB、deps --yes
 * 要下载 3GB）—— 那期间设置页所有请求一起挂住，用户看到的是「插件把 GUI 弄死了」。
 */
export function runEnvAsync(subcommand, extra = [], { timeoutMs = 300000 } = {}) {
  const py = findPython()
  if (py === null) {
    return Promise.resolve({ code: -1, stdout: '', stderr: '未找到可用的 Python 3（本功能需要 python 3.10+）' })
  }
  return new Promise((resolve) => {
    const child = spawn(py, [sfxEnvScript(), subcommand, ...extra], {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* gone */ }
      resolve({ code: -2, stdout, stderr: `${stderr}\n（超时 ${Math.round(timeoutMs / 1000)} 秒，已终止子进程）` })
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

/**
 * 本地生成一条音效。
 * 前置三关都过才真正跑 torch（任何一关不过都拒绝，绝不隐晦地跳过）：
 *   1) 模型文件齐（不齐 → 让用户跑 guide 手动下载）；
 *   2) venv 已装好（没装 → 让用户跑 deps --yes）；
 *   3) 显卡显存够（sfx_env.py check 的结论）—— 不够就直接劝退，
 *      不生成"能出但等一小时"的东西。
 * 输出：生成到临时目录 → 有 --project 就走 installFile 进 assets/audio/sfx
 *       并补 .meta；否则留在 sucai 素材目录（与图片通道同一落点体系）。
 */
/**
 * 组装给 generate.py 的参数。导出是为了能被真实测到
 * （在测试里复刻一份同样的拼装，测的是复刻品而不是实际代码）。
 *
 * ⚠️ 顺序必须是「所有 flag 在前，`--` 收尾，提示词放最后」：
 *    Python argparse 里提示词是位置参数，用户描述万一以 `-` 或 `--` 开头
 *    （`-- 号音效` 之类），放在前面会被当成未知 flag 直接报错。
 *    `--` 之后的 token 一律按位置参数解析，这才是安全写法。
 */
export function buildGenArgv(scriptPath, prompt, {
  outDir, seconds = 10, steps = 100, variants = 1, seed = 0, cfg = 7, lowvram,
} = {}) {
  return [
    scriptPath,
    '-o', String(outDir),
    '-s', String(seconds), '--steps', String(steps), '-n', String(variants),
    '--seed', String(seed), '--cfg', String(cfg),
    // 三态：true → --lowvram，false → --no-lowvram，undefined → 让脚本自动判。
    ...(lowvram === true ? ['--lowvram'] : lowvram === false ? ['--no-lowvram'] : []),
    '--', String(prompt),
  ]
}

export function generate(prompt, {
  seconds = 10, steps = 100, variants = 1, seed = 0, cfg = 7, projectDir, outName, lowvram, timeoutMs = 1800000,
} = {}) {
  const py = sfxVenvPython()
  if (!sfxModelReady()) {
    return { ok: false, code: 'model_missing', hint: '本地音效模型尚未下载（约 5.3GB，本插件不自动下载）。\n'
      + '先跑 /taptap-sfx check 看显卡是否够；够的话 /taptap-sfx guide 会打印逐条手动下载命令，'
      + '下载完 /taptap-sfx verify 校验。' }
  }
  if (py === null) {
    return { ok: false, code: 'venv_missing', hint: '依赖环境还没装好。运行 /taptap-sfx deps 查看要装什么（约 3GB 下载），'
      + '确认后加 --yes 才真正安装。' }
  }
  const outDir = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMP ?? '/tmp', 'sfx-'))
  const r = spawnSync(py, buildGenArgv(sfxGenScript(), prompt, {
    outDir, seconds, steps, variants, seed, cfg, lowvram,
  }), {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    maxBuffer: 16 * 1024 * 1024,
  })
  const wavs = (() => { try { return fs.readdirSync(outDir).filter((f) => f.endsWith('.wav')) } catch { return [] } })()
  if ((r.status ?? -1) !== 0 && wavs.length === 0) {
    return {
      ok: false, code: 'gen_failed',
      error: (r.stderr || r.stdout || '').trim().split('\n').slice(-4).join('\n') || `exit ${r.status}`,
    }
  }
  const results = []
  for (const wav of wavs) {
    const srcAbs = path.join(outDir, wav)
    if (projectDir) {
      try {
        const installed = installFile(srcAbs, path.resolve(projectDir), 'sfx', outName && wavs.length === 1 ? outName : wav)
        results.push({ file: installed.target, uuid: installed.uuid, kb: Math.round(installed.bytes / 1024) })
        continue
      } catch (err) {
        return { ok: false, code: 'install_failed', error: String(err?.message ?? err) }
      }
    }
    results.push({ file: srcAbs, kb: Math.round(fs.statSync(srcAbs).size / 1024) })
  }
  return { ok: true, generated: results.length, files: results, stderr: (r.stderr || '').trim() }
}

/**
 * 把 sfx_env.py check 的输出解析成机器可用的结论。
 * 导出是为了让「缺 Python 时不能判成可用」这条能被测到（它是劝退与否的总闸）。
 */
export function parseSfxCheck(r) {
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const gpuLine = /GPU\s*:\s*(.+)/.exec(text)
  const gpu = gpuLine ? gpuLine[1].trim() : ''
  const verdict = /结论\s*:\s*(.+)/.exec(text)?.[1]?.trim() ?? ''
  const noGpu = /未检测到 NVIDIA GPU/.test(text)
  const notRecommended = /不建议/.test(verdict)
  // ⚠️ 「没跑出 GPU 那一行」= check 根本没执行成功（典型是缺 Python），
  // 绝不能因为「文本里没有『不建议』三个字」就判成可用 —— 那会让用户一路
  // 跑到 gen 才失败，而且报的是 venv_missing 这种更晚、更难懂的错。
  const ran = r.code === 0 && gpuLine !== null
  return { ok: r.code === 0, ran, gpu, verdict, usable: ran && !noGpu && !notRecommended, text }
}

/** 硬件体检的机器可读摘要（供 CLI 决定是否劝退）。 */
export function checkHardware() {
  return parseSfxCheck(runEnv('check', [], { timeoutMs: 60000 }))
}

/**
 * 异步版本：给宿主（index.js）用。
 * checkHardware() 走 spawnSync，最长能占住宿主事件循环 60 秒 ——
 * 那期间设置页所有请求一起挂住，用户看到的是「插件把 GUI 弄死了」。
 */
export async function checkHardwareAsync() {
  return parseSfxCheck(await runEnvAsync('check', [], { timeoutMs: 60000 }))
}

/**
 * 解析 `/taptap-sfx gen` 的参数：先按引号感知规则分词（共用 tokens.mjs），
 * 再逐个摘掉已知 flag，**剩下的全部 token 拼回提示词**。
 *
 * 为什么不用正则剥 flag：旧写法只在「提示词带引号」时才干净 ——
 * `gen sword swing -n 2` 实测把 `-n 2` 原样留在英文提示词里发给模型
 * （模型会把 "-n 2" 当成声音描述的一部分）；而 `gen --project D:\p whoosh`
 * 更糟：那条 --project 正则带着贪婪的 `.*`，会把后面的整句吞掉，
 * 用户看到「请给一句描述」却完全不知道自己在哪写错了。
 *
 * 位置无关、引号无关；**未知 flag 留在提示词里而不是被静默丢弃**
 * （未知 flag 交给下游 Python argparse 报错，比在这里瞎猜更诚实）。
 */
export function parseGenArgs(rest) {
  // 只分词、**不**预先展开 `--key=value`：consumeGenFlags 内部用 flagOf 直接读
  // 内联值。先展开的话 `--model=-fast` 的 `-fast` 会被当成另一个 flag 而丢掉
  // —— 等号形式的意义恰恰是「这个值看起来像 flag」（实测踩过）。
  return consumeGenFlags(splitTokens(rest))
}

/**
 * 从**原子 token 数组**里摘掉已知 flag，剩下的全部拼回提示词。
 *
 * 语义完全对齐 Python argparse（`flagOf` / `looksLikeFlag` 是唯一来源）：
 *  - `--seed -1`：负数是**值**，不是 flag（旧写法把 `-1` 当 flag，于是
 *    `--seed -1` 整段漏进提示词发给模型 —— 与 CLI 结果不一致）；
 *  - `--model=-fast`：等号形式允许「看起来像 flag」的值；
 *  - `--`：之后的 token 一律按提示词处理，不再解析 flag。
 *
 * 为什么要和分词分开：CLI 拿到的 process.argv 每个元素已经是原子的值
 * （shell 早就把引号吃掉了）。若把 `args._` 重拼成字符串再分词，
 * `--project "D:\my proj"` 这种带空格的值会被拆成两段 —— 路径只剩一半、
 * 后半截还漏进提示词。所以 CLI 直接喂 argv 切片，宿主才走 splitTokens。
 */
export function consumeGenFlags(tokens) {
  const out = {
    prompt: '', project: '', seconds: '', variants: '', seed: '', out: '',
    steps: '', cfg: '', lowvram: '', missing: [],
  }
  const leftovers = []
  const list = tokens ?? []
  // 取值型 flag 的表：键名 → 落点字段。布尔型（--lowvram）单独列。
  // ⚠️ 漏列一个就会**静默失效或混进提示词**（本轮修过的真实缺陷），
  //    所以测试里有一条专门锁「解析器必须认识全部支持的 flag」。
  const VALUE_KEYS = {
    project: 'project', s: 'seconds', seconds: 'seconds',
    n: 'variants', variants: 'variants', seed: 'seed',
    out: 'out', o: 'out', steps: 'steps', cfg: 'cfg',
    prompt: 'PROMPT', p: 'PROMPT',
  }
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i]
    // `--` 之后全是位置参数（与 argparse 一致）：后面的 token 原样进提示词。
    if (t === '--') { leftovers.push(...list.slice(i + 1).map(String)); break }
    const f = flagOf(t)
    if (f === null) { leftovers.push(String(t)); continue }
    const field = VALUE_KEYS[f.name]
    if (field === undefined) {
      // 布尔开关；未知 flag 原样留在提示词里（交给下游报错，不偷偷丢）。
      if (f.name === 'lowvram') { out.lowvram = 'force'; continue }
      if (f.name === 'no-lowvram') { out.lowvram = 'off'; continue }
      leftovers.push(String(t))
      continue
    }
    // 值优先取等号内联形式；否则取下一个 token，且**不能**是下一个 flag。
    let value = f.inline
    if (value === null) {
      const next = list[i + 1]
      if (next !== undefined && !looksLikeFlag(next)) { value = String(next); i += 1 }
    }
    if (value === null) {
      // 用户写了 `--seed`（后面漏值，或漏了引号）：不能装作没事继续 ——
      // 对本地生成浪费一次长跑，对积分通道就是白烧钱。记下来让命令层拒绝。
      out.missing.push(String(t))
      continue
    }
    if (field === 'PROMPT') { leftovers.push(value); continue }
    out[field] = value
  }
  out.prompt = leftovers.join(' ').trim()
  return out
}

/** 导出以便测试直接打真实实现（与 taptap-zaiduyu 的 parseArgs 对称）。 */
export function parseArgs(argv) {
  // 与宿主消费器共用 flagOf / looksLikeFlag 一套语义：
  //  - `--key=value` 内联值直接认（下游 argparse 支持，实测不认会把值弄丢）；
  //  - `--seed -1` 的负数是**值**不是 flag；
  //  - 同一句话在 CLI 与斜杠命令上必须得到同样的结果。
  const args = { _: [] }
  const list = argv ?? []
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i])
    if (token === '--') { args._.push(...list.slice(i + 1).map(String)); break }
    const f = flagOf(token)
    if (f === null) { args._.push(token); continue }
    if (f.inline === null && ['lowvram', 'no-lowvram', 'fast', 'yes'].includes(f.name)) {
      args[f.name] = true
      continue
    }
    if (f.inline !== null) { args[f.name] = f.inline; continue }
    const next = list[i + 1]
    if (next === undefined || looksLikeFlag(next)) args[f.name] = true
    else { args[f.name] = String(next); i += 1 }
  }
  return args
}

/** 安全取数字：flag 存在且能解析成正数才生效，否则用默认。 */
function numOpt(value, fallback) {
  if (value === undefined || value === true) return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const cmd = (args._[0] ?? 'help').toLowerCase()

  if (cmd === 'help') {
    process.stdout.write([
      'taptap-sfx — 本地音效生成（Stable Audio Open 1.0，零额度）',
      '',
      '  check                  硬件/环境体检（显卡、显存、磁盘、模型完整度）',
      '  guide                  模型手动下载指引（本插件绝不自动下载 5.3GB 权重）',
      '  verify [--fast]        校验已下载文件（SHA256 / 只比大小）',
      '  deps [--yes]           打印或执行依赖安装（venv + torch，约 3GB）',
      '  doctor                 装好后的体检',
      '  gen "<英文描述>" [--project <dir>] [-s 秒] [-n 条数] [--steps 100]',
      '                         本地生成音效；有 --project 则直接进 assets/audio/sfx 并补 .meta',
      '',
      `skill 目录：${sfxSkillDir()}`,
      '提示：音效优先用 CC0 库（taptap-audio），本地生成是兜底 —— 首次要手动下 5.3GB 模型。',
      '提示：提示词用英文效果最好（模型只用英文数据训练）。',
    ].join('\n') + '\n')
    return
  }

  // 三个只读/准备类子命令：原样转发给 sfx_env.py，输出给用户看。
  for (const sub of ['check', 'guide', 'verify', 'doctor']) {
    if (cmd === sub) {
      const extra = []
      if (args.fast === true && sub === 'verify') extra.push('--fast')
      const r = runEnv(sub, extra)
      process.stdout.write(`${r.stdout}${r.stderr}`)
      if (r.code !== 0) process.exitCode = 1
      return
    }
  }

  if (cmd === 'deps') {
    // deps 默认只打印；--yes 才会下载约 3GB —— 这是用户级决定，不代做。
    const extra = args.yes === true ? ['--yes'] : []
    const r = runEnv('deps', extra, { timeoutMs: args.yes === true ? 3600000 : 60000 })
    process.stdout.write(`${r.stdout}${r.stderr}`)
    if (r.code !== 0) process.exitCode = 1
    return
  }

  if (cmd === 'gen') {
    // argv tokens are already shell-decoded. Use the same consumer as the
    // slash command so booleans, aliases and missing values cannot diverge.
    const genArgs = consumeGenFlags(argv.slice(1))
    if (genArgs.missing.length > 0) {
      process.stderr.write(`参数「${genArgs.missing.join('、')}」后面没有值，未开始生成。\n`)
      process.exitCode = 2
      return
    }
    const prompt = genArgs.prompt
    if (prompt.length === 0) {
      process.stderr.write('用法：taptap-sfx gen "<英文音效描述>" [--project <dir>] [-s 10] [-n 1] [--steps 100]\n')
      process.exitCode = 2
      return
    }
    // 先做硬件门槛检查：硬件不够就不要开始长跑（模型加载本身就几十秒到几分钟）。
    const hw = checkHardware()
    if (!hw.ran) {
      // check 没能真跑成功（典型是缺 Python）：这既不是「硬件不行」也不是「能跑」，
      // 必须分开说 —— 否则用户以为是显卡问题，去做毫无必要的硬件升级。
      process.stdout.write(`${JSON.stringify({
        ok: false,
        code: 'env_check_failed',
        error: hw.text.split(/\r?\n/).filter(Boolean).slice(-2).join(' / ') || '体检子进程没有正常退出',
        hint: '硬件体检没能执行完成，先修好本机 Python（跑 taptap-sfx check 看详情）；期间不会开始任何生成。',
      }, null, 2)}\n`)
      process.exitCode = 1
      return
    }
    if (!hw.usable) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        code: 'hardware_insufficient',
        gpu: hw.gpu || '未检测到',
        verdict: hw.verdict || '不建议在本机跑本地生成',
        hint: '建议改用 CC0 音效库：node "<插件目录>/src/taptap-audio.mjs" add "<描述>" --project <项目目录>',
      }, null, 2)}\n`)
      process.exitCode = 1
      return
    }
    const r = generate(prompt, {
      seconds: numOpt(genArgs.seconds, 10),
      steps: numOpt(genArgs.steps, 100),
      variants: numOpt(genArgs.variants, 1),
      seed: Number(genArgs.seed || 0),
      cfg: numOpt(genArgs.cfg, 7),
      projectDir: genArgs.project || undefined,
      outName: genArgs.out || undefined,
      lowvram: genArgs.lowvram === 'off' ? false : (genArgs.lowvram === 'force' ? true : undefined),
    })
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
    if (!r.ok) process.exitCode = 1
    return
  }

  process.stderr.write(`未知子命令：${cmd}（跑 taptap-sfx help）\n`)
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
