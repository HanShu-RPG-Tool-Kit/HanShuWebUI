import {
  EXPLORER_ORGANIZATION_PATH,
  emptyOrganization,
  relocateOrganization,
  serializeOrganization,
  type ExplorerOrganization,
} from '../project/explorerOrganization'
import type { FileEdit } from '../project/serviceClient'
import type { Workspace } from '../workspace'

export function withExplorer(workspace: Workspace, explorer: ExplorerOrganization): Workspace {
  return {
    ...workspace,
    packages: workspace.packages.map((pkg, index) => (index === 0 ? { ...pkg, explorer } : pkg)),
  }
}

/** 改名 / 删除后的归属；未变化返回 null。 */
export function relocatedExplorer(
  workspace: Workspace,
  commands: Array<{ path: string; destination: string | null }>,
): ExplorerOrganization | null {
  const explorer = workspace.packages[0]?.explorer ?? emptyOrganization()
  const next = relocateOrganization(explorer, commands)
  return serializeOrganization(next) === serializeOrganization(explorer) ? null : next
}

/** 源文件结构事务里随附的组织写入：与改名 / 删除同一事务提交。 */
export function organizationEdits(next: ExplorerOrganization | null): FileEdit[] {
  return next ? [{ op: 'write', path: EXPLORER_ORGANIZATION_PATH, data: serializeOrganization(next) }] : []
}
