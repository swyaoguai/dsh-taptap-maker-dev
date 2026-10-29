// 端到端：统一生图入口按 lanes 分派到 zaiduyu；缺凭据时干净失败并可回退。
// 不联网、不扣任何积分（凭据缺失 → generate.py 在登录前就退出）。
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const imp = async (rel) => import(pathToFileURL(path.join(root, 'src', rel)).href)

const { writeLanes } = await imp('lanes.mjs')
const { generateImage } = await imp('taptap-gpt.mjs')

// 落盘配置用系统临时目录，不在仓库里留 .tmp-e2e-home。
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'))
const home = path.join(scratch, 'home')
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✓ ${label}`)
  else { console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); failed += 1 }
}

console.log('\n[E2E] lanes 排序 → 统一入口分派（章鱼通道）')

// 场景 1：只有 zaiduyu 开着（autoFallback 关）→ 应该尝试 zaiduyu，因缺凭据失败，
// 且**不会**擅自切到别的通道（开关全关着/没开 autoFallback）。
writeLanes(home, {
  autoFallback: false,
  groups: {
    image: { order: ['zaiduyu', 'gptWeb', 'relayImage'], enabled: { zaiduyu: true, gptWeb: false, relayImage: false } },
  },
})
delete process.env.ZAIDUYU_USER
delete process.env.ZAIDUYU_PASS
const r1 = await generateImage(home, '测试图', {
  relayReady: () => true,
  zaiduyuReady: () => true, // 假装脚本/python 在，只让凭据缺失真实暴露
})
ok(r1.ok === false, '场景1：缺账号 → 不谎报成功')
// 凭据改成设置页 GUI 登录后，缺凭据的报错必须把用户**指向设置页**，
// 而不是继续让他去开终端配环境变量（口径分裂会让人白折腾一次）。
ok(/设置页/.test(String(r1?.hint ?? '')) && /登录并保存/.test(JSON.stringify(r1)),
  '场景1：错误里指引去设置页登录保存', JSON.stringify(r1).slice(0, 240))
ok(!/relayImage.*generated/.test(JSON.stringify(r1)), '场景1：autoFallback 关着，没有偷偷换通道')

// 场景 2：打开的是额度回退，不是任意错误重投。缺凭据仍停在章鱼，
// 未配置的 relay 也不应参与；实际额度拒收的回退由 runtime regressions 覆盖。
writeLanes(home, {
  autoFallback: true,
  groups: {
    image: { order: ['zaiduyu', 'relayImage'], enabled: { zaiduyu: true, relayImage: true } },
  },
})
const r2 = await generateImage(home, '测试图', {
  relayOpts: { dshHome: home, prompt: '测试图', out: path.join(home, 'x.png') },
  relayReady: () => false,
  zaiduyuReady: () => true,
})
ok(r2.ok === false, '场景2：缺凭据如实失败')
ok(r2.lane === 'zaiduyu', '场景2：按用户排序尝试章鱼', String(r2.lane))
ok(r2.rotatedLanes === false, '场景2：非额度错误不会偷偷换通道')
ok(/设置页/.test(r2.hint ?? ''), '场景2：保留明确登录指引')

// 场景 3：zaiduyu 关掉 → ready 表再真也不进候选（逐条开关算数）。
// 这里只验候选序列、不调 generateImage：否则会把 gptWeb 排进链并真起浏览器。
const { laneOrder } = await imp('lanes.mjs')
writeLanes(home, { groups: { image: { enabled: { zaiduyu: false } } } })
const seq3 = laneOrder(home, 'image')
ok(!seq3.includes('zaiduyu'), '场景3：关掉的章鱼通道不参与（开关与行为一致）', seq3.join('>'))

try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(failed === 0 ? '\n结果：全部通过' : `\n结果：${failed} 项失败`)
process.exitCode = failed > 0 ? 1 : 0
