import { randomId } from '../../project/crypto'
import { parseJsonValue } from '../../utils/strictJson'
import { isObject } from './model'
import { parseKit, unionKitTags, writeKitItem, type KitItem, type KitParam, type KitModifier } from './kit'

export const STOCK_SUBJECTS = { infinite: '无限库存', player: '玩家', game: '游戏', actor: '角色' } as const
export type ShopEntry = {
  id: string
  tags: string[]
  initialCapacity: number
  maxCapacity: number
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
  tags: string[]
  icon: KitItem | null
  stockSubject: keyof typeof STOCK_SUBJECTS
  params: KitParam[]
  modifiers: KitModifier[]
  script: { ref: string }[]
  entries: ShopEntry[]
}
export const createShopEntry = (): ShopEntry => ({ id: randomId(), tags: [], initialCapacity: 0, maxCapacity: 1, payment: [], goods: [], visibility: '', availability: '' })
export const createShop = (): ShopDocument => ({ format: 'hanshu.shop', version: 1, id: randomId(), name: 'name', tags: [], icon: null, stockSubject: 'infinite', params: [], modifiers: [], script: [], entries: [] })
export function shopTags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(t => typeof t !== 'string' || !t.trim())) throw new Error('标签必须是非空字符串列表')
  return unionKitTags(value as string[])
}
export const stringifyShop = (doc: ShopDocument) => {
  const items = (values: KitItem[]) => values.map(writeKitItem)
  return JSON.stringify({ format: doc.format, version: doc.version, id: doc.id, name: doc.name, tags: doc.tags, stockSubject: doc.stockSubject, icon: doc.icon ? writeKitItem({ ...doc.icon, count: 1, mods: undefined }) : null, params: doc.params, modifiers: doc.modifiers, script: doc.script, entries: doc.entries.map(e => ({ ...e, payment: items(e.payment), goods: items(e.goods) })) }, null, 2)
}

/** Reuse kit's item / inline stack and parameter codecs, without kit composition. */
export function parseShop(source: string, draft = false): ShopDocument {
  const raw = parseJsonValue(source)
  if (!isObject(raw) || raw.format !== 'hanshu.shop' || raw.version !== 1) throw new Error('需要 hanshu.shop version 1 商店模板')
  for (const field of ['visibility', 'availability']) {
    if (field in raw && (!Array.isArray(raw[field]) || raw[field].length > 0))
      throw new Error(`商店级 ${field} 条件组已移除，请使用商品条目条件`)
  }
  if ('extends' in raw || 'includes' in raw) throw new Error('商店模板不支持继承或组合；组合属于实例')
  if (typeof raw.id !== 'string' || (!draft && !raw.id.trim()) || typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('商店需要稳定 ID 和名称键')
  if (typeof raw.stockSubject !== 'string' || !Object.hasOwn(STOCK_SUBJECTS, raw.stockSubject)) throw new Error('库存主体类型无效')
  if (!Array.isArray(raw.entries) || !Array.isArray(raw.params) || !Array.isArray(raw.modifiers) || !Array.isArray(raw.script)) throw new Error('条目、超参数、修饰器和脚本必须是列表')
  const kit = parseKit(JSON.stringify({ params: raw.params, modifiers: raw.modifiers }))
  let icon: KitItem | null = null
  if (raw.icon !== undefined && raw.icon !== null) {
    if (!isObject(raw.icon)) throw new Error('图标必须是一个物品或 null')
    for (const field of ['item', 'id']) if (raw.icon[field] !== undefined && typeof raw.icon[field] !== 'string') throw new Error(`图标 ${field} 必须是字符串`)
    if ('virtual' in raw.icon || 'virtualItem' in raw.icon) throw new Error('图标必须是实际物品')
    if (raw.icon.mods !== undefined && (!isObject(raw.icon.mods) || Object.keys(raw.icon.mods).length > 0)) throw new Error('图标不支持数量修饰器')
    const iconData = parseKit(JSON.stringify({ items: [{ ...raw.icon, count: 1 }] })).items[0]
    if (iconData.item?.trim() || iconData.id.trim() || draft) icon = { ...iconData, count: 1, mods: undefined }
  }
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
    const initialCapacity = value.initialCapacity ?? 0, maxCapacity = value.maxCapacity ?? 1
    if (typeof initialCapacity !== 'number' || typeof maxCapacity !== 'number' || !Number.isSafeInteger(initialCapacity) || !Number.isSafeInteger(maxCapacity) || initialCapacity < 0 || maxCapacity < 0 || (!draft && initialCapacity > maxCapacity)) throw new Error('交易额度须为非负安全整数，初始额度不能超过最大额度')
    return { id: value.id, tags: shopTags(value.tags), initialCapacity, maxCapacity, payment: items(value.payment), goods: items(value.goods), visibility: value.visibility, availability: value.availability }
  })
  const script = raw.script.map(value => {
    if (!isObject(value) || typeof value.ref !== 'string' || (!draft && !value.ref.trim())) throw new Error('脚本需要非空引用')
    if (value.ref === '.' || value.ref === '..' || /[/\\:]/.test(value.ref) || [...value.ref].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('商店脚本引用必须是 shop 类型的脚本 ID，不能使用路径')
    return { ref: value.ref.trim() }
  })
  if (!draft && new Set(script.map(s => s.ref)).size !== script.length) throw new Error('脚本不能重复绑定')
  return { format: 'hanshu.shop', version: 1, id: raw.id, name: raw.name, tags: shopTags(raw.tags), stockSubject: raw.stockSubject as ShopDocument['stockSubject'], icon, params: kit.params, modifiers: kit.modifiers, script, entries }
}
