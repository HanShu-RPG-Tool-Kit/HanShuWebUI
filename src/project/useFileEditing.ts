import { useEffect, useSyncExternalStore } from 'react'
import type { ProjectClient } from './serviceClient'

const nothing = () => () => undefined
const zero = () => 0
export function useFileEditing(client: ProjectClient | undefined | null) {
  useSyncExternalStore(client?.editing.subscribe ?? nothing, client?.editing.getVersion ?? zero)
  useEffect(() => {
    if (!client) return
    const timer = setInterval(() => {
      if ([...client.leases.values()].some(lease => lease.expiresAt <= client.serverNow())) client.setStatus(client.online)
    }, 1000)
    return () => clearInterval(timer)
  }, [client])
  return client?.editing
}
