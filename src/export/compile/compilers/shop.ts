import type { FileCompiler } from '../types'
import { sourcePathOf } from '../../../workspace'
import { parseShop, stringifyShop } from '../../../workspaces/gameplay/shop'
import { buildKitModifierEnv } from '../../../workspaces/gameplay/kitExpr'
import { compileShopCondition } from '../../../workspaces/gameplay/shopExpr'
export const shopCompiler: FileCompiler = {
  id: 'shop', match: file => file.name.toLowerCase().endsWith('.shop'),
  async compile(file, ctx) {
    const error = (message: string) => ctx.report({ severity: 'error', code: 'shop_invalid', sourcePath: file.name, message })
    let shop: ReturnType<typeof parseShop>
    try { shop = parseShop(file.content) }
    catch (cause) { error(String(cause)); return [] }
    for (const other of ctx.index.package.scripts) {
      if (other.name === file.name || !other.name.toLowerCase().endsWith('.shop')) continue
      let otherId: string | undefined
      try { otherId = parseShop(other.content).id } catch { /* The other compiler reports its own malformed template. */ }
      if (otherId === shop.id) error(`商店模板 ID 与 ${other.name} 重复：${shop.id}`)
    }
    const env = buildKitModifierEnv(shop.params, shop.modifiers)
    env.errors.forEach(error)
    for (const script of shop.script) if (!ctx.index.package.scripts.some(s => sourcePathOf(s) === `src/script/shop/${script.ref}.py`)) error(`缺少商店脚本：${script.ref}`)
    for (const entry of shop.entries) {
      for (const expression of [entry.visibility, entry.availability]) if (expression.trim()) {
        try { compileShopCondition(expression, env) } catch (cause) { error(`条目 ${entry.id}：${String(cause)}`) }
      }
      for (const item of [...entry.payment, ...entry.goods]) {
        if (item.item && !ctx.index.package.scripts.some(s => s.name === `${item.item}.item`)) error(`缺少物品：${item.item}`)
        if (item.mods?.count && !env.declared.has(item.mods.count)) error(`缺少数量修饰器：${item.mods.count}`)
      }
    }
    return [{ path: `shop/${file.name}`, bytes: stringifyShop(shop), plane: 'server', packageName: ctx.index.package.name, sourcePath: file.name }]
  },
}
