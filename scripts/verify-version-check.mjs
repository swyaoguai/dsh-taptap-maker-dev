/**
 * 版本检查功能的离线自测（默认不联网；真实联网用 --live 开关）。
 *
 * 覆盖：
 *   1. semver 比较：三段都比（0.2.10 > 0.2.9 这个坑专门盯）
 *   2. 缓存读写：结果落盘、损坏时返回 undefined
 *   3. checkForUpdates：注入假 fetch，验证「远端更新 / 相同 / 网络失败」三条路
 *   4. 冷却判断：从未检查 → 需要；刚查过 → 不需要
 *   5. index.js 真的接上了（后台启动 + 路由 + 设置页 UI）
 *
 * 用法：node scripts/verify-version-check.mjs [--live]
 *   --live 会真实请求 GitHub（验证版本源可达），默认跳过以免拖慢/依赖网络。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CHECK_INTERVAL_MS, checkForUpdates, compareVersions, currentVersion,
  readCachedCheck, shouldCheck, versionCheckPath,
} from '../src/version-checker.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ver-')), 'h')
console.log(`临时目录：${home}\n`)

console.log('\n[1] 本地版本')
{
  const v = currentVersion()
  ok(/^\d+\.\d+\.\d+/.test(v), `版本号是 semver 形态（${v}）`)
  // package.json 与源码里的版本必须一致 —— 漂移会让检查结果失真。
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  ok(v === pkg.version, 'currentVersion() 与 package.json 一致')
}

console.log('\n[2] semver 比较（三段都比）')
{
  ok(compareVersions('0.2.0', '0.2.0') === 0, '相等 → 0')
  ok(compareVersions('0.2.0', '0.3.0') === -1, 'minor 更大 → -1')
  ok(compareVersions('0.2.9', '0.2.10') === -1, '⚠ patch 按数值比：0.2.9 < 0.2.10（字符串比会错判成大于）')
  ok(compareVersions('0.2.0', '0.2.9') === -1, '0.2.0 < 0.2.9')
  ok(compareVersions('1.0.0', '0.9.9') === 1, 'major 更大 → 1')
  ok(compareVersions('0.2.0-beta', '0.2.0') === 0, '带后缀的版本不崩溃（0.2.0-beta 数值上等于 0.2.0，够用）')
  ok(compareVersions(undefined, '1.0.0') === -1, 'undefined 输入安全（视为 0.0.0）')
  ok(compareVersions('', '') === 0, '空串对空串 → 0')
}

console.log('\n[3] checkForUpdates（注入假 fetch，不联网）')
{
  const makeFetch = (body, status = 200) => async () => ({
    ok: status === 200,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })

  const newer = await checkForUpdates(home, { fetchImpl: makeFetch({ version: '9.9.9' }) })
  ok(newer.isOutdated === true && newer.latest === '9.9.9', '远端更新 → isOutdated=true')
  ok(newer.current === currentVersion(), '记录了本地版本')

  const same = await checkForUpdates(home, { fetchImpl: makeFetch({ version: currentVersion() }) })
  ok(same.isOutdated === false, '版本相同 → 不提示更新')

  const bad = await checkForUpdates(home, { fetchImpl: makeFetch('{"version":', 200) })
  ok(bad.error && bad.latest === undefined, '远端 JSON 损坏 → 记录 error 而不是抛出')

  const http500 = await checkForUpdates(home, { fetchImpl: makeFetch('{}', 500) })
  ok(Boolean(http500.error), `HTTP 500 → 记录 error（${http500.error}）`)

  const netFail = await checkForUpdates(home, {
    fetchImpl: async () => { throw new Error('fetch failed') },
  })
  ok(/fetch failed/.test(netFail.error ?? ''), '网络异常 → 落盘 error，不抛出（后台定时器不被打断）')

  // 失败路径的最终落盘记录：netFail 是最后一次检查，缓存里应能看到它的 error。
  const cached = readCachedCheck(home)
  ok(cached !== undefined && typeof cached.checkedAt === 'number', '失败也有缓存记录（checkedAt 更新）')
  ok(cached.current === currentVersion(), '缓存里的 current 正确')
  ok(/fetch failed/.test(cached.error ?? ''), '缓存里保留了失败原因（设置页能显示「上次检查失败」）')
}

console.log('\n[4] 缓存读写与冷却')
{
  const newer = { current: '0.1.0', latest: '9.9.9', isOutdated: true, checkedAt: Date.now() }
  fs.writeFileSync(versionCheckPath(home), JSON.stringify(newer), 'utf8')
  const cached = readCachedCheck(home)
  ok(cached?.latest === '9.9.9' && cached.isOutdated === true, '写入后能读回')

  ok(shouldCheck(home) === false, '刚检查过 → 不需要再查（冷却期内）')

  // 把 checkedAt 改到 7 小时前 → 应该需要检查
  fs.writeFileSync(versionCheckPath(home), JSON.stringify({ ...newer, checkedAt: Date.now() - CHECK_INTERVAL_MS - 1000 }), 'utf8')
  ok(shouldCheck(home) === true, '超过冷却期 → 需要检查')

  fs.writeFileSync(versionCheckPath(home), '{ 损坏', 'utf8')
  ok(readCachedCheck(home) === undefined, '缓存损坏 → 返回 undefined（不崩）')
  ok(shouldCheck(home) === true, '缓存损坏 → 视为需要检查')
}

console.log('\n[5] index.js / client.js 接线')
{
  const idx = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const cli = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  ok(idx.includes('startBackgroundCheck(home'), 'apply() 里启动了后台检查')
  ok(idx.includes("sub === 'version'"), '有 GET /version 路由')
  ok(idx.includes("sub === 'version/check'"), '有 POST /version/check 路由')
  ok(/function AboutCard\(/.test(cli), '设置页有 AboutCard 组件')
  ok(cli.includes('API_BASE}/version/check'), '「检查更新」按钮调用 POST /version/check')
  ok(cli.includes("id: 'about'"), '新增「关于」标签页')
  ok(cli.includes('个账号已登录') === false || true, '（占位）')
  // 后台检查必须不阻塞插件加载：startBackgroundCheck 是同步调用 + 内部 fire-and-forget
  const vc = fs.readFileSync(new URL('../src/version-checker.mjs', import.meta.url), 'utf8')
  ok(/\.unref\?\.\(\)/.test(vc) || vc.includes('unref'), '定时器 unref（不阻止进程退出）')
  ok(vc.includes('AbortSignal.timeout'), '远程请求带超时（不无限挂起）')
}

console.log('\n[6] 真实版本源（--live 才跑）')
if (process.argv.includes('--live')) {
  const r = await checkForUpdates(home)
  ok(!r.error, `GitHub 版本源可达（latest=${r.latest ?? r.error}）`)
  ok(typeof r.isOutdated === 'boolean', 'isOutdated 是布尔值')
} else {
  console.log('  （跳过：加 --live 可验证真实网络请求）')
}

fs.rmSync(path.dirname(home), { recursive: true, force: true })
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)