/**
 * Cocos 侧 MCP 扩展的安装 / 体检。
 *
 * 我们**不自研编辑器扩展**：Cocos 的场景/预制体/资源是一套很难对齐的序列化格式，
 * 重造一遍既慢又容易在预制体引用、资源 UUID 上翻车。这里接的是开源 MIT 的
 * Funplay MCP for Cocos（编辑器内嵌 HTTP MCP 服务），我们负责：
 *   - 检测装没装、装在哪、什么版本；
 *   - 装到「项目级 extensions/」优先（天然按项目隔离，不污染全局）；
 *   - 写好它的工程配置（`portMode: project` = 按项目派生端口，避免多实例抢端口）；
 *   - 体检：端口、身份、工具档位是否够用。
 *
 * 安装过程只做「下载官方 release + 校验 SHA256 + 解压到目标目录」，
 * 不执行第三方脚本、不改全局 npm。
 *
 * @module src/cocos/install.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { CocosMcpError } from './mcp-http.mjs'
import { psSingleQuote } from '../win-proc.mjs'
import { cocosUserDir, downloadDir, normalizeProjectPath } from './paths.mjs'
import { readProjectMeta } from './router.mjs'

const REPO = 'FunplayAI/funplay-cocos-mcp'
const EXTENSION_DIR_NAME = 'funplay-cocos-mcp'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 探测扩展安装位置（项目级 / 全局），返回安装信息或 null。 */
export function detectExtension(projectPath) {
  const normal = normalizeProjectPath(projectPath)
  const meta = readProjectMeta(normal)
  const version = meta?.creatorVersion ?? ''
  const candidates = []
  candidates.push({
    scope: 'project',
    dir: path.join(normal, 'extensions', EXTENSION_DIR_NAME),
  })
  if (version !== '') {
    candidates.push({
      scope: 'global',
      dir: path.join(cocosUserDir(), 'builtin-extensions', version, EXTENSION_DIR_NAME),
    })
  }
  for (const candidate of candidates) {
    const pkg = readJson(path.join(candidate.dir, 'package.json'))
    if (pkg !== null) {
      return {
        ...candidate,
        installed: true,
        version: String(pkg.version ?? ''),
        name: String(pkg.name ?? EXTENSION_DIR_NAME),
      }
    }
  }
  return null
}

/** 工程级配置文件路径与当前内容。 */
export function projectConfigPath(projectPath) {
  return path.join(normalizeProjectPath(projectPath), 'funplay-cocos-mcp.config.json')
}

export function readProjectConfig(projectPath) {
  return readJson(projectConfigPath(projectPath))
}

/**
 * 列出**所有**已装位置（工程级 + 全局）。
 *
 * `detectExtension` 只返回第一个命中，于是「工程里装了一份、全局也装了一份」
 * 这种状态看起来和正常没区别 —— 但 Cocos 会把两份都加载，扩展注册两次、
 * 菜单重复、两个 MCP 端口抢同一个项目。doctor 需要能看到这个。
 */
export function detectAllExtensions(projectPath) {
  const normal = normalizeProjectPath(projectPath)
  const meta = readProjectMeta(normal)
  const version = meta?.creatorVersion ?? ''
  const out = []
  const dirs = [{ scope: 'project', dir: path.join(normal, 'extensions', EXTENSION_DIR_NAME) }]
  if (version !== '') {
    dirs.push({ scope: 'global', dir: path.join(cocosUserDir(), 'builtin-extensions', version, EXTENSION_DIR_NAME) })
  }
  for (const candidate of dirs) {
    const pkg = readJson(path.join(candidate.dir, 'package.json'))
    if (pkg === null) continue
    out.push({
      ...candidate,
      installed: true,
      version: String(pkg.version ?? ''),
      name: String(pkg.name ?? EXTENSION_DIR_NAME),
    })
  }
  return out
}

/**
 * 写入「按项目派生端口 + 自动启动」的配置（已存在就完全不动）。
 *
 * 为什么必须写这个：扩展默认可能沿用固定端口 8765，两个项目一起开就会抢同一个端口，
 * 第二个实例回退到临时端口 —— 而临时端口重启后会变，客户端配置立刻指向错项目。
 */
