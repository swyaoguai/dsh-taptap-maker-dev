#!/usr/bin/env node
/**
 * Sanitize the plugin before publishing it publicly.
 *
 * Strips anything that must not leave this machine:
 *   - the local Windows username / user profile paths
 *   - the local plugin dev directory (<plugin-dir>)
 *   - the local Maker project path (<maker-project>)
 *   - API keys / tokens / secrets that may have been pasted into files
 *
 * Run it, then re-run the scanner to confirm a clean tree.
 *
 * Usage: node scripts/sanitize-for-release.mjs
 *
 * @module scripts/sanitize-for-release.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USER = os.userInfo().username

const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmpaudio', '.tmpconv', 'skills-cache', '.tmptest'])

/** Files we never touch (binary, or intentionally local-only). */
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml'])

const REPLACEMENTS = [
  // Windows profile paths → generic placeholder
  [new RegExp(`C:\\\\Users\\\\${USER}`, 'g'), 'C:\\Users\\<you>'],
  [new RegExp(`C:/Users/${USER}`, 'g'), 'C:/Users/<you>'],
  [new RegExp(`C:\\\\Users\\\\${USER}(?=[\\\\/])`, 'gi'), 'C:\\Users\\<you>'],
  // Local dev dir for THIS plugin
  [/D:\\dsh-taptap-maker-dev/g, '<plugin-dir>'],
  [/D:\/dsh-taptap-maker-dev/g, '<plugin-dir>'],
  // Local Maker workspace
  [/D:\\tapyx/g, '<maker-project>'],
  [/D:\/tapyx/g, '<maker-project>'],
  // Secrets
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '<GITHUB_TOKEN>'],
  [/sk-[A-Za-z0-9_\-]{16,}/g, '<API_KEY>'],
  [/eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.?[A-Za-z0-9_\-]*/g, '<API_KEY>'],
  [/(apiKey|api_key|token|secret)["'\s:=]+[A-Za-z0-9_\-]{24,}/gi, '$1: "<REDACTED>"'],
]

const REPORTS = []

const SELF = path.resolve(fileURLToPath(import.meta.url))

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name))
      continue
    }
    if (!SCAN_EXT.has(path.extname(entry.name).toLowerCase())) continue
    if (SKIP_FILES.has(entry.name)) continue
    const file = path.join(dir, entry.name)
    // Never rewrite this script: its own patterns are the literal strings we
    // look for, so replacing them here would break the sanitizer.
    if (path.resolve(file) === SELF) continue
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    let next = text
    const hits = []
    for (const [re, to] of REPLACEMENTS) {
      const m = next.match(re)
      if (m !== null && m.length > 0) {
        hits.push(`${re.source.slice(0, 28)} ×${m.length}`)
        next = next.replace(re, to)
      }
    }
    if (next !== text) {
      fs.writeFileSync(file, next, 'utf8')
      REPORTS.push(`${path.relative(PKG, file).replace(/\\/g, '/')}: ${hits.join(', ')}`)
    }
  }
}

console.log(`sanitizing ${PKG} (user=${USER})`)
walk(PKG)

if (REPORTS.length === 0) console.log('no changes needed — tree already clean')
else {
  console.log(`\nmodified ${REPORTS.length} file(s):`)
  for (const r of REPORTS) console.log(`  ${r}`)
}
console.log('\ndone. re-run the scanner to verify.')
