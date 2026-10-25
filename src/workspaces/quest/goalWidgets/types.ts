import type { ComponentType } from 'react'
import type { GoalConfigField, GoalConfigValue } from '../goalDefinitions'

/** 文件头 `widget` 对象：至少有 `editor`，其余为各 editor 的参数。 */
export type GoalWidgetSpec = {
  editor: string
  [key: string]: unknown
}

export type GoalSelectOption = {
  value: string
  labels?: Record<string, { name?: string; description?: string }>
}

export type GoalWidgetProps = {
  field: GoalConfigField
  widget: GoalWidgetSpec | undefined
  value: GoalConfigValue | undefined
  inherited: boolean
  disabled?: boolean
  locale: string
  onChange: (value: GoalConfigValue | undefined, immediate?: boolean) => void
}

export type GoalWidgetEditor = {
  /** 对应 `widget.editor` */
  id: string
  order?: number
  Editor: ComponentType<GoalWidgetProps>
}
