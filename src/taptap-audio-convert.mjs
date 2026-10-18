#!/usr/bin/env node
/**
 * taptap-audio-convert — batch-convert / compress / normalize game audio with
 * ffmpeg, so assets downloaded from CC0 libraries (often .ogg or .mp3) land in
 * the format a Maker project expects (the bundled project uses .wav), at a sane
 * size and loudness.
 *
 * Every conversion is local and offline; no Maker credits, no network.
 *
 * Usage:
 *   node taptap-audio-convert.mjs --in D:\tmp\coin.ogg --out D:\tmp\coin.wav
 *   node taptap-audio-convert.mjs --in <maker-project>\assets\audio\sfx --out D:\tmp\wav --to wav
 *   node taptap-audio-convert.mjs --in sfx --out out --to wav --mono --rate 44100 --normalize --trim --fade-out 0.05
 *   node taptap-audio-convert.mjs --in bgm.ogg --out bgm_loop.ogg --loop 8
 *   node taptap-audio-convert.mjs --in bgm.mp3 --out cut.wav --start 12.5 --end 48 --fade-in 0.3 --fade-out 0.5
 *   node taptap-audio-convert.mjs --probe D:\tmp\coin.ogg
 *
 * Requires ffmpeg + ffprobe on PATH (or set FFMPEG / FFPROBE). If missing, the
 * script prints the exact install hint instead of failing silently.
 *
 * @module src/taptap-audio-convert.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm'])

/** Container → default encoder args. */
const TARGETS = {
  wav: { ext: '.wav', args: ['-c:a', 'pcm_s16le'] },
  mp3: { ext: '.mp3', args: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
  ogg: { ext: '.ogg', args: ['-c:a', 'libvorbis', '-q:a', '4'] },
  opus: { ext: '.opus', args: ['-c:a', 'libopus', '-b:a', '96k'] },
  m4a: { ext: '.m4a', args: ['-c:a', 'aac', '-b:a', '192k'] },
  flac: { ext: '.flac', args: ['-c:a', 'flac'] },
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const key = t.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else { args[key] = next; i += 1 }
  }
  return args
}

const binCache = new Map() // `${name}:${envValue}` -> resolved bin | null
function resolveBin(name, envVar) {
  const key = `${name}:${process.env[envVar] ?? ''}`
  if (binCache.has(key)) return binCache.get(key)
  let result = process.env[envVar] || null
  if (result === null) {
    const probe = spawnSync(name, ['-version'], { stdio: 'ignore' })
    result = probe.status === 0 ? name : null
  }
  binCache.set(key, result)
  return result
}

const ffmpegBin = () => resolveBin('ffmpeg', 'FFMPEG')
const ffprobeBin = () => resolveBin('ffprobe', 'FFPROBE')

/** Probe duration in seconds (needed for fade-out). */
export function probeDuration(file) {
  const bin = ffprobeBin()
  if (bin === null) return null
  const r = spawnSync(bin, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const v = Number.parseFloat((r.stdout || '').trim())
  return Number.isFinite(v) ? v : null
}

/**
 * Async variant so callers can probe MANY files concurrently (the BGM
 * workbench library view probes every download; serial spawnSync made the
 * first load take ~150ms × file count).
 */
export function probeDurationAsync(file) {
  return new Promise((resolve) => {
    const bin = ffprobeBin()
    if (bin === null) return resolve(null)
    execFile(bin, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], { timeout: 15000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      const v = Number.parseFloat(String(stdout ?? '').trim())
      resolve(Number.isFinite(v) ? v : null)
    })
  })
}

