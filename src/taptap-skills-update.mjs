#!/usr/bin/env node
/**
 * taptap-skills-update — refresh the bundled-skill cache from configured
 * sources, and detect which skills are new or changed since last cycle.
 *
 * Source spec forms (array of strings in config.skills.sources):
 *   - "dir:<abs path>"      local directory of skills (copied in)
 *   - "<abs path>"          same as dir:
 *   - "git:<repo url>"      shallow clone; copies its skills/ dir (or root *.md)
 *   - "<url>.git"           same as git:
 *   - "https://.../x.md"    one flat markdown skill
 *   - "https://.../SKILL.md under /<name>/"  one directory-bundle skill
 *
 * It writes into cacheDir and maintains `<cacheDir>/.update-manifest.json`
 * (lastChecked + per-skill sha256) so each cycle reports added / updated.
 * Every source is best-effort: one failing source never aborts the others.
 *
 * Network/git are optional. In an offline environment this is a safe no-op
 * that only records the attempt.
 *
 * @module src/taptap-skills-update.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { defaultCacheDir, readJson, writeJson } from './paths.js'

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

function copySkillDir(srcDir, destDir) {
  copySkillDirSelective(srcDir, destDir, () => true)
}

/** copySkillDir 的可筛版本：keep(relPath, absPath) 为 false 的条目跳过。 */
function copySkillDirSelective(srcDir, destDir, keep) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    // .git 整目录跳过：临时 clone 里带着完整 .git，拷进 skills-cache 既浪费
    // 磁盘又可能泄露用户机器路径。
    if (entry.name === '.git') continue
    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (!keep(entry.name, src)) continue
    if (entry.isDirectory()) copySkillDirSelective(src, dest, keep)
    else if (entry.isFile()) fs.copyFileSync(src, dest)
  }
}

/** Recursively find every directory that directly contains a SKILL.md. */
function findSkillDirs(root, acc, depth = 0) {
  if (depth > 6) return
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  const hasSkillMd = entries.some((e) => e.isFile() && /^skill\.md$/i.test(e.name))
  if (hasSkillMd) { acc.push(root); return } // leaf skill dir; don't descend further
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'references' && entry.name !== 'assets') {
      findSkillDirs(path.join(root, entry.name), acc, depth + 1)
    }
  }
}

/**
 * findSkillDirs 的「必下钻」版：根自身有 SKILL.md 时**仍然**继续找子技能目录
 * （仓库根技能 + 子目录技能可以共存，如 spine-rig 布局）。只在子目录也是
 * 技能目录时停住，不再把「根是技能」当成整棵树的终点。
 */
function findAllSkillDirs(root, acc, depth = 0) {
  if (depth > 6) return
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'references' || entry.name === 'assets' || entry.name === '.git') continue
    const sub = path.join(root, entry.name)
    let subEntries
    try { subEntries = fs.readdirSync(sub, { withFileTypes: true }) } catch { continue }
    const subHasSkill = subEntries.some((e) => e.isFile() && /^skill\.md$/i.test(e.name))
    if (subHasSkill) {
      acc.push(sub)
      continue // 子技能目录自身不再下钻
    }
    findAllSkillDirs(sub, acc, depth + 1)
  }
}

/** Collect every skill under a source directory (supports nested category layouts). */
function importFromDirectory(sourceDir, cacheDir, record) {
  if (!fs.existsSync(sourceDir)) throw new Error(`source directory not found: ${sourceDir}`)
  // Prefer a nested skills/ folder when present (common repo layout).
  const skillsSub = path.join(sourceDir, 'skills')
  const root = fs.existsSync(skillsSub) && fs.statSync(skillsSub).isDirectory() ? skillsSub : sourceDir
  // 1) Directory-bundle skills at any depth (skills/<name>/ or skills/<cat>/<name>/).
  //    用「必下钻」版：根自身有 SKILL.md 时仍要找子技能（两者共存，见下）。
  const skillDirs = []
  findSkillDirs(root, skillDirs)
  const rootHasSkillMd = ['SKILL.md', 'skill.md'].some((f) => fs.existsSync(path.join(sourceDir, f)))
  if (rootHasSkillMd && root === sourceDir) {
    // findSkillDirs 会把「根有 SKILL.md」当叶子提前停；共存场景改用必下钻版。
    const subDirs = []
    findAllSkillDirs(sourceDir, subDirs)
    for (const d of subDirs) {
      if (!skillDirs.some((x) => path.resolve(x) === path.resolve(d))) skillDirs.push(d)
    }
  }
  // Repo-root SKILL.md（如 spine-animation-ai 这种单技能仓库）：目录名是临时
  // clone 路径（Windows 上是 dsh-skills-xxxx 之类的随机名）—— 直接用会把
  // 「技能名」变成随机串，每次更新都判定为「新增 + 旧项消失」。改用仓库目录
  // 名（clone 时就是 repo 名）做稳定 id。
  const rootSkillMd = ['SKILL.md', 'skill.md'].map((f) => path.join(sourceDir, f)).find((p) => fs.existsSync(p))
  let rootSkillRecorded = false
  if (rootSkillMd !== undefined && path.dirname(rootSkillMd) === sourceDir && root === sourceDir) {
    // 根技能**总是**收录（即使仓库里同时还有别的技能目录——两者可以共存）。
    const repoName = path.basename(sourceDir.replace(/[\\/]+$/, ''))
      .replace(/\.git$/, '') || 'skill'
    // 拷贝时排除子技能目录（它们会按自己的名字单独收录，重复拷进根技能
    // 目录只会浪费磁盘 + 造成「改一个动两处」的错觉）。
    const subSkillDirs = new Set(skillDirs.map((d) => path.resolve(d)))
    copySkillDirSelective(sourceDir, path.join(cacheDir, repoName), (_rel, abs) => !subSkillDirs.has(path.resolve(abs)))
    record(repoName, fs.readFileSync(rootSkillMd))
    rootSkillRecorded = true
  }
  // 1b) 子目录技能（skills/<name>/、<cat>/<name>/ 或与根技能共存的 <name>/）。
  //     按各自目录名单独收录；根自身若也在列表里（findSkillDirs 的叶子语义）
  //     已经按仓库名收过了，跳过。
  for (const dir of skillDirs) {
    if (root === sourceDir && path.resolve(dir) === path.resolve(sourceDir)) continue
    const name = path.basename(dir)
    if (name.startsWith('.')) continue
    const skillMd = ['SKILL.md', 'skill.md'].map((f) => path.join(dir, f)).find((p) => fs.existsSync(p))
    if (skillMd === undefined) continue
    copySkillDir(dir, path.join(cacheDir, name))
    record(name, fs.readFileSync(skillMd))
  }
  // 2) Flat *.md skills directly under the chosen root.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
      // 根级 SKILL.md 已经按「稳定仓库名」收录过：再当扁平技能收一遍会出现
      // 同一内容两个名字（repo + SKILL），每次更新都误报变更。
      if (rootSkillRecorded && path.resolve(path.join(root, entry.name)) === path.resolve(rootSkillMd)) continue
      const data = fs.readFileSync(path.join(root, entry.name))
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(path.join(cacheDir, entry.name), data)
      record(entry.name.slice(0, -3), data)
    }
  }
}

