import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { useProjectSession } from '../../project/projectSession'
import { notify } from '../../activity'
import { randomId } from '../../project/crypto'
import { loadDisplayLocaleTables, projectDisplayLocales, stageDisplayTranslation, type LocaleTable } from '../../gameDevServer/displayLocalization'
import { displayTextBindings, displayTextRuntimeKey, displayTextSemanticKey, type DisplayTextDocument, type DisplayTextKind } from './displayTextLocale'
import { parseEntity } from './entityDoc'
import type { GetTextLocalization } from './displayTextNbt'
import { ItemEditor } from './ItemEditor'
import { EntityEditor } from './EntityEditor'

type LocaleProps = { name: string; locale: string; onLocaleChange: (locale: string) => void }
function useDisplayLocalization(kind: DisplayTextKind, document: DisplayTextDocument | null, { name, locale, onLocaleChange }: LocaleProps): GetTextLocalization {
  const session = useProjectSession(), client = session.binding?.handle.client
  const [tables, setTables] = useState<Map<string, LocaleTable>>(new Map())
  const [failure,setFailure] = useState<{client:typeof client;name:string;locales:string;error:string}|null>(null)
  const [retry,setRetry] = useState(0)
  const loaded = useRef<{ client: typeof client; name: string; locales: string } | null>(null)
  const locales = client ? projectDisplayLocales(client, locale) : [locale]
  const localeList = locales.join(',')
  useEffect(() => {
    let cancelled = false
    loaded.current = null
    setFailure(null)
    if (!client) return
    void loadDisplayLocaleTables(client, name, localeList.split(',')).then(next => {
      if (cancelled) return
      loaded.current = { client, name, locales: localeList }
      setTables(next)
    }).catch(error => { if (!cancelled) {setFailure({client,name,locales:localeList,error:String(error)});notify(`译文读取失败：${String(error)}`, { kind: 'error', source: 'localization' })} })
    return () => { cancelled = true }
  }, [client, name, localeList, client?.remoteEpoch,retry])
  function write(semanticKey: string, targetLocale: string, value: string | undefined) {
    if (!client?.writable || loaded.current?.client !== client || loaded.current.name !== name || loaded.current.locales !== localeList) throw Error('译文尚未加载或工程只读')
    const table = tables.get(targetLocale)
    if (!table) throw Error('当前语言不可编辑')
    const next = stageDisplayTranslation(client, table, semanticKey, value)
    setTables(previous => new Map(previous).set(targetLocale, next))
  }
  return (field, component) => {
    const runtimeKey = component && typeof component === 'object' && !Array.isArray(component) && 'translate' in component && typeof component.translate === 'string' ? component.translate : ''
    const projectKey = displayTextSemanticKey(runtimeKey, kind)
    const semanticKey = projectKey ?? (field.startsWith('item.lore.') ? `display.lore.${randomId()}` : `display.${field.split('.').at(-1)}`)
    const ready = !!client?.writable && loaded.current?.client === client && loaded.current.name === name && loaded.current.locales === localeList
    const currentTables = loaded.current?.client === client && loaded.current?.name === name && loaded.current?.locales === localeList ? tables : new Map<string, LocaleTable>()
    const error=failure?.client===client&&failure?.name===name&&failure?.locales===localeList?failure.error:undefined
    return {
      bound:projectKey!==null, error, onRetry:()=>setRetry(value=>value+1),
      activeLocale: locale, availableLocales: locales, semanticKey, runtimeKey:projectKey?runtimeKey:'', loading: !!client && !error && (!loaded.current || currentTables !== tables),
      translations: Object.fromEntries([...currentTables].flatMap(([locale, table]) => Object.hasOwn(table.values, semanticKey) ? [[locale, table.values[semanticKey]]] : [])),
      onLocaleChange,
      onTranslationChange: (locale, value) => { try { write(semanticKey, locale, value) } catch (error) { notify(String(error), { kind: 'error', source: 'localization' }) } },
      onBind: ready ? original => {
        if (document && displayTextBindings(kind, document).some(binding => binding.semanticKey === semanticKey && binding.field !== field)) {
          notify('另一个名称使用了此翻译键，请先解除其本地化绑定', { kind: 'warning', source: 'localization' })
          return original
        }
        // Seeding the translation is synchronous staging; the normal project save waits for its mirror.
        write(semanticKey, locale, original === undefined ? '' : typeof original === 'string' ? JSON.stringify({ text: original }) : JSON.stringify(original))
        return { translate: displayTextRuntimeKey(kind, semanticKey) }
      } : undefined,
    }
  }
}

export function LocalizedItemEditor(props: Omit<ComponentProps<typeof ItemEditor>, 'getTextLocalization'> & LocaleProps) {
  const { name, locale, onLocaleChange, ...editor } = props
  const getTextLocalization = useDisplayLocalization('item', editor.doc, { name, locale, onLocaleChange })
  return <ItemEditor {...editor} getTextLocalization={getTextLocalization}/>
}
export function LocalizedEntityEditor(props: Omit<ComponentProps<typeof EntityEditor>, 'getTextLocalization'> & LocaleProps) {
  const { name, locale, onLocaleChange, ...editor } = props
  let document = null
  try { document = parseEntity(editor.source) } catch { /* The editor exposes malformed source for repair. */ }
  const getTextLocalization = useDisplayLocalization('entity', document, { name, locale, onLocaleChange })
  return <EntityEditor {...editor} getTextLocalization={getTextLocalization}/>
}
