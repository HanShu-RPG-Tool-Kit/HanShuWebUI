import { isObject } from './model'
import { isSnapshotFresh, type ItemStackDisplay, type ItemTextSegment } from './itemstack'

type ItemLike = { id: string; count: number; components: Record<string, unknown>; display?: ItemStackDisplay }

export type ItemPresentation = {
  source: 'snapshot' | 'webui'
  name: ItemTextSegment[]
  tooltip: ItemTextSegment[][]
  /** 原版隐藏了整个提示框 */
  hidden: boolean
  foil: boolean
  /** 有图标但它来自已过期的快照 */
  iconStale: boolean
  /** WebUI 未渲染的组件 id */
  unrendered: string[]
  defaultColor: string
}

const COLORS: Record<string, string> = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
  dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
  dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF',
}

const RARITY_COLORS: Record<string, string> = {
  common: '#FFFFFF', uncommon: '#FFFF55', rare: '#55FFFF', epic: '#FF55FF',
}

const ENCHANTMENT_NAMES: Record<string, string> = {
  protection: '保护', fire_protection: '火焰保护', feather_falling: '摔落缓冲', blast_protection: '爆炸保护',
  projectile_protection: '弹射物保护', respiration: '水下呼吸', aqua_affinity: '水下速掘', thorns: '荆棘',
  depth_strider: '深海探索者', frost_walker: '冰霜行者', binding_curse: '绑定诅咒', soul_speed: '灵魂疾行',
  swift_sneak: '迅捷潜行', sharpness: '锋利', smite: '亡灵杀手', bane_of_arthropods: '节肢杀手',
  knockback: '击退', fire_aspect: '火焰附加', looting: '抢夺', sweeping_edge: '横扫之刃',
  efficiency: '效率', silk_touch: '精准采集', unbreaking: '耐久', fortune: '时运', power: '力量',
  punch: '冲击', flame: '火矢', infinity: '无限', luck_of_the_sea: '海之眷顾', lure: '饵钓',
  loyalty: '忠诚', impaling: '穿刺', riptide: '激流', channeling: '引雷', multishot: '多重射击',
  quick_charge: '快速装填', piercing: '穿透', mending: '经验修补', vanishing_curse: '消失诅咒',
  density: '致密', breach: '破甲', wind_burst: '风爆',
}

const CURSES = new Set(['binding_curse', 'vanishing_curse'])

/** 渲染过的、或在原版普通提示里本来就不显示的组件 */
const HANDLED = new Set([
  'custom_name', 'item_name', 'lore', 'rarity', 'enchantments', 'stored_enchantments', 'unbreakable',
  'enchantment_glint_override', 'hide_tooltip', 'hide_additional_tooltip', 'tooltip_display',
  'damage', 'max_damage', 'max_stack_size', 'repair_cost', 'custom_data', 'custom_model_data', 'item_model',
])

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']

const stripNamespace = (id: string) => id.replace(/^minecraft:/, '')

function component(components: Record<string, unknown>, key: string): unknown {
  return components[`minecraft:${key}`] ?? components[key]
}

function humanize(id: string): string {
  const path = stripNamespace(id).split(/[:/]/).pop() ?? ''
  return path.split('_').filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') || id
}

type Style = Omit<ItemTextSegment, 'text'>

function applyStyle(base: Style, source: Record<string, unknown>): Style {
  const next: Style = { ...base }
  if (typeof source.color === 'string') next.color = COLORS[source.color] ?? (source.color.startsWith('#') ? source.color : next.color)
  for (const key of ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'] as const) {
    if (typeof source[key] === 'boolean') next[key] = source[key] as boolean
  }
  return next
}

function clean(segment: ItemTextSegment): ItemTextSegment {
  const out: ItemTextSegment = { text: segment.text }
  if (segment.color) out.color = segment.color
  for (const key of ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'] as const) {
    if (segment[key]) out[key] = true
  }
  return out
}

