/**
 * Shared path + config helpers for dsh-taptap-maker-dev.
 *
 * Everything the plugin persists lives UNDER $DSH_HOME (outside any TapTap
 * Maker project workspace) on purpose: the Maker runtime auto-commits and
 * pushes the whole project workspace, so a plaintext image API key must never
 * sit inside the game repo. See README "安全" section.
 *
 * @module src/paths.js
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** Resolve $DSH_HOME, falling back to ~/.dsh. */
export function resolveDshHome(explicit) {
  const value = explicit || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.resolve(value)
}

/** The plugin's private data directory, created on demand. */
export function dataDir(dshHome) {
  const dir = path.join(resolveDshHome(dshHome), 'taptap-maker-dev')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Path to the OpenAI-compatible image generation config file. */
export function imageConfigPath(dshHome) {
  return path.join(dataDir(dshHome), 'image.json')
}

/** Read the raw image.json (what the settings form edits), or {}. */
export function readImageConfigRaw(dshHome) {
  return readJson(imageConfigPath(dshHome)) ?? {}
}

/** Merge a {baseURL,apiKey,model,size,credentialsFile} patch into image.json. */
export function writeImageConfigPatch(dshHome, patch = {}) {
  const file = imageConfigPath(dshHome)
  const merged = { ...(readJson(file) ?? {}) }
  for (const key of ['baseURL', 'apiKey', 'model', 'size', 'credentialsFile']) {
    if (typeof patch[key] === 'string') merged[key] = patch[key]
  }
  if (typeof merged._comment !== 'string') {
    merged._comment = '自定义生图（OpenAI 兼容 /images/generations）。此文件在 $DSH_HOME 下，不在任何 Maker 工作区内。'
  }
  writeJson(file, merged)
  return merged
}

/** Default skills cache directory (where the updater writes fetched skills). */
export function defaultCacheDir(dshHome) {
  return path.join(dataDir(dshHome), 'skills-cache')
}

/** Path to the user's disabled-skills list ({ disabled: [name, ...] }). */
export function skillsDisabledPath(dshHome) {
  return path.join(dataDir(dshHome), 'skills-disabled.json')
}

/** Read the disabled-skill name list, tolerant of a missing/invalid file. */
export function readDisabledSkills(dshHome) {
  const data = readJson(skillsDisabledPath(dshHome))
  const list = Array.isArray(data?.disabled) ? data.disabled : []
  return list.filter((n) => typeof n === 'string' && n.length > 0)
}

/** Persist the disabled-skill name list (deduped, sorted). */
export function writeDisabledSkills(dshHome, names) {
  const unique = Array.from(new Set(names.filter((n) => typeof n === 'string' && n.length > 0))).sort()
  writeJson(skillsDisabledPath(dshHome), { disabled: unique })
  return unique
}

/** Path to the live policy toggle file ({ blockCreditTools: boolean }). */
export function policyConfigPath(dshHome) {
  return path.join(dataDir(dshHome), 'policy.json')
}

/**
 * Resolve whether the credit-tool red-line is engaged. The live file wins; when
 * absent, fall back to the supplied default (plugin config; default true).
 */
export function readPolicyBlock(dshHome, fallback = true) {
  const data = readJson(policyConfigPath(dshHome))
  if (typeof data?.blockCreditTools === 'boolean') return data.blockCreditTools
  return fallback !== false
}

/** Persist the policy toggle; returns the stored boolean. */
export function writePolicyBlock(dshHome, enabled) {
  const value = enabled !== false
  writeJson(policyConfigPath(dshHome), { blockCreditTools: value })
  return value
}

/** Read a JSON file, returning undefined when absent or invalid. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write a JSON file (pretty), creating parent dirs. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * BGM prompt presets: when the user asks for background music, we generate a
 * ready-to-paste prompt for the MiniMax Audio web page (the API rejects new
 * users with HTTP 410, so the web page is the practical path).
 */
export function bgmPromptFor(desc) {
  const d = String(desc ?? '').trim()
  if (d.length === 0) return ''
  return [
    d,
    '纯音乐，无人声',
    '结构完整，可循环',
    '44.1kHz 高音质',
  ].join('，')
}

/**
 * Resolve effective image config with precedence:
 *   explicit credentialsFile JSON  >  env vars  >  image.json  >  inline fields.
 * Returns { baseURL, apiKey, model, size, n } with best-effort fields.
 */
export function resolveImageConfig(options = {}) {
  const dshHome = options.dshHome
  const fromFile = readJson(imageConfigPath(dshHome)) ?? {}
  const credFile = options.credentialsFile || fromFile.credentialsFile
  const fromCred = credFile ? readJson(path.resolve(credFile)) ?? {} : {}
  const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.length > 0)
  const num = (...vals) => vals.find((v) => typeof v === 'number' && Number.isFinite(v))
  return {
    baseURL: pick(
      fromCred.base_url, fromCred.baseURL,
      process.env.TAPTAP_IMAGE_BASE_URL,
      fromFile.baseURL, options.baseURL,
    ) ?? '',
    apiKey: pick(
      fromCred.api_key, fromCred.apiKey,
      process.env.TAPTAP_IMAGE_API_KEY,
      fromFile.apiKey, options.apiKey,
    ) ?? '',
    model: pick(
      fromCred.model,
      process.env.TAPTAP_IMAGE_MODEL,
      fromFile.model, options.model,
    ) ?? '',
    size: pick(process.env.TAPTAP_IMAGE_SIZE, fromFile.size, options.size) ?? '1024x1024',
    n: num(options.n, fromFile.n) ?? 1,
  }
}

/** Mask a secret for safe logging: keep head/tail only. */
export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return '(unset)'
  if (value.length <= 10) return `${value.slice(0, 2)}…`
  return `${value.slice(0, 5)}…${value.slice(-4)}`
}
