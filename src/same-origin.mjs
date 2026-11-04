/**
 * 本地 web 服务的同源判断（设置页的写操作靠它挡 CSRF）。
 *
 * 规则与理由：
 *  - 不带 `Origin`：非浏览器调用（curl、脚本、插件内部 fetch 有时也不带），放行。
 *  - `Origin: null`：sandbox iframe / opaque origin，**不可信**，拒绝。
 *  - 其余情况：必须**同时**满足
 *      1) `Host` 是回环地址（127.0.0.1 / localhost / [::1]）；
 *      2) `Origin` 的 host:port 与 `Host` 完全一致。
 *
 * 为什么要第 1 条：只比「Origin == Host」会被 DNS rebinding 绕过 ——
 * attacker.com 解析到 127.0.0.1 时，浏览器发出的正是
 * `Host: attacker.com` + `Origin: http://attacker.com`，两者相等但不该放行。
 * 要求 Host 是回环地址，才真正表示「请求打的是本机服务」。
 *
 * @module src/same-origin.mjs
 */

/** 把 `host[:port]` 拆成小写主机名。 */
function hostnameOf(host) {
  return String(host).replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0'
}

/**
 * @param {{origin?: string, host?: string}} headers 取自请求头
 * @returns {boolean} 是否允许这次写操作
 */
export function isSameOriginRequest({ origin, host } = {}) {
  if (typeof origin !== 'string' || origin === '') return true
  if (origin === 'null' || origin === 'NULL') return false
  const hostHeader = typeof host === 'string' ? host.trim() : ''
  if (hostHeader === '') return false
  if (!isLoopbackHostname(hostnameOf(hostHeader))) return false
  try {
    return new URL(origin).host === hostHeader
  } catch {
    return false
  }
}