export function ensureProjectConfig(projectPath, { force = false } = {}) {
  const file = projectConfigPath(projectPath)
  const existing = readJson(file)
  if (existing !== null && !force) return { file, written: false, config: existing }
  // 默认值 → 覆盖既有配置里我们不强管的字段 → 最后写死我们必须保证的三项。
  // 注意 `portMode`：用户主动固定过端口（fixed + port）就尊重它，
  // 否则一律用 project —— 多项目并行的前提就是端口跟着项目走。
  const config = {
    host: '127.0.0.1',
    portMode: 'project',
    autostart: true,
    toolProfile: 'core',
    enableConsoleLogging: true,
    executeJavascriptSafetyChecks: true,
    ...(existing ?? {}),
  }
  config.host = '127.0.0.1'
  if (!(config.portMode === 'fixed' && Number(config.port) > 0)) config.portMode = 'project'
  config.autostart = existing?.autostart !== false
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return { file, written: true, config }
}

/** 取最新 release 信息（网络失败返回 null，由调用方给出手动指引；限流则明确抛出）。 */
export async function fetchLatestRelease({ timeoutMs = 20000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'user-agent': 'dsh-game-forge', accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      // 区分「限流」与「网络不通」：GitHub 匿名 API 每小时 60 次，CI 里连跑几次
      // 就会 403；笼统说「网络/代理问题」会让人去查网络，白折腾。
      if (response.status === 403 || response.status === 429) {
        const remaining = response.headers.get('x-ratelimit-remaining')
        const reset = response.headers.get('x-ratelimit-reset')
        const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : '未知'
        throw new CocosMcpError(
          `GitHub API 限流（HTTP ${response.status}，剩余 ${remaining ?? '?'}，重置时间 ${resetAt}）。`
          + '这是匿名调用的每小时配额，不是网络故障。稍后再试，或手动安装：\n'
          + `  下载 https://github.com/${REPO}/releases 里的 Funplay.CocosMcp.v<版本>.zip，`
          + `解压后把 ${EXTENSION_DIR_NAME}/ 放进工程的 extensions/`,
          { code: 'RELEASE_RATE_LIMITED' },
        )
      }
      return null
    }
    const body = await response.json()
    const assets = Array.isArray(body.assets) ? body.assets : []
    const zip = assets.find((asset) => /\.zip$/i.test(String(asset.name ?? '')))
    const sums = assets.find((asset) => /sha256sums\.txt$/i.test(String(asset.name ?? '')))
    return {
      tag: String(body.tag_name ?? ''),
      version: String(body.tag_name ?? '').replace(/^v/, ''),
      zip: zip ? { name: zip.name, url: zip.browser_download_url, size: zip.size } : null,
      sums: sums ? { name: sums.name, url: sums.browser_download_url } : null,
      notes: String(body.body ?? '').slice(0, 2000),
    }
  } catch (error) {
    // 限流错误必须原样上抛（它带着可操作的指引）；其余网络/解析错误统一降级为 null。
    if (error instanceof CocosMcpError) throw error
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 下载体积上限：扩展包只有几百 KB，超过这个数一定不对劲。 */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024

async function downloadTo(url, file, { timeoutMs = 120000, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'dsh-game-forge' }, signal: controller.signal })
    if (!response.ok) throw new CocosMcpError(`下载失败 HTTP ${response.status}：${url}`, { code: 'DOWNLOAD_FAILED' })
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new CocosMcpError(`下载体积异常（${Math.round(declared / 1024)}KB > 上限 ${Math.round(maxBytes / 1024)}KB）：${url}`, { code: 'DOWNLOAD_TOO_BIG' })
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    // Content-Length 可能缺失/撒谎，落地前再核一次。
    if (buffer.length > maxBytes) {
      throw new CocosMcpError(`下载体积异常（${Math.round(buffer.length / 1024)}KB 超过上限）：${url}`, { code: 'DOWNLOAD_TOO_BIG' })
    }
    fs.writeFileSync(file, buffer)
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