function importFromGit(repoUrl, cacheDir, record) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taptap-skills-'))
  try {
    const result = spawnSync('git', ['clone', '--depth', '1', repoUrl, tmp], {
      stdio: 'ignore',
      timeout: 120000,
    })
    if (result.status !== 0) throw new Error(`git clone failed (status ${result.status})`)
    importFromDirectory(tmp, cacheDir, record)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function importFromUrl(url, cacheDir, record) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  // Derive a skill name from the URL path.
  const parts = url.split('?')[0].split('/').filter(Boolean)
  const last = parts[parts.length - 1] || 'skill.md'
  let name
  let destFile
  if (/^skill\.md$/i.test(last)) {
    name = parts[parts.length - 2] || 'skill'
    destFile = path.join(cacheDir, name, 'SKILL.md')
  } else {
    name = last.replace(/\.md$/i, '')
    destFile = path.join(cacheDir, `${name}.md`)
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  fs.writeFileSync(destFile, data)
  record(name, data)
}

/**
 * Run one update cycle. Returns a summary; never throws for a single bad
 * source (those land in `errors`).
 */
export async function runUpdate(options = {}) {
  const cacheDir = options.cacheDir || defaultCacheDir(options.dshHome)
  fs.mkdirSync(cacheDir, { recursive: true })
  const manifestPath = path.join(cacheDir, '.update-manifest.json')
  const manifest = readJson(manifestPath) ?? { lastChecked: null, skills: {} }
  // Freshness gate: skip the whole cycle (no clone/fetch) when the last check is
  // still within minIntervalMs. Keeps every DSH startup from re-cloning repos.
  const minIntervalMs = Number(options.minIntervalMs ?? 0)
  if (minIntervalMs > 0 && manifest.lastChecked) {
    const age = Date.now() - Date.parse(manifest.lastChecked)
    if (Number.isFinite(age) && age >= 0 && age < minIntervalMs) {
      return {
        cacheDir,
        lastChecked: manifest.lastChecked,
        skipped: true,
        sourceCount: Array.isArray(options.sources) ? options.sources.length : 0,
        added: [],
        updated: [],
        errors: [],
        skillCount: Object.keys(manifest.skills ?? {}).length,
      }
    }
  }
  const previous = manifest.skills ?? {}
  const current = {}
  const added = []
  const updated = []
  const errors = []
  const record = (name, buffer) => {
    const hash = sha256(buffer)
    current[name] = { hash, updatedAt: new Date().toISOString() }
    if (previous[name] === undefined) added.push(name)
    else if (previous[name].hash !== hash) updated.push(name)
  }
  const sources = Array.isArray(options.sources) ? options.sources : []
  for (const raw of sources) {
    const spec = String(raw).trim()
    if (spec.length === 0) continue
    try {
      if (spec.startsWith('dir:')) importFromDirectory(path.resolve(spec.slice(4)), cacheDir, record)
      else if (spec.startsWith('git:')) importFromGit(spec.slice(4), cacheDir, record)
      else if (spec.endsWith('.git')) importFromGit(spec, cacheDir, record)
      else if (/^https?:\/\//i.test(spec)) await importFromUrl(spec, cacheDir, record)
      else importFromDirectory(path.resolve(spec), cacheDir, record)
    } catch (error) {
      errors.push({ source: spec, error: error?.message ?? String(error) })
    }
  }
  // Preserve prior hashes for skills whose source was not re-checked this run.
  for (const [name, info] of Object.entries(previous)) {
    if (current[name] === undefined) current[name] = info
  }
  const summary = {
    cacheDir,
    lastChecked: new Date().toISOString(),
    sourceCount: sources.length,
    added,
    updated,
    errors,
    skillCount: Object.keys(current).length,
  }
  writeJson(manifestPath, { lastChecked: summary.lastChecked, skills: current })
  return summary
}

async function main() {
  const args = process.argv.slice(2)
  const sources = []
  let cacheDir
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--source') { sources.push(args[i + 1]); i += 1 }
    else if (args[i] === '--cache-dir') { cacheDir = args[i + 1]; i += 1 }
  }
  const summary = await runUpdate({ sources, cacheDir })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
