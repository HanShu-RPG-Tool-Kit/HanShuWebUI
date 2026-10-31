import type { FileCompiler } from '../types'
import { sourcePathOf } from '../../../workspace'
import { parseReputation, stringifyReputation } from '../../../workspaces/gameplay/reputation'

export const reputationCompiler: FileCompiler = {
  id: 'reputation', match: file => file.name.toLowerCase().endsWith('.rep'),
  async compile(file, ctx) {
    try {
      const faction = parseReputation(file.content)
      const path = sourcePathOf(file).slice(4)
      if (!/^reputations\/[^/\\:]+\.rep$/i.test(path)) throw new Error('声誉阵营需要扁平文件名')
      const selfId = file.name.replace(/\.rep$/i, '')
      const known = new Set(
        ctx.index.package.scripts
          .filter(script => script.name.toLowerCase().endsWith('.rep'))
          .map(script => script.name.replace(/\.rep$/i, '')),
      )
      for (const other of faction.hostile) {
        if (other === selfId) throw new Error(`敌对阵营不能指向自身：${other}`)
        if (!known.has(other)) throw new Error(`缺少敌对阵营：${other}（src/reputations/${other}.rep）`)
      }
      return [{ path, bytes: stringifyReputation(faction), plane: 'server', packageName: ctx.index.package.name, sourcePath: file.name }]
    } catch (error) {
      ctx.report({ severity: 'error', code: 'reputation_invalid', sourcePath: file.name, message: String(error) })
      return []
    }
  },
}
