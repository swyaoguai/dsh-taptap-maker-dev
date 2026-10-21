/**
 * 音效 / 素材落盘相关的问题（离线自测，不联网）。
 *
 * 这一组盯的是「写进用户工程的那些文件」—— Maker 会监听 assets/ 并在构建时
 * 读 .meta / .seq.json，所以这几处的写入方式直接影响用户的项目能不能构建成功：
 *
 *   1. ffmpeg 必须用 ffmpegPath() 解析，不能写裸 'ffmpeg'
 *      （ffmpeg 可能装在 FFMPEG_PATH / 注册表 / winget 目录而不在 PATH 上）
 *   2. .meta 与 .seq.json 必须原子写 —— 半截 JSON 会让构建报「meta 损坏」
 *   3. uuid 格式要符合 Maker 约定（22 字符 base64url）
 *
 * 用法：node scripts/verify-audio-assets.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { ffmpegPath } from '../src/video-media.mjs'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audio-assets-'))
console.log(`临时目录：${scratch}\n`)

const audioSrc = fs.readFileSync(new URL('../src/taptap-audio.mjs', import.meta.url), 'utf8')
const libSrc = fs.readFileSync(new URL('../src/audio-library.mjs', import.meta.url), 'utf8')
const seqSrc = fs.readFileSync(new URL('../src/video-sequence.mjs', import.meta.url), 'utf8')

console.log('\n[1] ffmpeg 必须走 ffmpegPath()，不能是裸名字')
{
  ok(!/spawnSync\('ffmpeg'/.test(audioSrc), '不再用裸 spawnSync(\'ffmpeg\')（ffmpeg 不在 PATH 上时会 ENOENT）')
  ok(/ffmpegPath\(\)/.test(audioSrc), '转换分支用了 ffmpegPath()')
  ok(/from '\.\/video-media\.mjs'/.test(audioSrc), '引入了 video-media 的解析器')
  ok(/timeout: 300_000/.test(audioSrc), '转换有超时（不会无限挂起）')

  // 本机实测：ffmpegPath() 必须真的能跑起来
  const p = ffmpegPath()
  const r = execFileSync(p, ['-version'], { encoding: 'utf8' })
  ok(/ffmpeg version/i.test(r), `ffmpegPath() 解析到的可执行文件能跑：${path.basename(p)}`)
}

console.log('\n[2] .meta / .seq.json 必须是原子写')
{
  for (const [name, src] of [['taptap-audio.mjs', audioSrc], ['audio-library.mjs', libSrc]]) {
    ok(/\.partial/.test(src), `${name} 用 .partial 临时名写 .meta`)
    ok(/renameSync\(`\$\{meta\}\.partial`, meta\)|renameSync\(`\$\{[^}]*meta\}\.partial`/.test(src), `${name} 写完后 rename 就位`)
    // 不应再有裸的 meta 写入
    ok(!/writeFileSync\(meta, /.test(src), `${name} 不再直接 writeFileSync(meta)`)
    ok(!/writeFileSync\(`\$\{target\}\.meta`/.test(src), `${name} 不再直接写 target.meta`)
  }
  // 序列帧导入
  ok(/writeFileSync\(`\$\{maniPath\}\.partial`/.test(seqSrc), '序列帧导入的 .seq.json 用 .partial 写')
  ok(/renameSync\(`\$\{maniPath\}\.partial`, maniPath\)/.test(seqSrc), '.seq.json 写完 rename 就位')
  ok(/meta\.partial/.test(seqSrc), '导入的 .meta 用 .partial 写')
}

console.log('\n[3] 原子写的实际效果（驱动真实 import）')
{
  const proj = path.join(scratch, 'proj')
  fs.mkdirSync(path.join(proj, 'assets'), { recursive: true })
  const wav = path.join(scratch, 'tone.wav')
  execFileSync(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav])

  const mod = await import('../src/taptap-audio.mjs')
  const res = mod.installFile(wav, proj, 'bgm')
  ok(fs.existsSync(res.target), '音频文件已落盘')
  ok(fs.existsSync(res.meta), '.meta 已生成')
  const parsed = JSON.parse(fs.readFileSync(res.meta, 'utf8'))
  ok(typeof parsed.uuid === 'string' && parsed.uuid.length === 22, 'uuid 是 22 字符', String(parsed.uuid.length))
  ok(!/[+/=]/.test(parsed.uuid), 'uuid 只含 base64url 合法字符')
  ok(res.uuid === parsed.uuid, '返回值里的 uuid 与文件一致')

  const partials = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.partial')) partials.push(p)
    }
  }
  walk(path.join(proj, 'assets'))
  ok(partials.length === 0, '落盘后没有 .partial 残留', partials.join(','))
}

console.log('\n[4] 转换分支仍可用（ffmpegPath 解析 + 超时）')
{
  const proj = path.join(scratch, 'proj2')
  fs.mkdirSync(path.join(proj, 'assets'), { recursive: true })
  const wav = path.join(scratch, 'tone2.wav')
  execFileSync(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', wav])

  const mod = await import('../src/taptap-audio.mjs')
  // 直接驱动 importLocalFiles 的转换路径（通过 CLI 参数等价物）
  const { spawnSync } = await import('node:child_process')
  const cli = spawnSync(process.execPath, [
    new URL('../src/taptap-audio.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    'import', wav, '--project', proj, '--to', 'mp3',
  ], { encoding: 'utf8' })
  let out = null
  try { out = JSON.parse(cli.stdout || '{}') } catch { /* 下面用 ok 报告 */ }
  ok(Boolean(out), '转换命令输出可解析', (cli.stdout || cli.stderr || '').slice(0, 120))
  ok(out?.ok === true, '转换成功', JSON.stringify(out).slice(0, 120))
  ok(out?.files?.[0]?.converted === 'mp3', '确实转成了 mp3')
  ok(String(out?.files?.[0]?.file ?? '').endsWith('.mp3'), '落盘的是 .mp3')
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)