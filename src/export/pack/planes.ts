import type { CompileArtifact, Plane } from '../compile/types'

export type PackTarget = 'client' | 'server' | 'shared' | 'combined'

/** 某导出目标应包含哪些平面的产物 */
export function planesForTarget(target: PackTarget): Plane[] {
  switch (target) {
    case 'client':
      return ['client', 'shared']
    case 'server':
      return ['server', 'shared']
    case 'shared':
      return ['shared']
    case 'combined':
      return ['client', 'server', 'shared']
  }
}

export function filterArtifactsForTarget(
  artifacts: CompileArtifact[],
  target: PackTarget,
): CompileArtifact[] {
  const allowed = new Set(planesForTarget(target))
  return artifacts.filter((a) => allowed.has(a.plane))
}

export function pakFileSuffix(target: PackTarget): string {
  switch (target) {
    case 'client':
      return 'client'
    case 'server':
      return 'server'
    case 'shared':
      return 'shared'
    case 'combined':
      return 'combined'
  }
}
