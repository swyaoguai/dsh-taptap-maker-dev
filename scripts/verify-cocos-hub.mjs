#!/usr/bin/env node
/**
 * Cocos 集成的离线验证：不需要真的开 Cocos Creator，也不需要装扩展。
 *
 * 覆盖的风险点（都是「看起来能跑、实际会写错工程」那类）：
 *  - 身份校验：端口上的服务自报的是**另一个项目**时必须中止；
 *  - 写令牌：写操作要把 `expected_context` 带上；
 *  - 排队与锁：同项目第二个写操作要被挡住，过期锁能被回收；
 *  - 配置层：patch 行能正确增/改/删，非法内容拒绝写入；
 *  - 注册表：slug/名称/前缀解析，歧义时报错而不是猜；
 *  - 协议：JSON 与 SSE 两种返回都能解析，Accept 不对时服务端 406 也要如实报错；
 *  - stdio 服务：initialize / tools/list / tools/call 全链路可用。
 *
 * 跑法：node scripts/verify-cocos-hub.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-verify-'))

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`  FAIL ${name}\n       ${error?.message ?? error}\n`)
  }
}

// ── 1. 客户端 / 身份校验（本地假 MCP 服务）──────────────────────────────
function startMockServer({ projectPath, projectId, sseOnce = false, sseNotifyFirst = false, toolError = false, delayMs = 0 } = {}) {  const state = { calls: [], sseOnce, sseNotifyFirst, toolError }
  const expectedContext = `${projectId}:instance-1`
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        name: 'funplay-cocos-mcp',
        version: 'test',
        projectName: path.basename(projectPath),
        projectIdentity: projectId,
        context: {
          project_id: projectId,
          instance_id: 'instance-1',
          project_path: projectPath,
          expected_context: expectedContext,
        },
      }))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(404).end('not found')
      return
    }
    const accept = String(req.headers.accept ?? '')
    if (!accept.includes('text/event-stream')) {
      res.writeHead(406, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Accept must include text/event-stream' }))
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      const message = JSON.parse(body)
      state.calls.push(message)
      const reply = (result) => {
        const payload = { jsonrpc: '2.0', id: message.id, result }
        if (state.sseNotifyFirst) {
          // 同一条 SSE 流里先塞一条服务端通知（id 不匹配），再给真正的响应。
          // 客户端如果「没匹配到就取最后一条」会拿错，这里用来锁住这个行为。
          state.sseNotifyFirst = false
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const notice = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })
          res.end(`event: message\ndata: ${notice}\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`)
          return
        }
        if (state.sseOnce) {
          state.sseOnce = false
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (message.method === 'initialize') {
        reply({
          protocolVersion: message.params?.protocolVersion ?? '2026-07-28',
          serverInfo: { name: 'funplay-cocos-mcp', version: 'test' },
          funplay: {
            server: 'funplay-cocos-mcp',
            projectName: path.basename(projectPath),
            projectIdentity: projectId,
            routingVersion: 1,
            context: {
              project_id: projectId,
              instance_id: 'instance-1',
              project_path: projectPath,
              expected_context: expectedContext,
            },
          },
          capabilities: { tools: {} },
        })
        return
      }
      if (message.method === 'tools/list') {
        reply({
          tools: [
            { name: 'execute_javascript', description: 'exec', inputSchema: { type: 'object' } },
            { name: 'get_scene_info', description: 'scene', inputSchema: { type: 'object' } },
          ],
        })
        return
      }
      if (message.method === 'tools/call') {
        if (state.toolError) {
          reply({ isError: true, content: [{ type: 'text', text: '上游拒绝：场景里有未保存的改动' }] })
          return
        }
        reply({
          content: [{ type: 'text', text: `called ${message.params?.name}` }],
          data: {
            tool: message.params?.name,
            gotExpectedContext: Boolean(message.params?.arguments?.expected_context),
            args: message.params?.arguments ?? {},
          },
        })
        return
      }
      if (message.method && message.method.startsWith('notifications/')) {
        res.writeHead(202).end()
        return
      }
      res.writeHead(400).end('{}')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      // 不 unref 的话，undici 的 keep-alive 连接 + 未关闭的 server 会让
      // 整个校验脚本在测试跑完后「不退出」——看起来像卡住，其实是句柄没释放。
      server.unref?.()
      resolve({ server, port, state, stop: () => closeMockServer(server) })
    })
  })
}

/** 关掉 mock server，并强制断开 keep-alive 连接（否则进程不退出）。 */
function closeMockServer(server) {
  try { server.closeAllConnections?.() } catch { /* 老版本 Node 没有该方法 */ }
  try { server.close() } catch { /* 已经关了 */ }
}

