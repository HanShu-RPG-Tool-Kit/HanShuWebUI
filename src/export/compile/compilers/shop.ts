import type { FileCompiler } from '../types'
import { sourcePathOf } from '../../../workspace'
import { conditionRuleIssue } from '../../../workspaces/gameplay/conditions'
import { parseShop, stringifyShop } from '../../../workspaces/gameplay/shop'
import { buildKitModifierEnv } from '../../../workspaces/gameplay/kitExpr'
export const shopCompiler: FileCompiler = {
  id: 'shop', match: file => file.name.toLowerCase().endsWith('.shop'),
  async compile(file, ctx) {
    const error = (message: string) => ctx.report({ severity: 'error', code: 'shop_invalid', sourcePath: file.name, message })
    let shop: ReturnType<typeof parseShop>
    try { shop = parseShop(file.content) }
    catch (cause) { error(String(cause)); return [] }
    const env = buildKitModifierEnv(shop.params, shop.modifiers)
    env.errors.forEach(error)
    for (const [label, rules] of [['可见性', shop.visibility], ['可用性', shop.availability]] as const) {
      rules.forEach((rule, index) => {
        const issue = conditionRuleIssue(rule, `商店${label}条件 ${index + 1}`)
        if (issue) error(issue)
      })
    }
    for (const script of shop.script) if (!ctx.index.package.scripts.some(s => sourcePathOf(s) === `src/script/shop/${script.ref}.js`)) error(`缺少商店脚本：${script.ref}`)
    if (shop.icon?.item && !ctx.index.package.scripts.some(s => s.name === `${shop.icon!.item}.item`)) error(`缺少图标物品：${shop.icon.item}`)
    for (const entry of shop.entries) {
      for (const expression of [entry.visibility, entry.availability]) if (/[;\n\r]/.test(expression)) {
        error(`条目 ${entry.id}：条件只能是表达式，不能含语句`)
      }
      for (const item of [...entry.payment, ...entry.goods]) {
        if (item.item && !ctx.index.package.scripts.some(s => s.name === `${item.item}.item`)) error(`缺少物品：${item.item}`)
        if (item.mods?.count && !env.declared.has(item.mods.count)) error(`缺少数量修饰器：${item.mods.count}`)
      }
    }
    try {
      return [{ path: `shop/${file.name}`, bytes: stringifyShop(shop, { plane: 'pak' }), plane: 'server', packageName: ctx.index.package.name, sourcePath: file.name }]
    } catch (cause) {
      error(String(cause))
      return []
    }
  },
}
