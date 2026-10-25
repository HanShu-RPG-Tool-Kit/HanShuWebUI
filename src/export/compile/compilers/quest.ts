import { getExtension } from '../../../workspace'
import { parseProgress, PROGRESS_FORMAT, type ProgressDocument } from '../../../workspaces/quest/progressDoc'
import { MULTI_QUEST_FORMAT, questAuthorKindFromSource, QUEST_EXT } from '../../../workspaces/quest/questKind'
import type { FileCompiler } from '../types'

function pakQuestPath(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.quest$/i, '')
  return `quest/${base || 'unnamed'}${QUEST_EXT}`
}

/**
 * 单进度（hanshu.progress）→ 多进度树图外壳。
 * 完整表单语义暂放入 `extensions.hanshuSimpleQuest`，供引擎在原生图编译就绪前读取；
 * 已是 progress-tree 的 `.quest` 原样进包。
 */
export function compileSimpleQuestDocument(doc: ProgressDocument): string {
  const tree = {
    format: MULTI_QUEST_FORMAT,
    version: 1 as const,
    id: doc.id,
    entry: {
      id: 'entry',
      target: null,
      title: { text: typeof doc.name === 'string' ? doc.name : 'name' },
      description: { text: typeof doc.description === 'string' ? doc.description : 'description' },
    },
    nodes: {},
    extensions: {
      hanshuSimpleQuest: doc,
    },
  }
  return `${JSON.stringify(tree, null, 2)}\n`
}

export const questCompiler: FileCompiler = {
  id: 'quest',
  match(file) {
    return getExtension(file.name) === QUEST_EXT
  },
  async compile(file, ctx) {
    const kind = questAuthorKindFromSource(file.content)
    const path = pakQuestPath(file.name)
    const plane = 'shared' as const

    if (kind === 'multi') {
      return [{ path, bytes: file.content, plane, packageName: ctx.index.package.name, sourcePath: file.name }]
    }

    if (kind === 'simple') {
      try {
        const doc = parseProgress(file.content)
        if (doc.format !== PROGRESS_FORMAT) throw new Error('unexpected format')
        return [{
          path,
          bytes: compileSimpleQuestDocument(doc),
          plane,
          packageName: ctx.index.package.name,
          sourcePath: file.name,
        }]
      } catch (error) {
        ctx.report({
          severity: 'error',
          code: 'quest_simple_compile',
          message: `单进度任务无法编译为多进度：${error instanceof Error ? error.message : String(error)}`,
          sourcePath: file.name,
        })
        return []
      }
    }

    ctx.report({
      severity: 'error',
      code: 'quest_format',
      message: '无法识别任务 format（需要 hanshu.progress 或 hanshu.progress-tree）',
      sourcePath: file.name,
    })
    return []
  },
}
