import {useSyncExternalStore} from 'react'
import type {EntityDocument} from '../entityDoc'
import {applyEntityFieldEdit,entityFieldEditors,subscribeEntityFieldEditors} from './registry'
import './registerBuiltins'
export function EntityFieldCards({document,disabled,onChange}:{document:EntityDocument;disabled:boolean;onChange:(doc:EntityDocument)=>void}){
 const editors=useSyncExternalStore(subscribeEntityFieldEditors,entityFieldEditors)
 return <>{editors.filter(e=>!e.appliesTo||e.appliesTo(document)).map(e=><section key={e.id} className={`entity-card entity-field-card tone-${e.tone??'steel'}`}><h3>{e.title}</h3><e.Editor data={document.entity.data.value} entityType={document.entity.id} disabled={disabled} onChange={next=>{if(!disabled)onChange({...document,entity:{...document.entity,data:{type:'compound',value:applyEntityFieldEdit(document.entity.data.value,e.fields,next)}}})}}/></section>)}</>
}
