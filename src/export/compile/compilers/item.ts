import { isItemFileName, parseItem } from '../../../workspaces/progress/itemDoc'
import { sourcePathOf } from '../../../workspace'
import type { FileCompiler } from '../types'

/** `src/items/foo.item` → pak 内 `items/foo.it` */
function itemArtifactPath(file: { name: string; srcKind?: string | null }): string {
  const rel = sourcePathOf(file)
  const path = rel.startsWith('src/') ? rel.slice('src/'.length) : rel
  return path.replace(/\.item$/i, '.it')
}

/**
 * `.item` → `.it`：只保留运行时 `item`（id + components），
 * 去掉 format / schemaVersion / tags / display。
 */
export const itemCompiler: FileCompiler = {
  id: 'item',
  match(file) {
    return isItemFileName(file.name)
  },
  async compile(file, ctx) {
    let doc
    try {
      doc = parseItem(file.content)
    } catch (err) {
      ctx.report({
        severity: 'warning',
        code: 'item_compile',
        message: err instanceof Error ? err.message : String(err),
        sourcePath: file.name,
        packageName: ctx.index.package.name,
      })
      return []
    }

    const body = `${JSON.stringify({
      item: {
        id: doc.item.id,
        components: doc.item.components,
      },
    }, null, 2)}\n`

    return [
      {
        path: itemArtifactPath(file),
        bytes: body,
        plane: 'server',
        packageName: ctx.index.package.name,
        sourcePath: file.name,
      },
    ]
  },
}