/** Build the -af filter chain from options. */
function buildFilter(opts, duration) {
  const parts = []
  if (opts.trim === true || opts.trim === 'true') {
    // Strip leading silence, then trailing silence via the reverse trick.
    const lead = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05:detection=peak'
    parts.push(lead, 'areverse', lead, 'areverse')
  }
  if (opts.normalize === true || opts.normalize === 'true') {
    parts.push('loudnorm=I=-16:TP=-1.5:LRA=11')
  }
  const fadeIn = Number(opts['fade-in'] ?? opts.fadeIn ?? 0)
  const fadeOut = Number(opts['fade-out'] ?? opts.fadeOut ?? 0)
  if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${fadeIn}`)
  if (fadeOut > 0 && duration !== null && duration > fadeOut) {
    parts.push(`afade=t=out:st=${(duration - fadeOut).toFixed(3)}:d=${fadeOut}`)
  }
  return parts.length > 0 ? parts.join(',') : null
}

/** Convert one file. Returns a result object. */
export function convertFile(src, dst, opts) {
  const to = (typeof opts.to === 'string' && opts.to) || 'wav'
  const target = TARGETS[to] ?? TARGETS.wav
  const bin = ffmpegBin()
  if (bin === null) throw new Error('ffmpeg not found on PATH; install it or set FFMPEG=<path>')

  if (path.extname(dst).toLowerCase() !== target.ext) {
    dst = `${dst.replace(/\.[^.]+$/, '')}${target.ext}`
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })

  // Precise time-range cut (--start/--end, seconds). `-ss` before `-i` seeks
  // (fast, frame-accurate enough for music), `-t` caps the output duration so
  // the cut length is exactly end-start regardless of source oddities.
  //
  // A malformed range must NOT fall through to "convert the whole file": that
  // looks like success and ships the wrong audio. Same for a range that starts
  // past the end of the source (ffmpeg happily writes an empty file).
  const hasStart = opts.start !== undefined && opts.start !== null && opts.start !== ''
  const hasEnd = opts.end !== undefined && opts.end !== null && opts.end !== ''
  const start = hasStart ? Number(opts.start) : 0
  if (!Number.isFinite(start) || start < 0) {
    throw new Error(`invalid --start "${opts.start}": expected seconds, e.g. --start 12.5`)
  }
  let end = hasEnd ? Number(opts.end) : null
  if (hasEnd && (!Number.isFinite(end) || end <= start)) {
    throw new Error(`invalid --end "${opts.end}": must be a number of seconds greater than --start (${start})`)
  }

  const fullDuration = probeDuration(src)
  if (end !== null && fullDuration !== null && end > fullDuration) end = fullDuration
  if (fullDuration !== null && start >= fullDuration) {
    throw new Error(`--start ${start}s is past the end of ${path.basename(src)} (${fullDuration.toFixed(2)}s)`)
  }

  const before = fs.statSync(src).size
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (start > 0) args.push('-ss', String(start))
  args.push('-i', src)
  const mono = opts.mono === true || opts.mono === 'true'
  const rate = Number(opts.rate ?? 0)
  const bitrate = typeof opts.bitrate === 'string' ? opts.bitrate : null

  const aArgs = [...target.args]
  if (end !== null) aArgs.push('-t', String(Number((end - start).toFixed(3))))
  if (bitrate !== null) {
    // Replace the encoder's default bitrate/quality slot.
    const bi = aArgs.findIndex((a) => a === '-b:a' || a === '-q:a')
    if (bi >= 0) { aArgs[bi + 1] = bitrate } else { aArgs.push('-b:a', bitrate) }
  }
  if (mono) aArgs.push('-ac', '1')
  if (rate > 0) aArgs.push('-ar', String(rate))

  // Fade-out must sit at the END OF THE CUT, not of the source file.
  const cutDuration = start > 0 || end !== null
    ? (end !== null
        ? end - start
        : (fullDuration !== null ? Math.max(fullDuration - start, 0) : null))
    : fullDuration
  const filter = buildFilter(opts, cutDuration)
  if (filter !== null) args.push('-af', filter)
  args.push(...aArgs, dst)

  const r = spawnSync(bin, args, { encoding: 'utf8' })
  if (r.status !== 0) {
    const detail = (r.stderr || '').trim().split('\n').slice(-1)[0] ?? ''
    throw new Error(detail.length > 0
      ? `ffmpeg failed on ${path.basename(src)}: ${detail}`
      : `ffmpeg failed on ${path.basename(src)} (exit ${r.status}); is the ffmpeg binary valid? install: winget install Gyan.FFmpeg`)
  }
  return {
    src, dst, from: path.extname(src).slice(1), to: target.ext.slice(1),
    bytesBefore: before, bytesAfter: fs.statSync(dst).size,
    duration: cutDuration === null ? null : Number(cutDuration.toFixed(2)),
    start: start > 0 ? start : null, end,
    mono, rate: rate > 0 ? rate : null, filter,
  }
}

/**
 * Make a seamless-ish loop by concatenating `times` copies with a short
 * crossfade. Useful for BGM made from a short one-shot.
 */
export function makeLoop(src, dst, times, opts) {
  const bin = ffmpegBin()
  if (bin === null) throw new Error('ffmpeg not found; install it or set FFMPEG=<path>')
  const count = Math.max(2, Math.min(Number(times ?? 2), 20))
  const inputs = []
  for (let i = 0; i < count; i += 1) inputs.push('-i', src)
  const labels = Array.from({ length: count }, (_, i) => `[${i}:a]`).join('')
  const filter = `${labels}concat=n=${count}:v=0:a=1[out]`
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const r = spawnSync(bin, ['-y', '-hide_banner', '-loglevel', 'error', ...inputs,
    '-filter_complex', filter, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k', dst],
    { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`loop failed: ${(r.stderr || '').trim().split('\n').slice(-1)[0] ?? 'unknown'}`)
  return { src, dst, copies: count, bytes: fs.statSync(dst).size }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (typeof args.probe === 'string') {
    const file = args.probe
    if (!fs.existsSync(file)) { process.stderr.write(`not found: ${file}\n`); process.exitCode = 2; return }
    const d = probeDuration(file)
    process.stdout.write(`${JSON.stringify({ file, durationSec: d, bytes: fs.statSync(file).size }, null, 2)}\n`)
    return
  }

  const input = typeof args.in === 'string' ? path.resolve(args.in) : null
  if (input === null) {
    process.stderr.write('usage: taptap-audio-convert --in <file|dir> --out <file|dir> [--to wav] [--start <sec>] [--end <sec>] [--mono] [--rate 44100] [--normalize] [--trim] [--fade-in 0.3] [--fade-out 0.5] [--loop N]\n')
    process.exitCode = 2
    return
  }
  if (!fs.existsSync(input)) { process.stderr.write(`not found: ${input}\n`); process.exitCode = 2; return }
  if (ffprobeBin() === null && ffmpegBin() === null) {
    process.stderr.write('ffmpeg/ffprobe not found. Install ffmpeg (e.g. `winget install Gyan.FFmpeg`) or set FFMPEG/FFPROBE env vars.\n')
    process.exitCode = 2
    return
  }

  const out = typeof args.out === 'string' ? path.resolve(args.out) : null
  if (out === null) { process.stderr.write('--out is required\n'); process.exitCode = 2; return }

  // Loop mode: single file in, single file out.
  if (args.loop !== undefined && fs.statSync(input).isFile()) {
    try {
      const r = makeLoop(input, out, args.loop, args)
      process.stdout.write(`${JSON.stringify({ ok: true, ...r }, null, 2)}\n`)
    } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1 }
    return
  }

  const isDir = fs.statSync(input).isDirectory()
  const files = isDir
    ? fs.readdirSync(input).filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase())).map((f) => path.join(input, f))
    : [input]

  if (files.length === 0) { process.stderr.write(`no audio files in ${input}\n`); process.exitCode = 1; return }

  const results = []
  let failed = 0
  for (const f of files) {
    const dst = isDir
      ? path.join(out, `${path.basename(f, path.extname(f))}${(TARGETS[args.to] ?? TARGETS.wav).ext}`)
      : out
    try {
      results.push(convertFile(f, dst, args))
    } catch (e) {
      failed += 1
      results.push({ src: f, error: e.message })
    }
  }

  const ok = results.filter((r) => !r.error)
  const savedBefore = ok.reduce((a, r) => a + r.bytesBefore, 0)
  const savedAfter = ok.reduce((a, r) => a + r.bytesAfter, 0)
  process.stdout.write(`${JSON.stringify({
    ok: failed === 0,
    converted: ok.length,
    failed,
    to: (typeof args.to === 'string' && args.to) || 'wav',
    bytesBefore: savedBefore,
    bytesAfter: savedAfter,
    files: results.map((r) => (r.error
      ? { file: path.basename(r.src), error: r.error }
      : {
        file: path.basename(r.dst),
        from: r.from, to: r.to,
        kbBefore: Math.round(r.bytesBefore / 1024),
        kbAfter: Math.round(r.bytesAfter / 1024),
        duration: r.duration,
        start: r.start,
        end: r.end,
      })),
  }, null, 2)}\n`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
