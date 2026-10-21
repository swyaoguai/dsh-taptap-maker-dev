/**
 * 素材落点（sucai/）的离线自测（不联网、不花额度）。
 *
 * 覆盖三件最容易出错、也最容易被用户直接撞上的事：
 *   1. 三类素材在项目里都落在 `sucai/<类型>/`，不在项目里就退回 $DSH_HOME；
 *   2. 落在项目里的目录**自带 .gitignore**（Maker 会自动提交整个工程）；
 *   3. 改造前的视频作业目录能**自动搬迁**，且搬迁后帧/视频路径仍然有效。
 *
 * 用法：node scripts/verify-assets.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ASSET_KINDS, isMakerProject, resolveAssetDir } from '../src/assets.mjs'
import { createJob, getJob, listJobs } from '../src/video-sequence.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-assets-'))
console.log(`临时目录：${scratch}\n`)

/** 造一个像样的 Maker 工程（有 assets/ 就算）。 */
function makeProject(name) {
  const dir = path.join(scratch, name)
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  return dir
}

console.log('\n[1] 工程识别')
{
  ok(isMakerProject(makeProject('p-yes')) === true, '有 assets/ 的目录算工程')
  const bare = path.join(scratch, 'p-no')
  fs.mkdirSync(bare, { recursive: true })
  ok(isMakerProject(bare) === false, '没有 assets/ 的不算工程')
}

console.log('\n[2] 三类素材在项目里的落点')
{
  const proj = makeProject('p-game')
  const home = path.join(proj, '.dsh-home')
  const rel = (p) => path.relative(proj, p).replace(/\\/g, '/')
  for (const [kind, sub] of Object.entries(ASSET_KINDS)) {
    const r = resolveAssetDir(home, kind, { projectDir: proj })
    ok(rel(r.dir) === `sucai/${sub}`, `${kind} → <项目>/sucai/${sub}`, rel(r.dir))
    ok(r.source === 'project', `${kind} 的来源标记为 project`, r.source)
    ok(fs.existsSync(path.join(r.dir, '.gitignore')), `${kind} 目录自带 .gitignore（不会被 Maker 自动提交）`)
    ok(fs.readFileSync(path.join(r.dir, '.gitignore'), 'utf8').includes('!.gitignore'), `${kind} 的 .gitignore 放行自身`)
  }
}

console.log('\n[3] 不在项目里就退回 $DSH_HOME（绝不在 C 盘根造目录）')
{
  const home = path.join(scratch, 'h-plain')
  const bare = path.join(scratch, 'not-a-project')
  fs.mkdirSync(bare, { recursive: true })
  for (const kind of Object.keys(ASSET_KINDS)) {
    const r = resolveAssetDir(home, kind, { projectDir: bare })
    ok(r.source === 'default', `${kind} 退回默认目录`, r.source)
    ok(r.dir.startsWith(path.join(home, 'taptap-maker-dev')), `${kind} 落在 $DSH_HOME 下`, r.dir)
    ok(!fs.existsSync(path.join(r.dir, '.gitignore')), `${kind} 在 $DSH_HOME 下无需 .gitignore`)
  }
}

console.log('\n[4] 显式指定优先，且只有真在项目里才 gitignore')
{
  const proj = makeProject('p-explicit')
  const home = path.join(scratch, 'h-exp')
  const outside = path.join(scratch, 'elsewhere', 'imgs')

  const byFlag = resolveAssetDir(home, 'image', { projectDir: proj, explicit: outside })
  ok(byFlag.source === 'flag' && path.resolve(byFlag.dir) === path.resolve(outside), '显式目录优先生效')
  ok(byFlag.insideProject === false, '项目外的目录不算「在项目里」')
  ok(!fs.existsSync(path.join(byFlag.dir, '.gitignore')), '项目外的目录不该被塞 .gitignore')

  const byConfig = resolveAssetDir(home, 'image', { projectDir: proj, configured: '{project}/sucai/custom' })
  ok(path.resolve(byConfig.dir) === path.resolve(proj, 'sucai', 'custom'), '{project} 占位符被展开', byConfig.dir)
  ok(byConfig.insideProject === true, '展开后落在项目内 → insideProject 为 true')

  const homeExpanded = resolveAssetDir(home, 'bgm', { projectDir: proj, configured: '{home}/mymusic' })
  ok(homeExpanded.dir === path.join(home, 'taptap-maker-dev', 'mymusic'), '{home} 占位符指向插件数据目录', homeExpanded.dir)
}

