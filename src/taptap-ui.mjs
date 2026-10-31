#!/usr/bin/env node
/** UI CLI entry. No shell expansion, replacement server or implicit game cwd. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runUiCommand, parseUiCommand } from './ui-command.mjs'
export { runUiCommand, parseUiCommand } from './ui-command.mjs'

let main = false
try { main = !!process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { /* imported module, not executable entry */ }
if (main) {
  try {
    const args = process.argv.slice(2); const { flags } = parseUiCommand(args)
    const result = await runUiCommand(args)
    console.log(result.help && !flags.json ? result.help : JSON.stringify(result, null, 2))
    if (result.ok === false || result.ready === false) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code ?? 'UI_ERROR', error: error.message, details: error.details, action: '未覆盖旧版、启动引擎或自动重试。' }, null, 2))
    process.exitCode = 1
  }
}
