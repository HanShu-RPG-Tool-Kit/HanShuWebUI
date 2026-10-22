import type { FileOperationRequest, ResourceOperationPlan } from '../src/collab/generated'

/** Test service fixture: explicit policy data, not a copy of production path rules. */
export function resourcePlanFixture(
  operations: FileOperationRequest[],
  options: {
    versions?: Map<string, string>
    owners?: Map<string, string>
    sourceKinds?: Map<string, string>
    revision?: number
  } = {},
): ResourceOperationPlan {
  const { versions = new Map(), owners = new Map(), sourceKinds = new Map(), revision = 1 } = options
  const paths = [...new Set(operations.flatMap(item => item.destination ? [item.path, item.destination] : [item.path]))]
  const authorities = paths.map(path => {
    const authorityPath = owners.get(path) ?? path
    return { path, authorityPath, sourceKind: sourceKinds.get(authorityPath) ?? null }
  })
  return {
    revision,
    operations: operations.map(item => ({ ...item, originPath: item.path, version: versions.get(item.path) ?? null, destinationVersion: item.destination ? versions.get(item.destination) ?? null : null })),
    leasePaths: [...new Set([...paths, ...authorities.map(item => item.authorityPath)])],
    authorities,
    relations: paths.filter(path => owners.has(path)).map(path => ({ kind: 'ownership', role: 'language', from: owners.get(path)!, to: path })),
  }
}
