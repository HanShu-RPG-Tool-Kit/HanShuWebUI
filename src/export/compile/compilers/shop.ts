import type { FileCompiler } from '../types'
import { sourcePathOf } from '../../../workspace'
import { parseShop } from '../../../workspaces/gameplay/shop'
import { buildKitModifierEnv, evalKitExpr } from '../../../workspaces/gameplay/kitExpr'
export const shopCompiler: FileCompiler = {
  id: 'shop', match: file => file.name.toLowerCase().endsWith('.shop'),
  async compile(file, ctx) {
    const shop = parseShop(file.content)
    const error = (message: string) => ctx.report({ severity: 'error', code: 'shop_invalid', sourcePath: file.name, message })
    const env = buildKitModifierEnv(shop.params, shop.modifiers)
    env.errors.forEach(error)
    for (const script of shop.script) if (!ctx.index.package.scripts.some(s => sourcePathOf(s) === script.ref && s.name.endsWith('.py'))) error(`缺少商店脚本：${script.ref}`)
    for (const entry of shop.entries) {
      for (const expression of [entry.visibility, entry.availability]) if (expression.trim()) {
        try { evalKitExpr(expression, env) } catch (cause) { error(`条目 ${entry.id}：${String(cause)}`) }
      }
      for (const item of [...entry.payment, ...entry.goods]) {
        if (item.item && !ctx.index.package.scripts.some(s => s.name === `${item.item}.item`)) error(`缺少物品：${item.item}`)
        if (item.mods?.count && !env.declared.has(item.mods.count)) error(`缺少数量修饰器：${item.mods.count}`)
      }
    }
    return [{ path: `shop/${file.name}`, bytes: file.content, plane: 'server', packageName: ctx.index.package.name, sourcePath: file.name }]
  },
}
