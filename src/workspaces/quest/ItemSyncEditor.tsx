import {useState} from 'react'
import {readItemSync, pathContains, syncRuleErrors, TEMPLATE_COMPONENT, type ItemSync} from './itemSync'
import type {ItemComponents,NbtValue} from './tnbtJson'

export function ItemSyncEditor({components,value,disabled,onChange}:{components:ItemComponents;value?:ItemSync;disabled?:boolean;onChange:(value:ItemSync)=>void}) {
  const sync=readItemSync(value)
  const [extra,setExtra]=useState(''),[error,setError]=useState('')
  const errors=syncRuleErrors(sync,components)
  const update=(next:ItemSync)=>onChange(readItemSync(next))
  function toggle(component:string,path:string[]) {
    if(!path.length) {
      const enabled=sync.instanceComponents.includes(component)
      update({...sync,instanceComponents:enabled?sync.instanceComponents.filter(id=>id!==component):[...sync.instanceComponents,component],instanceFields:sync.instanceFields.filter(r=>r.component!==component)})
    } else {
      const enabled=sync.instanceFields.some(r=>r.component===component&&r.path.length===path.length&&pathContains(r.path,path))
      update({...sync,instanceFields:enabled?sync.instanceFields.filter(r=>!(r.component===component&&pathContains(path,r.path))):[...sync.instanceFields,{component,path}]})
    }
  }
  function row(component:string,node:NbtValue|undefined,path:string[]=[],inherited=false):React.ReactNode {
    const explicit=!path.length?sync.instanceComponents.includes(component):sync.instanceFields.some(r=>r.component===component&&r.path.length===path.length&&pathContains(r.path,path))
    const open=inherited||explicit
    const hasChildren=node?.type==='compound'&&Object.keys(node.value).length>0
    const content=<div className="item-sync-row">
      <span className="item-sync-key" title={path.length?JSON.stringify(path):component}>{path.length?JSON.stringify(path.at(-1)):component}</span>
      {node&&<span className={`item-tree-badge is-${node.type}`}>{node.type}</span>}
      {hasChildren&&<span className="item-sync-expand-hint"><span className="when-closed">展开字段</span><span className="when-open">收起字段</span></span>}
      <button type="button" className={`item-sync-mode${open?' is-instance':''}`} disabled={disabled||inherited} aria-label={`${component}${path.length?' '+JSON.stringify(path):''}：${open?'实例管理':'模板锁定'}`} aria-pressed={open} title={inherited?'父节点已开放，包含此字段':node?.type==='compound'?'切换此字段及整棵子树的管理方式':'切换管理方式'} onClick={()=>toggle(component,path)}>{inherited?'随父节点':open?'实例管理':'模板锁定'}</button>
    </div>
    if(!hasChildren||node?.type!=='compound') return <div key={JSON.stringify(path)}>{content}</div>
    return <details key={JSON.stringify(path)} className="item-sync-branch"><summary>{content}</summary><div className="item-sync-children">{Object.entries(node.value).map(([key,child])=>row(component,child,[...path,key],open))}</div></details>
  }
  function addExtra() {
    try {update({...sync,instanceComponents:[...sync.instanceComponents,extra.trim()]});setExtra('');setError('')}
    catch(e){setError(e instanceof Error?e.message:String(e))}
  }
  return <section className="item-section item-sync-section">
    <header className="item-section-head"><h3>模板同步</h3><span>默认锁定 · 开放字段包含整棵子树</span></header>
    <div className="item-section-body">
      <label className="item-sync-extra"><span>允许未声明的额外组件<small>关闭时，仅保留模板组件和下方明确开放的实例状态。</small></span><input type="checkbox" role="switch" checked={sync.allowExtraComponents} disabled={disabled} onChange={e=>update({...sync,allowExtraComponents:e.target.checked})}/></label>
      <p className="item-sync-help">点击 compound 行的「展开字段」，可单独开放其中的字段；list 和数组按整体管理。</p>
      <div className="item-sync-tree">{Object.entries(components).filter(([id])=>id!==TEMPLATE_COMPONENT).map(([id,node])=><div key={id} className="item-sync-component">{row(id,node)}</div>)}</div>
      {sync.instanceComponents.filter(id=>!Object.hasOwn(components,id)).map(id=><div key={id} className="item-sync-component">{row(id,undefined)}</div>)}
      <div className="item-sync-add"><input aria-label="允许的实例组件 ID" placeholder="允许额外实例组件，如 minecraft:enchantments" value={extra} disabled={disabled} onChange={e=>{setExtra(e.target.value);setError('')}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();addExtra()}}}/><button type="button" disabled={disabled||!extra.trim()} onClick={addExtra}>允许组件</button></div>
      {error&&<p role="alert" className="item-banner is-error">{error}</p>}
      {errors.length>0&&<div role="alert" className="item-banner is-error">{errors.map(message=><p key={message}>{message}</p>)}<span>请恢复字段，或移除失效的开放规则后再导出。</span></div>}
      {sync.instanceFields.map(rule=><div className="item-sync-rule" key={JSON.stringify(rule)}><span>{rule.component} / {rule.path.map(k=>JSON.stringify(k)).join(' / ')}</span><button type="button" disabled={disabled} onClick={()=>update({...sync,instanceFields:sync.instanceFields.filter(r=>r!==rule)})}>收回开放</button></div>)}
    </div>
  </section>
}
