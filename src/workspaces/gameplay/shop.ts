import { randomId } from '../../project/crypto'
import { parseJsonValue } from '../../utils/strictJson'
import { isObject } from './model'
import { parseConditionRules, type ProgressConditionRule } from './conditions'
import { parseKit, writeKitItem, type KitItem, type KitParam, type KitModifier } from './kit'

export const STOCK_SUBJECTS = { infinite: '无限库存', player: '玩家', world: '世界', server: '服务器', game: '游戏', npc: '商人 NPC' } as const
export type ShopEntry = {
  id: string
  payment: KitItem[]
  goods: KitItem[]
  visibility: string
  availability: string
}
export type ShopDocument = {
  format: 'hanshu.shop'
  version: 1
  id: string
  name: string
  stockSubject: keyof typeof STOCK_SUBJECTS
  visibility: ProgressConditionRule[]
  availability: ProgressConditionRule[]
  params: KitParam[]
  modifiers: KitModifier[]
  script: { ref: string }[]
  entries: ShopEntry[]
}
export const createShopEntry = (): ShopEntry => ({ id: randomId(), payment: [], goods: [], visibility: '', availability: '' })
export const createShop = (): ShopDocument => ({ format: 'hanshu.shop', version: 1, id: randomId(), name: 'name', stockSubject: 'infinite', visibility: [], availability: [], params: [], modifiers: [], script: [], entries: [] })
export const stringifyShop = (doc: ShopDocument) => {
  const items = (values: KitItem[]) => values.map(writeKitItem)
  return JSON.stringify({ ...doc, entries: doc.entries.map(e => ({ ...e, payment: items(e.payment), goods: items(e.goods) })) }, null, 2)
}

/** Reuse kit's item / inline stack and parameter codecs, without kit composition. */
export function parseShop(source: string, draft = false): ShopDocument {
  const raw = parseJsonValue(source)
  if (!isObject(raw) || raw.format !== 'hanshu.shop' || raw.version !== 1) throw new Error('需要 hanshu.shop version 1 商店模板')
  if ('extends' in raw || 'includes' in raw) throw new Error('商店模板不支持继承或组合；组合属于实例')
  if (typeof raw.id !== 'string' || (!draft && !raw.id.trim()) || typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('商店需要稳定 ID 和名称键')
  if (typeof raw.stockSubject !== 'string' || !Object.hasOwn(STOCK_SUBJECTS, raw.stockSubject)) throw new Error('库存主体类型无效')
  if (!Array.isArray(raw.entries) || !Array.isArray(raw.params) || !Array.isArray(raw.modifiers) || !Array.isArray(raw.script)) throw new Error('条目、超参数、修饰器和脚本必须是列表')
  const kit = parseKit(JSON.stringify({ params: raw.params, modifiers: raw.modifiers }))
  const ids = new Set<string>()
  const entries = raw.entries.map((value): ShopEntry => {
    if (!isObject(value) || typeof value.id !== 'string' || !value.id.trim() || ids.has(value.id)) throw new Error('商品条目 ID 必须非空且唯一')
    ids.add(value.id)
    if (typeof value.visibility !== 'string' || typeof value.availability !== 'string') throw new Error('商品条件必须是表达式字符串')
    const items = (list: unknown): KitItem[] => {
      if (!Array.isArray(list)) throw new Error('支付和获得内容必须是物品列表')
      for (const item of list) {
        if (!isObject(item) || !((typeof item.item === 'string' && (draft || item.item.trim())) || (typeof item.id === 'string' && (draft || item.id.trim())))) throw new Error('每项必须包含 item 引用或内嵌 ItemStack id')
        if ('virtual' in item || 'virtualItem' in item) throw new Error('商店不提供虚拟物品类型')
        if (typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 0) throw new Error('物品数量必须是非负安全整数')
      }
      return parseKit(JSON.stringify({ items: list })).items
    }
    return { id: value.id, payment: items(value.payment), goods: items(value.goods), visibility: value.visibility, availability: value.availability }
  })
  const script = raw.script.map(value => {
    if (!isObject(value) || typeof value.ref !== 'string' || (!draft && !value.ref.trim())) throw new Error('脚本需要非空引用')
    return { ref: value.ref }
  })
  if (!draft && new Set(script.map(s => s.ref)).size !== script.length) throw new Error('脚本不能重复绑定')
  return { format: 'hanshu.shop', version: 1, id: raw.id, name: raw.name, stockSubject: raw.stockSubject as ShopDocument['stockSubject'], visibility: parseConditionRules(raw.visibility, '商店可见性条件', false), availability: parseConditionRules(raw.availability, '商店可用性条件', false), params: kit.params, modifiers: kit.modifiers, script, entries }
}
