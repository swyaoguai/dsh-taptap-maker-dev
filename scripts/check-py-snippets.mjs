#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SRC = path.join(process.cwd(), 'src', 'taptap-gpt.mjs')
const SRC_BGM = path.join(process.cwd(), 'src', 'taptap-bgm-web.mjs')
const text = fs.readFileSync(SRC, 'utf8')
const textBgm = fs.readFileSync(SRC_BGM, 'utf8')

function snippetBetween(text, startMarker, endMarker) {
  const a = text.indexOf(startMarker)
  if (a < 0) throw new Error(`start marker not found: ${startMarker}`)
  const b = text.indexOf(endMarker, a)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}`)
  const raw = text.slice(a + startMarker.length, b)
  return raw.replace(/`\s*$/, '')
}

const snippets = {
  gen: snippetBetween(text, 'const snippet = `import time, os\n', '\n\n  // The python side keeps waiting'),
  grab: snippetBetween(text, 'const snippet = `import time, os, base64 as _b64\n', '\n  const r = await runBrowser(dshHome, snippet, { headless: false, timeoutMs: waitMs + 120000, accountId: account })'),
  'bgm-generate': snippetBetween(textBgm, 'const snippet = `import time, os, base64\n', '\n  // MUST run headed'),
}

const wrapper = (body) => `import json
from playwright.sync_api import sync_playwright
result = {"ok": False, "log": [], "error": None}
def _snippet(pg, b, result):
${body.split('\n').map((l) => (l.length > 0 ? `    ${l}` : l)).join('\n')}
    return result
print("ok")
`

let failed = 0

// 第 0 步：先验宿主 JS 文件本身的语法。内嵌 Python 片段住在 JS template
// literal 里，Python 注释里一个反引号就会终止外层字符串、把整个模块炸成
// SyntaxError（2026-10-24 实际发生：check-py-snippets 只验 Python 反而全绿，
// 由 verify-host-routes 抓到）。先 node --check 宿主，这类错误当场暴露。
for (const host of [SRC, SRC_BGM]) {
  const r = spawnSync(process.execPath, ['--check', host], { encoding: 'utf8' })
  const label = path.basename(host)
  if (r.status === 0) {
    process.stdout.write(`${label}: host JS syntax OK\n`)
  } else {
    failed += 1
    process.stdout.write(`${label}: host JS syntax FAILED\n${r.stderr}\n`)
  }
}

for (const [name, body] of Object.entries(snippets)) {
  const filled = body.replace(/\$\{[^}]*\}/g, 'X')
  const py = wrapper(filled)
  const file = path.join(os.tmpdir(), `check-${name}.py`)
  fs.writeFileSync(file, py, 'utf8')
  const r = spawnSync('python', ['-m', 'py_compile', file], { encoding: 'utf8' })
  if (r.status === 0) {
    process.stdout.write(`${name}: python syntax OK\n`)
  } else {
    failed += 1
    process.stdout.write(`${name}: python syntax FAILED\n${r.stderr}\n`)
  }
}
process.exitCode = failed > 0 ? 1 : 0
