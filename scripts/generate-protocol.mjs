import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { rustCommand } from './rust-command.mjs'
const root = resolve(import.meta.dirname, '..')
const rust = rustCommand(root)
const result = spawnSync(rust.command, ['run', '--quiet', '--manifest-path', 'src-tauri/Cargo.toml', '-p', 'project-core', '--example', 'export_protocol'], { cwd: root, env: rust.env, encoding: 'utf8', windowsHide: true })
if (result.status !== 0) { console.error(result.stderr || result.error); process.exit(1) }
const file = resolve(root, 'src/collab/generated.ts')
const output = result.stdout.replace(/\r\n/g, '\n')
if (process.argv.includes('--check')) {
  if (!existsSync(file) || readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== output) { console.error('协议类型已过时，请运行 npm run generate:protocol'); process.exit(1) }
  console.log('C/S 协议类型与 Rust 模型一致。')
} else { mkdirSync(resolve(root, 'src/collab'), { recursive: true }); writeFileSync(file, output) }
