import { readComponents, readNbt, type ItemComponents } from '../tnbtJson'
import { useRef, useState, useSyncExternalStore } from 'react'
import { NodeContextMenu } from '../NodeContextMenu'
import { componentEditors, componentKey, isComponentGroup, subscribeComponentEditors, writeComponent, type ItemComponentGroupEditor } from './registry'
import './builtins'
import './complexCards'

export function ItemComponentCards({ components, disabled = false, onChange }: {
  components: Record<string, unknown>
  disabled?: boolean
  onChange: (components: ItemComponents) => void
}) {
  const editors = useSyncExternalStore(subscribeComponentEditors, componentEditors)
  const [menu, setMenu] = useState<{x: number; y: number} | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const values = readComponents(components)
  const grouped = new Set(editors.filter(isComponentGroup).flatMap(editor => editor.componentIds))
  const visible = editors.filter(editor => isComponentGroup(editor) || !grouped.has(editor.id)).sort((a,b)=>(a.order ?? 100)-(b.order ?? 100))
  const active = visible.filter(editor => isComponentGroup(editor)
    ? editor.alwaysVisible || editor.componentIds.some(id => Object.hasOwn(values, id)) : Object.hasOwn(values, editor.id))
  const available = visible.filter(editor => !active.includes(editor))
  function updateGroup(editor: ItemComponentGroupEditor, next: ItemComponents) {
    if(disabled)return
    const merged={...values}
    for(const id of editor.componentIds) { if(Object.hasOwn(next,id))merged[id]=next[id];else delete merged[id] }
    onChange(readComponents(merged))
  }
  return <section className="item-section item-common-section">
    <header className="item-section-head"><h3>常用组件</h3>
      <button ref={addRef} type="button" className="item-component-plus" aria-label="添加常用组件" aria-haspopup="menu" aria-expanded={!!menu}
        disabled={disabled || !available.length} onClick={() => { const rect = addRef.current?.getBoundingClientRect(); if (rect) setMenu(menu ? null : {x: rect.right - 280, y: rect.bottom + 5}) }}>＋</button>
    </header>
    <div className="item-section-body item-component-cards">
    {active.map(editor => {
      if (isComponentGroup(editor)) {
        const Editor = editor.Editor
        return <article className={`item-component-card is-wide is-${editor.tone ?? 'steel'}`} key={editor.id} aria-label={editor.title}>
          <header><div className="item-component-caption"><h4>{editor.title}</h4><code>{editor.caption}</code></div>
            <button type="button" className="item-tree-action" aria-label={`${editor.alwaysVisible ? '清空' : '移除'}${editor.title}`} title={`${editor.alwaysVisible ? '清空已设置的组件，保留编辑区' : '删除此分组的组件'}`} disabled={disabled} onClick={()=>{if(disabled)return;const next={...values};for(const id of editor.componentIds)delete next[id];onChange(next)}}>×</button></header>
          <Editor components={values} disabled={disabled} onChange={next=>updateGroup(editor,next)}/>
        </article>
      }

      const key = componentKey(components, editor.id)
      const value = readNbt(components[key])
      const Editor = editor.Editor
      return <article className={`item-component-card ${editor.wide ? 'is-wide' : ''} is-${editor.tone ?? 'steel'}`} key={editor.id} aria-label={editor.title}>
        <header><div className="item-component-caption"><h4>{editor.title}</h4><code>{editor.id}</code></div><button type="button" className="item-tree-action" aria-label={`移除${editor.title}`} disabled={disabled}
          onClick={() => { if (!disabled) { const next = { ...components }; delete next[key]; onChange(readComponents(next)) } }}>×</button></header>
        {editor.accepts(value)
          ? <Editor value={value} disabled={disabled} onChange={next => { if (!disabled) onChange(readComponents(writeComponent(components, editor.id, next))) }} />
          : <p className="item-card-note">此数据格式请在下方组件树中编辑。</p>}
      </article>
    })}
    {!active.length && <p className="item-card-note">从右上角 ＋ 选择 Minecraft 组件。</p>}
    </div>
    {menu && <NodeContextMenu {...menu} anchor={addRef} boundary={addRef} title="Minecraft 组件" label="添加常用组件" className="item-context-menu item-component-dropdown"
      items={available.map(editor => ({label: isComponentGroup(editor) ? editor.title : `${editor.title} · ${editor.id}`, disabled,
        action: () => { if(disabled)return;if(isComponentGroup(editor))updateGroup(editor,editor.createComponents());else onChange(readComponents(writeComponent(components, editor.id, editor.createValue()))) }}))}
      onClose={(restore = true) => { setMenu(null); if (restore) addRef.current?.focus({preventScroll:true}) }} />}
  </section>
}
