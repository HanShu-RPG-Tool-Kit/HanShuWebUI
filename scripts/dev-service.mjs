import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { rustCommand } from './rust-command.mjs'

const root = resolve(import.meta.dirname, '..')
const windows = process.platform === 'win32'
const executable = name => windows ? `${name}.exe` : name
const rust = rustCommand(root)
const children = new Set()
let shuttingDown = false; let server; let building = false; let pending = false; let timer
const watchers = []
function launch(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: {...rust.env, ...env}, stdio: 'inherit', windowsHide: true })
  children.add(child); child.on('exit', () => children.delete(child)); return child
}
function stop(child) {
  if (!child || child.exitCode !== null) return
  if (windows) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  else child.kill('SIGTERM')
}
function shutdown(code = 0) { if (shuttingDown) return; shuttingDown = true; clearTimeout(timer); watchers.forEach(w => w.close()); children.forEach(stop); setTimeout(() => process.exit(code), 300) }
process.on('SIGINT', () => shutdown()); process.on('SIGTERM', () => shutdown())
async function rebuild() {
  if (building) { pending = true; return }
  building = true; pending = false
  if (server) { const old = server; server = undefined; stop(old); await new Promise(r => old.exitCode === null ? old.once('exit', r) : r()) }
  const build = launch(rust.command, ['build', '--manifest-path', 'src-tauri/Cargo.toml', '-p', 'project-server'])
  const code = await new Promise(resolve => { build.once('exit', resolve); build.once('error', e => { console.error('无法启动 Cargo，请安装 Rust 或设置 HANSHU_CARGO。', e.message); resolve(1) }) })
  building = false
  if (shuttingDown) return
  if (code !== 0) { console.error('S 编译失败，修复后保存 Rust 文件会重试。'); return }
  const running = launch(resolve(root, 'src-tauri/target/debug', executable('project-server')), ['--project', process.env.HANSHU_PROJECT_DIR ?? '.hanshu-project', '--listen', '127.0.0.1:47831', '--local-projects', 'true'], {HANSHU_WEB_ROOT: resolve(root, 'dist')})
  server = running
  running.once('exit', code => { if (server === running && !shuttingDown) { console.error(`工程服务退出：${code}`); shutdown(code ?? 1) } })
  if (pending) void rebuild()
}
for (const directory of ['src-tauri/crates/project-core/src', 'src-tauri/crates/project-server/src']) {
  watchers.push(watch(resolve(root, directory), { recursive: true }, (_, filename) => { if (!filename?.endsWith('.rs')) return; clearTimeout(timer); timer = setTimeout(() => void rebuild(), 400) }))
}
if (!process.argv.includes('--server-only')) {
  const vite = launch(process.execPath, ['node_modules/vite/bin/vite.js'])
  vite.once('error', e => { console.error(e.message); shutdown(1) }); vite.once('exit', code => shutdown(code ?? 0))
}
// LAN guests receive the built application directly from S, without a dev proxy.
const web = launch(process.execPath, ['node_modules/vite/bin/vite.js', 'build'])
web.once('error', e => { console.error(e.message); shutdown(1) })
web.once('exit', code => { if (code === 0) void rebuild(); else shutdown(code ?? 1) })
