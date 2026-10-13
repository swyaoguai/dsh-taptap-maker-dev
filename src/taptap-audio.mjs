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

/** Write the asset plus its Maker .meta file. */
function installFile(srcAbs, project, kind, outName) {
  const dir = audioDir(project, kind)
  fs.mkdirSync(dir, { recursive: true })
  const name = outName && outName.length > 0 ? outName : `${path.basename(srcAbs, path.extname(srcAbs))}${path.extname(srcAbs)}`
  const target = path.join(dir, name)
  fs.copyFileSync(srcAbs, target)
  const meta = path.join(dir, `${name}.meta`)
  if (!fs.existsSync(meta)) {
    fs.writeFileSync(meta, `${JSON.stringify({ uuid: newAssetUuid() }, null, 2)}\n`)
  }
  return { target, meta, uuid: JSON.parse(fs.readFileSync(meta, 'utf8')).uuid }
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

  const query = args._.slice(1).join(' ')
  if (query.length === 0) {
    process.stderr.write('usage: taptap-audio search "<描述>" | add "<描述>" --project <dir> [--out name.wav] | sync\n')
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
