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
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) copySkillDir(src, dest)
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

/** Collect every skill under a source directory (supports nested category layouts). */
function importFromDirectory(sourceDir, cacheDir, record) {
  if (!fs.existsSync(sourceDir)) throw new Error(`source directory not found: ${sourceDir}`)
  // Prefer a nested skills/ folder when present (common repo layout).
  const skillsSub = path.join(sourceDir, 'skills')
  const root = fs.existsSync(skillsSub) && fs.statSync(skillsSub).isDirectory() ? skillsSub : sourceDir
  // 1) Directory-bundle skills at any depth (skills/<name>/ or skills/<cat>/<name>/).
  const skillDirs = []
  findSkillDirs(root, skillDirs)
  for (const dir of skillDirs) {
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
