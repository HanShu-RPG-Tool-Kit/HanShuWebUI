import { parseFlow, validateFlow } from '../../../workspaces/gameplay/model'
import { parseGoalDefinitionsFromSource } from '../../../workspaces/gameplay/goalDefinitions'
import { effectiveBuiltinScripts } from '../../../scriptResources'
import { getExtension } from '../../../workspace'
import { parseProgress, PROGRESS_FORMAT, type ProgressDocument } from '../../../workspaces/gameplay/progressDoc'
import { questAuthorKindFromSource, QUEST_EXT } from '../../../workspaces/gameplay/questKind'
import { compileQuestFlow, compileSimpleQuest, QUEST_COMPILED_EXT } from '../../../workspaces/gameplay/questCompiled'
import type { FileCompiler } from '../types'

function pakQuestPath(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.quest$/i, '')
  return `quest/${base || 'unnamed'}${QUEST_COMPILED_EXT}`
}

/** Both authoring formats lower to the same node-owned pointer graph. */
export function compileSimpleQuestDocument(doc: ProgressDocument): string {
  return `${JSON.stringify(compileSimpleQuest(doc), null, 2)}\n`
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
        const scripts = ctx.index.workspace.packages.flatMap(pkg => pkg.scripts).filter(script => !script.id.startsWith('builtin:'))
        const sources = [...effectiveBuiltinScripts(scripts).filter(script => script.type === 'goal').map(script => ({ name: script.name, content: script.source })), ...scripts.filter(script => script.srcKind === 'goal' && script.name.endsWith('.py'))]
        const definitions = sources.flatMap(script => parseGoalDefinitionsFromSource(script.content, { sourceName: script.name, sourceKey: null }))
        const seen = new Map<string, typeof definitions[number]>()
        for (const definition of definitions) {
          const duplicate = seen.get(definition.kind)
          if (duplicate) duplicate.error = definition.error = `goal 类型「${definition.kind}」在不同有效声明中重复。`
          seen.set(definition.kind, definition)
        }
        const errors = validateFlow(flow, definitions).filter(issue => issue.severity === 'error')
        if (errors.length) throw new Error(errors.map(issue => issue.message).join('；'))
        const compiled = compileQuestFlow(flow)
        const injections = Object.values(compiled.nodes).flatMap(node => 'submission' in node && node.submission?.submit_type === 'dialogue_injection' ? [node.submission.param] : [])
        const requires = [...new Map(injections.map(id => [id.toLowerCase(), { kind: 'hsInject', id }])).values()]
        return [{ path, bytes: `${JSON.stringify(compiled, null, 2)}\n`, plane, packageName: ctx.index.package.name, sourcePath: file.name, ...(requires.length ? { requires } : {}) }]
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
