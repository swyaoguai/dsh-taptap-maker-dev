/** Runtime RED/GREEN gates: all subprocess and HTTP dependencies are in-memory.
 * node scripts/verify-zaiduyu-errors.mjs; no login/generation/user configs/deletion.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import * as zaiduyu from '../src/taptap-zaiduyu.mjs'
import { parseSlashGenArgs } from '../src/taptap-gpt.mjs'
const source = fs.readFileSync(new URL('../src/taptap-zaiduyu.mjs', import.meta.url), 'utf8')
let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`) }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`) }
}
function load(name, deps, code = source) {
  const start = code.search(new RegExp(`export (?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `real ${name} exists`)
  const next = code.indexOf('\nexport ', start + 10)
  const ctx = vm.createContext({ ...deps })
  vm.runInContext(`${code.slice(start, next < 0 ? code.length : next).replace(/^export /, '')}\nthis.run = ${name}`, ctx)
  return ctx.run
}
function generation(stderr) {
  let calls = 0
  const run = load('generate', {
    zaiduyuLaneUsable: () => ({ script: true, python: 'mock-python', credentials: true }),
    resolveZaiduyuModel: (_home, model) => model ?? 'offline-default',
    resolveAssetDir: () => ({ dir: 'MEMORY-ONLY' }), path, Date,
    fs: { existsSync: () => false }, expandUser: (s) => s,
    runZaiduyu: async () => { calls++; return { code: 1, stdout: '', stderr } },
    parsePreflight: zaiduyu.parsePreflight, zaiduyuQuotaHit: zaiduyu.zaiduyuQuotaHit,
    classifyZaiduyuFailure: zaiduyu.classifyZaiduyuFailure,
  })
  return { run, count: () => calls }
}
await check('generation HTTP409 carries allocation code without asking login', async () => {
  const f = generation('服务器分配失败（HTTP 409），未提交生成：请刷新页面以获取服务器分配')
  await assert.rejects(f.run('MEMORY-HOME', 'offline icon', { model: 'offline-model' }), (e) => {
    assert.equal(e.code, 'server_allocation_required')
    assert.equal(e.requiresLogin, false)
    assert.equal(e.submitted, false)
    return true
  })
  assert.equal(f.count(), 1)
})
await check('upstream HTTP503 is service failure, never bad password', async () => {
  const f = generation('图片生成失败（HTTP 503）：upstream unavailable')
  await assert.rejects(f.run('MEMORY-HOME', 'offline icon', { model: 'offline-model' }), (e) => {
    assert.equal(e.kind, 'service')
    assert.equal(e.requiresLogin, false)
    return true
  })
  assert.equal(f.count(), 1)
})
await check('unknown submitted timeout stops with unknown state, no retry or login', async () => {
  const f = generation('图片生成结果暂时无法确认，未自动重投；请先核对请求状态或积分记录。网络连接中断或超时')
  await assert.rejects(f.run('MEMORY-HOME', 'offline icon', { model: 'offline-model' }), (e) => {
    assert.equal(e.code, 'result_unknown')
    assert.equal(e.requiresLogin, false)
    assert.equal(e.submitted, true)
    return true
  })
  assert.equal(f.count(), 1)
})
await check('login probe service rejection does not classify as credential failure', async () => {
  const run = load('loginProbe', {
    zaiduyuScriptExists: () => true, findPlainPython: () => 'mock-python',
    runZaiduyu: async () => ({ code: 1, stdout: '', stderr: '积分查询失败（HTTP 503）：站点服务暂不可用' }),
    classifyZaiduyuFailure: zaiduyu.classifyZaiduyuFailure,
  })
  const result = await run('offline-user', 'offline-password')
  assert.equal(result.kind, 'service')
  assert.equal(result.requiresLogin, false)
})
await check('confirmed authentication rejection still asks for credential verification', async () => {
  assert.equal(typeof zaiduyu.classifyZaiduyuFailure, 'function')
  const f = zaiduyu.classifyZaiduyuFailure('登录失败（HTTP 401）：账号或密码错误')
  assert.equal(f.kind, 'auth')
  assert.equal(f.requiresLogin, true)
})
await check('HTTP403 permission refusal alone must not imply logged out', async () => {
  assert.equal(typeof zaiduyu.classifyZaiduyuFailure, 'function')
  const f = zaiduyu.classifyZaiduyuFailure('图片生成失败（HTTP 403）：模型无权限')
  assert.equal(f.requiresLogin, false)
})
await check('unified slash consumes explicit model without prompt pollution', async () => {
  const a = parseSlashGenArgs('offline icon --model=offline-image --ref one.png --downscale 64x64')
  assert.equal(a.model, 'offline-image')
  assert.equal(a.prompt, 'offline icon')
  assert.deepEqual(a.refs, ['one.png'])
  assert.equal(a.downscale, '64x64')
  assert.deepEqual(a.missing, [])
})
await check('unified slash model last wins and missing value is rejected', async () => {
  const a = parseSlashGenArgs('--model first -m second offline icon')
  assert.equal(a.model, 'second')
  assert.equal(a.prompt, 'offline icon')
  assert.ok(parseSlashGenArgs('offline icon --model --ref a.png').missing.includes('--model'))
  assert.ok(parseSlashGenArgs('offline icon --model=').missing.includes('--model='))
})
await check('low-balance warning plus unknown result is NOT a quota rejection', async () => {
  const f = generation('提示：当前总积分不足预计消耗，未启用严格余额保护\n图片生成结果暂时无法确认，未自动重投；请先核对请求状态或积分记录。')
  await assert.rejects(f.run('MEMORY-HOME', 'offline icon', { model: 'offline-model' }), (e) => {
    assert.equal(e.code, 'result_unknown'); assert.equal(e.quota, false); return true
  })
  assert.equal(f.count(), 1)
})
await check('confirmed quota rejection is still machine-readable for permitted fallback', async () => {
  const f = generation('图片生成失败（HTTP 402）：积分不足')
  await assert.rejects(f.run('MEMORY-HOME', 'offline icon', { model: 'offline-model' }), (e) => {
    assert.equal(e.code, 'quota_exhausted'); assert.equal(e.quota, true); return true
  })
  assert.equal(f.count(), 1)
})
await check('dedicated empty explicit model is a missing value, not permission for a default', async () => {
  const a = zaiduyu.extractGenArgs('offline icon --model=')
  assert.ok(a.missing.includes('--model='))
})
await check('boolean image count rejects before any child submission', async () => {
  const f = generation('offline child should never run')
  await assert.rejects(f.run('MEMORY-HOME', 'offline icon', { model: 'offline-model', n: true }), (e) => {
    assert.equal(e.code, 'missing_value'); return true
  })
  assert.equal(f.count(), 0)
})
await check('explicit Zaiduyu model cannot be silently ignored by another paid lane', async () => {
  let submissions = 0
  const code = fs.readFileSync(new URL('../src/taptap-gpt.mjs', import.meta.url), 'utf8')
  const run = load('generateImage', {
    laneOrder: () => ['relayImage'], readGptLaneEnabled: () => false,
    readLanes: () => ({ autoFallback: true }),
    runWithFallback: async (chain, fn) => ({ ok: true, lane: chain[0], value: await fn(chain[0]), attempts: [] }),
    relayGenerate: async () => { submissions++; return { outputs: ['offline-image'] } },
  }, code)
  const r = await run('MEMORY-HOME', 'offline icon', { relayReady: () => true, zaiduyuOpts: { model: 'offline-selected' } })
  assert.equal(r.ok, false); assert.equal(r.error, 'model_lane_mismatch')
  assert.equal(r.submitted, false); assert.equal(submissions, 0)
})
await check('generation-node HTTP401 is not proof that saved account credentials expired', async () => {
  const f = generation('图片生成失败（HTTP 401）：Unauthorized')
  await assert.rejects(f.run('MEMORY-HOME', 'offline icon', { model: 'offline-model' }), (e) => {
    assert.equal(e.requiresLogin, false); return true
  })
  assert.equal(f.count(), 1)
})
await check('explicit compute ticket HTTP401 outranks account authentication inference', async () => {
  const f = generation('服务器分配票据无效（HTTP 401），请求未自动重投')
  await assert.rejects(f.run('MEMORY-HOME', 'offline icon', { model: 'offline-model' }), (e) => {
    assert.equal(e.requiresLogin, false); assert.equal(e.code, 'server_allocation_required'); return true
  })
  assert.equal(f.count(), 1)
})
console.log(`Result: ${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
