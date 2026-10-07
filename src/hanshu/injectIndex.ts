/**
 * 工作区级注入点索引（跨 `.hs` 文件全局唯一）。
 */

import { isHanshuFile, type Workspace } from '../workspace'
import { collectHsInjectNames } from './hsSyntaxRules'

/**
 * 其它源文件已占用的注入点：键为小写名字 → 首次占用方逻辑文件名。
 * `excludeSourceName` 通常为当前正在编辑/校验的文件。
 */
export function indexForeignHsInjects(
  workspace: Workspace,
  excludeSourceName?: string,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const pkg of workspace.packages) {
    for (const script of pkg.scripts) {
      if (!isHanshuFile(script.name)) continue
      if (excludeSourceName && script.name === excludeSourceName) continue
      for (const name of collectHsInjectNames(script.content)) {
        const key = name.toLowerCase()
        if (!map.has(key)) map.set(key, script.name)
      }
    }
  }
  return map
}
