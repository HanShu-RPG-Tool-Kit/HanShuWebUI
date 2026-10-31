import type { FileCompiler } from '../types'
import { isHanshuFile, sourcePathOf } from '../../../workspace'
import { parseActor, stringifyActor } from '../../../workspaces/gameplay/actor'
import { effectiveBuiltinScripts } from '../../../scriptResources'
import { collectHsInjectNames } from '../../../hanshu/hsSyntaxRules'

function injectNames(ctx: Parameters<FileCompiler['compile']>[1]): Set<string> {
  const names = new Set<string>()
  for (const script of ctx.index.package.scripts) {
    if (!isHanshuFile(script.name)) continue
    for (const name of collectHsInjectNames(script.content)) names.add(name)
  }
  return names
}

export const actorCompiler: FileCompiler = {
  id: 'actor', match: file => file.name.toLowerCase().endsWith('.actor'),
  async compile(file, ctx) {
    try {
      const actor = parseActor(file.content)
      const ids = new Set(ctx.index.package.scripts.filter(s => s.name.toLowerCase().endsWith('.py') && s.srcKind === 'actor').map(s => s.name.slice(0, -3)))
      for (const script of effectiveBuiltinScripts(ctx.index.package.scripts)) if (script.type === 'actor') ids.add(script.name.slice(0, -3))
      for (const id of actor.scripts) if (!ids.has(id)) throw new Error(`缺少演员脚本：${id}（src/script/actor/${id}.py）`)
      if (actor.reputation) {
        const path = `src/reputations/${actor.reputation}.rep`
        if (!ctx.index.package.scripts.some(s => sourcePathOf(s) === path)) throw new Error(`缺少声誉阵营：${actor.reputation}（${path}）`)
      }
      if (actor.interactService?.type === 'shop') {
        const template = actor.interactService.param.template
        if (!ctx.index.package.scripts.some(s => s.name.toLowerCase() === `${template.toLowerCase()}.shop`)) {
          throw new Error(`缺少商店模板：${template}（src/shop/${template}.shop）`)
        }
      }
      if (actor.dialogue) {
        const known = injectNames(ctx)
        const missing = new Set<string>()
        for (const entry of actor.dialogue.entries) {
          if (entry.inject && !known.has(entry.inject)) missing.add(entry.inject)
          for (const condition of entry.when) {
            if (condition.kind !== 'always' && condition.inject && !known.has(condition.inject)) missing.add(condition.inject)
          }
        }
        if (missing.size) throw new Error(`缺少对话注入点：${[...missing].join('、')}`)
      }
      const path = sourcePathOf(file).slice(4)
      if (!/^actors\/[^/\\:]+\.actor$/i.test(path)) throw new Error('演员模板需要扁平文件名')
      return [{ path, bytes: stringifyActor(actor), plane: 'server', packageName: ctx.index.package.name, sourcePath: file.name }]
    } catch (error) {
      ctx.report({ severity: 'error', code: 'actor_invalid', sourcePath: file.name, message: String(error) })
      return []
    }
  },
}
