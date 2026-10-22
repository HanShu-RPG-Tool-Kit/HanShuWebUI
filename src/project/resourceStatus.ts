import type { EditTransactionState, TransactionInfo } from './editTransactions'
import type { FileEdit, ProjectClient } from './serviceClient'

export type ResourceScope = { path: string; entryId?: string | null; transactionId?: number; command?: string }
const overlaps = (left: string, right: string) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)

export function editMatchesResource(edit: FileEdit, scope: ResourceScope, authority: (path: string) => string | undefined): boolean {
  if (scope.entryId || scope.command) {
    if (edit.path !== scope.path || !['skin-entry-patch', 'skin-library-command'].includes(edit.op) || typeof edit.data !== 'string') return false
    try {
      const command = JSON.parse(edit.data)
      if (scope.command && command.command !== scope.command) return false
      if (!scope.entryId) return true
      if (edit.op === 'skin-entry-patch') return command.entryId === scope.entryId
      return command.entry?.entryId === scope.entryId || Array.isArray(command.expectedEntries) && command.expectedEntries.some((entry: { entryId?: string }) => entry.entryId === scope.entryId)
    } catch { return false }
  }
  return [edit.path, edit.destination, ...(edit.affectedPaths ?? [])].some(path => path && (overlaps(path, scope.path) || authority(path) === scope.path))
}

export function resourceTransactions(client: Pick<ProjectClient, 'transactions' | 'editingAuthority'>, scope: ResourceScope, state: EditTransactionState): TransactionInfo[] {
  return state.transactions.filter(transaction => {
    if (scope.transactionId !== undefined && transaction.id !== scope.transactionId) return false
    if (transaction.phase === 'saved') return false
    const edits = client.transactions.submission(transaction.id)
    if (edits.length) return edits.some(edit => editMatchesResource(edit, scope, path => client.editingAuthority(path)))
    // Preparation can fail before a frozen request exists. Only a known resource
    // path (or the exact caller-owned transaction) may attribute that failure.
    return scope.transactionId !== undefined || !scope.entryId && !scope.command && transaction.paths.some(path => overlaps(path, scope.path) || client.editingAuthority(path) === scope.path)
  })
}

export function resourceDirty(client: Pick<ProjectClient, 'editingAuthority'>, scope: ResourceScope, state: EditTransactionState, local = false) {
  return local || !scope.entryId && state.pendingPaths.some(path => path === scope.path || client.editingAuthority(path) === scope.path)
}

export const savePhaseLabels = {
  preparing: '正在准备', submitting: '正在提交', saved: '已保存', failed: '提交失败', conflict: '提交冲突', uncertain: '结果待确认',
}

export function resourceSaveState(records: TransactionInfo[], dirty: boolean) {
  const priority = { uncertain: 6, conflict: 5, failed: 4, submitting: 3, preparing: 2, saved: 0 }
  const record = [...records].sort((a, b) => priority[b.phase] - priority[a.phase] || b.id - a.id)[0]
  return { record, text: record ? savePhaseLabels[record.phase] : dirty ? '未保存' : '已同步' }
}
