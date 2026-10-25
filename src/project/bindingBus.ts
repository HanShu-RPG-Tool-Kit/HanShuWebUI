import type { ProjectDirectory } from './serviceClient'
/**
 * 当前打开的剧本工程绑定 — 供皮肤等模块订阅。
 * StageplayWorkspace 在打开/关闭/切换工程时 publish。
 */

import type { BoundProject } from './projectFs'

export type ProjectBindingListener = (binding: BoundProject | null) => void

let current: BoundProject | null = null
const listeners = new Set<ProjectBindingListener>()

export function getBoundProject(): BoundProject | null {
  return current
}

export function getBoundProjectHandle(): ProjectDirectory | null {
  return current?.handle ?? null
}

export function setBoundProject(binding: BoundProject | null): void {
  current = binding
  for (const listener of listeners) {
    try {
      listener(binding)
    } catch (err) {
      console.error('project binding listener failed', err)
    }
  }
}

export function subscribeProjectBinding(
  listener: ProjectBindingListener,
): () => void {
  listeners.add(listener)
  listener(current)
  return () => {
    listeners.delete(listener)
  }
}
