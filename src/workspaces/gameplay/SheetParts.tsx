import { useState, type ReactNode } from 'react'
import './SheetParts.css'

export const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/** Keeps edits that the strict parser would reject as an uncommitted local draft instead of writing invalid source. */
export function useSheetDraft<T>(source: string, disabled: boolean, parse: (source: string) => T, stringify: (doc: T) => string, onChange: (source: string) => void) {
  const [draft, setDraft] = useState<{ base: string; doc: T; issue: string } | null>(null)
  const pending = !disabled && draft?.base === source ? draft : null
  const commit = (next: T) => {
    if (disabled) return
    let text: string
    try {
      text = stringify(next)
      parse(text)
    } catch (cause) {
      setDraft({ base: source, doc: next, issue: errorText(cause) })
      return
    }
    setDraft(null)
    onChange(text)
  }
  return { pending, commit, discard: () => setDraft(null) }
}

export function PendingBanner({ issue, onDiscard }: { issue: string; onDiscard: () => void }) {
  return <div className="sheet-pending" role="status">
    <span className="sheet-pending-dot" aria-hidden />
    <span><b>未写入</b>{issue}。补全后自动保存。</span>
    <button type="button" className="sheet-link" onClick={onDiscard}>撤销修改</button>
  </div>
}

export function SheetToggle({ label, hint, checked, disabled, onChange, ariaLabel }: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  ariaLabel?: string
  onChange: (checked: boolean) => void
}) {
  return <label className={`sheet-toggle${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}>
    <input type="checkbox" aria-label={ariaLabel ?? label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    <span className="sheet-toggle-track" aria-hidden><span /></span>
    <span className="sheet-toggle-text">{label}{hint && <small>{hint}</small>}</span>
  </label>
}

export function RefBadge({ missing, text }: { missing: boolean; text?: string }) {
  if (!missing) return null
  return <span className="sheet-ref-badge is-missing" title="项目中找不到该资源">{text ?? '引用缺失'}</span>
}

export function SheetField({ label, hint, invalid, children, className = '' }: { label: string; hint?: ReactNode; invalid?: boolean; children: ReactNode; className?: string }) {
  return <label className={`sheet-field${invalid ? ' is-invalid' : ''} ${className}`}>
    <span className="sheet-field-label">{label}</span>
    {children}
    {hint && <small className="sheet-field-hint">{hint}</small>}
  </label>
}

export function IconButton({ label, glyph, disabled, onClick }: { label: string; glyph: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className="sheet-icon-btn" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{glyph}</button>
}

export function JsonRepairPane({ title, label, source, error, disabled, apply, onCancel }: {
  title: string
  label: string
  source: string
  error: string
  disabled: boolean
  apply: (text: string) => void
  onCancel?: () => void
}) {
  const [text, setText] = useState(source)
  const [applyError, setApplyError] = useState('')
  const message = applyError || error
  return <div className="flow-kit-pane sheet-editor"><div className="kit-editor"><div className="kit-page sheet-page">
    <header className="kit-header sheet-header">
      <div className="sheet-heading">
        <h2>{title}</h2>
        <span className="sheet-kind">JSON 源码</span>
      </div>
      <span className="sheet-header-hint">{error ? '文档无法解析，修复后再回到表单' : '直接编辑源码，应用时按 Mod 规则校验'}</span>
    </header>
    {message ? <p className="kit-banner" role="alert">{message}</p> : <p className="sheet-note">未知字段与非法值会被拒绝；应用成功后回到表单。</p>}
    <textarea className="sheet-json" aria-label={label} spellCheck={false} disabled={disabled} value={text} onChange={e => { setText(e.target.value); setApplyError('') }} rows={22} />
    <div className="sheet-actions">
      {onCancel && <button type="button" className="sheet-btn" onClick={onCancel}>返回表单</button>}
      <button type="button" className="sheet-btn is-primary" disabled={disabled} onClick={() => { try { apply(text) } catch (cause) { setApplyError(errorText(cause)) } }}>应用 JSON</button>
    </div>
  </div></div></div>
}
