import { RichTextSurface } from './RichTextSurface'
import { decodeTextComponent, isTranslateComponent, TEXT_STYLE_KEYS, type TextSegment } from './codec'

export type TextLocalizationAdapter = {
  activeLocale: string
  availableLocales: string[]
  runtimeKey: string
  semanticKey: string
  translations: Record<string, string>
  loading?: boolean
  onLocaleChange: (locale: string) => void
  onTranslationChange: (locale: string, value: string | undefined) => void
  /** The owner creates the binding and seeds its language asset in the same draft. */
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
  // A Component string is literal, even when it happens to contain JSON syntax.
  return JSON.stringify(typeof value === 'string' ? { text: value } : value)
}
export function LocalizedTextField({label,value,onChange,disabled,localization,onAdvanced,baseStyle}: LocalizedTextFieldProps) {
  disabled = disabled || localization?.loading
  const bound = !!localization && isTranslateComponent(value) && value.translate === localization.runtimeKey
  const literal = value === undefined || decodeTextComponent(value).editable
  const missing = !!localization && !Object.hasOwn(localization.translations, localization.activeLocale)
  const languageValue = localization?.translations[localization.activeLocale] ?? ''
  const inheritedStyle = { ...baseStyle }
  if (bound && value && typeof value === 'object') {
    const component = value as Record<string, unknown>
    if (typeof component.color === 'string') inheritedStyle.color = component.color
    for (const key of TEXT_STYLE_KEYS) if (typeof component[key] === 'boolean') inheritedStyle[key] = component[key]
  }
  const state = localization?.loading ? '正在读取语言资产' : bound ? missing ? '缺少当前语言' : '已绑定' : literal ? value === undefined ? '未设置' : '固定文本' : isTranslateComponent(value) ? 'Minecraft 翻译键（只读）' : '高级文本（只读）'
  return <div className="localized-text-field">
    <div className="localized-text-controls">
      <label>文本来源 <select aria-label={`${label} 文本来源`} disabled={disabled} value={bound?'localized':literal?'literal':'advanced'} onChange={event=>{
        if(disabled)return
        if(event.target.value==='localized'&&localization?.onBind)onChange(localization.onBind(value))
        if(event.target.value==='literal'){
          if(!bound)return
          if(!window.confirm('使用当前语言转为固定文本并解除本地化？翻译参数将移除，其他语言译文保留。'))return
          // Keep root styles, events and unknown metadata during this explicit content conversion.
          const {translate:_translate,fallback:_fallback,with:_with,...rest}=value as Record<string,unknown>
          void _translate;void _fallback;void _with
          const translated=asComponent(languageValue)
          const content=typeof translated==='object'&&translated!==null&&!Array.isArray(translated)?translated:{text:'',extra:[translated]}
          const oldExtra=Array.isArray(rest.extra)?rest.extra:[]
          const newExtra='extra' in content&&Array.isArray(content.extra)?content.extra:[]
          const extra=[...newExtra,...oldExtra]
          onChange({...rest,...content,...(extra.length?{extra}:{})})
        }
      }}>
        <option value="literal" disabled={!literal&&!bound}>固定文本</option>
        <option value="localized" disabled={!bound&&(!literal||!localization?.onBind)}>工程本地化</option>
        {!literal&&!bound&&<option value="advanced">高级 Component</option>}
      </select></label>
      {bound&&localization&&<label>语言 <select aria-label={`${label} 语言`} value={localization.activeLocale} onChange={event=>localization.onLocaleChange(event.target.value)}>
        {localization.availableLocales.map(locale=><option key={locale} value={locale}>{locale}</option>)}
      </select></label>}
      <span role="status">{state}</span>
    </div>
    {bound&&localization?<>
      <RichTextSurface key={`${localization.runtimeKey}/${localization.activeLocale}`} label={label} value={languageValue} baseStyle={inheritedStyle} disabled={disabled} onChange={next=>localization.onTranslationChange(localization.activeLocale,next)}/>
      <small>翻译键：<code>{localization.runtimeKey}</code></small>
      {missing&&localization.availableLocales.some(locale=>Object.hasOwn(localization.translations,locale))&&<button type="button" disabled={disabled} onClick={()=>{
        const locale=localization.availableLocales.find(locale=>Object.hasOwn(localization.translations,locale))
        if(locale&&!disabled)localization.onTranslationChange(localization.activeLocale,localization.translations[locale])
      }}>复制已有译文</button>}
      {!missing&&<button type="button" disabled={disabled} onClick={()=>{if(!disabled&&window.confirm('删除当前语言的译文？'))localization.onTranslationChange(localization.activeLocale,undefined)}}>删除当前译文</button>}
    </>:literal?<RichTextSurface label={label} value={componentValue(value)} baseStyle={baseStyle} disabled={disabled} onChange={next=>{if(!disabled)onChange(asComponent(next))}}/>:<>
      <div className="kit-field"><span>{label}</span><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(value,null,2)}</pre></div>
      {onAdvanced&&<button type="button" onClick={onAdvanced}>在组件树中编辑</button>}
    </>}
  </div>
}
