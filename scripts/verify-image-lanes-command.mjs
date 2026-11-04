/**
 * `/game-image lanes`（生图通道顺序的对话入口）离线自测。
 *
 * 为什么要单独测这条命令：
 *   1. 用户抱怨过「排顺序的地方找不到了」—— 这条命令是设置页之外的第二个入口，
 *      它的输出必须如实说明「现在会走哪条」，否则等于又多一个会骗人的地方；
 *   2. 改顺序 = 可能把下次生图从免费通道换到付费通道，**必须**被
 *      guardUserSetting 拦住（除非用户自己带了 --yes）；
 *   3. 通道 id 写错时要当场拒绝，不能静默丢弃（"静默改参数"在这套插件里最坑）。
 *
 * 做法：把 index.js 里 `name: 'game-image'` 的 handler 整段抠出来，在 vm 里用
 * 真 readLanes / writeLanes / guardUserSetting + 临时 DSH_HOME 跑，不联网、不生成。
 *
 * 用法：node scripts/verify-image-lanes-command.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { readLanes, writeLanes } from '../src/lanes.mjs'
import { guardUserSetting } from '../src/guards.mjs'

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const here = path.dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0
const check = async (name, body) => {
  try { await body(); passed += 1; console.log(`PASS ${name}`) }
  catch (e) { failed += 1; console.error(`FAIL ${name}: ${e.message}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-image-lanes-'))

/**
 * 用指定 home 造一个能跑 handler 的沙箱。
 * `overrides` 用来把某些「就绪判断」调成 false，验证「会被跳过」的显示。
 */
function command(home, overrides = {}) {
  const at = source.indexOf("name: 'game-image'")
  const start = source.lastIndexOf('scoped.commands.register({', at)
  const end = source.indexOf('// /game-image 作为首选后', at)
  assert.ok(start >= 0 && end > start, '能从 index.js 里抠出 game-image 命令')

  let handler
  const context = {
    path, home, PKG_DIR: here,
    scoped: { commands: { register(c) { handler = c.handler } } },
    // 真实现：读写的就是这个 home 下的 lanes.json
    readLanes, writeLanes, guardUserSetting,
    // 只读状态：默认「都配好了」，让输出稳定
    readImageConfigRaw: () => ({ baseURL: 'https://relay.example/v1', apiKey: 'x', model: 'm' }),
    readGptLaneEnabled: () => true,
    gptWebLaneReady: () => true,
    zaiduyuUsableForApi: () => true,
    gptStatus: () => ({
      loggedIn: true, profile: 'P', downloadDir: 'D',
      pool: { total: 0, loggedIn: 0, cooling: 0, banned: 0, autoRotate: true, accounts: [] },
      laneEnabled: true,
    }),
    readGptPending: () => null,
    LANE_UNREADY_REASON: {},
    parseSlashGenArgs: () => ({ prompt: '', refs: [], missing: [] }),
    extractGenArgs: () => ({ prompt: '', references: [], missing: [] }),
    ...overrides,
  }
  vm.runInNewContext(source.slice(start, end), context)
  assert.equal(typeof handler, 'function', '命令 handler 已注册')
  return (rawInput) => handler({ rawInput })
}

await check('只看不改：输出说清顺序 / 就绪 / 回退 / 现在会走哪条', async () => {
  const home = path.join(tmpRoot, 'home1')
  writeLanes(home, { groups: { image: { order: ['zaiduyu', 'gptWeb', 'relayImage'], autoFallback: true } } })
  const r = await command(home)('lanes')
  assert.equal(r.kind, 'success', r.text)
  assert.match(r.text, /生图通道/)
  assert.match(r.text, /1\. 章鱼生图/)
  assert.match(r.text, /2\. ChatGPT 网页生图/)
  assert.match(r.text, /3\. 中转站生图/)
  assert.match(r.text, /按顺序自动回退：开/)
  assert.match(r.text, /现在会走：章鱼生图 → ChatGPT 网页生图 → 中转站生图/)
  assert.deepEqual(readLanes(home).groups.image.order, ['zaiduyu', 'gptWeb', 'relayImage'], '只是查看，不改配置')
})

