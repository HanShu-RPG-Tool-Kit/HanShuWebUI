import { cloneEffectValue, colorWithAlpha, effectColor, type EffectField } from './regionEffects'

export function EffectValue({ field, value, disabled, onChange }: { field: EffectField; value: unknown; disabled?: boolean; onChange: (value: unknown) => void }) {
  const current = value ?? field.default
  const available = !field.optional || value !== undefined
  const n = typeof current === 'number' ? current : Number(current), finite = Number.isFinite(n)
  const bounded = field.type === 'number' && field.min !== undefined && field.max !== undefined && field.max - field.min <= 100000
  const logarithmic = bounded && field.min! >= 0 && field.max! > 100
  const fromSlider = (x: number) => logarithmic ? field.min! + (Math.exp(x / 1000 * Math.log1p(field.max! - field.min!)) - 1) : x
  const sliderValue = logarithmic ? Math.log1p(Math.max(0, n - field.min!)) / Math.log1p(field.max! - field.min!) * 1000 : n
  const color = field.type === 'color' ? effectColor(current) ?? effectColor(field.default) ?? { hex: '#ffffff', alpha: 1 } : null
  const rgbOnly = !!field.opaque
  return <div className={`region-effect-value type-${field.type}`}>
    <div className="region-effect-value-label"><label>{field.optional && <input type="checkbox" aria-label={`覆盖${field.label}`} checked={available} disabled={disabled} onChange={e => onChange(e.target.checked ? cloneEffectValue(field.default) : undefined)} />}{field.label}{field.unit && <small>{field.unit}</small>}</label>{value !== undefined && <button type="button" title={`恢复${field.label}默认值`} aria-label={`恢复${field.label}默认值`} disabled={disabled} onClick={() => onChange(undefined)}>↺</button>}</div>
    {field.type === 'boolean' ? <label className="region-effect-switch"><input type="checkbox" aria-label={field.label} checked={!!current} disabled={disabled || !available} onChange={e => onChange(e.target.checked)} /><span>{current ? '开启' : '关闭'}</span></label>
      : field.type === 'choice' ? <select aria-label={field.label} value={String(current)} disabled={disabled || !available} onChange={e => onChange(e.target.value)}>{field.choices?.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
      : color ? <div className="region-effect-color"><input type="color" aria-label={field.label} value={color.hex} disabled={disabled || !available} onChange={e => onChange(colorWithAlpha(e.target.value, rgbOnly ? 1 : color.alpha))} /><span>{!available ? '跟随默认' : color.hex.toUpperCase()}</span>{!rgbOnly && <label>透明度<input type="range" aria-label={`${field.label}透明度`} min="0" max="1" step="0.01" value={color.alpha} disabled={disabled || !available} onChange={e => onChange(colorWithAlpha(color.hex, Number(e.target.value)))} /></label>}</div>
      : field.type.startsWith('vec') ? <div className="region-effect-vector">{Array.from({ length: Number(field.type.slice(3)) }, (_, i) => <label key={i}>{['X', 'Y', 'Z', 'W'][i]}<input aria-label={`${field.label} ${['X', 'Y', 'Z', 'W'][i]}`} type="number" step={field.step ?? .01} value={Number((current as number[])[i])} disabled={disabled || !available} onChange={e => { const next = [...current as number[]]; next[i] = e.target.value === '' ? NaN : Number(e.target.value); onChange(next) }} /></label>)}</div>
      : field.type === 'number' ? <div className="region-effect-number">{bounded && <input type="range" aria-label={`${field.label}滑块`} min={logarithmic ? 0 : field.min} max={logarithmic ? 1000 : field.max} step={logarithmic ? 1 : field.step ?? .01} value={finite ? sliderValue : 0} disabled={disabled || !available} onChange={e => { const v = fromSlider(Number(e.target.value)), step = field.step ?? .01; onChange(Number((Math.round(v / step) * step).toFixed(6))) }} />}<input type="number" aria-label={field.label} min={field.min} max={field.max} step={field.step ?? 'any'} value={finite ? n : ''} disabled={disabled || !available} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} /></div>
      : <input type="text" aria-label={field.label} value={String(current)} disabled={disabled || !available} onChange={e => onChange(e.target.value)} />}
  </div>
}
