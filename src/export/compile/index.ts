import type { Project, Workspace } from '../../workspace'
import { ensureBuiltinCompilers } from './compilers/registerBuiltin'
import { hasLinkErrors, linkArtifacts } from './link'
import { listFileCompilers, listPackagePasses } from './registry'
import type {
  CompileArtifact,
  CompileContext,
  CompileDiagnostic,
  CompileGraph,
  CompileIndex,
} from './types'

export type { CompileArtifact, CompileDiagnostic, CompileGraph, Plane, SymbolRef } from './types'
export { registerFileCompiler, registerPackagePass } from './registry'
export { ensureBuiltinCompilers } from './compilers/registerBuiltin'

function buildIndex(workspace: Workspace, pkg: Project): CompileIndex {
  const scriptsByName = new Map(pkg.scripts.map((s) => [s.name, s]))
  const assetsByPath = new Map(
    pkg.assets.map((a) => [a.path.replace(/\\/g, '/'), a]),
  )
  return { workspace, package: pkg, scriptsByName, assetsByPath }
}

/**
 * 编译整个工作区：文件编译器 → 包级 pass → 接线检查。
 * 有 error 级诊断时仍返回 graph（由打包层决定是否中止）。
 */
export async function buildCompileGraph(
  workspace: Workspace,
): Promise<CompileGraph> {
  ensureBuiltinCompilers()
  const diagnostics: CompileDiagnostic[] = []
  const artifacts: CompileArtifact[] = []
  const compilers = listFileCompilers()
  const passes = listPackagePasses()

  if (workspace.packages.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'empty_workspace',
      message: '工作区没有包，导出为空',
    })
  }

  for (const pkg of workspace.packages) {
    const index = buildIndex(workspace, pkg)
    const ctx: CompileContext = {
      index,
      report(d) {
        diagnostics.push({ ...d, packageName: d.packageName ?? pkg.name })
      },
    }

    const fromFiles: CompileArtifact[] = []
    for (const script of pkg.scripts) {
      // 专用编译器优先于 identity，避免注册顺序踩坑
      const compiler =
        compilers.find(
          (c) => c.id !== 'identity' && c.match(script, index),
        ) ?? compilers.find((c) => c.id === 'identity' && c.match(script, index))
      if (!compiler) continue
      const produced = await compiler.compile(script, ctx)
      fromFiles.push(...produced)
    }

    let packageArts = fromFiles
    for (const pass of passes) {
      const more = await pass.run(packageArts, ctx)
      packageArts = [...packageArts, ...more]
    }
    artifacts.push(...packageArts)
  }

  diagnostics.push(...linkArtifacts(artifacts))
  return { artifacts, diagnostics }
}

export function compileGraphHasErrors(graph: CompileGraph): boolean {
  return hasLinkErrors(graph.diagnostics)
}

/** 诊断格式化成导出警告字符串（兼容旧 ExportWarning） */
export function formatDiagnostics(
  diagnostics: CompileDiagnostic[],
): string[] {
  return diagnostics.map((d) => {
    const where = d.packageName
      ? `[${d.packageName}] ${d.sourcePath ?? ''}`
      : (d.sourcePath ?? '')
    const head = where.trim() ? `${where}: ` : ''
    return `${head}${d.message}`
  })
}
