import { isObject } from '../model'
import type { GoalLocaleEntry } from './locale'
import type { GoalSelectOption, GoalWidgetSpec } from './types'

export type GoalHeaderParam = {
  labels?: Record<string, GoalLocaleEntry>
  widget?: GoalWidgetSpec
}

export type GoalHeaderMeta = {
  id?: string
  labels?: Record<string, GoalLocaleEntry>
  params?: Record<string, GoalHeaderParam>
  localize?: Record<string, string>
}

/** 跳过前置空行与 `#` 注释后，解析文件头三引号 JSON（只给 WebUI）。 */
export function parseGoalHeaderMeta(source: string): GoalHeaderMeta | null {
  const text = source.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  let index = 0
  while (
    index < lines.length &&
    (lines[index]!.trim() === '' || lines[index]!.trim().startsWith('#'))
  ) {
    index += 1
  }
  const rest = lines.slice(index).join('\n')
  const match = /^('''|""")([\s\S]*?)\1/.exec(rest)
  if (!match) return null
  try {
    const raw = JSON.parse(match[2]!) as unknown
    if (!isObject(raw)) return null
    return normalizeHeader(raw)
  } catch {
    return null
  }
}

function normalizeHeader(raw: Record<string, unknown>): GoalHeaderMeta {
  const meta: GoalHeaderMeta = {}
  if (typeof raw.id === 'string' && raw.id.trim()) meta.id = raw.id.trim()
  const labels = readLabels(raw.labels)
  if (labels) meta.labels = labels
  const localize = readStringMap(raw.localize)
  if (localize) meta.localize = localize
  if (isObject(raw.params)) {
    const params: Record<string, GoalHeaderParam> = {}
    for (const [key, value] of Object.entries(raw.params)) {
      if (!key.trim() || !isObject(value)) continue
      const param: GoalHeaderParam = {}
      const paramLabels = readLabels(value.labels)
      if (paramLabels) param.labels = paramLabels
      const widget = readWidget(value.widget)
      if (widget) param.widget = widget
      params[key] = param
    }
    if (Object.keys(params).length) meta.params = params
  }
  return meta
}

function readLabels(value: unknown): Record<string, GoalLocaleEntry> | undefined {
  if (!isObject(value)) return undefined
  const out: Record<string, GoalLocaleEntry> = {}
  for (const [locale, entry] of Object.entries(value)) {
    if (!isObject(entry)) continue
    const item: GoalLocaleEntry = {}
    if (typeof entry.name === 'string') item.name = entry.name
    if (typeof entry.description === 'string') item.description = entry.description
    if (item.name !== undefined || item.description !== undefined) out[locale.toLowerCase()] = item
  }
  return Object.keys(out).length ? out : undefined
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined
  const out: Record<string, string> = {}
  for (const [locale, text] of Object.entries(value)) {
    if (typeof text === 'string' && text.trim()) out[locale.toLowerCase()] = text
  }
  return Object.keys(out).length ? out : undefined
}

function readWidget(value: unknown): GoalWidgetSpec | undefined {
  if (!isObject(value) || typeof value.editor !== 'string' || !value.editor.trim()) return undefined
  const widget: GoalWidgetSpec = { editor: value.editor.trim() }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'editor') continue
    if (key === 'options' && Array.isArray(entry)) {
      widget.options = entry
        .filter(isObject)
        .map((option): GoalSelectOption | null => {
          if (typeof option.value !== 'string') return null
          const labels = readLabels(option.labels)
          return labels ? { value: option.value, labels } : { value: option.value }
        })
        .filter((option): option is GoalSelectOption => option !== null)
      continue
    }
    widget[key] = entry
  }
  return widget
}
