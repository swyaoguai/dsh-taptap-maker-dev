#!/usr/bin/env node
/**
 * skill 接线 + 守则注入 的离线验证。
 *
 * 回答两个问题（这正是最容易「看起来都有、实际没接上」的地方）：
 *  1. `cocos-creator-mcp` 这个 skill 能不能被 provider 列出并取到正文？
 *     frontmatter 合法吗？名字被禁用表挡住了吗？
 *  2. Cocos 守则会不会按「是否登记 MCP 服务」正确注入/不注入？
 *     守则与 skill 里提到的工具名、action 值，在真实工具目录里都存在吗？
 *
 * 第 2 点的后半段是重点：文档写了一个不存在的工具名，模型会照着一个
 * 永远调不通的名字去试 —— 这属于「注入正常但工作流必然失败」。
 *
 * 跑法：node scripts/verify-cocos-skill-wiring.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-skill-'))

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

const SKILL_DIR = path.join(ROOT, 'skills', 'cocos-creator-mcp')
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md')

/** 从任意文本里抓出 `cocos_xxx` 形式的工具名。 */
function toolNamesIn(text) {
  return [...new Set([...String(text).matchAll(/\bcocos_[a-z_]+/g)].map((m) => m[0]))]
}

/** 从任意文本里抓出 `action=xxx` / `action: xxx` 形式的取值。 */
function actionsIn(text) {
  const found = new Set()
  for (const match of String(text).matchAll(/action\s*[=:：]\s*`?([a-z_]+)`?/gi)) found.add(match[1])
  return [...found]
}

