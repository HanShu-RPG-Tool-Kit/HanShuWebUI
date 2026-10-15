import { existsSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { homedir } from 'node:os'

/** Standard Rust installation first; workspace-local tools are an optional development fallback. */
export function rustCommand(root) {
  const binary = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const portableHome = resolve(root, '../.tools/cargo')
  const portable = join(portableHome, 'bin', binary)
  const candidates = [process.env.HANSHU_CARGO, process.env.CARGO_HOME && join(process.env.CARGO_HOME, 'bin', binary), join(homedir(), '.cargo/bin', binary), portable].filter(Boolean)
  const command = candidates.find(existsSync) ?? 'cargo'
  const env = { ...process.env }
  if (command === portable) {
    env.CARGO_HOME ??= portableHome
    env.RUSTUP_HOME ??= resolve(root, '../.tools/rustup')
    env.PATH = `${join(portableHome, 'bin')}${delimiter}${env.PATH ?? ''}`
  }
  return { command, env }
}