await check('没配好的通道标出「会被跳过」，不假装能用', async () => {
  const home = path.join(tmpRoot, 'home2')
  const r = await command(home, { gptWebLaneReady: () => false })('lanes')
  assert.match(r.text, /还没配好，会被跳过/)
  assert.match(r.text, /现在会走：章鱼生图/, '网页不可用时不该被算进「现在会走」')
  assert.doesNotMatch(r.text, /现在会走：章鱼生图 → ChatGPT 网页生图/)
})

await check('回退关着时输出「只试第一条」', async () => {
  const home = path.join(tmpRoot, 'home3')
  writeLanes(home, { groups: { image: { autoFallback: false } } })
  const r = await command(home)('lanes')
  assert.match(r.text, /按顺序自动回退：关/)
  assert.match(r.text, /只试第一条/)
})

await check('改顺序必须用户点头（护栏）；带 --yes 才落地', async () => {
  const home = path.join(tmpRoot, 'home4')
  writeLanes(home, { groups: { image: { order: ['zaiduyu', 'gptWeb', 'relayImage'] } } })
  const cmd = command(home)

  const blocked = await cmd('lanes --order gptWeb,zaiduyu,relayImage')
  assert.equal(blocked.kind, 'error', '不带授权不能改')
  assert.match(blocked.text, /通道使用顺序/)
  assert.deepEqual(readLanes(home).groups.image.order, ['zaiduyu', 'gptWeb', 'relayImage'], '被拦住时磁盘上不能变')

  const okRun = await cmd('lanes --order gptWeb,zaiduyu,relayImage --yes')
  assert.equal(okRun.kind, 'success', okRun.text)
  assert.deepEqual(readLanes(home).groups.image.order, ['gptWeb', 'zaiduyu', 'relayImage'])
  assert.match(okRun.text, /已更新生图通道：ChatGPT 网页生图 → 章鱼生图 → 中转站生图/)
})

await check('开关某条通道 / 改回退开关', async () => {
  const home = path.join(tmpRoot, 'home5')
  writeLanes(home, { groups: { image: { autoFallback: true } } })
  const cmd = command(home)

  const off = await cmd('lanes --off relayImage --yes')
  assert.equal(off.kind, 'success', off.text)
  assert.equal(readLanes(home).groups.image.enabled.relayImage, false)
  assert.doesNotMatch(off.text, /中转站生图 →/, '关掉的通道不该出现在启用列表里')

  const fb = await cmd('lanes --fallback off --yes')
  assert.equal(fb.kind, 'success', fb.text)
  assert.equal(readLanes(home).groups.image.autoFallback, false)
  assert.match(fb.text, /按顺序自动回退：关/)

  const fb2 = await cmd('lanes --fallback on --yes')
  assert.match(fb2.text, /按顺序自动回退：开/)
  assert.equal(readLanes(home).groups.image.autoFallback, true)
})

await check('写错的通道 id 当场拒绝，绝不静默丢弃', async () => {
  const home = path.join(tmpRoot, 'home6')
  writeLanes(home, { groups: { image: { order: ['zaiduyu', 'gptWeb', 'relayImage'] } } })
  const before = readLanes(home).groups.image.order
  const r = await command(home)('lanes --order zaiduyu,nope --yes')
  assert.equal(r.kind, 'error')
  assert.match(r.text, /未知通道：nope/)
  assert.deepEqual(readLanes(home).groups.image.order, before, '报错时不能改动配置')
})

await check('中文别名也认（通道 / 顺序 等价于 lanes）', async () => {
  const home = path.join(tmpRoot, 'home7')
  for (const alias of ['通道', '顺序']) {
    const r = await command(home)(alias)
    assert.equal(r.kind, 'success', `${alias}: ${r.text}`)
    assert.match(r.text, /生图通道/)
  }
})

try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