console.log('\n[5] 视频作业目录跟随项目，并记住位置')
{
  const proj = makeProject('p-video')
  const home = path.join(scratch, 'h-video')
  // 真实用法就是「在项目目录里执行命令」，所以靠 cwd 判定工程 —— 这里照做。
  const cwd = process.cwd()
  process.chdir(proj)
  const job = createJob(home, '奔跑 攻击')
  process.chdir(cwd)
  const rel = path.relative(proj, job.dir).replace(/\\/g, '/')

  ok(rel.startsWith('sucai/video/'), '作业目录落在 <项目>/sucai/video/', rel)
  ok(rel.includes('奔跑 攻击'), '目录名带作业名（资源管理器里认得出来）', rel)
  ok(rel.endsWith(job.id), '目录名以作业 id 结尾', rel)
  ok(fs.existsSync(path.join(job.dir, '.gitignore')), '作业目录自带 .gitignore')
  for (const sub of ['refs', 'videos', 'frames', 'keyed', 'out']) {
    ok(fs.existsSync(path.join(job.dir, sub)), `建好了 ${sub}/`)
  }

  ok(getJob(home, job.id)?.dir === job.dir, '目录记在 job.json 上（不重算）')
  ok(listJobs(home).some((j) => j.id === job.id), 'listJobs 能列出作业（目录名带空格也不影响解析）')
}

console.log('\n[6] 改名不改目录（不能让已有帧/视频失联）')
{
  const proj = makeProject('p-rename')
  const home = path.join(scratch, 'h-rename')
  const cwd = process.cwd()
  process.chdir(proj)
  const job = createJob(home, '旧名字')
  const before = job.dir
  // 用 saveJob 改名
  const saveJob = (await import('../src/video-sequence.mjs')).saveJob
  const renamed = saveJob(home, job.id, { name: '新名字' })
  process.chdir(cwd)
  ok(renamed.dir === before, '改名后目录不变（相对路径仍然有效）')
  ok(fs.existsSync(path.join(renamed.dir, 'job.json')), '改名后 job.json 仍在原处')
  ok(getJob(home, job.id)?.name === '新名字', '作业名确实改了')
}

console.log('\n[7] 旧位置（改造前）的作业能自动搬迁')
{
  const proj = makeProject('p-legacy')
  const home = path.join(scratch, 'h-legacy')
  const dataDir = path.join(home, 'taptap-maker-dev')

  // 手工造一个改造前的作业：$DSH_HOME/taptap-maker-dev/video-jobs/<id>/
  const id = 'vlegacy01'
  const oldRoot = path.join(dataDir, 'video-jobs', id)
  fs.mkdirSync(path.join(oldRoot, 'frames'), { recursive: true })
  fs.mkdirSync(path.join(oldRoot, 'videos'), { recursive: true })
  fs.writeFileSync(path.join(oldRoot, 'frames', 'f000.png'), 'PNGDATA')
  fs.writeFileSync(path.join(oldRoot, 'videos', 'output.mp4'), 'MP4DATA')
  fs.writeFileSync(path.join(oldRoot, 'job.json'), JSON.stringify({
    id, name: '老作业', createdAt: 1, updatedAt: 2, mode: 'frames',
    prompt: '', suffix: '', refs: { firstFrame: null, lastFrame: null },
    settings: {}, video: { status: 'ready', file: 'videos/output.mp4' },
    frames: { status: 'ready', count: 1, files: ['frames/f000.png'], keyed: [], report: [] },
    sheet: { status: 'empty' }, log: [],
  }, null, 2), 'utf8')

  const cwdBefore = process.cwd()
  process.chdir(proj)
  const got = getJob(home, id)
  process.chdir(cwdBefore)

  ok(got?.id === id, '旧作业能被读到')
  ok(path.relative(proj, got.dir).replace(/\\/g, '/').startsWith('sucai/video/'), '旧作业已搬到 <项目>/sucai/video/', got.dir)
  ok(fs.existsSync(path.join(got.dir, 'frames', 'f000.png')), '搬迁后帧文件还在')
  ok(fs.readFileSync(path.join(got.dir, 'videos', 'output.mp4'), 'utf8') === 'MP4DATA', '搬迁后视频内容一致')
  ok(!fs.existsSync(oldRoot), '旧目录不再残留（没有留下两份）')
  ok(listJobs(home).some((j) => j.id === id), '搬迁后仍出现在列表里')
}

console.log('\n[8] 非法字符与 Windows 保留名')
{
  const proj = makeProject('p-slug')
  const home = path.join(scratch, 'h-slug')
  const cwd = process.cwd()
  process.chdir(proj)
  const job = createJob(home, 'a/b:c*d?e"f<g>h|i')
  const con = createJob(home, 'CON')
  process.chdir(cwd)
  const base = path.basename(job.dir)
  ok(!/[\\/:*?"<>|]/.test(base), '非法字符被替换掉', base)
  ok(job.dir.startsWith(path.join(proj, 'sucai', 'video')), '仍然落在 sucai/video 下')
  ok(!/^CON-/i.test(path.basename(con.dir)), 'Windows 保留名被避开', path.basename(con.dir))
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)