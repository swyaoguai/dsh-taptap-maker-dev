/**
 * 本轮 bug 修复的防回归测试（离线，不联网、不花任何额度）。
 *
 * 每个用例都对应一个真实存在过的缺陷：
 *  1. `--ref` 重复传只保留最后一个 —— 用户以为做了多图合成，实际前面的图被**静默丢弃**。
 *     文档与守则都写明「--ref 可重复」，而解析端用赋值覆盖。
 *  2. 提示词不带引号时 `-n 2` / `--seed 7` / `--out x.wav` 原样混进英文提示词
 *     发给模型（模型会把 "-n 2" 当成声音描述）；`--project` 写在前面时那条
 *     贪婪 `.*` 正则会把整句吞成空提示词。
 *  3. 缺 Python 时 `check` 的输出里没有「不建议」，旧判定会算成**可用**，
 *     用户一路跑到生成才撞上更晚、更难懂的错。
 *  4. 提示词作为位置参数放在 flag 之前，万一它以 `-` 开头会被 argparse
 *     当未知 flag 报错 —— 必须 `--` 收尾。
 *  5. `--key=value` 连写、负数值、漏值：四条链路各写一套判断，同一句话
 *     在不同链路上结果不同（统一走 tokens.mjs 的 flagOf / looksLikeFlag）。
 *  6. /taptap-gpt 的 `--ref` 漏值会把下一个 flag 名当参考图，其值泄漏进提示词。
 *
 * 用法：node scripts/verify-cli-parsing.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const imp = async (rel) => import(pathToFileURL(path.join(root, 'src', rel)).href)

const z = await imp('taptap-zaiduyu.mjs')
const g = await imp('taptap-gpt.mjs')
const s = await imp('taptap-sfx.mjs')

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

console.log('\n[1] 重复 --ref 必须累积（章鱼通道）')
{
  const args = z.parseArgs(['gen', '--prompt', 'x', '--ref', 'a.png', '--ref', 'b.png', '--ref', 'c.png'])
  const refs = z.collectReferences(args)
  ok(refs.length === 3, '三张 --ref 全部收到', JSON.stringify(refs))
  ok(refs.join(',') === 'a.png,b.png,c.png', '顺序保留（首张是主图，顺序有语义）', refs.join(','))

  // 逗号分隔也要吃（用户手写多图的常见形式）
  const csv = z.collectReferences(z.parseArgs(['gen', '--ref', 'a.png,b.png']))
  ok(csv.length === 2, '逗号分隔收成两张', JSON.stringify(csv))

  // 非参考图键必须保持「后者覆盖」：重复传 --prompt 若被收成数组会破坏下游
  const single = z.parseArgs(['gen', '--prompt', 'one', '--prompt', 'two'])
  ok(!Array.isArray(single.prompt), '非参考图键不被累积成数组', JSON.stringify(single.prompt))

  // generate() 消费端与 CLI 收集端用的是同一份逻辑（两处口径不能分裂）
  ok(typeof z.collectReferences === 'function', '收集器是导出的单一实现（不是各写一份）')
}

console.log('\n[2] 网页通道 CLI 同样累积')
{
  const args = g.parseCliArgs(['gen', '--prompt', 'x', '--ref', 'a.png', '--ref', 'b.png'])
  ok(Array.isArray(args.ref) && args.ref.length === 2, '--ref 重复传收成数组', JSON.stringify(args.ref))
  const acct = g.parseCliArgs(['gen', '--account', 'a1', '--account', 'a2'])
  ok(acct.account === 'a2' && !Array.isArray(acct.account), '普通键仍是覆盖语义（不会把账号变成数组）')
}

console.log('\n[3] sfx 解析：flag 不漏进提示词，位置不被顺序绑架')
{
  const cases = [
    ['sword swing whoosh -n 2', 'sword swing whoosh', { variants: '2' }],
    ['metallic clang --seed 7', 'metallic clang', { seed: '7' }],
    ['whoosh --out my.wav', 'whoosh', { out: 'my.wav' }],
    ['laser zap --steps 150', 'laser zap', { steps: '150' }],
    ['deep rumble --cfg 6', 'deep rumble', { cfg: '6' }],
    // --project 写在提示词前面：旧的正则链带贪婪 .*，会把整句吞掉。
    ['--project D:/p whoosh --seed 7', 'whoosh', { project: 'D:/p', seed: '7' }],
    ['"coin pickup" --project "D:/my proj" -s 2', 'coin pickup', { project: 'D:/my proj', seconds: '2' }],
    ['--prompt sword swing', 'sword swing', {}],
  ]
  for (const [input, wantPrompt, want] of cases) {
    const got = s.parseGenArgs(input)
    ok(got.prompt === wantPrompt, `提示词干净：${input}`, `实际 ${JSON.stringify(got.prompt)}`)
    for (const [k, v] of Object.entries(want)) {
      ok(got[k] === v, `  ${k}=${v}`, `实际 ${JSON.stringify(got[k])}`)
    }
  }

  // 摘掉的每个 flag 都必须被转发，否则「写了却静默失效」。
  // 这里锁住字段集合：以后加新 flag 时若忘了同步转发，这条会先响。
  const all = s.parseGenArgs('whoosh --project p -s 1 -n 2 --seed 3 --steps 4 --cfg 5 --out o.wav --lowvram')
  for (const k of ['project', 'seconds', 'variants', 'seed', 'steps', 'cfg', 'out', 'lowvram']) {
    ok(all[k] !== '' && all[k] !== undefined, `解析器认识并摘出 --${k}`, JSON.stringify(all[k]))
  }
  ok(all.prompt === 'whoosh', '所有 flag 都摘干净后只剩提示词', JSON.stringify(all.prompt))

  // 未知 flag 保留在提示词里（交给下游报错），而不是被静默丢弃
  const unknown = s.parseGenArgs('whoosh --no-such-flag')
  ok(unknown.prompt.includes('whoosh'), '未知 flag 不影响提示词', unknown.prompt)
}

console.log('\n[4] 原子 token 路径：带空格的路径不能被拆坏')
{
  const r = s.consumeGenFlags(['sword', 'swing', '--project', 'D:\\my proj', '-s', '2'])
  ok(r.project === 'D:\\my proj', '带空格的 --project 值完整保住', JSON.stringify(r.project))
  ok(r.prompt === 'sword swing', '提示词按原子 token 拼回', JSON.stringify(r.prompt))
  ok(r.seconds === '2', '后续 flag 照常解析')
}

console.log('\n[5] 硬件体检：没跑成功 ≠ 可用（缺 Python 必须劝退）')
{
  const noPy = s.parseSfxCheck({ code: -1, stdout: '', stderr: '未找到可用的 Python 3（本功能需要 python 3.10+）' })
  ok(noPy.ran === false, 'check 没真跑成功时标 ran=false')
  ok(noPy.usable === false, '缺 Python 判为不可用（旧写法会因「没有『不建议』」判成可用）')

  const good = s.parseSfxCheck({ code: 0, stdout: 'GPU         : RTX 4060 Ti, 8 GB\n结论        : 可以跑 Stable Audio Open', stderr: '' })
  ok(good.ran === true && good.usable === true, '正常体检判为可用')

  const weak = s.parseSfxCheck({ code: 0, stdout: 'GPU         : UHD 630\n结论        : 不建议：显存不足', stderr: '' })
  ok(weak.ran === true && weak.usable === false, '显存不足判为不可用')

  const nogpu = s.parseSfxCheck({ code: 0, stdout: 'GPU         : 未检测到 NVIDIA GPU\n结论        : 本方案需要 NVIDIA 显卡', stderr: '' })
  ok(nogpu.usable === false, '无独显判为不可用')
}

console.log('\n[6] 给 Python 的 argv：提示词必须排在 `--` 之后')
{
  // 直接打真实实现（buildGenArgv）—— generate() 用的就是它，测它才算数。
  const a = s.buildGenArgv('gen.py', '- 号开头的怪提示词', { outDir: 'out' })
  ok(a[a.length - 1] === '- 号开头的怪提示词', '提示词在最后一位（-- 之后），不会被 argparse 当 flag')
  ok(a.includes('--'), 'argv 里有 `--` 分隔符')
  ok(a.indexOf('--') > a.indexOf('-o'), '分隔符在所有 flag 之后')
  const b = s.buildGenArgv('g.py', 'normal', { outDir: 'o', lowvram: true })
  ok(b.includes('--lowvram') && b[b.length - 1] === 'normal', 'lowvram=true 透传 --lowvram')
  const c = s.buildGenArgv('g.py', 'normal', { outDir: 'o', lowvram: false })
  ok(c.includes('--no-lowvram'), 'lowvram=false 透传 --no-lowvram')
  const d = s.buildGenArgv('g.py', 'normal', { outDir: 'o' })
  ok(!d.includes('--lowvram') && !d.includes('--no-lowvram'), '未指定时不传，交给脚本自动判断')
  // 数值必须全部转成字符串：spawn 传非字符串会直接抛错。
  ok(d.every((x) => typeof x === 'string'), 'argv 全为字符串', JSON.stringify(d.filter((x) => typeof x !== 'string')))
}

console.log('\n[7] 章鱼通道：flag 不漏进中文提示词、且全部转发')
{
  const cases = [
    // 这三个是本轮真实修掉的漏项：以前没进剥离清单，会原样混进提示词。
    ['小猫赏月 --size 2048x2048', { prompt: '小猫赏月', size: '2048x2048' }],
    ['小猫赏月 --quality high', { prompt: '小猫赏月', quality: 'high' }],
    ['小猫赏月 --description 猫', { prompt: '小猫赏月', description: '猫' }],
    ['小猫赏月 --model gpt-image-2 --ratio 16:9', { prompt: '小猫赏月', model: 'gpt-image-2', ratio: '16:9' }],
    ['小猫赏月 --resolution 2K --n 3', { prompt: '小猫赏月', resolution: '2K', n: '3' }],
    ['小猫赏月 --ref a.png --ref b.png', { prompt: '小猫赏月', references: ['a.png', 'b.png'] }],
    ['小猫赏月 --ref "a.png,b.png"', { prompt: '小猫赏月', references: ['a.png', 'b.png'] }],
    // --project 类「flag 在前」的写法不能被吞掉整句
    ['--model gpt-image-2 小猫赏月', { prompt: '小猫赏月', model: 'gpt-image-2' }],
    // 带空格的值靠引号保住
    ['"月亮 上的 猫" --model x', { prompt: '月亮 上的 猫', model: 'x' }],
  ]
  for (const [input, want] of cases) {
    const got = z.extractGenArgs(input)
    ok(got.prompt === want.prompt, `提示词干净：${input}`, `实际 ${JSON.stringify(got.prompt)}`)
    for (const [k, v] of Object.entries(want)) {
      if (k === 'prompt') continue
      const same = Array.isArray(v) ? JSON.stringify(got[k]) === JSON.stringify(v) : got[k] === v
      ok(same, `  ${k} 解析正确`, JSON.stringify(got[k]))
    }
  }

  // flag 表必须覆盖上游 generate.py 的全部可传参数 —— 少列一个就是静默污染提示词。
  const all = z.extractGenArgs('x --model m --ratio 1:1 --size 1x1 --resolution 1K --quality low --n 2 --description d --ref r.png')
  for (const k of ['model', 'ratio', 'size', 'resolution', 'quality', 'n', 'description']) {
    ok(all[k] !== '', `解析器认识 --${k}`, JSON.stringify(all[k]))
  }
  ok(all.references.length === 1, '解析器认识 --ref')
  ok(all.prompt === 'x', '全部 flag 摘干净后只剩提示词', JSON.stringify(all.prompt))

  // 解析出来的值必须真能走到 generate() 的参数里（转发契约，靠源码锁）
  const idxSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  const call = /const r = await zaiduyuGenerate\(home, gen\.prompt,\s*\{[\s\S]*?\n\s*\}\)/.exec(idxSrc)?.[0] ?? ''
  ok(call.length > 0, '命令层用共享解析器调用 generate()（不再是手写正则）')
  for (const k of ['model', 'ratio', 'size', 'resolution', 'quality', 'description', 'references']) {
    ok(call.includes(`gen.${k}`), `命令层把解析出的 ${k} 转发给 generate()`, call.slice(0, 100))
  }
  // 上游 generate() 也得真的把这些拼进 argv
  const zsrc = fs.readFileSync(path.join(root, 'src', 'taptap-zaiduyu.mjs'), 'utf8')
  const genBody = /export async function generate[\s\S]*?\n\}\n/.exec(zsrc)?.[0] ?? ''
  ok(genBody.includes("'--size'"), 'generate() 会把 size 下发给脚本')
  ok(genBody.includes("'--quality'"), 'generate() 会把 quality 下发给脚本')
  ok(genBody.includes("'--description'"), 'generate() 会把 description 下发给脚本')
}

console.log('\n[8] 参考图路径：`~` 必须按上游规则展开（否则误杀合法输入）')
{
  const homeDir = os.homedir()
  ok(z.expandUser('~') === homeDir, '裸 ~ 展开成家目录', z.expandUser('~'))
  ok(z.expandUser('~/Desktop/a.png') === path.join(homeDir, 'Desktop', 'a.png'), '~/x 展开（上游用 Path.expanduser）', z.expandUser('~/Desktop/a.png'))
  ok(z.expandUser('~\\Desktop\\a.png') === path.join(homeDir, 'Desktop', 'a.png'), 'Windows 反斜杠写法也展开')
  ok(z.expandUser('D:/tmp/a.png') === 'D:/tmp/a.png', '普通绝对路径不动')
  ok(z.expandUser('./a.png') === './a.png', '相对路径不动')
  ok(z.expandUser('~other/x') === '~other/x', '~user 形式不乱猜（交给上游报错）')

  // Existence checks use an existing directory. Never overwrite/delete a
  // fixed probe filename in the user's home just to test path expansion.
  ok(fs.existsSync(z.expandUser('~/.')), '~/ 展开后的既有目录不会被误判为不存在')
}

console.log('\n[9] `--key=value` 连写与负数值：四条链路必须同一语义（对齐 Python argparse）')
{
  const tk = await imp('tokens.mjs')
  ok(tk.flagOf('--seed=-1').inline === '-1', 'flagOf 读出内联值', JSON.stringify(tk.flagOf('--seed=-1')))
  ok(tk.flagOf('-m=gpt').name === 'm' && tk.flagOf('-m=gpt').inline === 'gpt', '短开关的等号形式也认')
  ok(tk.flagOf('--desc=a=b').inline === 'a=b', '只切第一个 =（值里可再含 =）')
  ok(tk.flagOf('x=y') === null, '不带前导 - 的 x=y 不是开关（不误伤提示词）')
  ok(tk.looksLikeFlag('-1') === false, '负数不是 flag（--seed -1 的 -1 是值）')
  ok(tk.looksLikeFlag('-') === false && tk.looksLikeFlag('--') === false, '单独的 - 与 -- 不是 flag')

  // ⚠️ normalizeEquals 必须产出**键名**（`--key`），不能是原始 token。
  // 曾经这里 push 了 f.raw，于是消费端 slice(2) 得到的键名变成 `prompt=x`、
  // 值才是 x —— 参数名整个错掉，而且"看起来有值"不会报错（实测抓到）。
  const ne = tk.normalizeEquals(['--prompt=x', '--ref=a.png', 'plain', '--n'])
  ok(ne[0] === '--prompt' && ne[1] === 'x', '展开出的是键名而不是 --prompt=x 整串', JSON.stringify(ne))
  ok(!ne.includes('--prompt=x'), '展开结果里不留原始 token', JSON.stringify(ne))

  // 内联值不能吞掉下一个 token（实测曾把 --ref 整条丢掉）。
  const zd = z.parseArgs(['gen', '-m=zap', '--ref=a.png'])
  ok(zd.m === 'zap' && zd.ref === 'a.png', 'CLI：内联值与后续参数同时生效', JSON.stringify(zd))
  const zd2 = z.parseArgs(['gen', '--seed', '-1'])
  ok(zd2.seed === '-1', 'CLI：负数按值处理', JSON.stringify(zd2))

  // 三条链路对同一句话必须给同样结果（历史上各写一套判断，结果不同）。
  const hostSeed = s.parseGenArgs('whoosh --seed -1')
  ok(hostSeed.seed === '-1' && hostSeed.prompt === 'whoosh', 'sfx 宿主：--seed -1 不混进提示词', JSON.stringify(hostSeed))
  const zdHost = z.extractGenArgs('猫 --n -1')
  ok(zdHost.n === '-1' && zdHost.prompt === '猫', 'zaiduyu 宿主：--n -1 不混进提示词', JSON.stringify(zdHost))
  const gptNeg = g.parseCliArgs(['gen', '--seed', '-1'])
  ok(gptNeg.seed === '-1', 'gpt CLI：同一语义', JSON.stringify(gptNeg))

  // 等号形式的意义就是「允许值看起来像 flag」。
  const dashVal = z.extractGenArgs('猫 --model=-fast')
  ok(dashVal.model === '-fast' && dashVal.prompt === '猫', '宿主：--model=-fast 保住值', JSON.stringify(dashVal))

  // 漏值必须**报告**，不能静默用默认参数 —— 积分通道里这意味着按别的计费出图。
  const miss = z.extractGenArgs('猫 --model')
  ok(miss.missing.length === 1 && miss.missing[0] === '--model', '宿主：漏值被报告', JSON.stringify(miss.missing))
  ok(miss.model === '', '漏值时不会把 true 塞成参数值')

  // `--` 之后按位置参数处理（与 argparse 一致）。
  const dd = s.parseGenArgs('whoosh -- -n 2')
  ok(dd.variants === '' && dd.prompt.includes('-n 2'), '宿主：`--` 之后的 flag 不再解析', JSON.stringify(dd))
}

console.log('\n[10] /taptap-gpt 斜杠命令：--ref 漏值不再吞掉下一个 flag')
{
  // 旧写法的实测结果（本轮修掉的真实缺陷）：
  //   refs = ["--account"]，提示词 = "a2 画一只猫"
  //   —— 网页通道会去上传一个不存在的路径，而**账号 id 混进了发给 ChatGPT 的描述**。
  const r = g.parseSlashGenArgs('--ref --account a2 画一只猫')
  ok(r.refs.length === 0, '漏值的 --ref 不被填成下一个 flag 名', JSON.stringify(r.refs))
  ok(!r.refs.some((x) => String(x).startsWith('-')), '参考图列表里没有 flag 名')
  ok(r.account === 'a2', '后面的 --account 照常解析出来', JSON.stringify(r.account))
  ok(r.prompt === '画一只猫', '账号 id 没有泄漏进提示词', JSON.stringify(r.prompt))
  ok(r.missing.length === 1 && r.missing[0] === '--ref', '漏值被报告给命令层拒绝提交', JSON.stringify(r.missing))

  // 正常形态不能因为这次改造而退化。
  const ok1 = g.parseSlashGenArgs('改成水彩风 --ref 角色.png --downscale 128x128')
  ok(ok1.prompt === '改成水彩风' && ok1.refs.join() === '角色.png' && ok1.downscale === '128x128',
    '常规用法仍正确', JSON.stringify(ok1))
  const ok2 = g.parseSlashGenArgs('-r a.png -r b.png 猫')
  ok(ok2.refs.length === 2, '短别名 -r 可重复累积（斜杠命令对外承诺支持）', JSON.stringify(ok2.refs))
  const ok3 = g.parseSlashGenArgs('--ref=a.png --account=x 猫')
  ok(ok3.refs.join() === 'a.png' && ok3.account === 'x' && ok3.prompt === '猫', '等号连写也支持')
  const ok4 = g.parseSlashGenArgs('画一只 猫')
  ok(ok4.prompt === '画一只 猫' && ok4.refs.length === 0, '纯描述不受影响')

  // 命令层必须真的消费 missing（否则报告了也没用）。
  const idxSrc2 = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  ok(/genArgs\.missing\.length > 0/.test(idxSrc2), '/taptap-gpt 命令层拒绝带漏值提交（不消耗额度）')
  ok(/gen\.missing/.test(idxSrc2), '/taptap-zaiduyu 命令层拒绝带漏值提交（不扣积分）')
}

console.log('\n[11] 参数校验必须先于环境/凭据校验，且张数不许静默改')
{
  // `--n 99` 若被 Math.min 钳成 12，用户会拿到 12 张并付出 12 倍积分，
  // 却以为自己只要了 1 张 —— 静默改参数在付费通道里比报错糟得多。
  const cases = [['n=99', 99], ['n=0', 0], ['n=-1', -1], ['n=abc', 'abc'], ['n=1.5', 1.5]]
  for (const [label, value] of cases) {
    let code = null
    try { await z.generate(path.join(root, '.nohome'), 'x', { n: value }) } catch (e) { code = e.code }
    ok(code === 'invalid_count', `generate() 拒绝非法张数（${label}）而不是静默钳制`, String(code))
  }
  // 值被解析成布尔 true 时不能当参数提交（String(true) === "true" 会变成模型名）。
  let mv = null
  try { await z.generate(path.join(root, '.nohome'), 'x', { model: true }) } catch (e) { mv = e.code }
  ok(mv === 'missing_value', 'generate() 拒绝 --model 的 true 值（不会把 "true" 当模型名提交）', String(mv))
  // 校验顺序：先参数、后凭据 —— 本机此刻没有站点凭据，
  // 所以「参数对」应报 no_credentials、「参数错」应报参数错。两者都能到达即顺序正确。
  let credCode = null
  try { await z.generate(path.join(root, '.nohome'), 'x', { n: 3 }) } catch (e) { credCode = e.code }
  ok(credCode === 'no_credentials', '合法参数才会继续走到凭据检查（顺序正确）', String(credCode))
}

console.log('\n[12] /taptap-image：--transparent 等漏项与「转发但下游不读」')
{
  const img = await imp('taptap-image.mjs')
  ok(typeof img.parseSlashArgs === 'function', '命令层解析器已导出（单一 spec 表，不在 index.js 里再抄一份）')

  // 实测过的旧缺陷：--transparent 既不剥掉也不转发 → 字面量进了提示词、透明底没生效。
  const t = img.parseSlashArgs('盾牌图标 --transparent')
  ok(t.prompt === '盾牌图标' && t.transparent === true, '--transparent 被剥掉且可转发', JSON.stringify(t))

  const eq = img.parseSlashArgs('盾牌图标 --size=512x512')
  ok(eq.size === '512x512' && eq.prompt === '盾牌图标', '等号连写不再整段留在提示词里', JSON.stringify(eq))

  // --ref 漏值：旧写法会把下一个 flag 名当参考图，其值漏进提示词。
  const miss = img.parseSlashArgs('改成赛博朋克风 --ref --size 512x512')
  ok(miss.missing.length === 1 && miss.refs.length === 0, '漏值被报告、不吞下一个 flag 名', JSON.stringify(miss))
  ok(!miss.prompt.includes('512x512'), '孤立值没有泄漏进提示词', JSON.stringify(miss.prompt))

  const multi = img.parseSlashArgs('猫 --ref a.png --ref b.png --multi-ref')
  ok(multi.refs.join() === 'a.png,b.png' && multi.multiRef === true, '重复 --ref 累积 + 布尔开关', JSON.stringify(multi))
  const csv = img.parseSlashArgs('盾牌图标 --ref 角色.png,服装.png')
  ok(csv.refs.length === 2, '逗号分隔展开', JSON.stringify(csv.refs))
  const short = img.parseSlashArgs('图标 -s 1024x1024 -d 128x128 -r a.png')
  ok(short.size === '1024x1024' && short.downscale === '128x128' && short.refs.join() === 'a.png', '短别名 -s/-d/-r 照常支持')
  const plain = img.parseSlashArgs('扁平图标 居中留白')
  ok(plain.prompt === '扁平图标 居中留白' && plain.refs.length === 0, '纯描述不受影响')

  // ⚠️ 关键不对称：generateImage 读 options.transparent，editImage **完全不读**。
  // 一律转发会让「图生图 + --transparent」变成"写了却静默没生效" ——
  // 命令层必须在 edit 路径下不转发、并把忽略说出来。
  const idxSrc3 = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  const block = /--transparent 分两种情况[\s\S]{0,900}?relayTransparentNote/.exec(idxSrc3)?.[0] ?? ''
  ok(block.length > 0, '命令层按路径区分 --transparent（不是无脑转发）')
  ok(/relayRefs\.length === 0\) argv\.push\('--transparent'\)/.test(idxSrc3), '仅文生图路径转发 --transparent')
  ok(/relayTransparentNote = '本次是图生图/.test(idxSrc3), '图生图路径给出"已忽略"的说明')
  ok(/relayTransparentNote,/.test(idxSrc3), '忽略说明真的输出给用户（不是只赋值的死变量）')

  // 尺寸格式当场拒绝：把 "foo" 丢给下游会"就近吸附"成用户没写过的尺寸。
  ok(/需要「宽x高」形式/.test(idxSrc3), '非法尺寸被当场拒绝（不静默吸附）')
  // 漏值必须被命令层消费，否则解析器报告了也没人管。
  ok(/relayParsed\.missing\.length > 0/.test(idxSrc3), '/taptap-image 命令层拒绝带漏值提交')
}

console.log('\n[13] flag 语义只有一个来源（防止"修一处漏三处"复发）')
{
  const tk = await imp('tokens.mjs')
  ok(typeof tk.consumeFlags === 'function' && typeof tk.flagValue === 'function' && typeof tk.flagList === 'function',
    '通用消费器在 tokens.mjs 里')
  // 四条链路的斜杠命令解析都必须走 tokens 的实现，不允许再各自手写正则白名单。
  const gptSrc = fs.readFileSync(path.join(root, 'src', 'taptap-gpt.mjs'), 'utf8')
  const imgSrc = fs.readFileSync(path.join(root, 'src', 'taptap-image.mjs'), 'utf8')
  ok(/consumeFlags\(splitTokens\(/.test(imgSrc), 'taptap-image 用通用消费器')
  ok(/export function parseSlashGenArgs/.test(gptSrc), 'taptap-gpt 有导出的斜杠解析器')
  const slashBody = /export function parseSlashGenArgs[\s\S]*?\n\}\n/.exec(gptSrc)?.[0] ?? ''
  ok(slashBody.includes('flagOf(') && slashBody.includes('looksLikeFlag('), 'taptap-gpt 斜杠解析走统一语义')
  // 命令层不许留裸正则（那是本轮所有泄漏缺陷的源头）。
  const idxSrc4 = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  ok(!/matchAll\(\/\(\?:--ref/.test(idxSrc4), 'index.js 里不再有裸的 --ref 正则提取')
  ok(!/\.replace\(\/\(\?:--ref[\s\S]{0,40}\)\/g, ''\)/.test(idxSrc4), 'index.js 里不再有正则剥 flag')
  // 未导入就被使用 = 运行时 ReferenceError（node --check 抓不到，本轮踩过三次）。
  for (const [file, names] of [
    ['src/taptap-image.mjs', ['consumeFlags', 'splitTokens', 'flagValue', 'flagList', 'flagOf', 'looksLikeFlag']],
    ['src/taptap-sfx.mjs', ['splitTokens', 'flagOf', 'looksLikeFlag']],
    ['src/taptap-zaiduyu.mjs', ['splitTokens', 'flagOf', 'looksLikeFlag']],
    ['src/taptap-gpt.mjs', ['flagOf', 'looksLikeFlag', 'splitTokens']],
  ]) {
    const src = fs.readFileSync(path.join(root, file), 'utf8')
    const importLine = (src.split('\n').find((l) => l.includes('./tokens.mjs')) ?? '')
    for (const n of names) {
      const used = src.split('\n').some((l) => !l.includes('./tokens.mjs') && !/^\s*[*]/.test(l.trim()) && new RegExp(`\\b${n}\\(`).test(l))
      ok(!used || importLine.includes(n), `${file} 用到了 ${n} 且已 import`, importLine.trim().slice(0, 90))
    }
  }
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
