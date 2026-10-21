/**
 * 视频序列帧管线的离线自测（不花 API 额度）。
 *
 * 用 ffmpeg 现场造一段「绿幕上一个小方块沿弧线走」的视频，然后跑完整条
 * 链路：抽帧 → 抠像 → 合成 → 导入一个假的 Maker 工程，并逐项断言：
 *
 *   - 抽帧张数、尺寸、时长都对；
 *   - 三种时间排法（uniform / first-last / loop）的首尾采样点符合约定；
 *   - 抠像后四角透明、主体不透明；
 *   - 合成图尺寸 = 格子 × 网格，且透明区域占比合理；
 *   - 导入后 assets/image/ 下出现 png + 同名 .meta（含 27 位 uuid）+ .seq.json；
 *   - assets/ 下**没有**多出中间产物（视频、原始帧都不该进去）。
 *
 * 用法：node scripts/verify-video-pipeline.mjs
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { ffmpegPath } from '../src/video-media.mjs'
import {
  composeJobSheet, createJob, extractJobFrames, getJob, importToMaker,
  keyJobFrames, saveJob, setReference,
} from '../src/video-sequence.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-video-verify-'))
const home = scratch // dataDir(home) 会建在这个临时目录下
console.log(`临时目录：${scratch}`)

const import_path = await import('node:path')
// 作业目录跟随项目，路径记在 job.json 的 `dir` 上 —— 别在这里写死。
const jobRoot = (job) => (typeof job?.dir === 'string' ? job.dir : getJob(scratch, job.id)?.dir)
const imported_path = (job) => path.join(jobRoot(job), job.sheet.file)

/** 独立解一遍 PNG（只用 zlib），数不透明像素 —— 不依赖被测代码自己的编码器。 */
function countOpaquePixels(file) {
  const buf = readFileSync(file)
  let off = 8
  let w = 0
  let h = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4) }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * 4
  const px = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    const rs = y * (stride + 1)
    const filter = raw[rs]
    for (let x = 0; x < stride; x += 1) {
      const cur = raw[rs + 1 + x]
      const left = x >= 4 ? px[y * stride + x - 4] : 0
      const up = y > 0 ? px[(y - 1) * stride + x] : 0
      let v = cur
      if (filter === 1) v = (cur + left) & 0xff
      else if (filter === 2) v = (cur + up) & 0xff
      else if (filter === 3) v = (cur + ((left + up) >> 1)) & 0xff
      px[y * stride + x] = v
    }
  }
  let opaque = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] > 8) opaque += 1
  return { opaque, total: w * h, width: w, height: h }
}

/** 造一段 3 秒 / 24fps 的绿幕视频：白色方块从左下沿弧线走到右下。 */
function makeTestVideo(outFile) {
  const vf = [
    'color=c=0x00b000:s=384x384:d=3:r=24',
    // 一个 48×48 的白块，用表达式让 x/y 随时间变化（走一个半圆）
    "drawbox=x='96+96*sin(t*3.14159)':y='240-72*sin(t*3.14159)':w=56:h=56:color=white@1:t=fill",
  ].join(',')
  execFileSync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', vf,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '3',
    outFile,
  ], { stdio: 'inherit' })
  return outFile
}

