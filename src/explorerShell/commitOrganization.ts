import { ServiceError } from '../collab/protocol'
import {
  EXPLORER_ORGANIZATION_PATH,
  emptyOrganization,
  serializeOrganization,
  type ExplorerOrganization,
} from '../project/explorerOrganization'
import { getProjectSession, setProjectSession } from '../project/projectSession'
import { withExplorer } from './relocation'

let queue: Promise<unknown> = Promise.resolve()

/**
 * 提交只改共享组织的操作（新建 / 改名 / 移动 / 删除虚拟文件夹，或调整归属）。
 *
 * 先更新本窗口投影，再以一次文件事务写 `meta/explorer.json`（版本校验、短期写权由 ProjectClient 处理）。
 * 明确拒绝时回滚投影；结果未知时保持投影并等待原事务恢复，不换编号重试。
 * 同一窗口的组织提交按顺序排队，后一次基于前一次的确认版本。
 */
export function commitOrganization(next: ExplorerOrganization): Promise<void> {
  const run = queue.then(async () => {
    const live = getProjectSession()
    const binding = live.binding
    const pkg = live.workspace.packages[0]
    if (!binding || !pkg) throw new Error('请先打开工程')
    const previous = pkg.explorer ?? emptyOrganization()
    const data = serializeOrganization(next)
    if (serializeOrganization(previous) === data) return
    const client = binding.handle.client
    setProjectSession({ workspace: withExplorer(live.workspace, next) })
    try {
      await client.sourceCommands([], [{ op: 'write', path: EXPLORER_ORGANIZATION_PATH, data }])
    } catch (error) {
      const uncertain = error instanceof ServiceError && error.code === 'commit_uncertain'
      const current = getProjectSession()
      const explorer = current.workspace.packages[0]?.explorer
      if (!uncertain && current.binding?.handle.client === client && explorer && serializeOrganization(explorer) === data) {
        setProjectSession({ workspace: withExplorer(current.workspace, previous) })
      }
      throw error
    }
  })
  queue = run.catch(() => undefined)
  return run
}