/** Minecraft 文本组件：字符串 / 对象 / 数组；1.20.5~1.21.4 的 JSON 字符串形态也兼容 */
export function textComponentSegments(value: unknown, base: Style = {}): ItemTextSegment[] {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^[[{"]/.test(trimmed)) {
      try {
        return textComponentSegments(JSON.parse(trimmed), base)
      } catch { /* 当普通文本 */ }
    }
    return [clean({ ...base, text: value })]
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [clean({ ...base, text: String(value) })]
  if (Array.isArray(value)) {
    if (value.length === 0) return []
    const [first, ...rest] = value
    const head = textComponentSegments(first, base)
    const style = isObject(first) ? applyStyle(base, first) : base
    return [...head, ...rest.flatMap((child) => textComponentSegments(child, style))]
  }
  if (!isObject(value)) return []
  const style = applyStyle(base, value)
  let text = ''
  if (typeof value.text === 'string') text = value.text
  else if (typeof value.translate === 'string') text = typeof value.fallback === 'string' ? value.fallback : value.translate
  else if (typeof value.keybind === 'string') text = value.keybind
  else if (typeof value.selector === 'string') text = value.selector
  const own = text ? [clean({ ...style, text })] : []
  const extra = Array.isArray(value.extra) ? value.extra.flatMap((child) => textComponentSegments(child, style)) : []
  return [...own, ...extra]
}

/** 1.20.5~1.21.4：{ levels: {...}, show_in_tooltip }；1.21.5+：直接是 { id: level } */
function readEnchantments(value: unknown): { entries: [string, number][]; shown: boolean } {
  if (!isObject(value)) return { entries: [], shown: true }
  const levels = isObject(value.levels) ? value.levels : value
  const entries = Object.entries(levels)
    .filter(([, level]) => typeof level === 'number' && level > 0)
    .map(([id, level]) => [id, level as number] as [string, number])
  return { entries, shown: value.show_in_tooltip !== false }
}

/** 最高等级为 1 的附魔，1 级时原版不显示罗马数字 */
const SINGLE_LEVEL = new Set([
  'silk_touch', 'mending', 'infinity', 'aqua_affinity', 'flame', 'channeling', 'multishot', 'binding_curse', 'vanishing_curse',
])

function enchantmentLine(id: string, level: number): ItemTextSegment[] {
  const key = stripNamespace(id)
  const name = ENCHANTMENT_NAMES[key] ?? humanize(id)
  const text = level === 1 && SINGLE_LEVEL.has(key) ? name : `${name} ${ROMAN[level] ?? level}`
  return [{ text, color: CURSES.has(key) ? '#FF5555' : '#AAAAAA' }]
}

function hiddenComponents(components: Record<string, unknown>): Set<string> {
  const display = component(components, 'tooltip_display')
  if (!isObject(display) || !Array.isArray(display.hidden_components)) return new Set()
  return new Set(display.hidden_components.filter((id): id is string => typeof id === 'string').map(stripNamespace))
}

export function renderItemTooltip(item: ItemLike): Omit<ItemPresentation, 'source' | 'iconStale' | 'defaultColor'> {
  const components = item.components
  const tooltipDisplay = component(components, 'tooltip_display')
  const hidden = component(components, 'hide_tooltip') !== undefined
    || (isObject(tooltipDisplay) && tooltipDisplay.hide_tooltip === true)
  const hiddenSet = hiddenComponents(components)
  const hideAdditional = component(components, 'hide_additional_tooltip') !== undefined

  const enchantments = readEnchantments(component(components, 'enchantments'))
  const stored = readEnchantments(component(components, 'stored_enchantments'))
  const glintOverride = component(components, 'enchantment_glint_override')
  const foil = typeof glintOverride === 'boolean' ? glintOverride : enchantments.entries.length > 0

  let rarity = typeof component(components, 'rarity') === 'string' ? stripNamespace(component(components, 'rarity') as string) : 'common'
  if (enchantments.entries.length > 0) rarity = rarity === 'common' || rarity === 'uncommon' ? 'rare' : rarity === 'rare' ? 'epic' : rarity
  const rarityColor = RARITY_COLORS[rarity] ?? '#FFFFFF'

  const customName = component(components, 'custom_name')
  const itemName = component(components, 'item_name')
  const name = customName !== undefined
    ? textComponentSegments(customName, { color: rarityColor, italic: true })
    : itemName !== undefined
      ? textComponentSegments(itemName, { color: rarityColor })
      : [{ text: humanize(item.id || '未填 ID'), color: rarityColor }]

  const lines: ItemTextSegment[][] = [name]
  if (enchantments.shown && !hiddenSet.has('enchantments')) {
    for (const [id, level] of enchantments.entries) lines.push(enchantmentLine(id, level))
  }
  if (stored.shown && !hiddenSet.has('stored_enchantments') && !hideAdditional) {
    for (const [id, level] of stored.entries) lines.push(enchantmentLine(id, level))
  }
  const lore = component(components, 'lore')
  if (Array.isArray(lore) && !hiddenSet.has('lore')) {
    for (const line of lore) lines.push(textComponentSegments(line, { color: '#AA00AA', italic: true }))
  }
  const unbreakable = component(components, 'unbreakable')
  if (unbreakable !== undefined && !hiddenSet.has('unbreakable') && !(isObject(unbreakable) && unbreakable.show_in_tooltip === false)) {
    lines.push([{ text: '无法破坏', color: '#5555FF' }])
  }

  const unrendered = Object.keys(components).filter((key) => !HANDLED.has(stripNamespace(key)))
  return { name, tooltip: lines, hidden, foil, unrendered }
}

/** 快照与当前数据一致时用快照（含模组追加的行），否则用 WebUI 近似渲染 */
export function presentItem(item: ItemLike): ItemPresentation {
  const display = item.display
  const defaultColor = display?.defaultColor || '#FFFFFF'
  if (display && isSnapshotFresh(item)) {
    const name = display.name?.length ? display.name : [{ text: humanize(item.id), color: display.rarityColor }]
    return {
      source: 'snapshot',
      name,
      tooltip: display.tooltip?.length ? display.tooltip : [name],
      hidden: false,
      foil: display.foil === true,
      iconStale: false,
      unrendered: [],
      defaultColor,
    }
  }
  return { ...renderItemTooltip(item), source: 'webui', iconStale: !!display?.icon, defaultColor }
}