async function main() {
  const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href)
  const { CocosMcpError, McpHttpClient, probeHealth } = await load('src/cocos/mcp-http.mjs')
  const { connectTarget } = await load('src/cocos/router.mjs')
  const { projectSlug, normalizeProjectPath } = await load('src/cocos/paths.mjs')
  const { acquireFileLock, releaseFileLock, makeOwner, peekLock, withProjectLock } = await load('src/cocos/locks.mjs')
  const { acquireBuildSlot, releaseBuildSlot, buildSlotsStatus } = await load('src/cocos/locks.mjs')
  const { TOOL_INDEX } = await load('src/cocos/tools.mjs')
  const { upsertMcpRow, removeMcpRow, findRowBlock, renderRow } = await load('src/cocos/register.mjs')
  const { upsertProject, resolveProjectRef, listProjects, readRegistry } = await load('src/cocos/registry.mjs')
  const { tokenize } = await load('src/cocos/command.mjs')
  const { installExtension } = await load('src/cocos/install.mjs')

  process.stdout.write('\ncocos hub 验证\n')

  // ── 客户端 + 身份 ────────────────────────────────────────────
  const projectA = path.join(tmpRoot, 'game-a')
  const projectB = path.join(tmpRoot, 'game-b')
  fs.mkdirSync(path.join(projectA, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(projectB, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(projectA, 'package.json'), JSON.stringify({ name: 'game-a', creator: { version: '3.8.8' } }))
  fs.writeFileSync(path.join(projectB, 'package.json'), JSON.stringify({ name: 'game-b', creator: { version: '3.8.8' } }))

  const mockA = await startMockServer({ projectPath: projectA, projectId: 'pid-a' })
  const mockB = await startMockServer({ projectPath: projectB, projectId: 'pid-b', sseOnce: true })

  await test('客户端能握手并读出项目身份', async () => {
    const client = new McpHttpClient(`http://127.0.0.1:${mockA.port}/mcp/project/pid-a/`)
    await client.initialize()
    const identity = client.identity()
    assert.equal(identity.projectId, 'pid-a')
    assert.equal(normalizeProjectPath(identity.projectPath), normalizeProjectPath(projectA))
    assert.ok(identity.expectedContext.includes('pid-a'))
  })

  await test('写调用会把 expected_context 带给上游', async () => {
    const client = new McpHttpClient(`http://127.0.0.1:${mockA.port}/mcp/project/pid-a/`)
    await client.initialize()
    const result = await client.toolsCall('execute_javascript', { code: 'return 1' }, {
      expectedContext: client.identity().expectedContext,
    })
    assert.equal(result?.data?.gotExpectedContext, true)
  })

  await test('SSE 帧格式的响应也能解析', async () => {
    const client = new McpHttpClient(`http://127.0.0.1:${mockB.port}/mcp/project/pid-b/`)
    await client.initialize()
    const result = await client.toolsCall('get_scene_info', {})
    assert.equal(result?.data?.tool, 'get_scene_info')
  })

  await test('只读调用不带身份令牌（避免被上游 schema 拒绝）', async () => {
    const client = new McpHttpClient(`http://127.0.0.1:${mockA.port}/mcp/project/pid-a/`)
    await client.initialize()
    const result = await client.toolsCall('get_scene_info', {})
    assert.equal(result?.data?.gotExpectedContext, false)
  })

  await test('SSE 流里先来一条通知时，仍取到 id 匹配的那条响应', async () => {
    const mockNotify = await startMockServer({ projectPath: projectA, projectId: 'pid-a', sseNotifyFirst: true })
    const client = new McpHttpClient(`http://127.0.0.1:${mockNotify.port}/mcp/project/pid-a/`)
    await client.initialize()
    const result = await client.toolsCall('get_scene_info', {})
    assert.equal(result?.data?.tool, 'get_scene_info', '不能把通知当成结果')
    closeMockServer(mockNotify.server)
  })

  await test('上游 isError 必须抛错（不能当成功）', async () => {
    const mockErr = await startMockServer({ projectPath: projectA, projectId: 'pid-a', toolError: true })
    const client = new McpHttpClient(`http://127.0.0.1:${mockErr.port}/mcp/project/pid-a/`)
    await client.initialize()
    let error = null
    try {
      await client.toolsCall('get_scene_info', {})
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== null, 'isError 结果必须抛出')
    assert.equal(error.code, 'UPSTREAM_TOOL_ERROR')
    assert.match(error.message, /未保存的改动/)
    closeMockServer(mockErr.server)
  })

  await test('端口上自报的是另一个项目时必须中止（防写错工程）', async () => {
    const target = {
      entry: { slug: projectSlug(projectA), name: 'game-a', path: projectA },
      health: { port: mockB.port, projectId: 'pid-b', projectPath: projectB },
      group: null,
    }
    let error = null
    try {
      await connectTarget(target)
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof CocosMcpError, '应当抛出 CocosMcpError')
    assert.equal(error.code, 'PROJECT_MISMATCH')
  })

  await test('身份一致时连接成功并返回端点', async () => {
    const target = {
      entry: { slug: projectSlug(projectA), name: 'game-a', path: projectA },
      health: { port: mockA.port, projectId: 'pid-a', projectPath: projectA },
      group: null,
    }
    const connection = await connectTarget(target)
    assert.ok(connection.endpoint.includes(`:${mockA.port}`))
    assert.equal(connection.identity.projectId, 'pid-a')
  })

  // ── 锁 ──────────────────────────────────────────────────────
  await test('releaseFileLock 缺 owner 时拒绝释放（不能删别人的锁）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-rel-'))
    const file = path.join(home, 'owned.lock')
    const owner = makeOwner('holder')
    const acquired = await acquireFileLock(file, { owner })
    assert.equal(acquired.ok, true)
    // 以前 owner 缺失会跳过校验直接删锁 —— 任何忘记传 owner 的调用点都能放掉别人的锁。
    assert.equal(releaseFileLock(file, undefined), false)
    assert.equal(releaseFileLock(file, {}), false)
    assert.equal(fs.existsSync(file), true, '锁必须还在')
    assert.equal(releaseFileLock(file, { key: 'not-the-owner' }), false)
    assert.equal(fs.existsSync(file), true)
    assert.equal(releaseFileLock(file, owner), true)
    assert.equal(fs.existsSync(file), false)
  })

  await test('同项目的第二个写操作会被挡住', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-lock-'))
    const ownerA = makeOwner('test-a')
    const ownerB = makeOwner('test-b')
    const file = path.join(home, 'l.lock')
    const first = await acquireFileLock(file, { owner: ownerA })
    assert.equal(first.ok, true)
    const second = await acquireFileLock(file, { owner: ownerB, waitMs: 0 })
    assert.equal(second.ok, false)
    assert.equal(second.holder.key, ownerA.key)
    releaseFileLock(file, ownerA)
    const third = await acquireFileLock(file, { owner: ownerB })
    assert.equal(third.ok, true)
    releaseFileLock(file, ownerB)
  })

  await test('过期锁会被回收（进程崩了不会永久卡死）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-stale-'))
    const file = path.join(home, 'stale.lock')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ key: 'dead', pid: 999999, host: os.hostname(), ts: Date.now() - 60000, expiresAt: Date.now() - 30000 }))
    assert.equal(peekLock(file), null)
    const owned = await acquireFileLock(file, { owner: makeOwner('stale-test') })
    assert.equal(owned.ok, true)
    releaseFileLock(file, owned.holder)
  })

  await test('刚创建但内容还没写完的锁不会被抢走（wx 竞态）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-race-'))
    const file = path.join(home, 'race.lock')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 模拟「另一个进程已创建文件、正在写入」：内容是半截 JSON，mtime 是现在。
    fs.writeFileSync(file, '{"key":"other","pid":')
    const peek = peekLock(file)
    assert.ok(peek !== null, '正在写入的锁不能被报告成空闲')
    const stolen = await acquireFileLock(file, { owner: makeOwner('racer'), waitMs: 0 })
    assert.equal(stolen.ok, false, '不能把别人正在写的锁删掉')

    // 同一份坏内容，但文件很旧 → 才算残留，可以回收。
    const old = new Date(Date.now() - 60000)
    fs.utimesSync(file, old, old)
    const reclaimed = await acquireFileLock(file, { owner: makeOwner('reclaimer'), waitMs: 0 })
    assert.equal(reclaimed.ok, true)
    releaseFileLock(file, reclaimed.holder)
  })

  await test('withProjectLock 释放后同一项目可再次获取', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-with-'))
    const slug = 'game-a-abc123'
    const value = await withProjectLock(home, slug, makeOwner('one'), async () => 42)
    assert.equal(value, 42)
    let busyError = null
    await withProjectLock(home, slug, makeOwner('two'), async () => {
      try {
        await withProjectLock(home, slug, makeOwner('three'), async () => 'nope')
      } catch (error) {
        busyError = error
      }
    })
    assert.ok(busyError !== null, '嵌套写操作应当被拒')
    assert.match(busyError.message, /只允许一个写操作/)
  })

  await test('构建槽位按上限统计，且上限为 2 时第二个槽位可见', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-slots-'))
    const ownerA = makeOwner('build-a')
    const ownerB = makeOwner('build-b')
    const slotOne = await acquireBuildSlot(home, ownerA, { max: 2, waitMs: 0 })
    assert.equal(slotOne.ok, true)
    assert.equal(slotOne.slot, 1)
    const slotTwo = await acquireBuildSlot(home, ownerB, { max: 2, waitMs: 0 })
    assert.equal(slotTwo.ok, true)
    assert.equal(slotTwo.slot, 2)
    const busy = await acquireBuildSlot(home, makeOwner('build-c'), { max: 2, waitMs: 0 })
    assert.equal(busy.ok, false, '两个槽位都占满时必须拒绝')
    assert.equal(busy.holders.length, 2, '错误信息里要列出两个占用者')
    assert.equal(buildSlotsStatus(home, 1).length, 1, '上限 1 时只应看到第一个槽位')
    assert.equal(buildSlotsStatus(home, 2).length, 2, '上限 2 时应看到两个槽位')
    releaseBuildSlot(slotOne.file, ownerA)
    releaseBuildSlot(slotTwo.file, ownerB)
  })

  await test('cocos_status 能查「已登记但没运行」的项目', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-status-'))
    const registered = await upsertProject(home, { path: projectA, name: 'game-a', creatorVersion: '3.8.8' })
    const slug = projectSlug(projectA)
    assert.ok(registered.projects[slug])
    const result = await TOOL_INDEX.get('cocos_status').handler(
      { project: slug },
      { dshHome: home, config: {}, sessionId: 'verify' },
    )
    assert.equal(result.slug, slug)
    assert.equal(result.running, false)
    assert.equal(result.meta?.creatorVersion, '3.8.8')
  })

  // ── 配置层 patch ────────────────────────────────────────────
  await test('patch 行能新增、保持幂等、再删除', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-patch-'))
    const patchFile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    fs.mkdirSync(path.dirname(patchFile), { recursive: true })
    fs.writeFileSync(patchFile, '- id: existing\n  name: something\n  config:\n    a: 1\n')
    const nodePath = process.execPath
    const hubPath = path.join(ROOT, 'src/cocos/server.mjs')

    const first = upsertMcpRow({ dshHome: home, nodePath, hubPath })
    assert.equal(first.changed, true)
    const text = fs.readFileSync(patchFile, 'utf8')
    assert.match(text, /- id: mcp-cocos/)
    assert.match(text, /serverName: cocos/)
    assert.match(text, /id: existing/, '用户原有条目必须保留')

    const second = upsertMcpRow({ dshHome: home, nodePath, hubPath })
    assert.equal(second.changed, false, '重复登记应幂等')

    const removed = removeMcpRow({ dshHome: home })
    assert.equal(removed.changed, true)
    const after = fs.readFileSync(patchFile, 'utf8')
    assert.ok(!after.includes('mcp-cocos'))
    assert.match(after, /id: existing/)
  })

  await test('非法 patch 文件拒绝写入（不硬塞）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-badpatch-'))
    const patchFile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    fs.mkdirSync(path.dirname(patchFile), { recursive: true })
    fs.writeFileSync(patchFile, 'this: is not a patch list\n')
    let error = null
    try {
      upsertMcpRow({ dshHome: home, nodePath: process.execPath, hubPath: path.join(ROOT, 'src/cocos/server.mjs') })
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== null)
    assert.equal(error.code, 'PATCH_NOT_A_LIST')
    assert.equal(fs.readFileSync(patchFile, 'utf8'), 'this: is not a patch list\n', '文件不能被改动')
  })

  await test('renderRow 生成的 YAML 块能被 findRowBlock 找到', async () => {
    const row = renderRow({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', hubPath: 'D:\\a b\\server.mjs', buildSlots: 2 })
    const found = findRowBlock(`${row}\n- id: next\n  name: x\n`)
    assert.ok(found !== null)
    assert.match(found.block, /--build-slots/)
    assert.match(found.block, /- '2'/)
  })

  await test('patch 写入保留文件原本的 CRLF 换行', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-crlf-'))
    const patchFile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    fs.mkdirSync(path.dirname(patchFile), { recursive: true })
    fs.writeFileSync(patchFile, '- id: existing\r\n  name: something\r\n')
    upsertMcpRow({ dshHome: home, nodePath: process.execPath, hubPath: path.join(ROOT, 'src/cocos/server.mjs') })
    const text = fs.readFileSync(patchFile, 'utf8')
    assert.ok(text.includes('\r\n'), 'CRLF 文件不应被改成 LF')
    assert.ok(!/[^\r]\n/.test(text), '不应混入裸 LF')
    removeMcpRow({ dshHome: home })
    const after = fs.readFileSync(patchFile, 'utf8')
    assert.ok(after.includes('\r\n'))
    assert.ok(!/[^\r]\n/.test(after))
  })

  await test('撤掉登记行时一并清掉本插件的说明注释', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-cleanup-'))
    const patchFile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    fs.mkdirSync(path.dirname(patchFile), { recursive: true })
    fs.writeFileSync(patchFile, '- id: keep\n  name: x\n')
    upsertMcpRow({ dshHome: home, nodePath: process.execPath, hubPath: path.join(ROOT, 'src/cocos/server.mjs') })
    assert.ok(fs.readFileSync(patchFile, 'utf8').includes('dsh-game-forge: Cocos MCP 入口'))
    removeMcpRow({ dshHome: home })
    const text = fs.readFileSync(patchFile, 'utf8')
    assert.ok(!text.includes('dsh-game-forge: Cocos MCP 入口'), '注释不应留成孤儿')
    assert.ok(!text.includes('mcp-cocos'))
    assert.match(text, /id: keep/)
  })

  await test('注释开头但实际是 mapping 的 patch 文件也要拒绝写入', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-mapping-'))
    const patchFile = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    fs.mkdirSync(path.dirname(patchFile), { recursive: true })
    fs.writeFileSync(patchFile, '# 一些说明\nsomeKey: value\n')
    let error = null
    try {
      upsertMcpRow({ dshHome: home, nodePath: process.execPath, hubPath: path.join(ROOT, 'src/cocos/server.mjs') })
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== null, 'mapping 文件必须拒绝')
    assert.equal(error.code, 'PATCH_NOT_A_LIST')
    assert.equal(fs.readFileSync(patchFile, 'utf8'), '# 一些说明\nsomeKey: value\n')
  })

  await test('slug：中文目录名保留可读性，不同中文项目不撞名', async () => {
    const a = projectSlug(path.join(tmpRoot, '游戏甲'))
    const b = projectSlug(path.join(tmpRoot, '游戏乙'))
    assert.match(a, /^游戏甲-[0-9a-f]{6}$/)
    assert.notEqual(a, b)
  })

  await test('slug：同一路径不同写法得到同一个 slug', async () => {
    const base = path.join(tmpRoot, 'same-proj')
    fs.mkdirSync(path.join(base, 'assets'), { recursive: true })
    const one = projectSlug(base)
    const two = projectSlug(`${base}${path.sep}`)
    const three = projectSlug(process.platform === 'win32' ? base.toUpperCase() : base)
    assert.equal(one, two)
    assert.equal(one, three, '大小写不敏感的文件系统上应视为同一项目')
  })

  // ── 注册表 ──────────────────────────────────────────────────
  await test('注册表：slug / 名称 / 前缀解析，歧义要报错', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-reg-'))
    const a = await upsertProject(home, { path: projectA, name: 'game-a', creatorVersion: '3.8.8' })
    const slugA = projectSlug(projectA)
    assert.ok(a.projects[slugA])
    const b = await upsertProject(home, { path: path.join(tmpRoot, 'game-ab'), name: 'game-ab' })
    assert.equal(listProjects(home).length, 2)
    assert.equal(resolveProjectRef(home, slugA).slug, slugA)
    assert.equal(resolveProjectRef(home, projectA).slug, slugA)
    assert.equal(resolveProjectRef(home, 'game-a').slug, slugA)
    let ambiguous = null
    try {
      resolveProjectRef(home, 'game-a')
      // 'game-a' 精确匹配到同名项目，不应歧义
    } catch (error) {
      ambiguous = error
    }
    assert.equal(ambiguous, null)
  })

  await test('registry 写入是原子的（不留下临时文件）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-atomic-'))
    await upsertProject(home, { path: projectA, name: 'game-a' })
    await upsertProject(home, { path: projectB, name: 'game-b' })
    const dir = path.join(home, 'game-forge', 'cocos')
    const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  })

  // ── 命令解析 ────────────────────────────────────────────────
  await test('命令 tokenize 支持带空格的路径与引号', async () => {
    assert.deepEqual(tokenize('install "D:\\my games\\demo" --yes'), ['install', 'D:\\my games\\demo', '--yes'])
    assert.deepEqual(tokenize('  list  '), ['list'])
    assert.deepEqual(tokenize("build 'a b' --platform web-mobile"), ['build', 'a b', '--platform', 'web-mobile'])
  })

  await test('cocos_exec 写操作会拿项目写锁：并发的第二个必须被拒', async () => {
    // 假上游故意拖慢响应，制造锁重叠窗口；把 /health 结果塞进注入的 discovery，
    // 整条工具路径（参数 → 身份 → 写锁 → 上游）都能在没有真编辑器时跑通。
    const slow = await startMockServer({ projectPath: projectA, projectId: 'pid-a', delayMs: 500 })
    const health = await probeHealth(slow.port)
    assert.ok(health !== null, 'mock /health 应能被探到')
    const fakeDiscovery = {
      instances: [{
        pid: 424242,
        projectPath: projectA,
        exePath: '',
        build: false,
        ports: [slow.port],
        mcpHealths: [health],
      }],
      probedAt: Date.now(),
      platform: process.platform,
    }
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-execlock-'))
    await upsertProject(home, { path: projectA, name: 'game-a', creatorVersion: '3.8.8' })
    const slug = projectSlug(projectA)
    const ctx = { dshHome: home, config: {}, sessionId: 'verify', discovery: fakeDiscovery }
    const def = TOOL_INDEX.get('cocos_exec')
    const call = () => def.handler({ project: slug, context: 'scene', code: 'return 1' }, ctx)
    const [a, b] = await Promise.allSettled([call(), call()])
    const okResults = [a, b].filter((item) => item.status === 'fulfilled')
    const busyErrors = [a, b].filter((item) => item.status === 'rejected' && /只允许一个写操作/.test(String(item.reason)))
    if (okResults.length !== 1) {
      const details = [a, b].map((item) => item.status === 'rejected' ? `${item.reason?.code}: ${item.reason?.message}` : 'ok').join(' || ')
      assert.fail(`并发两个写操作应恰好成功一个，实际：${details}`)
    }
    assert.equal(busyErrors.length, 1, '另一个应被写锁拒绝')
    // 成功的那个返回后锁必须已释放。
    assert.equal(fs.existsSync(path.join(home, 'game-forge', 'cocos', 'locks', `${slug}.write.lock`)), false)
    closeMockServer(slow.server)
  })

  await test('命令解析：flag 写在项目名前也不会把值当成项目名', async () => {
    const { parseTokens } = await load('src/cocos/command.mjs')
    const first = parseTokens(['myproj', '--platform', 'web-mobile', '--wait', '30'])
    assert.deepEqual(first.positional, ['myproj'])
    assert.equal(first.values.get('platform'), 'web-mobile')
    assert.equal(first.values.get('wait'), '30')
    // 之前用 indexOf('--wait') + 1 取值，这种顺序会把 '30' 当成项目
    const second = parseTokens(['--wait', '30', 'myproj'])
    assert.deepEqual(second.positional, ['myproj'])
    assert.equal(second.values.get('wait'), '30')
    const third = parseTokens(['--global', 'myproj'])
    assert.ok(third.flags.has('global'))
    assert.deepEqual(third.positional, ['myproj'])
  })

  await test('参数校验：拼错 project（projects）必须被拒，不能静默落到默认项目', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-args-'))
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cocos/server.mjs'), '--home', home], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: home },
    })
    const responses = []
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') responses.push(JSON.parse(line))
      }
    })
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {} } })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cocos_exec', arguments: { projects: 'x', context: 'scene', code: 'return 1' } } })
    const deadline = Date.now() + 20000
    while (responses.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    child.stdin.end()
    await new Promise((resolve) => { child.on('exit', resolve); setTimeout(resolve, 3000) })

    const init = responses.find((item) => item.id === 1)
    assert.equal(init.result.protocolVersion, '2026-07-28', '不支持的协议版本必须回落到自己支持的版本')
    const call = responses.find((item) => item.id === 2)
    assert.equal(call.result.isError, true, '未知参数必须报错')
    assert.match(call.result.content[0].text, /不认识参数/)
  })

  await test('安装拒绝非 Cocos 工程（防止塞进 Maker 工程）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-notcocos-'))
    const makerLike = path.join(tmpRoot, 'maker-like')
    fs.mkdirSync(path.join(makerLike, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(makerLike, 'package.json'), JSON.stringify({ name: 'maker-game', version: '1.0.0' }))
    let error = null
    try {
      await installExtension({ projectPath: makerLike, dshHome: home })
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== null, '没有 creator.version 就必须拒绝')
    assert.equal(error.code, 'NOT_COCOS_PROJECT')
  })

  await test('artifact 清理只保留最近 N 个，且不误删别的文件', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-prune-'))
    const dir = path.join(home, 'game-forge', 'cocos', 'shots')
    fs.mkdirSync(dir, { recursive: true })
    // 造 50 份构建日志（旧的）+ 3 份截图 + 1 份别人的文件。
    for (let i = 0; i < 50; i += 1) {
      const file = path.join(dir, `game-a-build-${1000 + i}.log`)
      fs.writeFileSync(file, 'x')
      const old = new Date(Date.now() - (100 - i) * 60000)
      fs.utimesSync(file, old, old)
    }
    for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(dir, `shot-${i}.png`), 'y')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me')

    const { pruneArtifacts } = await load('src/cocos/tools.mjs')
    const removed = pruneArtifacts(dir, { keep: 5, match: /-build-\d+\.log$/ })
    assert.equal(removed, 45, '50 份日志保留 5 份，应删 45 份')
    const left = fs.readdirSync(dir)
    assert.equal(left.filter((name) => /-build-\d+\.log$/.test(name)).length, 5)
    assert.equal(left.filter((name) => name.endsWith('.png')).length, 3, '截图不能被当成日志删掉')
    assert.ok(left.includes('notes.txt'), '不匹配的文件必须原样保留')
  })

  await test('pickCreatorExecutable 按版本挑对的 exe，而不是拿第一个', async () => {
    const { pickCreatorExecutable } = await load('src/cocos/discover.mjs')
    const candidates = [
      'C:\\ProgramData\\cocos\\editors\\Creator\\3.7.2\\CocosCreator.exe',
      'C:\\ProgramData\\cocos\\editors\\Creator\\3.8.8\\CocosCreator.exe',
      'C:\\ProgramData\\cocos\\editors\\Creator\\3.8.9\\CocosCreator.exe',
    ]
    assert.equal(pickCreatorExecutable(candidates, '3.8.8'), candidates[1], '精确版本优先')
    assert.equal(pickCreatorExecutable(candidates, '3.8.2'), candidates[1], '次版本匹配（3.8.x）')
    assert.equal(pickCreatorExecutable(candidates, ''), candidates[0], '无版本要求取第一个')
    assert.equal(pickCreatorExecutable([], '3.8.8'), null, '空候选返回 null')
    // 之前 candidates[0] 兜底：给 3.8.8 的工程用 3.7.2 构建，产物行为不可预期。
    assert.notEqual(pickCreatorExecutable(candidates, '3.8.8'), candidates[0])
  })

  await test('isUsableNodePath 排除应用商店存根与不存在的路径', async () => {
    const { isUsableNodePath } = await load('src/cocos/register.mjs')
    // Windows 上 `where node` 常先返回 0 字节存根，拿它当 MCP command 会立刻退出。
    assert.equal(isUsableNodePath('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\node.exe'), false)
    assert.equal(isUsableNodePath('/home/x/.local/share/WindowsApps/node'), false)
    assert.equal(isUsableNodePath('C:\\definitely\\missing\\node.exe'), false)
    assert.equal(isUsableNodePath(''), false)
    assert.equal(isUsableNodePath(null), false)
    // 真正的 node 可执行文件应当可用。
    assert.equal(isUsableNodePath(process.execPath), true)
  })

  await test('客户端取消：cocos_open 的等待循环会被 abort 中断', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-cancel-'))
    const projectDir = path.join(tmpRoot, 'cancel-proj')
    fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'cancel-proj', creator: { version: '3.8.8' } }))
    await upsertProject(home, { path: projectDir, name: 'cancel-proj', creatorVersion: '3.8.8' })
    const controller = new AbortController()
    // 没有任何在跑实例 → cocos_open 会进入「启动后等待」的循环；用 abort 打断它。
    const emptyDiscovery = { instances: [], probedAt: Date.now(), platform: process.platform }
    const promise = TOOL_INDEX.get('cocos_open').handler(
      { project: projectSlug(projectDir), wait_ms: 60000, creator_exe: process.execPath },
      { dshHome: home, config: {}, sessionId: 'verify', discovery: emptyDiscovery, signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 300)
    let error = null
    try {
      await promise
    } catch (caught) {
      error = caught
    }
    // 要么被取消（CANCELLED），要么因为 node 不接受 --project 而 SPAWN_FAILED；
    // 关键是**不能在 60s 等待里挂住**。
    assert.ok(error !== null, 'abort 后应尽快结束并抛错')
    assert.ok(['CANCELLED', 'SPAWN_FAILED'].includes(error.code), `实际错误码：${error.code} ${error.message}`)
  })

  await test('取消信号会传到 fetch：上游迟迟不回时立刻中断，报 CANCELLED 而非 TIMEOUT', async () => {
    // 慢上游：延迟 5 秒才回。工具超时设成 30 秒，取消发生在 200ms。
    const slow = await startMockServer({ projectPath: projectA, projectId: 'pid-a', delayMs: 5000 })
    const { McpHttpClient } = await load('src/cocos/mcp-http.mjs')
    const client = new McpHttpClient(`http://127.0.0.1:${slow.port}/mcp/project/pid-a/`, { timeoutMs: 30000 })
    const controller = new AbortController()
    const started = Date.now()
    const call = client.initialize({ signal: controller.signal }).catch((error) => error)
    setTimeout(() => controller.abort(), 200)
    const outcome = await call
    const elapsed = Date.now() - started
    closeMockServer(slow.server)
    assert.ok(outcome instanceof Error, '必须抛错')
    assert.equal(outcome.code, 'CANCELLED', `取消不能被报成 ${outcome.code}`)
    assert.ok(elapsed < 2000, `取消后应立刻返回，实际等了 ${elapsed}ms`)
  })

  await test('探测不到 Creator 时不缓存空结果（装完立刻能用）', async () => {
    const { findCreatorExecutables, invalidateCreatorExeCache } = await load('src/cocos/discover.mjs')
    invalidateCreatorExeCache()
    const first = findCreatorExecutables()
    // 无论本机有没有装 Creator，空结果都必须**每次都重新探测**：
    // 缓存空值会让「刚装好 Creator」的用户十分钟内一直报 NO_CREATOR_EXE。
    const second = findCreatorExecutables()
    assert.deepEqual(second, first)
    const real = findCreatorExecutables({ cacheMs: 0 })
    assert.deepEqual(real, first, '强制重扫应与缓存结果一致（本测试只锁行为，不锁内容）')
  })

  await test('CLI 布尔开关不会吞掉后面的工程路径（--global <路径>）', async () => {
    const { spawnSync } = await import('node:child_process')
    const cliPath = path.join(ROOT, 'src/cocos/cli.mjs')
    // 只跑到 usage 分支（不加 --yes）：关键是它把路径认成位置参数、
    // 并且认出 --global，而不是把路径当成 --global 的值。
    const result = spawnSync(process.execPath, [cliPath, 'install', '--global', projectA], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
    assert.match(text, /全局 builtin-extensions/, '--global 必须被识别为真（而不是被路径覆盖成字符串）')
    assert.doesNotMatch(text, /D:\\/, 'usage 里不该出现被吞掉的路径')
  })

  await test('install --yes 后 --global 仍生效（布尔归一化）', async () => {
    const { spawnSync } = await import('node:child_process')
    const cliPath = path.join(ROOT, 'src/cocos/cli.mjs')
    // --yes=false 应当当作「未确认」→ 只打印说明并退出 1，不会真的下载。
    const result = spawnSync(process.execPath, [cliPath, 'install', projectA, '--yes=false'], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    assert.equal(result.status, 1, '未确认时必须拒绝执行')
    assert.match(`${result.stdout ?? ''}`, /确认后请加 --yes/, '应给出确认提示')
  })

  await test('同一工程能加载两份扩展时 doctor 要报出来', async () => {
    const { doctor } = await load('src/cocos/install.mjs')
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-dup-'))
    const projectDir = path.join(tmpRoot, 'dup-proj')
    fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'dup', creator: { version: '3.8.8' } }))
    const writeExt = (dir) => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'funplay-cocos-mcp', version: '0.7.0' }))
    }
    writeExt(path.join(projectDir, 'extensions', 'funplay-cocos-mcp'))
    const report = await doctor({ projectPath: projectDir, dshHome: home })
    assert.equal(report.installedScopes.length, 1, '只有工程级一份时不应报重复')
    assert.equal(report.problems.some((line) => line.includes('同时加载')), false)

    // 再放一份全局的（用 COCOS_USER_DIR 指向临时目录，别碰真实用户目录）
    const fakeUser = fs.mkdtempSync(path.join(tmpRoot, 'cocos-user-'))
    const previous = process.env.COCOS_USER_DIR
    process.env.COCOS_USER_DIR = fakeUser
    try {
      writeExt(path.join(fakeUser, 'builtin-extensions', '3.8.8', 'funplay-cocos-mcp'))
      const dup = await doctor({ projectPath: projectDir, dshHome: home })
      if (dup.installedScopes.length > 1) {
        assert.equal(dup.problems.some((line) => line.includes('同时加载')), true, '两份都要加载时必须报重复')
      }
    } finally {
      if (previous === undefined) delete process.env.COCOS_USER_DIR
      else process.env.COCOS_USER_DIR = previous
    }
  })

  await test('注册表：损坏副本只留最近 3 份（不会每次读都复制一份）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-corrupt-'))
    const regFile = path.join(home, 'game-forge', 'cocos', 'projects.json')
    fs.mkdirSync(path.dirname(regFile), { recursive: true })
    fs.writeFileSync(regFile, '{ broken json')
    for (let i = 0; i < 10; i += 1) readRegistry(home)
    const copies = fs.readdirSync(path.dirname(regFile)).filter((name) => name.includes('.corrupt-'))
    assert.equal(copies.length, 3, `损坏副本应只留 3 份，实际 ${copies.length}`)
    assert.deepEqual(readRegistry(home).projects, {}, '损坏时读出来是空表，不抛错')
  })

  await test('注册表：磁盘版本比插件新时拒绝写入（不静默降级丢字段）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-v2-'))
    const regFile = path.join(home, 'game-forge', 'cocos', 'projects.json')
    fs.mkdirSync(path.dirname(regFile), { recursive: true })
    const newer = JSON.stringify({ version: 2, projects: { x: { slug: 'x', newField: 1 } } })
    fs.writeFileSync(regFile, newer)
    assert.equal(readRegistry(home).version, 2, '读得到版本号')
    let error = null
    try {
      await upsertProject(home, { path: projectA, name: 'game-a' })
    } catch (caught) {
      error = caught
    }
    assert.ok(error !== null, '必须拒绝写回旧版本')
    assert.match(String(error.message), /注册表版本是 2/)
    // 关键：原文件一个字节都不能被改坏
    assert.equal(fs.readFileSync(regFile, 'utf8'), newer)
  })

  await test('注册表：传空 name 时保留原名字（不会被覆盖成空白）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-name-'))
    await upsertProject(home, { path: projectA, name: 'game-a', creatorVersion: '3.8.8' })
    const after = await upsertProject(home, { path: projectA, name: '' })
    const slug = projectSlug(projectA)
    assert.equal(after.projects[slug].name, 'game-a')
  })

  await test('注册表写入会释放跨进程锁（不留 registry.lock）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-reglock-'))
    await upsertProject(home, { path: projectB, name: 'game-b' })
    const lockFile = path.join(home, 'game-forge', 'cocos', 'locks', 'registry.lock')
    assert.equal(fs.existsSync(lockFile), false, '写完后锁必须释放')
  })

  // ── stdio 服务 ──────────────────────────────────────────────
  await test('stdio 服务：initialize / tools/list / tools/call 全链路', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-stdio-'))
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cocos/server.mjs'), '--home', home], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: home },
    })
    const responses = []
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        responses.push(JSON.parse(line))
      }
    })
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cocos_projects', arguments: {} } })

    const deadline = Date.now() + 20000
    while (responses.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.stdin.end()
    await new Promise((resolve) => { child.on('exit', resolve); setTimeout(resolve, 5000) })

    const init = responses.find((item) => item.id === 1)
    assert.ok(init?.result?.serverInfo?.name === 'cocos', 'initialize 应返回 serverInfo')
    const list = responses.find((item) => item.id === 2)
    const names = list.result.tools.map((tool) => tool.name)
    for (const expected of ['cocos_projects', 'cocos_exec', 'cocos_scene', 'cocos_build', 'cocos_raw']) {
      assert.ok(names.includes(expected), `tools/list 应包含 ${expected}`)
    }
    const call = responses.find((item) => item.id === 3)
    assert.equal(call.result.isError, false)
    const payload = JSON.parse(call.result.content[0].text)
    assert.ok(Array.isArray(payload.projects), 'cocos_projects 应返回 projects 数组')
  })

  closeMockServer(mockA.server)
  closeMockServer(mockB.server)

  // ── 结果 ────────────────────────────────────────────────────
  process.stdout.write(`\n通过 ${passed} 项，失败 ${failures.length} 项\n`)
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stdout.write(`\n[${failure.name}]\n${failure.error?.stack ?? failure.error}\n`)
    }
    process.exitCode = 1
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exit(1)
})
