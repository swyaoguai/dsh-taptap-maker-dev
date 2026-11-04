/**
 * Cocos 集成里的小工具函数。
 *
 * @module src/cocos/util.mjs
 */

/** 等待若干毫秒。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

/** 对超长文本做安全截断（带省略标记）。 */
export function clipText(text, limit = 20000) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…(已截断，共 ${value.length} 字符)`
}

/** 把未知错误变成可读的一行描述。 */
export function errorText(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message ?? error)
}
