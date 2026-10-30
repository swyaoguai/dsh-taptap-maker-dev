/**
 * User-selected default image model for the Zaiduyu lane.
 * Preferences are independent of credentials, so clearing one never logs out
 * an account. No catalogue/site defaults or alternative models are selected.
 */
import path from 'node:path'
import { dataDir, readJson, writeJson } from './paths.js'

export function zaiduyuPreferencesPath(dshHome) {
  return path.join(dataDir(dshHome), 'zaiduyu-preferences.json')
}

function validateModel(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    const error = new Error('模型 ID 必须是最多 200 字符的字符串，且不能含控制字符。')
    error.code = 'invalid_model'
    throw error
  }
  const model = value.trim()
  if (!allowEmpty && model.length === 0) {
    const error = new Error('显式指定的模型 ID 不能为空；请指定模型或省略该参数以使用已保存的默认模型。')
    error.code = 'invalid_model'
    throw error
  }
  return model
}

/** Read only this preference file; an invalid saved value is not a choice. */
export function readZaiduyuPreferences(dshHome) {
  const raw = readJson(zaiduyuPreferencesPath(dshHome))
  try {
    return { defaultModel: validateModel(raw?.defaultModel ?? '', { allowEmpty: true }) }
  } catch {
    return { defaultModel: '' }
  }
}

/** Empty string deliberately clears the preference, without deleting a file. */
export function writeZaiduyuPreferences(dshHome, patch) {
  const defaultModel = validateModel(patch?.defaultModel, { allowEmpty: true })
  const preferences = { defaultModel }
  writeJson(zaiduyuPreferencesPath(dshHome), preferences)
  return preferences
}

/** Explicit per-request choice wins, but never mutates the saved preference. */
export function resolveZaiduyuModel(dshHome, explicit) {
  if (explicit !== undefined) return validateModel(explicit)
  const { defaultModel } = readZaiduyuPreferences(dshHome)
  if (defaultModel) return defaultModel
  const error = new Error('尚未选择章鱼生图模型。请在设置页选择并保存默认模型，或为本次请求明确指定模型；不会自动选择其他模型。')
  error.code = 'model_required'
  throw error
}
