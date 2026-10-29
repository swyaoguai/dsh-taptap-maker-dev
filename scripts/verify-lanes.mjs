/**
 * 通道优先级 / 开关 / 额度回退 的离线自测（不联网、不花任何额度）。
 *
 * 覆盖：
 *   1. 归一化：脏数据 / 旧文件 / 未知通道 id 都不能破坏配置；
 *   2. 不变量：不能把所有通道关成空集；
 *   3. 额度错误识别：三条链路的原始报错文本都要能认出来；
 *   4. 回退执行器：开关关着就不回退、全失败要汇总原因、成功要报告是哪条通道。
 *
 * 用法：node scripts/verify-lanes.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GROUPS, LANE_GROUPS, fallbackCandidates, laneOrder, quotaSignal,
  readLanes, runWithFallback, writeLanes,
} from '../src/lanes.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-lanes-'))
console.log(`临时目录：${scratch}`)
const home = path.join(scratch, 'home')

console.log('\n[1] 默认值（必须与改造前的实际行为一致）')
{
  const cfg = readLanes(home)
  ok(cfg.autoFallback === false, '自动回退默认关 —— 不擅自动用用户的付费通道')
  ok(cfg.groups.video.order.join('>') === 'relay>minimax>local', '视频默认顺序 relay > minimax > local', cfg.groups.video.order.join('>'))
  ok(cfg.groups.image.order.join('>') === 'gptWeb>relayImage>zaiduyu', '生图默认顺序 网页 > 中转站 > 章鱼', cfg.groups.image.order.join('>'))
  ok(GROUPS.every((g) => cfg.groups[g].order.length === LANE_GROUPS[g].lanes.length), '每组通道一个不少')
}

console.log('\n[2] 排序与开关')
{
  writeLanes(home, { groups: { video: { order: ['minimax', 'local', 'relay'] } } })
  ok(laneOrder(home, 'video').join('>') === 'minimax>local>relay', '重排生效')

  writeLanes(home, { groups: { video: { enabled: { relay: false } } } })
  ok(laneOrder(home, 'video').join('>') === 'minimax>local', '关掉中转站后不再出现在候选里')

  // 不变量：不能全关
  writeLanes(home, { groups: { video: { enabled: { relay: false, minimax: false, local: false } } } })
  const after = readLanes(home).groups.video
  ok(after.order.some((id) => after.enabled[id]), '全部关掉时至少保留一条（不会把自己锁死）')
}

console.log('\n[3] 脏数据归一化')
{
  // 模拟磁盘上被手改坏的 lanes.json
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path.join(home, 'taptap-maker-dev', 'lanes.json'), JSON.stringify({
    autoFallback: 'yes',
    groups: {
      video: { order: ['relay', 'relay', '不存在的通道', 42], enabled: { relay: false, minimax: false, local: false, 幽灵: true } },
      image: null,
    },
  }), 'utf8')
  const cfg = readLanes(home)
  ok(cfg.autoFallback === false, 'autoFallback 不是布尔值时按关处理')
  ok(cfg.groups.video.order.length === new Set(cfg.groups.video.order).size, '重复 id 被去重')
  ok(!cfg.groups.video.order.includes('不存在的通道') && !cfg.groups.video.order.includes(42), '未知通道被丢弃')
  ok(cfg.groups.video.order.length === 3, '缺失的通道被补回', cfg.groups.video.order.join('>'))
  ok(cfg.groups.video.order.some((id) => cfg.groups.video.enabled[id]), '脏数据里全 false 也仍保留一条可用')
  ok(cfg.groups.image.order.length === 3, 'groups.image 为 null 时回落到默认', cfg.groups.image.order.join('>'))

  writeFileSync(path.join(home, 'taptap-maker-dev', 'lanes.json'), '{ 这不是 JSON', 'utf8')
  ok(readLanes(home).groups.video.order.length === 3, '文件损坏时不抛异常，退回默认')
}

console.log('\n[4] 额度错误识别（三条链路的原始文本）')
{
  ok(quotaSignal({ status: 402 }) === 'insufficient_balance', 'HTTP 402')
  ok(quotaSignal(new Error('{"status_code":1008,"insufficient balance"}')) === 'minimax_1008', 'MiniMax 1008')
  ok(quotaSignal(new Error('insufficient_balance_error')) === 'insufficient_balance', 'snake_case insufficient_balance')
  ok(quotaSignal(new Error('积分不足，请购买积分')) === 'credit_exhausted', '网页 BGM 中文提示')
  ok(quotaSignal(new Error('你已达到上限')) === 'quota_reached', 'ChatGPT 网页中文提示')
  // 「今日免费额度已用完」是 ChatGPT 免费档的真实横幅（2026-10-24 报障）：
  // 之前关键词表匹配不上它 → 账号不轮换、通道不回退。锁进测试防回归。
  ok(quotaSignal(new Error('今日免费额度已用完，明天再来吧')) === 'credit_exhausted', 'ChatGPT「今日免费额度已用完」横幅')
  ok(quotaSignal(new Error('免费额度已用完')) === 'credit_exhausted', '「免费额度已用完」简写')
  ok(quotaSignal(new Error('Rate limit reached')) === 'quota_reached', 'rate limit')
  ok(quotaSignal({ status: 429, message: 'too many requests' }) === 'rate_limited', '429 + too many requests')
  ok(quotaSignal(new Error('提示词为空')) === null, '普通错误不被误判成额度问题')
  ok(quotaSignal(undefined) === null, 'undefined 安全')
}

console.log('\n[5] 回退执行器')
{
  const describe = (e) => e?.message ?? String(e)
  let seq = []
  const okAll = await runWithFallback(['a', 'b', 'c'], async (id) => { seq.push(id); return `via-${id}` }, describe)
  ok(okAll.ok && okAll.lane === 'a' && okAll.value === 'via-a', '第一条成功就不往下走')
  ok(seq.join(',') === 'a', '没有多余调用')

  seq = []
  const second = await runWithFallback(['a', 'b'], async (id) => {
    seq.push(id)
    if (id === 'a') throw new Error('quota')
    return 'via-b'
  }, describe)
  ok(second.ok && second.lane === 'b', '第一条失败后换到第二条')
  ok(seq.join(',') === 'a,b', '按顺序试，没有乱序或跳过')

  const none = await runWithFallback([], async () => 'x', describe)
  ok(!none.ok && none.reason === 'no_lane_enabled', '没有候选时如实报告')

  const all = await runWithFallback(['a', 'b'], async (id) => { throw new Error(`炸了-${id}`) }, describe)
  ok(!all.ok && all.attempts.length === 2, '全部失败时记录每条通道')
  ok(all.attempts[0].lane === 'a' && /炸了-a/.test(all.attempts[0].reason), '失败记录带上通道 id 与原因，界面能逐条显示')
}

console.log('\n[6] 候选序列 = 开关 + 顺序 + 就绪判断')
{
  // 用一个干净目录：writeLanes 是「合并」语义，继承上一节状态才是真实行为。
  const clean = path.join(scratch, 'home2')
  writeLanes(clean, {
    autoFallback: true, // 回退总开关要先开，下面两条才谈得上「候选」
    groups: {
      video: { order: ['minimax', 'relay', 'local'], enabled: { minimax: true, relay: true, local: true } },
      image: { enabled: { gptWeb: true, relayImage: true } },
    },
  })
  ok(fallbackCandidates(clean, 'video', () => true).join('>') === 'minimax>relay', '按顺序、且排除 local（需手动挑文件）')
  ok(fallbackCandidates(clean, 'video', (id) => id === 'minimax').join('>') === 'minimax', '未就绪的通道被跳过')

  writeLanes(clean, { groups: { video: { enabled: { relay: false } } } })
  ok(!fallbackCandidates(clean, 'video', () => true).includes('relay'), '关掉的通道不进候选')

  writeLanes(clean, { autoFallback: false })
  ok(fallbackCandidates(clean, 'video', () => true).length === 0, '总开关关着 → 不回退（只用第一条）')
  writeLanes(clean, { autoFallback: true })
  ok(fallbackCandidates(clean, 'video', () => true).length > 0, '总开关打开 → 可以回退')

  // 只开着 local 时，auto 不该有可提交的通道，但 local 仍留在开关里（用户手动用）。
  writeLanes(clean, { groups: { video: { order: ['local', 'relay', 'minimax'], enabled: { local: true, relay: false, minimax: false } } } })
  ok(laneOrder(clean, 'video').join('>') === 'local', '只开 local → 候选序列就是它')
  ok(fallbackCandidates(clean, 'video', () => true).length === 0, '但 local 不作为自动回退候选（要用户手动挑文件）')
}

console.log('\n[7] 逐条开关被命令层尊重 + 统一入口已接线（源码契约）')
{
  // [Bug 2026-10-24] 两套开关曾脱节：设置页「生成通道」卡关掉 gptWeb 后，
  // /taptap-gpt 只读 imageLane.json 总开关照样弹浏览器。锁死三个契约：
  //   1. generateWithRotation 同时检查 lanes 逐条开关；
  //   2. /taptap-image 入口检查 relayImage 逐条开关；
  //   3. /taptap-gpt 生图路径走统一入口 generateImage（autoFallback 才有入口）。
  // 相对 cwd 的路径在别的工作目录跑会 ENOENT —— 用脚本自身位置定位仓库文件。
  const here = path.dirname(fileURLToPath(import.meta.url))
  const gpt = readFileSync(path.join(here, '..', 'src', 'taptap-gpt.mjs'), 'utf8')
  const rot = /export async function generateWithRotation[\s\S]*?\n\}/.exec(gpt)?.[0] ?? ''
  ok(rot.includes("isLaneEnabled(dshHome, 'image', 'gptWeb')"), 'generateWithRotation 检查 image/gptWeb 逐条开关')
  const idx = readFileSync(path.join(here, '..', 'index.js'), 'utf8')
  ok(/relayImageLaneEnabled\(home\)/.test(idx), '/taptap-image 入口检查 relayImage 逐条开关')
  ok(/gptGenerateImage\(home, prompt/.test(idx), '/taptap-gpt 生图走统一入口 generateImage（含 autoFallback 回退）')

  // 章鱼生图（积分站）接入统一入口：ready 判断 + 命令层开关都要算数，
  // 否则就是「设置页能排它、实际永远走不到」（历史上 relay 回退踩过同样的坑）。
  ok(/zaiduyu: \(\) =>/.test(gpt), 'generateImage 的 ready 表里有 zaiduyu')
  ok(/laneId === 'zaiduyu'/.test(gpt), 'generateImage 的分派里有 zaiduyu 分支')
  ok(/zaiduyuReady/.test(idx) && /zaiduyuLaneEnabled\(home\)/.test(idx), '/taptap-gpt 入口传了 zaiduyu 就绪判断与逐条开关')
  ok(/zaiduyu: '需要在下面「章鱼生图/.test(idx), '未配置时给界面一句「去哪儿填账号」')
}

try { rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)