import type {TextLocalizationAdapter} from '../../textComponent/LocalizedTextField'
import type {NbtValue} from './tnbtJson'

export type GetTextLocalization = (field: string, component: unknown) => TextLocalizationAdapter | undefined
const booleanFields = new Set(['bold','italic','underlined','strikethrough','obfuscated'])

/** Component-aware TNBT decoding. Unknown fields retain their ordinary JSON shape. */
export function readDisplayText(value: NbtValue | undefined, key = ''): unknown {
  if (!value) return undefined
  if (value.type === 'compound') return Object.fromEntries(Object.entries(value.value).map(([key, child]) => [key, readDisplayText(child, key)]))
  if (value.type === 'list') return value.value.map(child => readDisplayText(child))
  if (value.type === 'byte' && booleanFields.has(key) && (value.value === 0 || value.value === 1)) return value.value === 1
  return value.value
}

/** Only called after an explicit edit; untouched children keep their original TNBT. */
export function writeDisplayText(component: unknown, original?: NbtValue): NbtValue {
  if (original && JSON.stringify(readDisplayText(original)) === JSON.stringify(component)) return original
  if (typeof component === 'string') return {type:'string',value:component}
  if (typeof component === 'boolean') return {type:'byte',value:component ? 1 : 0}
  if (typeof component === 'number' && Number.isFinite(component)) return Number.isInteger(component) && component >= -2147483648 && component <= 2147483647 ? {type:'int',value:component} : {type:'double',value:String(component)}
  if (Array.isArray(component)) return {type:'list',value:component.map((child,i)=>writeDisplayText(child,original?.type==='list'?original.value[i]:undefined))}
  if (component && typeof component === 'object') return {type:'compound',value:Object.fromEntries(Object.entries(component).map(([key,child])=>[key,writeDisplayText(child,original?.type==='compound'?original.value[key]:undefined)]))}
  throw new Error('文本组件需要字符串、对象或数组')
}

/** Display projection only: localization never rewrites the stored Component. */
export function localizedDisplayText(component: unknown, adapter?: TextLocalizationAdapter): unknown {
  if (!adapter || !component || typeof component !== 'object' || Array.isArray(component) || !('translate' in component) || component.translate !== adapter.runtimeKey) return component
  const raw = adapter.translations[adapter.activeLocale]
  if (raw === undefined) return component
  let translated: unknown = raw
  if (/^\s*[[{"]/.test(raw)) { try { translated = JSON.parse(raw) } catch { /* Plain literal. */ } }
  const {translate: _key, fallback: _fallback, with: _with, extra, ...style} = component as Record<string, unknown>
  void _key; void _fallback; void _with
  return {...style,text:'',extra:[translated,...(Array.isArray(extra)?extra:[])]}
}
