import { RichTextSurface } from './RichTextSurface'
import { decodeTextComponent, isTranslateComponent, TEXT_STYLE_KEYS, type TextSegment } from './codec'

export type TextLocalizationAdapter = {
  activeLocale: string
  availableLocales: string[]
  bound?: boolean
  localized?: boolean
  onModeChange?: (localized:boolean) => void
  runtimeKey: string
  semanticKey: string
  translations: Record<string, string>
  loading?: boolean
  error?: string
  onRetry?: () => void
  onLocaleChange: (locale: string) => void
  onTranslationChange: (locale: string, value: string | undefined) => void
  /** Creates the binding and stages the edited text in the same document draft. */
  onBind?: (component: unknown) => unknown
}
export type LocalizedTextFieldProps = {
  label: string
  value: unknown
  disabled?: boolean
  onChange: (component: unknown) => void
  localization?: TextLocalizationAdapter
  onAdvanced?: () => void
  baseStyle?: Omit<TextSegment, 'text'>
}
function asComponent(raw: string): unknown {
  if (/^\s*[[{"]/.test(raw)) { try { return JSON.parse(raw) } catch { /* plain text */ } }
  return { text: raw }
}
function componentValue(value: unknown): string {
  if (value === undefined) return ''
  return JSON.stringify(typeof value === 'string' ? { text: value } : value)
}
/** Language is owned by the workspace status bar; editing creates a project binding automatically. */
export function LocalizedTextField({label,value,onChange,disabled,localization,onAdvanced,baseStyle}: LocalizedTextFieldProps) {
  const bound = localization?.bound === true && isTranslateComponent(value) && value.translate === localization.runtimeKey
  const localized=localization?.localized!==false
  const translationDisabled = disabled || localization?.loading || !!localization?.error
  const literal = value === undefined || decodeTextComponent(value).editable
  const missing = !!localization && !Object.hasOwn(localization.translations, localization.activeLocale)
  const languageValue = localization?.translations[localization.activeLocale] ?? ''
  const inheritedStyle = { ...baseStyle }
  if (bound && value && typeof value === 'object') {
    const component = value as Record<string, unknown>
    if (typeof component.color === 'string') inheritedStyle.color = component.color
    for (const key of TEXT_STYLE_KEYS) if (typeof component[key] === 'boolean') inheritedStyle[key] = component[key]
  }
  return <div className="localized-text-field">
    {localization&&(bound||literal)&&<label className="localized-text-mode"><input type="checkbox" aria-label={`${label} 本地化`} checked={localized} disabled={disabled||!localization.onModeChange||localization.loading||!!localization.error} onChange={event=>localization.onModeChange?.(event.target.checked)}/>本地化</label>}
    {(localized&&(localization?.error || localization?.loading || (bound && missing))) && <div className="localized-text-controls">
      {localization?.error ? <span role="alert">译文读取失败{localization.onRetry && <button type="button" onClick={localization.onRetry}>重试读取译文</button>}</span>
        : <span role="status">{localization?.loading ? '正在读取语言资产…' : '当前语言尚未填写'}</span>}
    </div>}
    {bound||literal?<RichTextSurface key={localization?.activeLocale??'literal'} label={label} value={bound?languageValue:componentValue(value)} baseStyle={bound?inheritedStyle:baseStyle} disabled={bound?translationDisabled:disabled || (localized&&localization?.loading)} onChange={next=>{
        if(bound&&localization){if(!translationDisabled)localization.onTranslationChange(localization.activeLocale,next);return}
        if(disabled || (localized&&localization?.loading))return
        const edited=asComponent(next)
        onChange(localized&&localization?.onBind ? localization.onBind(edited) : edited)
      }}/>:<>
        <div className="kit-field"><span>{label}</span><span role="status">{isTranslateComponent(value)?'Minecraft 翻译键（只读）':'高级文本（只读）'}</span><pre>{JSON.stringify(value,null,2)}</pre></div>
        {onAdvanced&&<button type="button" onClick={onAdvanced}>在组件树中编辑</button>}
      </>}
  </div>
}
