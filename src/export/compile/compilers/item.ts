import { readItemSync, syncRuleErrors } from '../../../workspaces/progress/itemSync'
import { isItemFileName, parseItem, type ItemDocument } from '../../../workspaces/progress/itemDoc'
import { sourcePathOf } from '../../../workspace'
import type { FileCompiler } from '../types'

export function itemTemplateArtifact(doc: ItemDocument) {
  const sync=readItemSync(doc.sync), errors=syncRuleErrors(sync,doc.item.components)
  if(errors.length)throw Error(errors.join('；'))
  return {
    format: 'rpgtoolkit:item-template', schemaVersion: 1,
    componentFormat: 'tnbt-json-v1', componentMode: 'complete',
    sync, item: doc.item,
  }
}

/** `src/items/foo.item` → pak 内 `items/foo.it` */
function itemArtifactPath(file: { name: string; srcKind?: string | null }): string {
  const rel = sourcePathOf(file)
  const path = rel.startsWith('src/') ? rel.slice('src/'.length) : rel
  return path.replace(/\.item$/i, '.it')
}

/**
 * `.item` → `.it`：输出运行时 item、同步规则与协议版本，
 * 不携带作者标签和展示快照。
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
      const errors = syncRuleErrors(readItemSync(doc.sync), doc.item.components)
      if (errors.length) throw Error(errors.join('；'))
    } catch (err) {
      ctx.report({
        severity: 'error',
        code: 'item_compile',
        message: err instanceof Error ? err.message : String(err),
        sourcePath: file.name,
        packageName: ctx.index.package.name,
      })
      return []
    }

    const body = `${JSON.stringify(itemTemplateArtifact(doc), null, 2)}\n`

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