async function main() {
  const { TaptapSkillProvider } = await load('src/skills-provider.js')
  const { TOOL_INDEX } = await load('src/cocos/tools.mjs')
  const { cocosPolicyText } = await load('src/cocos/policy.mjs')
  const { workflowPolicyText } = await load('src/policy.mjs')
  const { upsertMcpRow, removeMcpRow } = await load('src/cocos/register.mjs')

  process.stdout.write('\ncocos skill 与守则注入验证\n')

  // ── 1. skill 能被 provider 发现 ──────────────────────────────
  const provider = new TaptapSkillProvider('game-forge', [{ dir: path.join(ROOT, 'skills'), rank: 360 }], {
    pinnedRoot: path.join(ROOT, 'skills'),
  })

  await test('provider 能列出 cocos-creator-mcp（且带 description）', async () => {
    const list = await provider.list()
    const hit = list.find((item) => item.name === 'cocos-creator-mcp')
    assert.ok(hit, `未在 ${list.length} 个 skill 中列出 cocos-creator-mcp`)
    assert.ok(hit.description.length > 10, 'description 太短，模型不会选它')
    assert.ok(hit.whenToUse && hit.whenToUse.length > 5, '缺 whenToUse，路由时缺少触发线索')
    assert.equal(hit.invocation.modelInvocable, true, '必须允许模型自行加载')
    assert.equal(hit.rank, 360)
  })

  await test('provider 能取到正文（get），且正文非空', async () => {
    const list = await provider.list()
    const candidate = list.find((item) => item.name === 'cocos-creator-mcp')
    const full = await provider.get(candidate)
    assert.ok(typeof full.content === 'string' && full.content.length > 200, '正文太短')
    assert.ok(!full.content.startsWith('---'), '正文不应包含 frontmatter')
    assert.ok(full.content.includes('cocos_projects'), '正文应包含工具名示例')
  })

  await test('禁用表能挡住它（用户主动禁用后不再出现在候选里）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'disabled-'))
    const disabledFile = path.join(home, 'skills-disabled.json')
    fs.writeFileSync(disabledFile, JSON.stringify({ disabled: ['cocos-creator-mcp'] }))
    const filtered = new TaptapSkillProvider('game-forge', [{ dir: path.join(ROOT, 'skills'), rank: 360 }], {
      pinnedRoot: path.join(ROOT, 'skills'),
      disabledFile,
    })
    const list = await filtered.list()
    assert.equal(list.some((item) => item.name === 'cocos-creator-mcp'), false)
    // 但管理列表仍要能看到它（否则用户没法再启用）
    assert.equal(filtered.listAll().some((item) => item.name === 'cocos-creator-mcp'), true)
  })

  await test('frontmatter 名字符合 provider 的命名规则', async () => {
    const text = fs.readFileSync(SKILL_FILE, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    assert.ok(match, 'frontmatter 缺失或格式不对')
    const name = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim()
    assert.equal(name, 'cocos-creator-mcp')
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, '名字必须是小写连字符（否则 provider 直接跳过）')
    assert.equal(path.basename(SKILL_DIR), name, '目录名必须与 name 一致（否则同名覆盖/禁用表对不上）')
  })

  // ── 2. skill / 守则里引用的工具确实存在 ──────────────────────
  await test('skill 提到的每个 cocos_* 工具都真实存在', async () => {
    const text = fs.readFileSync(SKILL_FILE, 'utf8')
    const names = toolNamesIn(text)
    assert.ok(names.length > 0, 'skill 里没提到任何工具')
    const missing = names.filter((name) => !TOOL_INDEX.has(name))
    assert.deepEqual(missing, [], `skill 引用了不存在的工具：${missing.join('、')}`)
  })

  await test('skill 里的 action 取值都在对应工具的 enum 里', async () => {
    const text = fs.readFileSync(SKILL_FILE, 'utf8')
    const schemaActions = new Map()
    for (const [name, def] of TOOL_INDEX) {
      const enumValues = def.inputSchema?.properties?.action?.enum
      if (Array.isArray(enumValues)) schemaActions.set(name, new Set(enumValues))
    }
    const allActions = new Set([...schemaActions.values()].flatMap((set) => [...set]))
    const referenced = actionsIn(text)
    assert.ok(referenced.length > 0, 'skill 里没写 action=xxx 示例')
    const unknown = referenced.filter((action) => !allActions.has(action))
    assert.deepEqual(unknown, [], `skill 写了不存在的 action：${unknown.join('、')}`)
  })

  await test('守则文本里提到的工具也存在，且指向 skill', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'policy-'))
    fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: keep\n  name: x\n')
    upsertMcpRow({ dshHome: home, nodePath: process.execPath, hubPath: path.join(ROOT, 'src/cocos/server.mjs') })
    const text = cocosPolicyText(home)
    assert.ok(text.length > 100, '登记后守则应有内容')
    const missing = toolNamesIn(text).filter((name) => !TOOL_INDEX.has(name))
    assert.deepEqual(missing, [], `守则引用了不存在的工具：${missing.join('、')}`)
    assert.match(text, /cocos-creator-mcp/, '守则必须指向 skill 名，否则模型不会去加载它')
  })

  // ── 3. 注入按登记状态开关 ────────────────────────────────────
  await test('未登记 → 不注入；登记 → 注入（这是开关的唯一依据）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'toggle-'))
    fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true })
    const patch = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    fs.writeFileSync(patch, '- id: keep\n  name: x\n')
    assert.equal(cocosPolicyText(home), '', '未登记时必须返回空串（否则白白占 token）')
    upsertMcpRow({ dshHome: home, nodePath: process.execPath, hubPath: path.join(ROOT, 'src/cocos/server.mjs') })
    assert.ok(cocosPolicyText(home).includes('Cocos Creator'), '登记后必须注入')
    removeMcpRow({ dshHome: home })
    assert.equal(cocosPolicyText(home), '', '撤销登记后必须停止注入')
  })

  await test('patch 文件损坏/缺失时安全降级为空串（不抛错、不误注入）', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'broken-'))
    assert.equal(cocosPolicyText(home), '')
    fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'this is not yaml list')
    assert.equal(cocosPolicyText(home), '')
  })

  // ── 4. 工作流守则要认得 Cocos 这个引擎 ──────────────────────
  await test('workflow 守则的引擎判定包含 Cocos（否则会被当成网页项目）', async () => {
    const text = workflowPolicyText({ gptLaneOn: true, skillCount: 161, pluginDir: ROOT })
    assert.match(text, /Cocos Creator/, '引擎判定里必须出现 Cocos Creator')
    assert.match(text, /creator\.version/, '必须给出可机器判断的工程特征')
    assert.match(text, /cocos-creator-mcp|`cocos_\*`/, '必须指向 Cocos 的 skill 或工具')
    // 关键：Cocos 特征必须出现在「package.json 里有 pixi.js / 纯前端」之前，
    // 否则模型读到第一个匹配就按网页项目处理了。
    const cocosAt = text.indexOf('creator.version')
    const webAt = text.indexOf('pixi.js')
    assert.ok(cocosAt > 0 && webAt > 0)
    assert.ok(cocosAt < webAt, 'Cocos 判定必须排在网页判定之前（两者都有 package.json）')
  })

  await test('skill 路由目录里有 Cocos 条目，且指向真实 skill', async () => {
    const router = fs.readFileSync(path.join(ROOT, 'skills', 'taptap-skill-router', 'SKILL.md'), 'utf8')
    assert.match(router, /cocos-creator-mcp/, 'router 必须能路由到它')
    const list = await provider.list()
    for (const name of [...router.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)].map((m) => m[1])) {
      if (name.startsWith('cocos-') || name.startsWith('taptap-') || name.startsWith('godot-')) {
        assert.ok(list.some((item) => item.name === name), `router 引用了不存在的 skill：${name}`)
      }
    }
  })

  // ── 5. 命令入口（agent 不加载 skill 时的兜底） ──────────────
  await test('/game-cocos 帮助文本列出的子命令都真实可执行', async () => {
    const { runCocosCommand } = await load('src/cocos/command.mjs')
    const home = fs.mkdtempSync(path.join(tmpRoot, 'cmd-'))
    const help = await runCocosCommand('', { home, config: {} })
    assert.equal(help.kind, 'success')
    for (const sub of ['list', 'status', 'install', 'doctor', 'register', 'unregister', 'open', 'build']) {
      assert.ok(help.text.includes(sub), `帮助文本缺少子命令 ${sub}`)
    }
    // 未知子命令要给错误 + 用法，而不是静默成功
    const unknown = await runCocosCommand('nonsense', { home, config: {} })
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /未知子命令/)
  })

  // ── 6. host 侧的注入接线（源码级回归护栏） ──────────────────
  await test('index.js 仍按「登记才注入」挂 section，且 order 在工作流之后', async () => {
    const source = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
    assert.match(source, /import \{ cocosPolicyText \} from '\.\/src\/cocos\/policy\.mjs'/, '必须真的引用守则函数')
    assert.match(source, /name: 'game-forge:cocos'/, 'section 名字用于后续 dispose，不能改散')
    const orderMatch = /name: 'game-forge:cocos',\s*order: (\d+)/.exec(source)
    assert.ok(orderMatch, '找不到 cocos section 的 order')
    const cocosOrder = Number(orderMatch[1])
    const workflowOrder = Number(/name: 'game-forge:workflow',\s*order: (\d+)/.exec(source)?.[1] ?? 0)
    const creditOrder = Number(/name: 'game-forge:credit',\s*order: (\d+)/.exec(source)?.[1] ?? 0)
    assert.ok(cocosOrder > workflowOrder, 'cocos 守则要排在工作流之后')
    assert.ok(creditOrder < workflowOrder, '额度红线必须排在最前面（290 < 300）')
    // 空文本时不能挂 section（否则注入一段空标题）。
    assert.match(source, /if \(cocosText !== ''\)/, '必须按文本是否为空决定注不注入')
  })

  fs.rmSync(tmpRoot, { recursive: true, force: true })
  process.stdout.write(`\n通过 ${passed} 项，失败 ${failures.length} 项\n`)
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stdout.write(`\n[${failure.name}]\n${failure.error?.stack ?? failure.error}\n`)
    }
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exit(1)
})
