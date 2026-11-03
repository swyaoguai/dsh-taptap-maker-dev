/**
 * 发现「此刻有哪些 Cocos Creator 编辑器实例、各自是哪个项目、MCP 挂在哪个端口」。
 *
 * 为什么不能靠「约定端口」找项目：
 *  - Cocos 的预览端口自己会递增（本机实测 7456、7457），MCP 端口则由扩展按项目路径
 *    派生并在被占用时回退 —— 端口只是「线索」，不是「身份」。
 *  - 三个项目同时开时，端口和项目目录的对应关系是动态的；任何写死的映射早晚会串。
 *
 * 所以走「进程 → 项目 → 端口 → 探测身份」这条链：
 *  1. 枚举 CocosCreator 主进程（命令行里带 `--project <dir>`，且不含 `--type=`，
 *     后者是 Electron 的渲染/GPU 子进程，不是编辑器实例）；
 *  2. 取这些 pid 正在 LISTEN 的端口（MCP 服务与预览服务都在主进程里）；
 *  3. 逐端口 `GET /health`，读回 `project_path` / `project_id` —— 这才是身份。
 *
 * 兜底：拿不到进程表（非 Windows、或 PowerShell 被策略挡住）时，退回
 * 「已知项目 + 上次记录端口」的探测，宁可只报不可用，也不猜。
 *
 * @module src/cocos/discover.mjs
 */
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { psSingleQuote } from '../win-proc.mjs'
import { probeHealth } from './mcp-http.mjs'
import { normalizeProjectPath, sameProjectPath, stripTrailingSep } from './paths.mjs'

const IS_WINDOWS = process.platform === 'win32'

/** 模块级缓存：工具调用很密，不能每次都扫进程表。 */
let cache = { at: 0, value: null }

/** 清掉缓存（测试与「刚启动编辑器」后用）。 */
export function invalidateDiscoveryCache() {
  cache = { at: 0, value: null }
}

function runPowerShellJson(script, timeoutMs) {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  if (result.error) throw new Error(`PowerShell 执行失败：${result.error.message}`)
  const text = (result.stdout ?? '').trim()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`PowerShell 输出无法解析为 JSON：${text.slice(0, 300)}`)
  }
}

/** Windows：一次 PowerShell 调用拿齐「主进程 + 各自监听端口」。 */
function scanWindows({ timeoutMs = 20000 } = {}) {
  const filter = psSingleQuote("Name='CocosCreator.exe'")
  const script = [
    `$procs = @(Get-CimInstance Win32_Process -Filter ${filter} -ErrorAction SilentlyContinue) | `,
    "Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match '--project\\s' }\n",
    '$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ',
    'Select-Object LocalPort,OwningProcess)\n',
    '$out = @()\n',
    'foreach ($p in $procs) {\n',
    '  $cmd = [string]$p.CommandLine\n',
    '  $proj = $null\n',
    '  if ($cmd -match \'--project\\s+"([^"]+)"\') { $proj = $Matches[1] }\n',
    "  elseif ($cmd -match '--project\\s+(\\S+)') { $proj = $Matches[1] }\n",
    '  if (-not $proj) { continue }\n',
    '  $ports = @()\n',
    '  foreach ($l in $listeners) { if ($l.OwningProcess -eq $p.ProcessId) { $ports += [int]$l.LocalPort } }\n',
    '  $out += [pscustomobject]@{\n',
    '    pid = [int]$p.ProcessId;\n',
    '    project = $proj;\n',
    '    exe = [string]$p.ExecutablePath;\n',
    '    build = [bool]($cmd -match \'--build\');\n',
    '    commandLine = $cmd;\n',
    '    ports = $ports\n',
    '  }\n',
    '}\n',
    '$out | ConvertTo-Json -Compress -Depth 5\n',
  ].join('')
  const parsed = runPowerShellJson(script, timeoutMs)
  if (parsed === null) return []
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list
    .filter((item) => item && Number.isFinite(Number(item.pid)))
    .map((item) => ({
      pid: Number(item.pid),
      projectPath: normalizeProjectPath(stripTrailingSep(String(item.project ?? ''))),
      exePath: typeof item.exe === 'string' && item.exe !== '' ? item.exe : '',
      build: Boolean(item.build),
      ports: Array.isArray(item.ports)
        ? [...new Set(item.ports.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0 && p < 65536))]
        : [],
    }))
}

/** 非 Windows 的最小实现：ps + lsof（拿不到就返回空表，不猜）。 */
function scanPosix() {
  try {
    const ps = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', timeout: 15000 })
    const lines = String(ps.stdout ?? '').split(/\r?\n/)
    const out = []
    for (const line of lines) {
      if (!/CocosCreator/i.test(line) || /--type=/.test(line)) continue
      const match = /--project\s+("([^"]+)"|(\S+))/.exec(line)
      if (!match) continue
      const pid = Number.parseInt(line.trim().split(/\s+/)[0], 10)
      if (!Number.isFinite(pid)) continue
      let ports = []
      const lsof = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], { encoding: 'utf8', timeout: 8000 })
      const seen = new Set()
      for (const l of String(lsof.stdout ?? '').split(/\r?\n/)) {
        const m = /:(\d+)\s+\(LISTEN\)/.exec(l)
        if (m) seen.add(Number(m[1]))
      }
      ports = [...seen]
      out.push({
        pid,
        projectPath: normalizeProjectPath(stripTrailingSep(match[2] ?? match[3] ?? '')),
        exePath: '',
        build: /--build/.test(line),
        ports,
      })
    }
    return out
  } catch {
    return []
  }
}

