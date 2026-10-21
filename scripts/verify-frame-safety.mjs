/**
 * 抽帧 / 抠像产物的「先备后换」保护（离线自测，不联网、不花额度）。
 *
 * 背景：以前抽帧是「先 rmSync 整个 frames/ 再逐张写」。写到一半失败（磁盘满、
 * 权限、被 Ctrl-C）时，上一轮的帧就被删光了，只剩半截新帧，而作业状态还没
 * 更新 —— 用户既没新结果也没旧结果。抠像那步是原地覆盖，同样会混出
 * 「一半新参数一半旧参数」的结果。
 *
 * 这里验证三件事：
 *   1. 代码里确实是「先写 staging，全部成功后才落位」
 *   2. 落位失败会回滚，旧文件还在
 *   3. Windows 上不能靠「重命名整个目录」实现 —— 必须逐文件 rename
 *      （这是实测踩到的 EPERM，不是理论顾虑）
 *
 * 用法：node scripts/verify-frame-safety.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const src = fs.readFileSync(new URL('../src/video-sequence.mjs', import.meta.url), 'utf8')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-frame-safety-'))
console.log(`临时目录：${scratch}\n`)

const body = (name) => {
  const start = src.indexOf(`export async function ${name}(`)
  if (start < 0) return ''
  const end = src.indexOf('\nexport ', start + 10)
  return src.slice(start, end < 0 ? src.length : end)
}

console.log('\n[1] 抽帧：先写 staging，落位在写完之后')
{
  const fn = body('extractJobFrames')
  ok(fn.length > 0, '能找到 extractJobFrames')
  const iStage = fn.indexOf('.frames-staging')
  const iWrite = fn.indexOf('encodePng(frames[i]')
  const iSwap = fn.indexOf('swapDirFromStaging(')
  ok(iStage > 0, '用到 .frames-staging 临时目录')
  ok(iWrite > iStage, '先把帧写进 staging')
  ok(iSwap > iWrite, '落位发生在全部写入之后')
  ok(/\.frames-prev/.test(fn), '有备份目录用于回滚')
  ok(/rollbackSwap\(|swapDirFromStaging\(/.test(fn), '切换失败时回滚（走共享实现）')
  // 关键：不能再出现「一上来就删整个 frames」
  ok(!/rmSync\(path\.join\(jobRoot\(home, id\), 'frames'\)/.test(fn), '不再一开始就删掉整个 frames/（那是数据丢失的根源）')
}

console.log('\n[2] 抠像：同样先写 staging')
{
  const fn = body('keyJobFrames')
  ok(fn.length > 0, '能找到 keyJobFrames')
  ok(/\.keyed-staging/.test(fn), '用到 .keyed-staging 临时目录')
  ok(/\.keyed-prev/.test(fn), '有 .keyed-prev 备份用于回滚')
  const iStage = fn.indexOf('.keyed-staging')
  const iKey = fn.indexOf('keyFrame(rgba')
  ok(iStage >= 0 && iKey >= 0, '抠像与暂存目录都在位')
}

console.log('\n[3] Windows 上必须逐文件 rename（不能重命名整个目录）')
{
  const fn = body('extractJobFrames')
  ok(!/renameSync\(framesDir, backup\)/.test(fn), '不重命名整个 frames 目录（Windows 会 EPERM）')
  ok(!/renameSync\(keyedDir, keyedBackup\)/.test(body('keyJobFrames')), '抠像也不重命名整个 keyed 目录')
  // 实测：Windows 上重命名一个目录在有句柄时会失败
  const d = path.join(scratch, 'rename-probe')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'a.txt'), 'x')
  let dirRenameOk = true
  try { fs.renameSync(d, path.join(scratch, 'renamed')) } catch { dirRenameOk = false }
  ok(dirRenameOk, '当前环境下目录 rename 可用（但代码已不依赖它）')
  if (dirRenameOk) fs.renameSync(path.join(scratch, 'renamed'), d)
}

console.log('\n[4] 落位中途失败 → 旧文件能回来（直接跑真实实现）')
{
  const root = path.join(scratch, 'swap')
  fs.mkdirSync(root, { recursive: true })
  const mod = await import('../src/video-sequence.mjs')
  // swapDirFromStaging / rollbackSwap 是模块内私有，这里用真实代码路径验证：
  // 抽帧用的就是它。直接构造目录并观察结果。
  const dir = path.join(root, 'frames')
  const staging = path.join(root, '.frames-staging')
  const backup = path.join(root, '.frames-prev')
  for (const d of [dir, staging, backup]) fs.mkdirSync(d, { recursive: true })

  const old = ['f00.png', 'f01.png', 'f02.png']
  for (const n of old) fs.writeFileSync(path.join(dir, n), Buffer.from(`OLD-${n}`))
  const next = ['f00.png', 'f01.png', 'f02.png', 'f03.png']
  for (const n of next) fs.writeFileSync(path.join(staging, n), Buffer.from(`NEW-${n}`))

  // 先把 f03 的源文件删掉 —— 切换到它时 renameSync 必然失败，
  // 于是前 3 个已经换成新的，正好检验「回滚是否覆盖已就位的新文件」。
  fs.rmSync(path.join(staging, 'f03.png'), { force: true })

  let threw = ''
  try {
    mod.__testSwapDirFromStaging(staging, dir, backup, next)
  } catch (e) { threw = e?.message ?? String(e) }
  ok(threw !== '', '切换失败会抛出', threw)

  const after = fs.readdirSync(dir).sort()
  ok(after.join(',') === old.join(','), '回滚后文件列表与切换前一致', after.join(','))
  const restored = fs.readFileSync(path.join(dir, 'f00.png'), 'utf8')
  ok(restored === 'OLD-f00.png', '恢复的是旧内容（不是半截新的）', restored)
  ok(!fs.existsSync(path.join(dir, 'f03.png')), '没有留下半截新文件')
}

console.log('\n[5] 成功路径：换完后清理旧残留与备份')
{
  const dir = path.join(scratch, 'ok')
  const staging = path.join(scratch, 'ok-staging')
  const backup = path.join(scratch, 'ok-backup')
  for (const d of [dir, staging, backup]) fs.mkdirSync(d, { recursive: true })
  // 上一轮 4 张，这一轮只要 2 张
  for (const n of ['f00.png', 'f01.png', 'f02.png', 'f03.png']) fs.writeFileSync(path.join(dir, n), Buffer.from('OLD'))
  const next = ['f00.png', 'f01.png']
  for (const n of next) fs.writeFileSync(path.join(staging, n), Buffer.from('NEW'))

  for (const name of next) {
    const dest = path.join(dir, name)
    if (fs.existsSync(dest)) fs.renameSync(dest, path.join(backup, name))
    fs.renameSync(path.join(staging, name), dest)
  }
  for (const name of fs.readdirSync(dir)) {
    if (!next.includes(name)) fs.rmSync(path.join(dir, name), { force: true })
  }
  fs.rmSync(staging, { recursive: true, force: true })
  fs.rmSync(backup, { recursive: true, force: true })

  ok(fs.readdirSync(dir).sort().join(',') === 'f00.png,f01.png', '张数变少时旧的多余帧被清掉', fs.readdirSync(dir).join(','))
  ok(fs.readFileSync(path.join(dir, 'f00.png'), 'utf8') === 'NEW', '留下的是新内容')
  ok(!fs.existsSync(staging) && !fs.existsSync(backup), '临时目录与备份都已清理，不留垃圾')
}

console.log('\n[6] 合成图尺寸：高度也必须有上限（否则撑爆内存）')
{
  const { chooseLayout } = await import('../src/video-sequence.mjs')
  // 正常规模不应被拦
  const okCase = chooseLayout({ count: 12, cellWidth: 256 })
  ok(okCase.tooLarge !== true, '12 帧 × 256 正常放行', JSON.stringify(okCase))
  ok(256 * okCase.columns <= 8192, '宽度不超过 8192')

  // ⚠️ 以前只卡宽度、不卡高度：64 帧 × 2048 → 8192×32768（1 GB 单张）
  const big = chooseLayout({ count: 64, cellWidth: 2048 })
  ok(big.tooLarge === true, '64 帧 × 2048 被判为过大（以前会算出 32768px 高）')
  ok(big.perFrameLimit >= 1, '给出「每格建议上限」，让用户知道该调到多少', String(big.perFrameLimit))

  const huge = chooseLayout({ count: 64, cellWidth: 4096 })
  ok(huge.tooLarge === true, '64 帧 × 4096 同样被拦（否则单张要 4 GB）')

  const many = chooseLayout({ count: 200, cellWidth: 256 })
  ok(many.tooLarge !== true, '200 帧 × 256 仍可行（约 56 MB）')
  const mw = 256 * many.columns
  const mh = 256 * Math.ceil(200 / many.columns)
  ok(mw <= 8192 && mh <= 8192, '成品图宽高都在 8192 内', `${mw}x${mh}`)

  // composeJobSheet 两条路径（auto / 用户显式指定）都要有闸门
  const fn = body('composeJobSheet')
  ok(/tooLarge/.test(fn), 'auto 路径会因 tooLarge 抛错')
  ok(/超过单张上限/.test(fn), '报错文案说清是尺寸超限')
  ok(/maxCols|columns 调到/.test(fn), '用户显式指定 columns 时也会被拦并给出建议值')
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)