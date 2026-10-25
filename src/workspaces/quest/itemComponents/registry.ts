import type { NbtValue, ItemComponents } from '../tnbtJson'
import type { ComponentType } from 'react'
import type {GetTextLocalization} from '../displayTextNbt'

export type ComponentEditorProps = {
  value: NbtValue
  disabled: boolean
  onChange: (value: NbtValue) => void
}

/** Cards edit exactly one component; the host owns adding, removing and immutable updates. */
export type ItemComponentEditor = {
  id: string
  title: string
  tone?: 'steel' | 'amber' | 'violet' | 'green'
  wide?: boolean
  order?: number
  createValue: () => NbtValue
  /** Unsupported shapes stay intact and remain editable in the component tree. */
  accepts: (value: NbtValue) => boolean
  Editor: ComponentType<ComponentEditorProps>
}

export type ItemComponentGroupEditor = {
  kind: 'group'
  id: string
  title: string
  caption: string
  /** A form section can remain visible with no underlying components. */
  alwaysVisible?: boolean
  tone?: ItemComponentEditor['tone']
  order?: number
  componentIds: readonly string[]
  createComponents: () => ItemComponents
  Editor: ComponentType<{components: ItemComponents; disabled: boolean; getTextLocalization?: GetTextLocalization; onChange: (components: ItemComponents, loreOrder?:readonly number[]) => void}>
}
export type ItemComponentCard = ItemComponentEditor | ItemComponentGroupEditor
export const isComponentGroup = (editor: ItemComponentCard): editor is ItemComponentGroupEditor => 'kind' in editor && editor.kind === 'group'

let editors: readonly ItemComponentCard[] = []
const listeners = new Set<() => void>()
export function registerItemComponentEditor(editor: ItemComponentEditor): () => void
export function registerItemComponentEditor(editor: ItemComponentGroupEditor): () => void
export function registerItemComponentEditor(editor: ItemComponentCard): () => void {
  if (!/^[a-z0-9_.-]+:[a-z0-9/._-]+$/.test(editor.id) || editors.some(entry => entry.id === editor.id)) {
    throw new Error(`组件编辑器 ID 无效或重复：${editor.id}`)
  }
  if (isComponentGroup(editor) && (!editor.componentIds.length || new Set(editor.componentIds).size !== editor.componentIds.length
    || editor.componentIds.some(id => !/^[a-z0-9_.-]+:[a-z0-9/._-]+$/.test(id))
    || editors.some(entry => isComponentGroup(entry) && entry.componentIds.some(id => editor.componentIds.includes(id))))) {
    throw new Error(`组件组字段无效或与已注册分组重叠：${editor.id}`)
  }
  editors = [...editors, editor]
  listeners.forEach(listener => listener())
  return () => {
    editors = editors.filter(entry => entry !== editor)
    listeners.forEach(listener => listener())
  }
}
export const componentEditors = () => editors
export function subscribeComponentEditors(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function componentKey(_components: Record<string, unknown>, id: string): string { return id }
export function writeComponent(components: Record<string, unknown>, id: string, value: NbtValue) {
  return { ...components, [componentKey(components, id)]: value }
}
