import { randomId } from '../../project/crypto'
import type { ItemDocument } from './itemDoc'
import type { EntityDocument } from './entityDoc'
import { readDisplayText, writeDisplayText } from './displayTextNbt'
import type { NbtValue } from './tnbtJson'

export type DisplayTextKind = 'item' | 'entity'
export type DisplayTextDocument = ItemDocument | EntityDocument
export type DisplayTextBinding = {
  field: string
  semanticKey: string
  runtimeKey: string
  component: unknown
}

const semanticPattern = /^display\.(?:item_name|custom_name|lore\.[a-z0-9_-]+)$/
const runtimePattern = /^hanshu\.(item|entity)\.([a-z0-9_-]+)\.(display\.(?:item_name|custom_name|lore\.[a-z0-9_-]+))$/

/** Identity belongs to the reference, so renaming its source never changes translations. */
export function displayTextRuntimeKey(kind: DisplayTextKind, semanticKey: string, identity = randomId()): string {
  if (!semanticPattern.test(semanticKey) || !/^[a-z0-9_-]+$/.test(identity)) throw Error('显示文本本地化标识无效')
  return `hanshu.${kind}.${identity}.${semanticKey}`
}

export function displayTextSemanticKey(runtimeKey: string, kind?: DisplayTextKind): string | null {
  const match = runtimePattern.exec(runtimeKey)
  return match && (!kind || match[1] === kind) ? match[3] : null
}

export function displayTextFields(kind: DisplayTextKind, document: DisplayTextDocument): string[] {
  if (kind === 'entity') return ['entity.custom_name']
  const lore = (document as ItemDocument).item.components['minecraft:lore']
  return ['item.item_name', 'item.custom_name', ...(lore?.type === 'list' ? lore.value.map((_, index) => `item.lore.${index}`) : [])]
}

function textNbt(kind: DisplayTextKind, document: DisplayTextDocument, field: string): NbtValue | undefined {
  if (kind === 'entity') {
    if (field !== 'entity.custom_name') throw Error('实体显示文本字段无效')
    return (document as EntityDocument).entity.data.value.CustomName
  }
  const components = (document as ItemDocument).item.components
  if (field === 'item.item_name' || field === 'item.custom_name') return components[`minecraft:${field.slice(5)}`]
  const match = /^item\.lore\.(0|[1-9]\d*)$/.exec(field)
  const lore = components['minecraft:lore']
  if (!match || lore?.type !== 'list' || Number(match[1]) >= lore.value.length) throw Error('物品描述行不存在')
  return lore.value[Number(match[1])]
}

export function getDisplayText(kind: DisplayTextKind, document: DisplayTextDocument, field: string): unknown {
  return readDisplayText(textNbt(kind, document, field))
}

export function replaceDisplayText<T extends DisplayTextDocument>(kind: DisplayTextKind, document: T, field: string, component: unknown): T {
  const original = textNbt(kind, document, field)
  if (kind === 'entity') {
    const doc = document as EntityDocument
    return { ...doc, entity: { ...doc.entity, data: { type: 'compound', value: { ...doc.entity.data.value, CustomName: writeDisplayText(component, original) } } } } as unknown as T
  }
  const doc = document as ItemDocument
  const components = { ...doc.item.components }
  if (field === 'item.item_name' || field === 'item.custom_name') components[`minecraft:${field.slice(5)}`] = writeDisplayText(component, original)
  else {
    const index = Number(field.slice('item.lore.'.length))
    const lore = components['minecraft:lore'] as Extract<NbtValue, { type: 'list' }>
    components['minecraft:lore'] = { type: 'list', value: lore.value.map((line, i) => i === index ? writeDisplayText(component, original) : line) }
  }
  return { ...doc, item: { ...doc.item, components } } as T
}

/** Only explicit project references are bindings; ordinary Minecraft translate keys stay intact. */
export function displayTextBindings(kind: DisplayTextKind, document: DisplayTextDocument): DisplayTextBinding[] {
  const bindings: DisplayTextBinding[] = []
  for (const field of displayTextFields(kind, document)) {
    const component = getDisplayText(kind, document, field)
    if (!component || typeof component !== 'object' || Array.isArray(component)) continue
    const runtimeKey = (component as Record<string, unknown>).translate
    if (typeof runtimeKey !== 'string') continue
    const semanticKey = displayTextSemanticKey(runtimeKey, kind)
    if (semanticKey) bindings.push({ field, semanticKey, runtimeKey, component })
  }
  return bindings
}

/** Advanced Component trees can still consume translations even when their UI is read-only. */
export function displayTextReferences(kind: DisplayTextKind, document: DisplayTextDocument): DisplayTextBinding[] {
  const references: DisplayTextBinding[] = []
  function visit(component: unknown, field: string) {
    if (!component || typeof component !== 'object') return
    if (Array.isArray(component)) { component.forEach((child, index) => visit(child, `${field}.${index}`)); return }
    const value = component as Record<string, unknown>
    if (typeof value.translate === 'string') {
      const semanticKey = displayTextSemanticKey(value.translate, kind)
      if (semanticKey) references.push({ field, semanticKey, runtimeKey: value.translate, component })
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${field}.${key}`)
  }
  for (const field of displayTextFields(kind, document)) visit(getDisplayText(kind, document, field), field)
  return references
}

/** Compile document-local authored values to globally unique runtime translations. */
export function displayTextRuntimeTranslations(bindings: readonly DisplayTextBinding[], table: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const binding of bindings) if (Object.hasOwn(table, binding.semanticKey)) result[binding.runtimeKey] = table[binding.semanticKey]
  return result
}
