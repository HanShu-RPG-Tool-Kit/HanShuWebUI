import type { FileCompiler } from '../types'
import { sourcePathOf } from '../../../workspace'
import { parseActor, stringifyActor } from '../../../workspaces/gameplay/actor'
import { effectiveBuiltinScripts } from '../../../scriptResources'

export const actorCompiler: FileCompiler = {
  id: 'actor', match: file => file.name.toLowerCase().endsWith('.actor'),
  async compile(file, ctx) {
    try {
      const actor = parseActor(file.content)
      const ids = new Set(ctx.index.package.scripts.filter(s => s.name.toLowerCase().endsWith('.py') && s.srcKind === 'actor').map(s => s.name.slice(0, -3)))
      for (const script of effectiveBuiltinScripts(ctx.index.package.scripts)) if (script.type === 'actor') ids.add(script.name.slice(0, -3))
      for (const id of actor.scripts) if (!ids.has(id)) throw new Error(`缺少演员脚本：${id}（src/script/actor/${id}.py）`)
      const path = sourcePathOf(file).slice(4)
      if (!/^actors\/[^/\\:]+\.actor$/i.test(path)) throw new Error('演员模板需要扁平文件名')
      return [{ path, bytes: stringifyActor(actor), plane: 'server', packageName: ctx.index.package.name, sourcePath: file.name }]
    } catch (error) {
      ctx.report({ severity: 'error', code: 'actor_invalid', sourcePath: file.name, message: String(error) })
      return []
    }
  },
}
