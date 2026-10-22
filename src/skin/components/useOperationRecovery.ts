import { useState, useSyncExternalStore } from 'react'
import type { ProjectClient } from '../../project/serviceClient'
import { libraryCommand, type SkinLibraryCommand } from '../local/libraryCommands'

/** Bind an operation's recovery controls to the request actually created by it.
 * An older failure of the same kind must never be displayed as this form's result.
 */
export function useOperationRecovery(client: ProjectClient) {
  const [transactionId, setTransactionId] = useState<number | undefined>()
  const transactions = useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot, client.transactions.getSnapshot)
  const transaction = transactions.transactions.find(item => item.id === transactionId)
  async function run<T>(command: SkinLibraryCommand['command'], action: () => Promise<T>): Promise<T> {
    const before = new Map(client.transactions.getSnapshot().transactions.map(item => [item.id, `${item.requestId}:${item.phase}`]))
    try { return await action() }
    finally {
      const submitted = [...client.transactions.getSnapshot().transactions].reverse().find(item =>
        before.get(item.id) !== `${item.requestId}:${item.phase}` &&
        client.transactions.submission(item.id).some(edit => libraryCommand(edit)?.command === command),
      )
      if (submitted) setTransactionId(submitted.id)
    }
  }
  return { transactionId, run, phase: transaction?.phase, recovered: transaction?.phase === 'saved', blocked: !!transaction && transaction.phase !== 'saved' }
}
