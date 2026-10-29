// 离线检查：整合进来的两个第三方 skill 能被 provider 正常发现并读取。
// 用法：node scripts/verify-integrated-skills.mjs
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const mod = pathToFileURL(path.join(root, 'src', 'skills-provider.js')).href
const { TaptapSkillProvider } = await import(mod)
const p = new TaptapSkillProvider('t', [{ dir: path.join(root, 'skills'), rank: 360 }], { disabledFile: null })
const list = p.listAll()
let failed = 0
for (const n of ['zaiduyu-imagegen', 'taptap-maker-local-sfx']) {
  const s = list.find((x) => x.name === n)
  if (!s) { console.log(`MISSING: ${n}`); failed += 1; continue }
  console.log(`OK: ${n}  (desc ${s.description.length} 字, disabled=${s.disabled})`)
  const def = await p.get({ ...s, locator: { file: path.join(root, 'skills', n, 'SKILL.md'), base: path.join(root, 'skills', n) } })
  if (!def?.content || def.content.length < 200) { console.log(`  !! 正文读取失败 ${n}`); failed += 1 }
  else console.log(`  正文 ${def.content.length} 字`)
}
console.log(`总计 ${list.length} 个 skill`)
process.exitCode = failed > 0 ? 1 : 0
