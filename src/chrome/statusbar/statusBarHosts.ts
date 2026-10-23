type Hosts = {
  left: HTMLElement | null
  right: HTMLElement | null
  version: number
}

let hosts: Hosts = { left: null, right: null, version: 0 }
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function setStatusBarHost(
  which: 'left' | 'right',
  el: HTMLElement | null,
): void {
  if (hosts[which] === el) return
  hosts = { ...hosts, [which]: el, version: hosts.version + 1 }
  emit()
}

export function getStatusBarHosts(): Hosts {
  return hosts
}

export function subscribeStatusBarHosts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
