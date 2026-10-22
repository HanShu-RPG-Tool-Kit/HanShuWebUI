import type { FileEdit } from './serviceClient'

const commandLabels: Record<string, string> = {
  'ensure-library': '初始化皮肤库',
  'create-folder': '新建皮肤文件夹',
  'patch-folder': '修改皮肤文件夹',
  'delete-folder': '删除空文件夹',
  'delete-folder-entries': '清空文件夹内的皮肤',
  'import-entry': '导入皮肤',
  'batch-patch': '批量修改皮肤',
  'delete-entries': '删除皮肤',
  'rename-tag': '重命名皮肤标签',
  'delete-tag': '删除皮肤标签',
}

/** Human-readable context only. Unknown or malformed commands still keep their
 * original payload for export/retry; this never reconstructs a new request. */
export function skinTransactionDescription(edits: FileEdit[]): string | undefined {
  const edit = edits.find(item => item.op === 'skin-library-command')
  if (!edit) return undefined
  if (typeof edit.data !== 'string') return '皮肤库操作'
  try {
    const command = JSON.parse(edit.data) as Record<string, unknown>
    const label = commandLabels[String(command.command)] ?? '皮肤库操作'
    const name = typeof command.name === 'string' ? command.name
      : typeof command.from === 'string' ? command.from : undefined
    return name ? `${label} · ${name}` : label
  } catch { return '皮肤库操作' }
}
