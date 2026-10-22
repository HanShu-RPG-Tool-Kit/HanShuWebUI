import { useEffect, useSyncExternalStore } from 'react'
import type { ProjectClient } from './serviceClient'
import { useFileEditing } from './useFileEditing'
import { useResourcePresence } from './useResourcePresence'
import { resourceDirty, resourceTransactions } from './resourceStatus'

/** Active-view publisher; the floating panel owns project-wide collaboration UI. */
export function FilePresenceBar({ client, path, entryId = null, mode = 'optimistic', dirty: localDirty = false }: { client: ProjectClient; path: string; entryId?: string | null; mode?: 'managed' | 'optimistic'; dirty?: boolean; label?: string }) {
  const editing = useFileEditing(client)!
  const transactions = useSyncExternalStore(client.transactions.subscribe, client.transactions.getSnapshot)
  const draftPaths = JSON.stringify([...new Set([...transactions.pendingPaths, ...transactions.transactions.filter(item => ['failed', 'conflict', 'uncertain'].includes(item.phase)).flatMap(item => item.paths)])].sort())
  useEffect(() => {
    const paths = JSON.parse(draftPaths) as string[]
    if (!client.online || !paths.length) return
    let current = true
    void client.planOperations(paths.map(path => ({ op: 'write', path, destination: null }))).then(() => { if (current) editing.changed() }).catch(() => undefined)
    return () => { current = false }
  }, [client, editing, draftPaths, client.tree.revision, client.online])
  const scope = { path, entryId }
  const dirty = resourceDirty(client, scope, transactions, localDirty)
  const pending = resourceTransactions(client, scope, transactions).some(record => record.phase !== 'saved')
  useResourcePresence(client, path, entryId, (mode === 'managed' ? editing.canEdit(path) : client.writable && (dirty || pending)) ? 'editing' : 'viewing')
  return null
}
