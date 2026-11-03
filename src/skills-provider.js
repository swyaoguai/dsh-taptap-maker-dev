/**
 * Skill provider for dsh-game-forge.
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
 * Lower rank = higher priority (verified against `@deepseek-ai/dsh-skill`'s
 * `compareIndexedCandidates`, which sorts ascending). 350/360 sit between the
 * filesystem provider's custom (300) and user (400) roots, so these skills are
 * prioritised over the generic user library but never clobber a project's own
 * `.dsh/skills`.
 *
 * ⚠️ 但「缓存优先」有一个必须堵住的例外：缓存里的同名 skill 会**静默覆盖内置
 * skill**，而内置的 `taptap-maker-core` 之类承载的是额度红线与安全规则。因此
 * 内置根里标了 `pinned: true` 的 skill 永远只从内置根读取（见 `pinnedNames()`），
 * 其余同名覆盖会打一条警告，让「我的守则怎么突然变了」有据可查。
 *
 * @module src/skills-provider.js
 */
import fs from 'node:fs'
import path from 'node:path'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** frontmatter 在前 32KB 内必然结束；超过说明这文件不是正常 skill。 */
const FRONTMATTER_MAX_BYTES = 32768

/**
 * Parse a minimal single-line-scalar YAML frontmatter block.
 *
 * 只支持单行标量（够用且不引入 YAML 依赖），但**要支持行尾注释**：
 * `pinned: true  # 治理类…` 在 YAML 里是 true，之前被当成整个字符串 "true  # …"，
 * toBool 认不出来 → pinned 静默失效（治理类 skill 照样会被外部源覆盖）。
 */
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
    } else {
      // YAML：` #` 之后是注释（引号内的不算，上面已单独处理）。
      const hash = value.search(/\s#/)
      if (hash >= 0) value = value.slice(0, hash).trim()
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

/**
 * Locate a skill's markdown file within a skill directory, or a flat file.
 *
 * ⚠️ 不再把 `README.md` 当作 skill 文件：目录里随手放个 README 就会被当成
 * 「一个 skill」，名字还是目录名。只认 SKILL.md / skill.md / <name>.md。
 */
function skillFileFor(root, entryName) {
  const dir = path.join(root, entryName)
  try {
    if (fs.statSync(dir).isDirectory()) {
      for (const candidate of ['SKILL.md', 'skill.md', `${entryName}.md`]) {
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

/** Read only the head of a file (frontmatter lives at the very top). */
function readPrefix(file, maxBytes = FRONTMATTER_MAX_BYTES) {
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
 * @param options.pinnedRoot - 承载「受保护 skill」的根（内置根）。该根里
 *   frontmatter 标了 `pinned: true` 的 skill 不允许被其它根同名覆盖。
 * @param options.logger - 可选，用于报告「缓存覆盖了内置 skill」这类静默行为。
 */
export class TaptapSkillProvider {
  constructor(providerName, roots, options = {}) {
    this.name = providerName
    this.roots = roots
    this.ttlMs = options.ttlMs ?? 60000
    this.disabledFile = options.disabledFile ?? null
    this.pinnedRoot = options.pinnedRoot ?? null
    this.logger = options.logger ?? null
    this._cache = null
    this._cacheAt = 0
    this._pinned = null
    this._shadowed = new Set()
  }

  /** Drop the memoized list so the next list() re-scans (call after an update). */
  reset() {
    this._cache = null
    this._cacheAt = 0
    this._pinned = null
    this._shadowed.clear()
  }

  /** 内置根里声明 `pinned: true` 的 skill 目录名集合（缓存一次）。 */
  pinnedNames() {
    if (this._pinned !== null) return this._pinned
    const set = new Set()
    if (this.pinnedRoot) {
      for (const entryName of enumerateNames(this.pinnedRoot)) {
        if (!SKILL_NAME.test(entryName)) continue
        const located = skillFileFor(this.pinnedRoot, entryName)
        if (located === undefined) continue
        try {
          if (toBool(parseFrontmatter(readPrefix(located.file)).data.pinned, false)) set.add(entryName)
        } catch { /* 读不了就当没标 */ }
      }
    }
    this._pinned = set
    return set
  }

  /** 同名覆盖了内置 skill（且不是 pinned）时说一声 —— 静默改规则最难查。 */
  noteShadow(entryName, rootDir) {
    if (this._shadowed.has(entryName)) return
    this._shadowed.add(entryName)
    this.logger?.warn?.(
      `game-forge skills: 「${entryName}」来自 ${rootDir}，会覆盖内置同名 skill（内置版本在 skills/ 下可查）`,
    )
  }

  /** @returns candidate summaries for every discoverable skill across roots. */
  async list() {
    const now = Date.now()
    // 返回副本：宿主/调用方就地排序或改写都不会污染这里的缓存。
    if (this._cache !== null && now - this._cacheAt < this.ttlMs) return this._cache.slice()
    const disabled = readDisabledSet(this.disabledFile)
    const pinned = this.pinnedNames()
    const out = []
    const seen = new Set()
    for (const root of this.roots) {
      const isPinnedRoot = this.pinnedRoot !== null && path.resolve(root.dir) === path.resolve(this.pinnedRoot)
      for (const entryName of enumerateNames(root.dir)) {
        if (seen.has(entryName) || !SKILL_NAME.test(entryName)) continue
        // pinned 只能由内置根提供：跳过其它根里的同名项，留给内置根那一轮。
        if (!isPinnedRoot && pinned.has(entryName)) continue
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
        if (!isPinnedRoot && this.pinnedRoot !== null && !pinned.has(entryName)
            && skillFileFor(this.pinnedRoot, entryName) !== undefined) {
          this.noteShadow(entryName, root.dir)
        }
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
    return out.slice()
  }

  /**
   * Enumerate every discoverable skill name across roots, regardless of the
   * disabled list, each tagged with { name, description, disabled, rank }.
   * Used by the management command so the user can see what to enable again.
   */
  listAll() {
    const disabled = readDisabledSet(this.disabledFile)
    const pinned = this.pinnedNames()
    const out = []
    const seen = new Set()
    for (const root of this.roots) {
      const isPinnedRoot = this.pinnedRoot !== null && path.resolve(root.dir) === path.resolve(this.pinnedRoot)
      for (const entryName of enumerateNames(root.dir)) {
        if (seen.has(entryName) || !SKILL_NAME.test(entryName)) continue
        if (!isPinnedRoot && pinned.has(entryName)) continue
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
        out.push({
          name,
          description,
          rank: root.rank,
          pinned: pinned.has(entryName),
          disabled: disabled.has(name) || disabled.has(entryName),
        })
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
