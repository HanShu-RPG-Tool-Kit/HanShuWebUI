import { parseBossbar, parseBossbarDocument, stringifyBossbar } from '../../../workspaces/audiovisual/bossbar/parse'
import { BOSSBAR_LIMITS } from '../../../workspaces/audiovisual/bossbar/protocol'
import { sourcePathOf } from '../../../workspace'
import type { CompileArtifact, CompileContext, FileCompiler } from '../types'
import type { SourceFile } from '../../../workspace'

/**
 * `.bossbar` 专用编译器。
 *
 * 完整 v2 文档（含唯一 Base64 PNG 图集）放进 client 平面。
 * 服务端只发送变量，不加载模板。不产出外部 PNG 或资源清单。
 * `templateHash` 由读取方对实际编译字节取 SHA-256，不写回文档。
 */

function artifactPathOf(file: { name: string }): string {
  const rel = sourcePathOf(file)
  const path = rel.startsWith('src/') ? rel.slice('src/'.length) : rel
  return path.replace(/\.bossbar$/i, '.bossbar')
}

/** 与打包顺序一致，同路径由后面的包覆盖；只检查最终有效模板。 */
function effectiveTemplates(ctx: CompileContext) {
  const packages = ctx.index.workspace.packages.map(pkg => pkg.id === ctx.index.package.id ? ctx.index.package : pkg)
  if (!packages.some(pkg => pkg.id === ctx.index.package.id)) packages.push(ctx.index.package)
  const templates = new Map<string, { packageId: string; packageName: string; source: SourceFile }>()
  for (const pkg of packages) {
    for (const script of pkg.scripts) {
      if (!script.name.toLowerCase().endsWith('.bossbar')) continue
      templates.set(artifactPathOf(script), { packageId: pkg.id, packageName: pkg.name, source: script })
    }
  }
  return templates
}

export const bossbarCompiler: FileCompiler = {
  id: 'bossbar',
  match(file) {
    return file.name.toLowerCase().endsWith('.bossbar')
  },
  async compile(file, ctx): Promise<CompileArtifact[]> {
    const report = (message: string, path = '') =>
      ctx.report({ severity: 'error', code: 'bossbar_compile', message: path ? path + '：' + message : message, sourcePath: file.name })

    const templates = effectiveTemplates(ctx)
    const ownPath = artifactPathOf(file)
    const effective = templates.get(ownPath)
    if (effective && (effective.packageId !== ctx.index.package.id || effective.source.id !== file.id)) return []

    let document
    try {
      document = parseBossbar(file.content)
    } catch (cause) {
      const diagnostics = (cause as { diagnostics?: { path: string; message: string }[] }).diagnostics
      if (diagnostics?.length) {
        for (const diagnostic of diagnostics) report(diagnostic.message, diagnostic.path)
      } else {
        report(cause instanceof Error ? cause.message : String(cause))
      }
      return []
    }

    for (const [path, template] of templates) {
      if (path === ownPath) continue
      const result = parseBossbarDocument(template.source.content)
      if (result.ok && result.document.id === document.id) {
        report('模板 ID ' + document.id + ' 与 ' + template.packageName + '/' + template.source.name + ' 重复，PAK 中不同路径不能有相同 ID')
        return []
      }
    }

    const bytes = stringifyBossbar(document)
    const byteLength = new TextEncoder().encode(bytes).length
    if (byteLength > BOSSBAR_LIMITS.documentBytes) {
      report('规范文档 ' + byteLength + ' 字节，超过上限 ' + BOSSBAR_LIMITS.documentBytes)
      return []
    }

    return [
      {
        path: artifactPathOf(file),
        bytes,
        plane: 'client',
        packageName: ctx.index.package.name,
        sourcePath: file.name,
      },
    ]
  },
}
