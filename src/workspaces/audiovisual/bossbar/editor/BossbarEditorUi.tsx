import { useEffect, useState, type ReactNode } from 'react'

/** 设计视图共用的小控件：统一 label 排版与"输入过程中不打断"的行为 */

export function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="bb-section">
      <header className="bb-section-head">
        <h4>{title}</h4>
        {extra}
      </header>
      <div className="bb-section-body">{children}</div>
    </section>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="bb-row">
      <span className="bb-row-label">{label}</span>
      <span className="bb-row-control">{children}</span>
    </label>
  )
}

/** 数字输入：输入中途保留原文，失焦或回车才提交；非法值回退 */
export function NumberField({
  value,
  onCommit,
  step = 1,
  min,
  max,
  suffix,
  disabled,
}: {
  value: number
  onCommit: (value: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
  disabled?: boolean
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(formatNumberText(value))
  }, [focused, value])
  const commit = (raw: string) => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setText(formatNumberText(value))
      return
    }
    let next = parsed
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    setText(formatNumberText(next))
    if (next !== value) onCommit(next)
  }
  return (
    <span className="bb-number">
      <input
        className="bb-input bb-mono"
        type="number"
        step={step}
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onChange={(event) => setText(event.target.value)}
        onBlur={(event) => {
          setFocused(false)
          commit(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit((event.target as HTMLInputElement).value)
            ;(event.target as HTMLInputElement).blur()
          }
        }}
      />
      {suffix && <em>{suffix}</em>}
    </span>
  )
}

function formatNumberText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000)
}

export function TextField({
  value,
  onCommit,
  placeholder,
  mono,
  disabled,
}: {
  value: string
  onCommit: (value: string) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
}) {
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(value)
  }, [focused, value])
  return (
    <input
      className={'bb-input' + (mono ? ' bb-mono' : '')}
      type="text"
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        setFocused(false)
        if (text !== value) onCommit(text)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
      }}
    />
  )
}

export function ColorField({
  value,
  onCommit,
  disabled,
}: {
  value: string
  onCommit: (value: string) => void
  disabled?: boolean
}) {
  const hex = /^#[0-9A-Fa-f]{6}/.test(value) ? value.slice(0, 7) : '#ffffff'
  const alpha = /^#[0-9A-Fa-f]{8}$/.test(value) ? parseInt(value.slice(7, 9), 16) : 255
  return (
    <span className="bb-color">
      <input
        type="color"
        value={hex}
        disabled={disabled}
        onChange={(event) => {
          const rgb = event.target.value.slice(1).toUpperCase()
          const alpha = /^#[0-9A-Fa-f]{8}$/.test(value) ? value.slice(7, 9).toUpperCase() : 'FF'
          onCommit('#' + rgb + alpha)
        }}
      />
      <TextField
        mono
        value={value}
        disabled={disabled}
        onCommit={(next) => onCommit(normalizeColor(next, value))}
      />
      <NumberField
        value={alpha}
        min={0}
        max={255}
        step={1}
        disabled={disabled}
        onCommit={(next) => onCommit(value.slice(0, 7).toUpperCase() + Math.round(next).toString(16).toUpperCase().padStart(2, '0'))}
      />
    </span>
  )
}

function normalizeColor(next: string, fallback: string): string {
  const text = next.trim()
  if (/^#[0-9A-Fa-f]{8}$/.test(text)) return text.toUpperCase()
  if (/^#[0-9A-Fa-f]{6}$/.test(text)) return (text + 'FF').toUpperCase()
  return fallback
}

export function SelectField<T extends string>({
  value,
  options,
  onCommit,
  disabled,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onCommit: (value: T) => void
  disabled?: boolean
}) {
  return (
    <select
      className="bb-input"
      value={value}
      disabled={disabled}
      onChange={(event) => onCommit(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function ToggleField({
  checked,
  onCommit,
  label,
  disabled,
}: {
  checked: boolean
  onCommit: (value: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <label className="bb-toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCommit(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  variant,
  title,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'danger' | 'ghost'
  title?: string
}) {
  return (
    <button
      type="button"
      className={'bb-button' + (variant ? ' bb-button-' + variant : '')}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="bb-empty-hint">{children}</p>
}
