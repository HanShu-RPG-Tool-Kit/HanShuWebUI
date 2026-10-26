import { parseFlow, validateFlow } from '../../../workspaces/gameplay/model'
import { getExtension } from '../../../workspace'
import { parseProgress, PROGRESS_FORMAT, type ProgressDocument } from '../../../workspaces/gameplay/progressDoc'
import { MULTI_QUEST_FORMAT, questAuthorKindFromSource, QUEST_EXT } from '../../../workspaces/gameplay/questKind'
import type { FileCompiler } from '../types'

function pakQuestPath(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.quest$/i, '')
  return `quest/${base || 'unnamed'}${QUEST_EXT}`
}

/**
 * 单进度（hanshu.progress）→ 多进度树图外壳。
 * 完整表单语义暂放入 `extensions.hanshuSimpleQuest`，供引擎在原生图编译就绪前读取；
 * 多进度 `.quest` 校验后进包，并补齐缺失的局部分支顺序。
 */
export function compileSimpleQuestDocument(doc: ProgressDocument): string {
  const start = 'progress_start'
  const title = typeof doc.name === 'string' ? doc.name : 'name'
  const description = typeof doc.description === 'string' ? doc.description : 'description'
  const tree = {
    format: MULTI_QUEST_FORMAT,
    version: 1 as const,
    id: doc.id,
    start,
    progress: {
      [start]: {
        title: { text: title },
        questTitle: { text: title },
        description: { text: description },
        runningLog: { text: '' },
        completedLog: { text: '' },
        goals: doc.goals.map(goal => ({ id: goal.id, kind: goal.kind, params: goal.config })),
        completion: doc.completion === 'custom' ? 'custom' : doc.completion === 'any' ? 'any' : 'all',
        ...(doc.completion === 'custom' && doc.completionGraph ? { completionGraph: doc.completionGraph } : {}),
      },
    },
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
      try {
        const flow = parseFlow(file.content)
        const errors = validateFlow(flow).filter(issue => issue.severity === 'error')
        if (errors.length) throw new Error(errors.map(issue => issue.message).join('；'))
        return [{ path, bytes: `${JSON.stringify(flow, null, 2)}\n`, plane, packageName: ctx.index.package.name, sourcePath: file.name }]
      } catch (error) {
        ctx.report({severity:'error',code:'quest_graph',message:`任务图无法导出：${error instanceof Error ? error.message : String(error)}`,sourcePath:file.name})
        return []
      }
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
