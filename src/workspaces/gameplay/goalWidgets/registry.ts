import type { GoalConfigField, GoalConfigFieldType } from '../goalDefinitions'
import type { GoalWidgetEditor, GoalWidgetSpec } from './types'

let entries: readonly GoalWidgetEditor[] = []
let revision = 0
const listeners = new Set<() => void>()

function notify() {
  revision += 1
  listeners.forEach((fn) => fn())
}

export function registerGoalWidgetEditor(editor: GoalWidgetEditor) {
  const id = editor.id.trim()
  if (!id || entries.some((item) => item.id === id)) {
    throw Error(`Goal widget 编辑器 ID 无效或重复：${editor.id}`)
  }
  const next = { ...editor, id }
  entries = [...entries, next].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
  )
  notify()
  return () => {
    entries = entries.filter((item) => item !== next)
    notify()
  }
}

export function goalWidgetEditors() {
  return entries
}

export function goalWidgetEditorsRevision() {
  return revision
}

export function subscribeGoalWidgetEditors(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function lookupGoalWidgetEditor(id: string): GoalWidgetEditor | undefined {
  return entries.find((item) => item.id === id)
}

/** 运行时类型 → 默认 editor（未写 widget / 未知 editor 时）。 */
export function defaultEditorForFieldType(type: GoalConfigFieldType): string {
  if (type === 'bool') return 'bool'
  if (type === 'int' || type === 'float') return 'number'
  return 'text'
}

/**
 * 解析字段最终使用的 editor：
 * 1. widget.editor 已注册 → 用之
 * 2. slider 缺 min/max → 降级 number
 * 3. suggest / tags（本阶段无 RPC）→ text
 * 4. 否则按字段类型默认
 */
export function resolveGoalWidget(
  field: GoalConfigField,
): { editorId: string; widget: GoalWidgetSpec | undefined; Editor: GoalWidgetEditor['Editor'] } {
  const widget = field.widget
  let editorId = widget?.editor?.trim() || ''
  if (editorId === 'slider') {
    const min = Number(widget?.min)
    const max = Number(widget?.max)
    if (!Number.isFinite(min) || !Number.isFinite(max)) editorId = 'number'
  }
  if (editorId === 'suggest' || editorId === 'tags') {
    // 需要游戏目录 RPC 的类型本阶段统一回退文本框，保留 type 信息给 title。
    if (!lookupGoalWidgetEditor(editorId)) editorId = 'text'
  }
  if (!editorId || !lookupGoalWidgetEditor(editorId)) {
    editorId = defaultEditorForFieldType(field.type)
  }
  const found = lookupGoalWidgetEditor(editorId) ?? lookupGoalWidgetEditor('text')
  if (!found) throw Error('未注册 text Goal widget，请先 import registerBuiltins')
  return { editorId: found.id, widget, Editor: found.Editor }
}
