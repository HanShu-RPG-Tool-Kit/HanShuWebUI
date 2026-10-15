import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { rustCommand } from './rust-command.mjs'

const root = resolve(import.meta.dirname, '..')
const rust = rustCommand(root)
const cli = spawn(process.execPath, [resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)], { cwd: root, env: rust.env, stdio: 'inherit', windowsHide: true })
cli.on('error', error => { console.error(error.message); process.exitCode = 1 })
cli.on('exit', code => { process.exitCode = code ?? 1 })
