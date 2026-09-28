import { useState, type ReactNode } from 'react'
import { parseJsonValue } from '../../utils/strictJson'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flow-field"><span>{label}</span>{children}</label>
}

export function TextField({ label, value, onChange, multiline = false, placeholder, disabled }: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean; placeholder?: string; disabled?: boolean
}) {
  return <Field label={label}>{multiline
    ? <textarea value={value} disabled={disabled} rows={4} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    : <input value={value} disabled={disabled} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />}</Field>
}

/** JSON subfields are applied explicitly; pending input blocks navigation and export. */
export function JsonField({ label, value, onApply, onPending, shape = 'object' }: {
  label: string; value: unknown; onApply: (value: unknown) => void; onPending: (label: string, pending: boolean) => void; shape?: 'object' | 'array'
}) {
  const canonical = JSON.stringify(value, null, 2)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const dirty = draft !== null && draft !== canonical
  function apply() {
    try {
      const parsed = parseJsonValue(draft ?? canonical)
      if (shape === 'array' ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(shape === 'array' ? '请输入 JSON 数组' : '请输入 JSON 对象')
      }
      onApply(parsed)
      setDraft(null)
      setError('')
      onPending(label, false)
    } catch (cause) { setError(String(cause)) }
  }
  return <div className="flow-json-field">
    <Field label={label}><textarea className="flow-code" rows={5} spellCheck={false} value={draft ?? canonical} onChange={(event) => {
      setDraft(event.target.value)
      setError('')
      onPending(label, event.target.value !== canonical)
    }} /></Field>
    {dirty && <div className="flow-inline-actions"><button type="button" onClick={apply}>应用 {label}</button><button type="button" onClick={() => { setDraft(null); setError(''); onPending(label, false) }}>放弃修改</button></div>}
    {error && <p className="flow-error" role="alert">{error}</p>}
  </div>
}
