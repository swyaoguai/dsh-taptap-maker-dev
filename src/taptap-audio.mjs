#!/usr/bin/env node
/**
 * taptap-audio — find and install CC0 game audio (SFX / BGM) into a Maker
 * project.
 *
 * This is the audio counterpart to taptap-image: it costs NO Maker credits.
 * Everything comes from Kenney's CC0 packs (commercial use allowed, no
 * attribution required).
 *
 * Usage:
 *   node taptap-audio.mjs search "金币音效"
 *   node taptap-audio.mjs search "背景音乐" --limit 5
 *   node taptap-audio.mjs add "金币音效" --project <maker-project> --out coin.wav
 *   node taptap-audio.mjs add "点击按钮" --project <maker-project>        # auto name
 *   node taptap-audio.mjs sync                                     # download/refresh library
 *
 * `add` writes the file into <project>/assets/audio/{sfx|bgm}/ and creates the
 * sibling .meta ({"uuid": "..."}) that Maker expects.
 *
 * @module src/taptap-audio.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolveDshHome, defaultCacheDir } from './paths.js'
import { ensureLibrary, searchAudio, newAssetUuid, installRemoteMatch } from './audio-library.mjs'
import { SOURCES } from './audio-sources.mjs'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else { args[key] = next; i += 1 }
    } else {
      args._.push(token)
    }
  }
  return args
}

/** Pick the sub-folder by kind. */
function audioDir(project, kind) {
  return path.join(project, 'assets', 'audio', kind === 'bgm' ? 'bgm' : 'sfx')
}

/** Write the asset plus its Maker .meta file. (Also used by the BGM widget's
 * trim/import web routes in index.js.) */
export function installFile(srcAbs, project, kind, outName) {
  const dir = audioDir(project, kind)
  fs.mkdirSync(dir, { recursive: true })
  const name = outName && outName.length > 0 ? outName : `${path.basename(srcAbs, path.extname(srcAbs))}${path.extname(srcAbs)}`
  const target = path.join(dir, name)
  fs.copyFileSync(srcAbs, target)
  const meta = path.join(dir, `${name}.meta`)
  if (!fs.existsSync(meta)) {
    fs.writeFileSync(meta, `${JSON.stringify({ uuid: newAssetUuid() }, null, 2)}\n`)
  }
  return { target, meta, uuid: JSON.parse(fs.readFileSync(meta, 'utf8')).uuid, bytes: fs.statSync(target).size }
}

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm'])

/**
 * Import audio files the user ALREADY has (e.g. BGM downloaded from the
 * MiniMax Audio web page, or any CC0 track) into a Maker project.
 *
 * Pipeline: pick source(s) → optional ffmpeg conversion → copy into
 * assets/audio/{sfx|bgm}/ → write the sibling .meta (uuid).
 *
 * This exists because the MiniMax music API rejects new users (HTTP 410), so
 * the web page is the practical path for full BGM today.
 */
