import { ServiceError } from '../../collab/protocol'
import type { TransactionInfo } from '../../project/editTransactions'
import type { FileEdit, ProjectClient } from '../../project/serviceClient'
import type { LibraryEntry, PatchEntryRequest } from '../contracts/types'

export const SKIN_INDEX_PATH = '.hanshu/skinmanager/library.json'
export type SkinEntryCommand = {
  entryId: string
  expectedRevision: number
  changes: Omit<PatchEntryRequest, 'revision' | 'resolvePending'>
}

export function entryCommand(edit: FileEdit): SkinEntryCommand | undefined {
  if (edit.op !== 'skin-entry-patch' || edit.path !== SKIN_INDEX_PATH || typeof edit.data !== 'string') return
  try {
    const command = JSON.parse(edit.data)
    if (typeof command.entryId === 'string' && Number.isSafeInteger(command.expectedRevision) && command.changes && typeof command.changes === 'object') return command
  } catch { /* A malformed recovery record must not authorize replacing another entry. */ }
}

export function entrySubmissionState(client: ProjectClient, entryId: string): {
  transaction: TransactionInfo | undefined
  command: SkinEntryCommand | undefined
  result: LibraryEntry | undefined
} {
  const records = client.transactions.getSnapshot().transactions
  for (const transaction of [...records].reverse()) {
    const command = client.transactions.submission(transaction.id).map(entryCommand).find(value => value?.entryId === entryId)
    if (command) return { transaction, command, result: undefined }
  }
  const ack = client.skinEntryAcknowledgement(entryId)
  const transaction = ack && records.find(record => record.requestId === ack.requestId)
  if (ack && transaction?.phase === 'saved') {
    return { transaction, command: JSON.parse(ack.command) as SkinEntryCommand, result: ack.entry as LibraryEntry }
  }
  return { transaction: undefined, command: undefined, result: undefined }
}

/** Only an explicit user decision may remove a failed command. Unknown outcomes stay queryable. */
export async function discardEntrySubmission(client: ProjectClient, entryId: string): Promise<void> {
  const { transaction } = entrySubmissionState(client, entryId)
  if (!transaction || transaction.phase === 'saved') return
  if (transaction.phase !== 'failed' && transaction.phase !== 'conflict') {
    throw new ServiceError('pending_transaction', '这次修改的结果尚未确认，请先查询提交结果')
  }
  await client.transactions.forget(transaction.id)
}
