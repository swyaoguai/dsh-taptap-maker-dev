/**
 * 校验注入给 Python 的脚本语法（不启动浏览器、不联网、不花额度）。
 *
 * 为什么需要：`gen`/`login`/`grab` 的浏览器逻辑都是**字符串模板**里的 Python。
 * 模板里写错缩进或语法，Node 侧完全看不出来，只有真跑浏览器时才炸 ——
 * 那时已经弹了窗口、甚至已经消耗了一次生成。这里在 CI/本地就把语法挡下来。
 *
 * 做法：把模板里的 ${...} 插值替换成合理字面量，套上 runBrowser 的固定包装，
 * 用 Python 的 ast.parse 编译。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let passed = 0
let failed = 0
const ok = (cond, label, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`) }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const src = fs.readFileSync(new URL('../src/taptap-gpt.mjs', import.meta.url), 'utf8')

/** 从源码里取出某个函数内第一个 `const snippet = \`` 模板串的原文。 */
function extractSnippet(fromMarker) {
  const from = src.indexOf(fromMarker)
  if (from < 0) return null
  const decl = src.indexOf('const snippet = `', from)
  if (decl < 0) return null
  let i = decl + 'const snippet = `'.length
  let out = ''
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { out += ch + (src[i + 1] ?? ''); i += 2; continue }
    if (ch === '`') break
    out += ch
    i += 1
  }
  return out
}

/**
 * 把模板里的 ${...} 换成字面量。逐个处理（不依赖具体表达式文本），
 * 这样以后模板里新增插值也不用改测试。
 */
function fillInterpolations(tpl) {
  let out = ''
  let i = 0
  while (i < tpl.length) {
    if (tpl[i] === '$' && tpl[i + 1] === '{') {
      let depth = 1
      let j = i + 2
      while (j < tpl.length && depth > 0) {
        if (tpl[j] === '{') depth += 1
        else if (tpl[j] === '}') depth -= 1
        j += 1
      }
      const expr = tpl.slice(i + 2, j - 1)
      // pyStr(...) → 带引号的字符串；JSON.stringify(...) → JSON 字面量；数字 → 数字
      let repl = '0'
      if (/^pyStr\(/.test(expr.trim())) repl = "'PLACEHOLDER'"
      else if (/^JSON\.stringify\(/.test(expr.trim())) repl = '["C:/x/a.png"]'
      else if (/Math\.floor\(/.test(expr)) repl = '300'
      else if (/^Number\(/.test(expr.trim())) repl = '1'
      out += repl
      i = j
      continue
    }
    out += tpl[i]
    i += 1
  }
  return out
}

/** 按 runBrowser 的方式包装成完整可解析脚本。 */
function wrap(body) {
  const indented = body.split('\n').map((l) => (l.length > 0 ? `    ${l}` : l)).join('\n')
  return [
    'import json',
    'from playwright.sync_api import sync_playwright',
    'result = {"ok": False, "log": [], "error": None}',
    'def _snippet(pg, b, result):',
    indented,
    '    return result',
    'try:',
    '    pass',
    'except Exception as e:',
    '    result["error"] = str(e)',
  ].join('\n')
}

function pySyntaxOk(code, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pycheck-'))
  const file = path.join(dir, 'snippet.py')
  fs.writeFileSync(file, code, 'utf8')
  let okFlag = true
  let detail = ''
  try {
    execFileSync('python', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())', file], { stdio: 'pipe' })
  } catch (e) {
    okFlag = false
    detail = String(e.stderr ?? e.stdout ?? e.message).slice(0, 900)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  ok(okFlag, label, detail)
  return okFlag
}

let hasPython = true
try { execFileSync('python', ['-c', 'import sys'], { stdio: 'ignore' }) } catch { hasPython = false }

if (!hasPython) {
  console.log('（跳过：本机没有 python，无法校验 Python 模板语法）')
  console.log('\n结果：0 项通过，0 项失败')
  process.exit(0)
}

console.log('\n[1] gen() 的浏览器脚本（含参考图上传）语法有效')
{
  const tpl = extractSnippet('export async function gen(')
  ok(tpl !== null, '能取出 gen 的 snippet 模板')
  if (tpl !== null) {
    const code = wrap(fillInterpolations(tpl))
    pySyntaxOk(code, 'gen snippet 可被 Python 解析')
    // 参考图上传的关键调用必须在
    ok(/set_input_files/.test(tpl), 'gen 里有 set_input_files（参考图上传）')
    ok(/input\[type='file'\]/.test(tpl), 'gen 里会查找 file input')
    ok(/ref_upload_no_input/.test(tpl), '找不到 file input 时有明确错误码')
    ok(/thumbs and thumbs >= 1/.test(tpl), '上传后会等缩略图出现（避免附件没传完就发送）')
  }
}

console.log('\n[2] grab() 的浏览器脚本语法有效')
{
  const tpl = extractSnippet('export async function grab(')
  ok(tpl !== null, '能取出 grab 的 snippet 模板')
  if (tpl !== null) pySyntaxOk(wrap(fillInterpolations(tpl)), 'grab snippet 可被 Python 解析')
}

console.log('\n[3] login() 的浏览器脚本语法有效')
{
  const tpl = extractSnippet('export async function login(')
  ok(tpl !== null, '能取出 login 的 snippet 模板')
  if (tpl !== null) pySyntaxOk(wrap(fillInterpolations(tpl)), 'login snippet 可被 Python 解析')
}

console.log('\n[4] 网页通道不假装支持 size')
{
  ok(/网页通道不支持指定尺寸/.test(src), '返回 notes 里如实说明 size 被忽略')
  ok(/size: null/.test(src), 'size 返回 null（不把用户想要的值当成实际值）')
  ok(/requestedSize/.test(src), '另存 requestedSize 以便调用方区分')
}

console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