/** 扫进程表（不带 MCP 探测）。 */
export function scanEditors(opts = {}) {
  try {
    return IS_WINDOWS ? scanWindows(opts) : scanPosix()
  } catch {
    return []
  }
}

/**
 * 给一个实例的每个候选端口做 `/health` 探测，找出真正的 MCP 端点。
 *
 * 一个实例通常只有 1~2 个监听端口（预览 + MCP）。并行探测、失败静默。
 */
async function probeInstancePorts(instance, { timeoutMs = 900 } = {}) {
  const ports = instance.ports.slice(0, 12)
  if (ports.length === 0) return []
  const results = await Promise.all(ports.map((port) => probeHealth(port, { timeoutMs })))
  return results.filter((item) => item !== null && item.ok)
}

/**
 * 完整发现：实例 + 每个实例的 MCP 身份。
 *
 * @param {object} [opts]
 * @param {number} [opts.cacheMs] 缓存有效期（0 = 强制重扫）
 * @param {number} [opts.timeoutMs] 单端口探测超时
 * @returns {Promise<{instances: Array, probedAt: number, platform: string}>}
 */
export async function discoverLive(opts = {}) {
  const cacheMs = opts.cacheMs ?? 2500
  const now = Date.now()
  if (cacheMs > 0 && cache.value !== null && now - cache.at < cacheMs) return cache.value

  const instances = scanEditors()
  const enriched = await Promise.all(instances.map(async (instance) => {
    const healths = instance.ports.length > 0 ? await probeInstancePorts(instance, opts) : []
    // 交互实例优先：`--build` 是命令行构建用的无头实例，不该被当成交互目标。
    healths.sort((a, b) => a.port - b.port)
    return { ...instance, mcpHealths: healths }
  }))

  const value = { instances: enriched, probedAt: now, platform: process.platform }
  cache = { at: now, value }
  return value
}

/**
 * 把「正在运行的实例」整理成按项目聚合的视图。
 *
 * 同一项目可能同时有两个实例（交互 + 无头构建），这里合并成一条，
 * 并保留全部 pid/端口，方便上层决定用哪个、以及提示「有两个实例」。
 */
export function groupByProject(discovery) {
  const byKey = new Map()
  for (const instance of discovery.instances) {
    const key = IS_WINDOWS ? instance.projectPath.toLowerCase() : instance.projectPath
    const existing = byKey.get(key) ?? {
      projectPath: instance.projectPath,
      instances: [],
      healths: [],
    }
    existing.instances.push(instance)
    for (const health of instance.mcpHealths) {
      if (!existing.healths.some((item) => item.port === health.port)) existing.healths.push(health)
    }
    byKey.set(key, existing)
  }
  return [...byKey.values()].map((group) => {
    const interactive = group.instances.filter((instance) => !instance.build)
    const buildOnly = group.instances.filter((instance) => instance.build)
    return {
      ...group,
      interactivePid: interactive[0]?.pid ?? null,
      buildPids: buildOnly.map((instance) => instance.pid),
      exePath: (interactive[0] ?? group.instances[0])?.exePath ?? '',
    }
  })
}

/** 在运行中的实例里按项目路径找一组（找不到返回 null）。 */
export function findRunningProject(discovery, projectPath) {
  const groups = groupByProject(discovery)
  return groups.find((group) => sameProjectPath(group.projectPath, projectPath)) ?? null
}

/** 本机可能存在的 Cocos Creator 可执行文件（用于启动编辑器/命令行构建）。 */
export function findCreatorExecutables() {
  const found = []
  if (IS_WINDOWS) {
    const script = [
      '$roots = @()\n',
      "$roots += (Join-Path $env:ProgramData 'cocos\\editors\\Creator')\n",
      "$roots += (Join-Path $env:ProgramFiles 'CocosCreator')\n",
      "$roots += (Join-Path ${env:ProgramFiles(x86)} 'CocosCreator')\n",
      '$out = @()\n',
      'foreach ($r in $roots) {\n',
      '  if (-not $r -or -not (Test-Path $r)) { continue }\n',
      '  $out += @(Get-ChildItem -Path $r -Filter CocosCreator.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue | ',
      'ForEach-Object { $_.FullName })\n',
      '}\n',
      '$out | ConvertTo-Json -Compress\n',
    ].join('')
    try {
      const parsed = runPowerShellJson(script, 20000)
      const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
      for (const item of list) if (typeof item === 'string' && item.endsWith('.exe')) found.push(item)
    } catch { /* 找不到就让调用方给参数 */ }
  }
  return found
}

/** 从可执行文件路径推断 Creator 版本（`.../Creator/3.8.8/CocosCreator.exe`）。 */
export function creatorVersionFromExe(exePath) {
  if (typeof exePath !== 'string') return ''
  const match = /[\\/](\d+\.\d+\.\d+(?:[-.\w]*)?)[\\/](?:CocosCreator\.exe)?$/i.exec(exePath)
  if (match) return match[1]
  const any = /(\d+\.\d+\.\d+)/.exec(exePath)
  return any ? any[1] : ''
}

export { os as _os }