async function main() {
  console.log('\n[1] 造测试视频')
  const video = makeTestVideo(path.join(scratch, 'test.mp4'))
  ok(existsSync(video), '测试视频已生成')

  console.log('\n[2] 建作业并挂上「已生成的视频」')
  const job = createJob(home, '方块行走')
  saveJob(home, job.id, {
    prompt: '白色方块在绿幕前走三步，全身入画，相机固定',
    settings: { frameCount: 8, arrange: 'uniform', longEdge: 384, cellWidth: 128, cellHeight: 128, bgTolerance: 40 },
  })
  // 直接落进 videos/ 并把状态标成 ready（跳过付费的提交步骤）
  // 目录从作业对象上读，不要在这里写死路径 —— 作业目录现在是跟随项目的。
  const root = job.dir
  copyFileSync(video, path.join(root, 'videos', 'output.mp4'))
  const j2 = getJob(home, job.id)
  j2.video = { status: 'ready', file: 'videos/output.mp4', model: 'MiniMax-H3' }
  writeFileSync(path.join(root, 'job.json'), JSON.stringify(j2))
  ok(getJob(home, job.id).video.status === 'ready', '作业已标记为视频就绪')

  console.log('\n[3] 抽帧（uniform 8 帧）')
  const afterFrames = await extractJobFrames(home, job.id)
  ok(afterFrames.frames.status === 'ready', '抽帧状态 ready', afterFrames.frames.error)
  ok(afterFrames.frames.count === 8, `抽到 8 帧（实际 ${afterFrames.frames.count}）`)
  ok(afterFrames.frames.files.length === 8, '帧文件 8 个')
  const times = afterFrames.frames.times
  ok(times[0] > 0, `首帧避开了 0 秒（${times[0]}s）`)
  ok(times[times.length - 1] < afterFrames.frames.duration, `末帧没顶到结尾（${times[times.length - 1]}s < ${afterFrames.frames.duration.toFixed(2)}s）`)
  const sorted = times.every((t, i) => i === 0 || t > times[i - 1])
  ok(sorted, '采样时间单调递增')
  for (const f of afterFrames.frames.files) {
    ok(existsSync(path.join(jobRoot(job), 'frames', f)), `帧文件存在 ${f}`)
  }

  console.log('\n[4] 三种时间排法')
  const fl = await extractJobFrames(home, job.id, { arrange: 'first-last', frameCount: 5 })
  ok(fl.frames.times[0] === 0, `first-last 首点 = 0（${fl.frames.times[0]}）`)
  ok(fl.frames.times[4] < fl.frames.duration, `first-last 末点 < 时长（${fl.frames.times[4]}）`)
  const lp = await extractJobFrames(home, job.id, { arrange: 'loop', frameCount: 6 })
  ok(lp.frames.times[0] === 0 && lp.frames.times[5] < lp.frames.duration, 'loop 首点 = 0 且末点 < 时长')
  // 回到 uniform 继续后面的步骤
  await extractJobFrames(home, job.id, { arrange: 'uniform', frameCount: 8 })

  console.log('\n[5] 抠像')
  const afterKey = await keyJobFrames(home, job.id)
  ok(afterKey.frames.keyed.length === 8, `抠出 8 帧（实际 ${afterKey.frames.keyed.length}）`)
  ok(afterKey.frames.report.length === 8, '逐帧报告 8 条')
  // 注意：测试视频主体只占画面 2%，所以 backgroundFraction ≈ 0.98、confident=false
  // 是**正确**的自检结论（真实素材的主体一般占 15%~50%）。这里断言报告如实反映了它。
  const frac = afterKey.frames.report.map((r) => r.backgroundFraction)
  ok(frac.every((f) => f > 0.5), '绿幕被大片抠掉（背景占比 > 50%）', JSON.stringify(frac))
  ok(afterKey.frames.report.every((r) => r.chroma === 'green'), 'auto 判出了绿幕')
  ok(afterKey.frames.report.some((r) => r.confident === false), '主体占比过低时自检会标「不可信」（诚实告警）')

  console.log('\n[6] 合成')
  const afterSheet = await composeJobSheet(home, job.id)
  ok(afterSheet.sheet.status === 'ready', '合成状态 ready', afterSheet.sheet.error)
  ok(afterSheet.sheet.width === 128 * 8, `整图宽 = 128×8 = ${afterSheet.sheet.width}`)
  ok(afterSheet.sheet.height === 128, `整图高 = 128 = ${afterSheet.sheet.height}`)
  ok(afterSheet.sheet.layout === 'row' && afterSheet.sheet.columns === 8, '8 帧排成一行')

  console.log('\n[6b] 合成图里真的有主体（不是全透明）')
  // 独立解码一遍 PNG，数一数不透明像素 —— 这是「渲染出来是空的」那个 bug 的守卫。
  const sheetInfo = countOpaquePixels(imported_path(afterSheet))
  ok(sheetInfo.opaque > 1000, `合成图有不透明像素（${sheetInfo.opaque}）`)
  ok(sheetInfo.opaque < sheetInfo.total * 0.9, `合成图不是整张实心（${(sheetInfo.opaque / sheetInfo.total * 100).toFixed(1)}%）`)

  console.log('\n[7] 导入一个假的 Maker 工程')
  const project = path.join(scratch, 'fake-maker-project')
  mkdirSync(path.join(project, 'assets', 'image'), { recursive: true })
  const imported = await importToMaker(home, job.id, { projectDir: project, assetName: 'Block Walk', fps: 10 })
  const assetPath = imported.file
  ok(existsSync(assetPath), `素材已落盘 ${path.basename(assetPath)}`)
  ok(existsSync(`${assetPath}.meta`), '同名 .meta 已生成')
  const meta = JSON.parse(readFileSync(`${assetPath}.meta`, 'utf8'))
  ok(typeof meta.uuid === 'string' && meta.uuid.length === 27, `.meta uuid 是 27 位（${meta.uuid}）`)
  const maniPath = imported.manifest?.asset ? path.join(project, imported.manifest.asset.replace(/\//g, path.sep).replace(/\.png$/, '.seq.json')) : ''
  ok(maniPath && existsSync(maniPath), '.seq.json 清单已生成')
  if (maniPath && existsSync(maniPath)) {
    const mani = JSON.parse(readFileSync(maniPath, 'utf8'))
    ok(mani.sheet.columns === 8 && mani.sheet.frameCount === 8, '清单记了列数与帧数')
    ok(mani.animation.fps === 10, '清单记了回放帧率')
  }
  ok(imported.lua.includes('sprite.rect'), '给了 Lua 切图片段')

  console.log('\n[8] assets/ 里只有成品，没有中间产物')
  const imageFiles = readdirSync(path.join(project, 'assets', 'image'))
  const pngs = imageFiles.filter((f) => f.endsWith('.png'))
  ok(pngs.length === 1, `assets/image 下只有 1 张 png（实际 ${pngs.length}: ${pngs.join(',')}）`)
  ok(!imageFiles.some((f) => /\.mp4$|^f\d+\.png$/.test(f)), '没有混入视频或原始帧')

  console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
  if (failed === 0) {
    console.log('（临时目录保留，方便肉眼检查：' + project + '）')
  } else {
    console.log('临时目录：' + scratch)
  }
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('自测崩溃：', error)
  process.exitCode = 1
})
