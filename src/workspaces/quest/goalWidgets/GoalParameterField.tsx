import { useSyncExternalStore } from 'react'
import type { GoalConfigField, GoalConfigValue } from '../goalDefinitions'
import {
  pickGoalLocaleDescription,
  pickGoalLocaleName,
} from './locale'
import {
  goalWidgetEditorsRevision,
  resolveGoalWidget,
  subscribeGoalWidgetEditors,
} from './registry'
import './registerBuiltins'

export function GoalParameterField({
  field,
  value,
  disabled,
  locale,
  onChange,
}: {
  field: GoalConfigField
  value: GoalConfigValue | undefined
  disabled?: boolean
  locale: string
  onChange: (value: GoalConfigValue | undefined, immediate?: boolean) => void
}) {
  useSyncExternalStore(subscribeGoalWidgetEditors, goalWidgetEditorsRevision, goalWidgetEditorsRevision)
  const inherited = value === undefined
  const current = value ?? field.default
  const name = pickGoalLocaleName(field.labels, locale, field.label || field.key)
  const description = pickGoalLocaleDescription(field.labels, locale) || field.hint
  const resolved = resolveGoalWidget({ ...field, label: name })
  const { Editor } = resolved
  return (
    <div className={`progress-parameter${inherited ? ' is-default' : ' is-explicit'}`}>
      <span className="progress-parameter-name" title={description || undefined}>
        {name}
        {field.required && <sup>*</sup>}
      </span>
      <div className="progress-parameter-control">
        <div className="progress-parameter-input" title={description || undefined}>
          <Editor
            field={{ ...field, label: name }}
            widget={field.widget}
            value={current}
            inherited={inherited}
            disabled={disabled}
            locale={locale}
            onChange={onChange}
          />
        </div>
        <span className="progress-value-origin">
          {inherited ? (field.default === undefined ? '未填写' : '默认') : '已填写'}
        </span>
        <button
          type="button"
          className="progress-reset-value"
          disabled={inherited || disabled}
          aria-label={`${name}：${field.default === undefined ? '清除填写' : '恢复默认值'}`}
          title={
            field.default === undefined ? '清除填写' : `恢复默认值：${String(field.default)}`
          }
          onClick={() => onChange(undefined, true)}
        >
          ↶
        </button>
      </div>
    </div>
  )
}