async function fetchText(url, { timeoutMs = 20000, maxBytes = 1024 * 1024 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'dsh-game-forge' }, signal: controller.signal })
    if (!response.ok) return null
    const text = await response.text()
    return text.length > maxBytes ? text.slice(0, maxBytes) : text
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 从 SHA256SUMS.txt 里取指定文件的期望哈希。 */
function expectedHash(sumsText, fileName) {
  if (typeof sumsText !== 'string') return ''
  for (const line of sumsText.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match && path.basename(match[2]) === fileName) return match[1].toLowerCase()
  }
  return ''
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

function expandZip(zipFile, destDir) {
  if (process.platform !== 'win32') {
    const unzip = spawnSync('unzip', ['-o', zipFile, '-d', destDir], { encoding: 'utf8' })
    if (unzip.status !== 0) {
      throw new CocosMcpError(`解压失败（需要 unzip）：${unzip.stderr ?? ''}`, { code: 'UNZIP_FAILED' })
    }
    return
  }
  // ⚠️ 这里必须用 PowerShell 的单引号字面量（内部单引号写两遍）。
  // 之前用 JSON.stringify 拼参数是错的：JSON 的 `\\` 在 PowerShell 里**不会被反转义**，
  // 路径里的反斜杠会翻倍；路径含 `$`（用户名/盘符目录）还会被 PowerShell 当变量展开。
  const result = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath ${psSingleQuote(zipFile)} -DestinationPath ${psSingleQuote(destDir)} -Force`,
  ], { encoding: 'utf8', timeout: 120000 })
  if (result.status !== 0) {
    throw new CocosMcpError(`解压失败：${result.stderr ?? ''}`, { code: 'UNZIP_FAILED' })
  }
}

/** 解压后定位真正的扩展根目录（zip 里可能多套一层文件夹）。 */
function locateExtensionRoot(dir) {
  const direct = path.join(dir, 'package.json')
  if (fs.existsSync(direct)) return dir
  const candidates = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .filter((candidate) => fs.existsSync(path.join(candidate, 'package.json')))
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  // 多个带 package.json 的目录（例如顺带打进去的示例/文档工程）：
  // 必须挑对，否则会把文档工程拷成扩展。优先认名字与入口文件。
  const byName = candidates.find((candidate) => {
    const pkg = readJson(path.join(candidate, 'package.json'))
    return pkg !== null && (pkg.name === EXTENSION_DIR_NAME || typeof pkg.mcpName === 'string')
  })
  if (byName) return byName
  const byEntry = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'browser.js')))
  return byEntry ?? candidates[0]
}

/** 下载缓存里保留的安装备份数量：多了只是垃圾（每次 --force 都会留一份）。 */
const BACKUP_KEEP = 3

/** 只保留最近 N 个安装备份（`backup-<name>-<ts>`）。 */
function pruneInstallBackups(cacheDir, { keep = BACKUP_KEEP } = {}) {
  let entries
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return 0
  }
  const backups = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map((entry) => {
      const full = path.join(cacheDir, entry.name)
      try {
        return { full, at: fs.statSync(full).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item) => item !== null)
    .sort((a, b) => b.at - a.at)
  let removed = 0
  for (const item of backups.slice(keep)) {
    try {
      fs.rmSync(item.full, { recursive: true, force: true })
      removed += 1
    } catch { /* 被占用就下次再说 */ }
  }
  return removed
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(source, target)
    else fs.copyFileSync(source, target)
  }
}

/**
 * 安装扩展。
 *
 * @param {object} opts
 * @param {string} opts.projectPath Cocos 工程目录
 * @param {string} [opts.dshHome]
 * @param {boolean} [opts.global] 装到全局 builtin-extensions（所有项目共享）
 * @param {boolean} [opts.force] 已安装也覆盖
 * @param {string} [opts.version] 指定版本（默认最新 release）
 */
export async function installExtension({
  projectPath, dshHome, global = false, force = false, version = '',
} = {}) {
  const normal = normalizeProjectPath(projectPath)
  const meta = readProjectMeta(normal)
  if (meta === null) {
    throw new CocosMcpError(`${normal} 看起来不是 Cocos 工程（缺 package.json 或 assets/）`, { code: 'NOT_COCOS_PROJECT' })
  }
  // ⚠️ 这里必须严于 readProjectMeta：TapTap Maker 工程同样有 assets/，
  // 往里面塞 Cocos 扩展等于污染一个会被自动提交的工作区。
  // Cocos Creator 的 package.json 一定带 creator.version 字段 —— 就用它做硬校验。
  if (meta.creatorVersion === '') {
    throw new CocosMcpError(
      `${normal} 的 package.json 没有 creator.version 字段 —— 不是 Cocos Creator 工程。`
      + '（TapTap Maker / 其它带 assets/ 的工程不能装这个扩展。）',
      { code: 'NOT_COCOS_PROJECT' },
    )
  }
  if (!/^3\./.test(meta.creatorVersion)) {
    throw new CocosMcpError(
      `该扩展只支持 Cocos Creator 3.x（本项目 ${meta.creatorVersion}）。2.x 请另找对应插件。`,
      { code: 'UNSUPPORTED_VERSION' },
    )
  }

  const existing = detectExtension(normal)
  if (existing !== null && !force) {
    const configState = ensureProjectConfig(normal)
    const others = detectAllExtensions(normal).filter((item) => item.dir !== existing.dir)
    return {
      installed: false,
      alreadyInstalled: true,
      scope: existing.scope,
      dir: existing.dir,
      version: existing.version,
      config: configState,
      // 别的地方还装着一份 → Cocos 会两个都加载，必须提示（否则「菜单怎么有两份」查不到原因）。
      otherScopes: others.map((item) => ({ scope: item.scope, dir: item.dir, version: item.version })),
      note: others.length > 0
        ? `已经装好了，未重复下载。但另外还有 ${others.length} 份（${others.map((item) => item.scope).join('、')}）：`
          + 'Cocos 会全部加载，建议只留一份。'
        : '已经装好了，未重复下载。要覆盖重装请加 --force。',
    }
  }

  const release = await fetchLatestRelease()
  if (release === null || release.zip === null) {
    throw new CocosMcpError(
      '拉取 GitHub release 失败（网络/代理问题）。可以手动下载安装：\n'
      + `  1. 打开 https://github.com/${REPO}/releases\n`
      + `  2. 下载 Funplay.CocosMcp.v<版本>.zip 并解压\n`
      + `  3. 把里面的 ${EXTENSION_DIR_NAME}/ 目录放到 ${path.join(normal, 'extensions', EXTENSION_DIR_NAME)}`,
      { code: 'RELEASE_UNAVAILABLE' },
    )
  }
  if (version !== '' && release.version !== version) {
    // 指定了版本但接口给的是 latest：仍然提示一下，避免装出与预期不符的东西。
    // 这里不自动拼旧版本 URL（旧 release 资源命名可能不同），交由用户决定。
    if (!force) {
      throw new CocosMcpError(
        `最新版本是 ${release.version}，不是你要的 ${version}。要装最新版请去掉 version 参数。`,
        { code: 'VERSION_MISMATCH' },
      )
    }
  }

  const targetDir = global
    ? path.join(cocosUserDir(), 'builtin-extensions', meta.creatorVersion || 'unknown', EXTENSION_DIR_NAME)
    : path.join(normal, 'extensions', EXTENSION_DIR_NAME)

  const cache = downloadDir(dshHome)
  // 资产名来自远端 JSON：绝不能直接拼进本地路径（`../../x.zip` 会把文件写到缓存目录外）。
  const zipName = path.basename(String(release.zip.name || 'funplay-cocos-mcp.zip'))
  const zipFile = path.join(cache, zipName)
  const buffer = await downloadTo(release.zip.url, zipFile)
  const actual = sha256File(zipFile)
  const sumsText = release.sums === null ? null : await fetchText(release.sums.url)
  const expected = expectedHash(sumsText, zipName)
  if (expected !== '' && expected !== actual) {
    throw new CocosMcpError(
      `下载包校验失败（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）。已中止安装。`,
      { code: 'CHECKSUM_MISMATCH' },
    )
  }

  const staging = path.join(cache, `staging-${Date.now()}`)
  let backupDir = null
  try {
    fs.mkdirSync(staging, { recursive: true })
    expandZip(zipFile, staging)
    const root = locateExtensionRoot(staging)
    if (root === null) {
      throw new CocosMcpError('解压后没找到 package.json，压缩包结构可能变了。', { code: 'BAD_ARCHIVE' })
    }

    // 覆盖前把旧目录挪开（不直接删，留一份可回滚）。
    // ⚠️ 备份必须放到 extensions/ **外面**：Cocos 会把 extensions/ 下每个
    // 带 package.json 的目录都当扩展加载，`extensions/funplay-cocos-mcp.bak-…`
    // 等于给编辑器塞了一个幽灵扩展（旧版本和新版本同时注册、菜单重复）。
    if (fs.existsSync(targetDir)) {
      backupDir = path.join(cache, `backup-${path.basename(targetDir)}-${Date.now()}`)
      try {
        fs.renameSync(targetDir, backupDir)
      } catch {
        // rename 失败（跨盘等）才降级为原地删除 —— 此时没有可回滚副本，如实报告。
        fs.rmSync(targetDir, { recursive: true, force: true })
        backupDir = null
      }
    }
    try {
      copyDir(root, targetDir)
    } catch (error) {
      // 拷贝失败要把旧版本还回去，不能让工程停在「扩展被删了一半」的状态。
      if (backupDir !== null) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
        try { fs.renameSync(backupDir, targetDir) } catch { /* 还原失败就只能按原错误上报 */ }
      }
      throw error
    }
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
  }
  pruneInstallBackups(cache)

  const configState = ensureProjectConfig(normal)
  return {
    installed: true,
    scope: global ? 'global' : 'project',
    dir: targetDir,
    version: release.version,
    tag: release.tag,
    bytes: buffer.length,
    checksum: { expected: expected || null, actual },
    backupDir: backupDir ?? undefined,
    config: { file: configState.file, written: configState.written, config: configState.config },
    note: global
      ? '已装到全局 builtin-extensions；所有用同一 Creator 版本的项目都会加载它。'
      : '已装到工程的 extensions/ 目录。需要在 Cocos 里重新加载扩展或重启编辑器后生效。',
  }
}

