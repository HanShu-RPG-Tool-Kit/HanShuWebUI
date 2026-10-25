import { useState } from 'react'
import type { GoalConfigValue } from '../goalDefinitions'
import { pickGoalLocaleName } from './locale'
import type { GoalSelectOption, GoalWidgetProps } from './types'

function asNumber(value: GoalConfigValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function NumberField({
  label,
  value,
  integer,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string
  value: number | undefined
  integer?: boolean
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  onChange: (value: GoalConfigValue | undefined, immediate?: boolean) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const valid = (text: string) => {
    if (text.trim() === '') return true
    if (!Number.isFinite(Number(text))) return false
    if (integer && !Number.isInteger(Number(text))) return false
    const number = Number(text)
    if (min !== undefined && number < min) return false
    if (max !== undefined && number > max) return false
    return true
  }
  function commit() {
    if (draft === null) return
    if (draft.trim() === '') {
      onChange(undefined, true)
      setDraft(null)
      setError(false)
      return
    }
    if (!valid(draft)) {
      setError(true)
      return
    }
    onChange(Number(draft), true)
    setDraft(null)
    setError(false)
  }
  return (
    <span className="progress-number">
      <input
        type="number"
        step={step ?? (integer ? 1 : 'any')}
        min={min}
        max={max}
        inputMode={integer ? 'numeric' : 'decimal'}
        aria-label={label}
        aria-invalid={error}
        disabled={disabled}
        value={draft ?? (value === undefined ? '' : String(value))}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(event.target.validity.badInput)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') {
            setDraft(null)
            setError(false)
          }
        }}
      />
      {error && (
        <small role="alert">请输入合法{integer ? '整数' : '数值'}；尚未保存，Esc 撤销</small>
      )}
    </span>
  )
}

export function TextGoalWidget({ field, value, disabled, onChange }: GoalWidgetProps) {
  const name = field.label || field.key
  const hint =
    field.widget?.editor === 'suggest' && typeof field.widget.type === 'string'
      ? `补全源 ${field.widget.type}（暂用文本）`
      : field.widget?.editor === 'tags' && typeof field.widget.type === 'string'
        ? `标签源 ${field.widget.type}（暂用文本）`
        : undefined
  return (
    <input
      aria-label={name}
      disabled={disabled}
      value={typeof value === 'string' ? value : value === undefined ? '' : String(value)}
      placeholder={hint || '请输入'}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function NumberGoalWidget({ field, value, widget, disabled, onChange }: GoalWidgetProps) {
  return (
    <NumberField
      label={field.label || field.key}
      value={asNumber(value)}
      integer={field.type === 'int'}
      min={typeof widget?.min === 'number' ? widget.min : undefined}
      max={typeof widget?.max === 'number' ? widget.max : undefined}
      step={typeof widget?.step === 'number' ? widget.step : undefined}
      disabled={disabled}
      onChange={onChange}
    />
  )
}

export function SliderGoalWidget({ field, value, widget, disabled, onChange }: GoalWidgetProps) {
  const min = Number(widget?.min)
  const max = Number(widget?.max)
  const step = typeof widget?.step === 'number' ? widget.step : field.type === 'int' ? 1 : 0.1
  const current = asNumber(value) ?? (Number.isFinite(min) ? min : 0)
  const name = field.label || field.key
  return (
    <label className="progress-goal-slider">
      <input
        type="range"
        aria-label={name}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(event) => {
          const next = Number(event.target.value)
          onChange(field.type === 'int' ? Math.trunc(next) : next, true)
        }}
      />
      <output aria-hidden>{current}</output>
    </label>
  )
}

export function BoolGoalWidget({ field, value, disabled, onChange }: GoalWidgetProps) {
  const name = field.label || field.key
  const checked = Boolean(value)
  return (
    <label className="progress-bool">
      <input
        type="checkbox"
        role="switch"
        aria-label={name}
        disabled={disabled}
        checked={checked}
        onChange={(event) => onChange(event.target.checked, true)}
      />
      <span>{checked ? '开启' : '关闭'}</span>
    </label>
  )
}

export function SelectGoalWidget({
  field,
  value,
  widget,
  disabled,
  locale,
  onChange,
}: GoalWidgetProps) {
  const name = field.label || field.key
  const options = (Array.isArray(widget?.options) ? widget!.options : []) as GoalSelectOption[]
  const current = value === undefined ? '' : String(value)
  const known = options.some((option) => option.value === current)
  return (
    <select
      aria-label={name}
      disabled={disabled}
      value={current}
      onChange={(event) => onChange(event.target.value, true)}
    >
      <option value="" disabled>
        请选择
      </option>
      {current && !known && (
        <option value={current}>
          {current}（无效）
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {pickGoalLocaleName(option.labels, locale, option.value)}
        </option>
      ))}
    </select>
  )
}
