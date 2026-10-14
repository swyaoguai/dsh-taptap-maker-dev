#!/usr/bin/env node
/**
 * taptap-music — generate background music through MiniMax's own music API
 * using the user's own API key (M plan / paid). Costs NO Maker credits.
 *
 * Endpoint and models were verified against the live MiniMax docs:
 *   POST https://api.minimax.cn/v1/music_generation
 *   Body: { model, prompt, lyrics?, audio_setting:{sample_rate,bitrate,format},
 *           is_instrumental?, stream?, output_format?, aigc_watermark? }
 *   Response: { data:{ audio (hex|url), status }, extra_info:{ music_duration, ... },
 *               base_resp:{ status_code, status_msg } }
 *
 * The URL is fixed (per the user's request); model + apiKey are user-supplied,
 * exactly like the image lane.
 *
 * IMPORTANT — pricing/availability notice from the vendor docs (2026-08-20):
 *   paid music endpoints stopped onboarding NEW users, and the *-free variants
 *   (music-3.0-free / music-2.6-free / music-cover-free) were discontinued.
 *   Existing paid / M-plan users keep working. This CLI surfaces the vendor's
 *   own error text instead of hiding it.
 *
 * Usage:
 *   node taptap-music.mjs --prompt "史诗管弦战斗音乐" --out D:\tmp\bgm.mp3
 *   node taptap-music.mjs --prompt "..." --out bgm.mp3 --instrumental
 *   node taptap-music.mjs --models              # list available model ids
 *   node taptap-music.mjs --config              # show effective config
 *
 * @module src/taptap-music.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveMusicConfig, maskSecret, musicConfigPath, resolveDshHome } from './paths.js'

/** Fixed endpoint — verified from vendor docs. */
export const MINIMAX_MUSIC_URL = 'https://api.minimax.cn/v1/music_generation'

/**
 * Model ids as documented by MiniMax (verified from the live docs page).
 * M Plan / paid users can use music-3.0 / music-2.6 / music-cover (RPM 120).
 * The *-free variants were DISCONTINUED per the vendor notice; they are listed
 * only so a stale config explains itself instead of failing cryptically.
 */
export const MUSIC_MODELS = [
  { id: 'music-3.0', label: 'music-3.0（推荐 · 文本生成音乐，M Plan/付费，RPM 120）', available: true },
  { id: 'music-2.6', label: 'music-2.6（上一代，M Plan/付费，RPM 120）', available: true },
  { id: 'music-cover', label: 'music-cover（基于参考音频翻唱，M Plan/付费，RPM 120）', available: true },
  { id: 'music-3.0-free', label: 'music-3.0-free（限免版 · 厂商公告已停服）', available: false },
  { id: 'music-2.6-free', label: 'music-2.6-free（限免版 · 厂商公告已停服）', available: false },
  { id: 'music-cover-free', label: 'music-cover-free（限免版 · 厂商公告已停服）', available: false },
]

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else { args[key] = next; i += 1 }
  }
  return args
}

/**
 * Generate music. Resolves output as a file path.
 * `output_format: 'url'` is requested first (smaller response); the URL is
 * valid 24h so we download it immediately. Falls back to hex on failure.
 */
export async function generateMusic(options) {
  const cfg = resolveMusicConfig(options)
  if (cfg.apiKey.length === 0) {
    throw new Error(
      `MiniMax API key not configured. Set apiKey in ${musicConfigPath(options.dshHome)} `
      + 'or env MINIMAX_API_KEY.',
    )
  }
  const model = (typeof options.model === 'string' && options.model) || cfg.model || 'music-3.0'
  const prompt = options.prompt ?? ''
  if (prompt.length === 0) throw new Error('--prompt is required')
  if (prompt.length > 2000) throw new Error(`--prompt too long (${prompt.length} > 2000)`)

  const instrumental = options.instrumental === true || options.instrumental === 'true'
  const body = {
    model,
    prompt,
    audio_setting: {
      sample_rate: Number(options.sampleRate ?? cfg.sampleRate ?? 44100),
      bitrate: Number(options.bitrate ?? cfg.bitrate ?? 256000),
      format: (typeof options.format === 'string' && options.format) || cfg.format || 'mp3',
    },
    output_format: 'url',
  }
  // Instrumental: prompt required, lyrics must be omitted.
  if (instrumental) body.is_instrumental = true
  else if (typeof options.lyrics === 'string' && options.lyrics.length > 0) body.lyrics = options.lyrics

  const response = await fetch(MINIMAX_MUSIC_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(options.timeoutMs ?? cfg.timeoutMs ?? 180000)),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch {
    throw new Error(`non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`)
  }
  const statusCode = json?.base_resp?.status_code
  const statusMsg = json?.base_resp?.status_msg ?? ''
  if (statusCode !== undefined && statusCode !== 0) {
    // Translate the two common vendor codes the user will actually hit so the
    // failure path is self-explanatory instead of a wall of English JSON.
    let hint = ''
    if (statusCode === 1004) hint = '（key 无效/未带；请检查 music.json 里的 apiKey 字段）'
    if (statusCode === 2153) hint = '（该 key 已被厂商认定为"新用户"：M Plan 历史付费用户应该可用，新 key 可能要走 MiniMax Audio）'
    if (statusCode === 1002) hint = '（触发限流；稍后重试）'
    throw new Error(`MiniMax error ${statusCode}: ${statusMsg || text.slice(0, 200)}${hint}`)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)

  const audio = json?.data?.audio
  if (typeof audio !== 'string' || audio.length === 0) {
    throw new Error(`no audio in response: ${text.slice(0, 200)}`)
  }

  const out = options.out
  fs.mkdirSync(path.dirname(out), { recursive: true })
  let bytes
  let via
  if (/^https?:\/\//i.test(audio)) {
    const dl = await fetch(audio, { signal: AbortSignal.timeout(120000) })
    if (!dl.ok) throw new Error(`audio download failed HTTP ${dl.status}`)
    bytes = Buffer.from(await dl.arrayBuffer())
    via = 'url'
  } else {
    // hex payload
    bytes = Buffer.from(audio, 'hex')
    via = 'hex'
  }
  if (bytes.length === 0) throw new Error('decoded audio is empty')
  fs.writeFileSync(out, bytes)
  return {
    out,
    bytes: bytes.length,
    via,
    model,
    durationMs: json?.extra_info?.music_duration ?? null,
    sampleRate: json?.extra_info?.music_sample_rate ?? null,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.models === true) {
    process.stdout.write(`${JSON.stringify({ models: MUSIC_MODELS.map((m) => m.id) }, null, 2)}\n`)
    return
  }
  if (args.config === true) {
    const cfg = resolveMusicConfig(args)
    process.stdout.write(`${JSON.stringify({
      endpoint: MINIMAX_MUSIC_URL,
      configFile: musicConfigPath(args.dshHome),
      dshHome: resolveDshHome(args.dshHome),
      model: cfg.model || '(unset)',
      apiKey: maskSecret(cfg.apiKey),
      format: cfg.format ?? 'mp3',
    }, null, 2)}\n`)
    return
  }
  if (typeof args.prompt !== 'string' || typeof args.out !== 'string') {
    process.stderr.write(
      'usage: taptap-music --prompt "<描述>" --out <file.mp3> [--instrumental] [--lyrics "..."] [--model music-3.0]\n',
    )
    process.exitCode = 2
    return
  }
  const result = await generateMusic(args)
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
