/**
 * PR2 硬验收：主体不得依赖 Agent 插件。
 *
 * 规则：
 * - `src/plugins/agent/**` 与 `src/app/pluginLoader.ts` 是插件本体/装配点，天然可以互相引用；
 * - 其它 `src/**` 与 `scripts/**`（开发期脚本单独检查）不得 import `plugins/agent`；
 * - 主体样式不再出现 `.agent-*` / `.diff-modal*` 选择器（样式已随插件迁出）。
 *
 * 该脚本在 PR2 清理完成前预期会报出存量违规；清理完成后必须 0 违规。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

const PLUGIN_ROOT = 'src/plugins/agent/'
const LOADER = 'src/app/pluginLoader.ts'
const ASSEMBLY = 'src/app/plugins.ts'

const IMPORT_RE = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
}

function isPluginFile(rel: string): boolean {
  return rel.startsWith(PLUGIN_ROOT) || rel === LOADER || rel === ASSEMBLY
}

const files: string[] = []
walk(SRC, files)

const violations: string[] = []
if (existsSync(join(ROOT, 'src/agent'))) {
  violations.push('src/agent 仍存在（Agent 核心应全部位于 src/plugins/agent/core）')
}
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  if (isPluginFile(rel)) continue
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1]
    const looksLikeAgentCore = /(?:^|\/)agent\/(?!-)/.test(spec)
    if (/(?:^|\/)plugins\/agent(?:\/|$)/.test(spec) || looksLikeAgentCore) {
      const line = text.slice(0, match.index).split('\n').length
      violations.push(`${rel}:${line} imports '${spec}'`)
    }
  }
}

const cssViolations: string[] = []
for (const cssPath of ['src/App.css']) {
  const full = join(ROOT, cssPath)
  try {
    const text = readFileSync(full, 'utf8')
    for (const match of text.matchAll(/(\.agent-[a-z0-9-]+|\.diff-modal[a-z0-9-]*)/gi)) {
      const line = text.slice(0, match.index).split('\n').length
      cssViolations.push(`${cssPath}:${line} contains '${match[0]}'`)
      if (cssViolations.length >= 20) break
    }
  } catch {
    // 文件不存在时忽略（后续可能拆分样式）
  }
}

if (violations.length > 0) {
  console.error('主体依赖 Agent 插件（必须清零）：')
  for (const line of violations) console.error(`  - ${line}`)
}
if (cssViolations.length > 0) {
  console.error('主体样式仍含 Agent 选择器（应随插件迁出）：')
  for (const line of cssViolations) console.error(`  - ${line}`)
}
if (violations.length > 0 || cssViolations.length > 0) process.exit(1)
console.log('Agent 插件隔离检查通过：主体无插件 import，样式无 AGENT 选择器。')
