/**
 * 素材落点：三类素材统一收进项目里的 `sucai/`。
 *
 * 为什么要有这一层：图片、视频、BGM 过去各存各的（一个跟项目、一个在
 * `$DSH_HOME/video-jobs/`、一个在 `$DSH_HOME/bgm-downloads/`），用户要在三个
 * 地方找素材，而且真正想进游戏的文件又散落在作业目录的 `frames/`、`keyed/`
 * 这些中间产物里。现在统一成：
 *
 *   <项目>/sucai/images/     生图（含网页生图与中转站生图）
 *   <项目>/sucai/video/<作业>/ 视频作业整棵目录（refs / videos / frames / keyed / sheet）
 *   <项目>/sucai/bgm/       背景音乐
 *
 * ⚠️ 两个必须守住的不变量：
 *
 * 1. **自忽略**：Maker 运行时会把整个工程自动 commit+push。落在项目里的东西
 *    必须自带 `.gitignore`（`*\n!.gitignore`），否则一份 API Key 或几十兆视频
 *    会被自动推上去。我们只写自己的目录，**绝不碰用户的根 .gitignore**。
 *
 * 2. **不在项目里就退回 $DSH_HOME**：命令可能在任意 cwd 执行。不做这个判断的
 *    话，会在用户的 C 盘根目录凭空造一个 `sucai/` —— 那正是用户当初反对的做法。
 *
 * @module src/assets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths.js'

/** 素材子目录名（三类）。 */
export const ASSET_KINDS = {
  image: 'images',
  video: 'video',
  bgm: 'bgm',
}

/** 素材根目录名（在项目下）。 */
export const ASSET_ROOT = 'sucai'

/** 目录是否像一个 TapTap Maker 工程根（有 assets/）。 */
export function isMakerProject(dir) {
  try {
    return fs.existsSync(path.join(dir, 'assets'))
  } catch {
    return false
  }
}

/**
 * 建目录，并保证它不会被 Maker 自动提交。
 *
 * `@param {string} dir 目标目录
 * @param {boolean} insideProject 是否落在项目里（只有 true 才写 .gitignore）
 */
export function ensureAssetDir(dir, { insideProject }) {
  fs.mkdirSync(dir, { recursive: true })
  if (insideProject) {
    const gi = path.join(dir, '.gitignore')
    try {
      // 只在缺失时写：不要覆盖用户自己加的规则。
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n!.gitignore\n', 'utf8')
    } catch { /* best effort: 建目录成功就够了 */ }
  }
  return dir
}

/**
 * 把 {project} / {home} 占位符展开；相对路径按项目目录解析。
 *
 * 注意占位符后面跟的斜杠要规范化：用户写 `{home}/mymusic` 时，正斜杠会留在
 * Windows 路径中间。功能上多数情况还能用，但产出的路径字符串不干净 ——
 * 显示在界面 / 日志里会看着别扭，所以这里统一换成 path.join 拼。
 */
function expand(raw, cwd, home) {
  const text = String(raw).trim()
  const projectIdx = text.search(/\{project\}/i)
  const homeIdx = text.search(/\{home\}/i)
  if (projectIdx < 0 && homeIdx < 0) {
    return path.isAbsolute(text) ? text : path.resolve(cwd, text)
  }
  // 以占位符开头：把后面的分段按 path.join 拼，避免混进 `/`。
  const m = /^(\{project\}|\{home\})(.*)$/i.exec(text)
  if (m) {
    const root = /^project$/i.test(m[1].replace(/[{}]/g, '')) ? cwd : home
    const rest = m[2].split(/[\\/]+/).filter(Boolean)
    return rest.length ? path.join(root, ...rest) : root
  }
  // 占位符在中间（少见的写法）：替换后再按绝对/相对处理。
  const replaced = text.replace(/\{project\}/gi, cwd).replace(/\{home\}/gi, home)
  return path.isAbsolute(replaced) ? replaced : path.resolve(cwd, replaced)
}

/**
 * 解析某类素材的落点。
 *
 * 优先级（与图片那条链保持一致）：
 *   1. explicit —— 本次调用显式指定（`--dir`）；
 *   2. configured —— 设置页里配的目录（支持 {project} / {home}）；
 *   3. 在项目里 → `<项目>/sucai/<子目录>`；
 *   4. 不在项目里 → `$DSH_HOME/taptap-maker-dev/<兜底目录>`。
 *
 * @param {string} dshHome
 * @param {'image'|'video'|'bgm'} kind
 * @param {{explicit?: string, configured?: string, projectDir?: string, fallback?: string}} [opts]
 * @returns {{dir: string, source: 'flag'|'config'|'project'|'default', projectDir: string, insideProject: boolean}}
 */
export function resolveAssetDir(dshHome, kind, { explicit, configured, projectDir, fallback } = {}) {
  const cwd = path.resolve(projectDir ?? process.cwd())
  const home = dataDir(dshHome)
  const inProject = isMakerProject(cwd)
  const sub = ASSET_KINDS[kind]
  if (!sub) throw new Error(`未知的素材类型：${kind}`)

  const configuredRaw = (typeof explicit === 'string' && explicit.trim().length > 0)
    ? explicit
    : (typeof configured === 'string' ? configured : '')
  if (configuredRaw.trim().length > 0) {
    const dir = expand(configuredRaw, cwd, home)
    // 只有真的落在项目目录下才算「在项目里」：配一个 D:\ 盘外路径不该被 gitignore 逻辑误伤。
    const inside = inProject && path.resolve(dir).toLowerCase().startsWith(path.resolve(cwd).toLowerCase())
    return {
      dir: ensureAssetDir(dir, { insideProject: inside }),
      source: explicit ? 'flag' : 'config',
      projectDir: cwd,
      insideProject: inside,
    }
  }

  if (inProject) {
    const dir = path.join(cwd, ASSET_ROOT, sub)
    return { dir: ensureAssetDir(dir, { insideProject: true }), source: 'project', projectDir: cwd, insideProject: true }
  }
  const dir = path.join(home, fallback ?? `${sub}`)
  return { dir: ensureAssetDir(dir, { insideProject: false }), source: 'default', projectDir: cwd, insideProject: false }
}