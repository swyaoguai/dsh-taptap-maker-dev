/**
 * Skill provider for dsh-taptap-maker-dev.
 *
 * Implements the `ctx.skills` provider contract (list → candidates, get →
 * full definition). It scans one or more roots for skills in the standard
 * directory-bundle format (`<root>/<name>/SKILL.md`) or flat `<root>/<name>.md`,
 * parses a small YAML-ish frontmatter, and returns bodies on demand.
 *
 * Two root kinds, each with its own precedence rank:
 *   - bundled roots  (shipped with the plugin, ./skills)       → rank 360
 *   - cache roots    (fetched by the updater, newer, win ties) → rank 350
 *
 * Lower rank = higher priority. 350/360 sit between the filesystem provider's
 * custom (300) and user (400) roots, so these skills are prioritised over the
 * generic user library but never clobber a project's own `.dsh/skills`.
 *
 * @module src/skills-provider.js
 */
import fs from 'node:fs'
import path from 'node:path'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Parse a minimal single-line-scalar YAML frontmatter block. */
export function parseFrontmatter(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return { data: {}, body: text.replace(/^\uFEFF/, '') }
  const data = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep < 0) continue
    const key = line.slice(0, sep).trim()
    let value = line.slice(sep + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }
  return { data, body: match[2] }
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': case '1': return true
      case 'false': case 'no': case 'off': case '0': return false
    }
  }
  return fallback
}

/** Locate a skill's markdown file within a skill directory, or a flat file. */
function skillFileFor(root, entryName) {
  const dir = path.join(root, entryName)
  try {
    if (fs.statSync(dir).isDirectory()) {
      for (const candidate of ['SKILL.md', 'skill.md', `${entryName}.md`, 'README.md']) {
        const p = path.join(dir, candidate)
        if (fs.existsSync(p)) return { file: p, base: dir }
      }
      return undefined
    }
  } catch {
    // not a directory; fall through to flat-file handling
  }
  const flat = path.join(root, `${entryName}.md`)
  if (fs.existsSync(flat)) return { file: flat, base: root }
  return undefined
}

/** Read only the first bytes of a file (frontmatter lives at the very top). */
function readPrefix(file, maxBytes = 8192) {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(maxBytes)
    const n = fs.readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** Load the disabled-skill name set from a JSON file ({ disabled: [...] }). */
function readDisabledSet(file) {
  if (!file) return new Set()
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(data?.disabled) ? data.disabled : []
    return new Set(list.filter((n) => typeof n === 'string' && n.length > 0))
  } catch {
    return new Set()
  }
}

/** Enumerate candidate skill names directly under one root. */
function enumerateNames(root) {
  const names = new Set()
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      names.add(entry.name)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      names.add(entry.name.slice(0, -3))
    }
  }
  return names
}

/**
 * One skill provider over a fixed, ordered list of roots.
 * @param providerName - stable provider id reported on every candidate.
 * @param roots - [{ dir, rank }] searched in order; earlier wins same-name ties.
 */
export class TaptapSkillProvider {
  constructor(providerName, roots, options = {}) {
    this.name = providerName
    this.roots = roots
    this.ttlMs = options.ttlMs ?? 60000
    this.disabledFile = options.disabledFile ?? null
    this._cache = null
    this._cacheAt = 0
  }

  /** Drop the memoized list so the next list() re-scans (call after an update). */
  reset() {
    this._cache = null
    this._cacheAt = 0
  }

  /** @returns candidate summaries for every discoverable skill across roots. */
  async list() {
    const now = Date.now()
    if (this._cache !== null && now - this._cacheAt < this.ttlMs) return this._cache
    const disabled = readDisabledSet(this.disabledFile)
    const out = []
    const seen = new Set()
    for (const root of this.roots) {
      for (const entryName of enumerateNames(root.dir)) {
        if (seen.has(entryName) || !SKILL_NAME.test(entryName)) continue
        if (disabled.has(entryName)) { seen.add(entryName); continue }
        const located = skillFileFor(root.dir, entryName)
        if (located === undefined) continue
        let parsed
        try {
          parsed = parseFrontmatter(readPrefix(located.file))
        } catch {
          continue
        }
        const name = (parsed.data.name || entryName).trim()
        if (!SKILL_NAME.test(name)) continue
        if (disabled.has(name)) { seen.add(entryName); continue }
        const description = (parsed.data.description || '').trim()
        if (description.length === 0) continue
        seen.add(entryName)
        const whenToUse = (parsed.data.whenToUse || parsed.data['when-to-use'] || '').trim()
        out.push({
          name,
          description,
          ...whenToUse.length > 0 ? { whenToUse } : {},
          invocation: {
            modelInvocable: !toBool(parsed.data['disable-model-invocation'], false),
            userInvocable: toBool(parsed.data['user-invocable'], true),
          },
          source: located.file,
          provider: this.name,
          rank: root.rank,
          path: located.base,
          locator: { file: located.file, base: located.base },
        })
      }
    }
    this._cache = out
    this._cacheAt = now
    return out
  }

  /**
   * Enumerate every discoverable skill name across roots, regardless of the
   * disabled list, each tagged with { name, description, disabled, rank }.
   * Used by the management command so the user can see what to enable again.
   */
  listAll() {
    const disabled = readDisabledSet(this.disabledFile)
    const out = []
    const seen = new Set()
    for (const root of this.roots) {
      for (const entryName of enumerateNames(root.dir)) {
        if (seen.has(entryName) || !SKILL_NAME.test(entryName)) continue
        const located = skillFileFor(root.dir, entryName)
        if (located === undefined) continue
        let parsed
        try {
          parsed = parseFrontmatter(readPrefix(located.file))
        } catch {
          continue
        }
        const name = (parsed.data.name || entryName).trim()
        if (!SKILL_NAME.test(name)) continue
        const description = (parsed.data.description || '').trim()
        if (description.length === 0) continue
        seen.add(entryName)
        out.push({ name, description, rank: root.rank, disabled: disabled.has(name) || disabled.has(entryName) })
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1))
    return out
  }

  /** Load one candidate's full definition, including the markdown body. */
  async get(candidate) {
    const locator = candidate.locator ?? { file: candidate.source, base: candidate.path }
    const parsed = parseFrontmatter(fs.readFileSync(locator.file, 'utf8'))
    const whenToUse = (parsed.data.whenToUse || parsed.data['when-to-use'] || '').trim()
    return {
      name: candidate.name,
      description: candidate.description,
      ...whenToUse.length > 0 ? { whenToUse } : {},
      invocation: candidate.invocation,
      source: locator.file,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.base },
      content: parsed.body.trim(),
    }
  }
}
