import { defaultPlaneForFile, sourcePathOf } from '../../../workspace'
import {
  isQuestCatalogFileName,
  parseQuestCatalog,
  questCatalogCandidateIds,
} from '../../../workspaces/gameplay/questCatalog'
import type { FileCompiler } from '../types'

export const questCatalogCompiler: FileCompiler = {
  id: 'quest-catalog',
  match(file) {
    return isQuestCatalogFileName(file.name)
  },
  async compile(file, ctx) {
    let doc: ReturnType<typeof parseQuestCatalog>
    try {
      doc = parseQuestCatalog(file.content)
    } catch (error) {
      ctx.report({
        severity: 'error',
        code: 'quest_catalog_invalid',
        sourcePath: sourcePathOf(file),
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }
    const ids = questCatalogCandidateIds(ctx.index.package.scripts)
    for (const directory of doc.directories) {
      for (const questId of directory.quests) {
        if (!ids.has(questId)) {
          ctx.report({
            severity: 'warning',
            code: 'quest_catalog_missing',
            sourcePath: sourcePathOf(file),
            message: `任务分类缺少任务：${questId}（目录 ${directory.id}）`,
          })
        }
      }
    }
    const rel = sourcePathOf(file)
    return [{
      path: rel.startsWith('src/') ? rel.slice('src/'.length) : rel,
      bytes: file.content,
      plane: defaultPlaneForFile(file.name),
      packageName: ctx.index.package.name,
      sourcePath: file.name,
    }]
  },
}