function importLocalFiles(sources, project, kind, opts = {}) {
  const results = []
  for (const src of sources) {
    const stat = fs.statSync(src)
    if (!stat.isFile()) { results.push({ src, error: 'not a file' }); continue }
    if (!AUDIO_EXT.has(path.extname(src).toLowerCase())) {
      results.push({ src, error: `unsupported extension ${path.extname(src)}` }); continue
    }
    let toInstall = src
    let tmpDir = null
    // Optional conversion step (e.g. mp3 → wav for Maker conventions).
    if (opts.convertTo) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'))
      const tmpOut = path.join(
        tmpDir,
        `${path.basename(src, path.extname(src))}.${opts.convertTo}`,
      )
      const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src,
        ...(opts.convertTo === 'wav' ? ['-c:a', 'pcm_s16le'] : []),
        ...(opts.convertTo === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', String(opts.bitrate ?? '192k')] : []),
        ...(opts.convertTo === 'ogg' ? ['-c:a', 'libvorbis', '-q:a', '4'] : []),
        ...(opts.mono ? ['-ac', '1'] : []),
        ...(opts.rate ? ['-ar', String(opts.rate)] : []),
        tmpOut], { encoding: 'utf8' })
      if (r.status !== 0 || !fs.existsSync(tmpOut)) {
        // Clean up our own temp dir on this path too (a leaked imp-* dir keeps
        // the whole converted file alive in %TEMP% forever).
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
        results.push({ src, error: `ffmpeg convert failed: ${(r.stderr || '').trim().split('\n').slice(-1)[0] ?? 'unknown'}` })
        continue
      }
      toInstall = tmpOut
    }
    const name = opts.name && sources.length === 1
      ? opts.name
      : `${path.basename(toInstall, path.extname(toInstall))}${path.extname(toInstall)}`
    try {
      const inst = installFile(toInstall, project, kind, name)
      results.push({
        src: path.basename(src),
        file: inst.target,
        meta: inst.meta,
        uuid: inst.uuid,
        kb: Math.round(inst.bytes / 1024),
        converted: opts.convertTo ?? null,
      })
    } catch (e) {
      results.push({ src, error: e.message })
    } finally {
      // installFile copies the bytes, so the temp dir is dead weight now.
      if (tmpDir !== null) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  }
  return results
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = (args._[0] ?? 'search').toLowerCase()
  const cacheDir = (args.cacheDir && typeof args.cacheDir === 'string')
    ? path.resolve(args.cacheDir)
    : path.join(defaultCacheDir(resolveDshHome(args.dshHome)), 'audio')

  if (cmd === 'sync' || cmd === 'update') {
    const result = await ensureLibrary(cacheDir, { force: args.force === true || args.force === 'true' })
    process.stdout.write(`${JSON.stringify({
      ok: result.errors.length === 0,
      cacheDir,
      indexed: result.index.length,
      errors: result.errors,
    }, null, 2)}\n`)
    return
  }

  // `import` — bring files the user already has (e.g. BGM from the MiniMax
  // Audio web page) into the project, optionally converting them first.
  if (cmd === 'import' || cmd === '导入' || cmd === 'install-local') {
    const project = typeof args.project === 'string' ? path.resolve(args.project) : null
    if (project === null) {
      process.stderr.write('--project <Maker项目目录> is required for import\n')
      process.exitCode = 2
      return
    }
    if (!fs.existsSync(path.join(project, 'assets'))) {
      process.stderr.write(`${project} does not look like a Maker project (no assets/ dir)\n`)
      process.exitCode = 2
      return
    }
    const inArg = args.in ?? args.from ?? args._[1]
    if (typeof inArg !== 'string') {
      process.stderr.write('usage: taptap-audio import --in <文件或目录> --project <dir> [--to wav] [--kind bgm|sfx] [--out name] [--mono] [--rate 44100]\n')
      process.exitCode = 2
      return
    }
    const inPath = path.resolve(inArg)
    if (!fs.existsSync(inPath)) {
      process.stderr.write(`not found: ${inPath}\n`)
      process.exitCode = 2
      return
    }
    const kind = args.kind === 'sfx' ? 'sfx' : 'bgm'
    const files = fs.statSync(inPath).isDirectory()
      ? fs.readdirSync(inPath)
        .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
        .map((f) => path.join(inPath, f))
      : [inPath]
    if (files.length === 0) {
      process.stderr.write(`no audio files found in ${inPath}\n`)
      process.exitCode = 1
      return
    }
    // newest-first: the file just downloaded from the web page is usually last.
    if (fs.statSync(inPath).isDirectory()) {
      files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      if (args.latest === true || args.latest === 'true') files.splice(1)
    }
    if (args.latest === true || args.latest === 'true') files.splice(1)

    const results = importLocalFiles(files, project, kind, {
      convertTo: typeof args.to === 'string' ? args.to : null,
      mono: args.mono === true || args.mono === 'true',
      rate: Number(args.rate ?? 0) || null,
      bitrate: typeof args.bitrate === 'string' ? args.bitrate : '192k',
      name: typeof args.out === 'string' ? args.out : null,
    })
    const ok = results.filter((r) => !r.error)
    process.stdout.write(`${JSON.stringify({
      ok: ok.length === results.length,
      kind,
      imported: ok.length,
      failed: results.length - ok.length,
      files: results.map((r) => (r.error
        ? { file: r.src, error: r.error }
        : { file: r.file, uuid: r.uuid, kb: r.kb, converted: r.converted })),
    }, null, 2)}\n`)
    if (ok.length === 0) process.exitCode = 1
    return
  }

  // `sources` takes no query, so it MUST be handled before the "query is
  // required" guard below — otherwise it was unreachable and printed usage.
  if (cmd === 'sources' || cmd === '源' || cmd === '清单') {
    process.stdout.write(`${JSON.stringify({
      sources: [
        { id: 'kenney', title: 'Kenney（本地 CC0）', license: 'CC0 — 可商用、可修改、无需署名', kind: 'sfx+bgm', note: '已下载到本地缓存，706 个音频' },
        ...SOURCES.map((s) => ({
          id: s.id, title: s.title, license: s.license, kind: s.kind, home: s.home, note: s.note,
        })),
      ],
      excluded: [
        { id: 'freesound', reason: '需要用户自己的 API Key（裸请求实测 401）' },
        { id: 'opengameart', reason: '授权混杂，含 CC-BY-NC 等禁止商用的协议' },
      ],
    }, null, 2)}\n`)
    return
  }

  const query = args._.slice(1).join(' ')
  if (query.length === 0) {
    process.stderr.write('usage: taptap-audio search "<描述>" | add "<描述>" --project <dir> [--out name.wav] | sources | sync\n')
    process.exitCode = 2
    return
  }

  const result = await searchAudio(cacheDir, query, { limit: Number(args.limit ?? 8) })
  if (result.errors.length > 0) {
    process.stderr.write(`library warnings: ${result.errors.join('; ')}\n`)
  }

  if (cmd === 'search' || cmd === 'find') {
    process.stdout.write(`${JSON.stringify({
      ok: result.matches.length > 0,
      query,
      tokens: result.tokens,
      kind: result.kind,
      note: result.note,
      library: result.total,
      matches: result.matches.map((m) => ({
        pack: m.pack, file: m.file, kb: m.kb, source: m.source,
        local: m.local === true, license: m.license ?? null,
      })),
      externalCount: result.externalCount ?? 0,
    }, null, 2)}\n`)
    if (result.matches.length === 0) process.exitCode = 1
    return
  }

  if (cmd === 'add' || cmd === 'install') {
    const project = typeof args.project === 'string' ? path.resolve(args.project) : null
    if (project === null) {
      process.stderr.write('--project <Maker项目目录> is required for add\n')
      process.exitCode = 2
      return
    }
    if (!fs.existsSync(path.join(project, 'assets'))) {
      process.stderr.write(`${project} does not look like a Maker project (no assets/ dir)\n`)
      process.exitCode = 2
      return
    }
    if (result.matches.length === 0) {
      process.stdout.write(`${JSON.stringify({ ok: false, query, reason: 'no CC0 match found' }, null, 2)}\n`)
      process.exitCode = 1
      return
    }
    const pickIndex = Number(args.pick ?? 0)
    const chosen = result.matches[Math.min(pickIndex, result.matches.length - 1)]
    const kind = chosen.kind === 'bgm' ? 'bgm' : 'sfx'
    const outName = typeof args.out === 'string' ? args.out : null
    if (chosen.local === false) {
      // Remote source: download on demand (one file), then write .meta.
      const remote = await installRemoteMatch(chosen, project, kind, outName)
      if (!remote.ok) {
        process.stdout.write(`${JSON.stringify({ ok: false, query, source: `${chosen.pack}/${chosen.file}`, error: remote.error }, null, 2)}\n`)
        process.exitCode = 1
        return
      }
      process.stdout.write(`${JSON.stringify({
        ok: true,
        query,
        source: `${chosen.pack}/${chosen.file}`,
        license: chosen.license,
        file: remote.target,
        meta: remote.meta,
        uuid: remote.uuid,
        candidates: result.matches.slice(0, 5).map((m) => `${m.pack}/${m.file}`),
        note: result.note,
      }, null, 2)}\n`)
      return
    }
    const installed = installFile(chosen.abs, project, kind, outName)
    process.stdout.write(`${JSON.stringify({
      ok: true,
      query,
      source: `${chosen.pack}/${chosen.file}`,
      license: 'CC0 (Kenney) — commercial use allowed, no attribution required',
      file: installed.target,
      meta: installed.meta,
      uuid: installed.uuid,
      candidates: result.matches.slice(0, 5).map((m) => `${m.pack}/${m.file}`),
      note: result.note,
    }, null, 2)}\n`)
    return
  }

  process.stderr.write(`unknown command: ${cmd}\n`)
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