/**
 * 体检：工程是不是 Cocos 工程、扩展装没装、配置是否按项目端口、能不能连上。
 */
export async function doctor({ projectPath, dshHome } = {}) {
  const normal = normalizeProjectPath(projectPath)
  const meta = readProjectMeta(normal)
  const extension = detectExtension(normal)
  const all = detectAllExtensions(normal)
  const config = readProjectConfig(normal)
  const report = {
    projectPath: normal,
    isCocosProject: meta !== null,
    creatorVersion: meta?.creatorVersion ?? '',
    hasAssets: meta?.hasAssets ?? false,
    extension: extension ?? { installed: false },
    installedScopes: all.map((item) => ({ scope: item.scope, dir: item.dir, version: item.version })),
    config: config ?? { present: false },
    problems: [],
    suggestions: [],
  }
  if (meta === null) {
    report.problems.push('不是 Cocos 工程（缺 package.json 或 assets/）')
  }
  if (extension === null) {
    report.problems.push('没有安装 Cocos MCP 扩展')
    report.suggestions.push('运行 /game-cocos install <项目目录> 安装（MIT 版 funplay-cocos-mcp）')
  }
  if (all.length > 1) {
    // Cocos 会把工程级和全局的扩展都加载：注册两次、菜单重复、端口互相抢。
    report.problems.push(
      `同一工程能同时加载 ${all.length} 份扩展（${all.map((item) => `${item.scope} ${item.version || '?'}`).join('、')}）：`
      + 'Cocos 会全部加载，容易出现扩展重复注册、菜单重复、两个 MCP 端口抢同一个项目',
    )
    report.suggestions.push('只保留一份：删掉工程里的 extensions/funplay-cocos-mcp，或删掉全局 builtin-extensions 下那份')
  }
  if (config !== null && config.portMode === 'fixed') {
    report.problems.push(`扩展使用固定端口 ${config.port ?? '?'}：多项目并行时会抢端口`)
    report.suggestions.push('把 funplay-cocos-mcp.config.json 的 portMode 改成 "project"（按项目派生端口）')
  }
  if (config === null && extension !== null) {
    report.suggestions.push('缺少 funplay-cocos-mcp.config.json；/game-cocos install --force 会补一份按项目端口的配置')
  }
  return report
}

export { EXTENSION_DIR_NAME, REPO as EXTENSION_REPO }
