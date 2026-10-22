import { useEffect, useRef } from 'react'
import type { ProjectClient } from './serviceClient'

/** Mounted only for the active view. This publishes intent, never requests a lease. */
export function useResourcePresence(client: ProjectClient, path: string, entryId: string | null, activity: 'viewing' | 'editing') {
  const owned = useRef<{ client: ProjectClient; token: symbol } | null>(null)
  useEffect(() => {
    const token = client.editing.claimFocus(path, { entryId })
    owned.current = { client, token }
    return () => {
      client.editing.releaseFocus(token)
      if (owned.current?.token === token) owned.current = null
    }
  }, [client, path, entryId])
  useEffect(() => {
    const owner = owned.current
    if (owner?.client === client) client.editing.updateFocus(owner.token, activity)
  }, [client, path, entryId, activity])
}
