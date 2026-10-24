import type {ComponentType} from 'react'
import type {NbtValue} from '../tnbtJson'
import type {EntityDocument} from '../entityDoc'
export type EntityFieldEditorProps={data:Readonly<Record<string,NbtValue>>;entityType:string;disabled:boolean;onChange:(data:Record<string,NbtValue>)=>void}
export type EntityFieldEditor={
 id:string;title:string;tone?:'steel'|'violet'|'amber'|'green';order?:number;
 /** Exclusive root NBT keys owned by this card. Other keys cannot be overwritten. */
 fields:readonly string[];
 appliesTo?:(document:EntityDocument)=>boolean;
 Editor:ComponentType<EntityFieldEditorProps>;
}
let entries:readonly EntityFieldEditor[]=[]
const listeners=new Set<()=>void>()
export function registerEntityFieldEditor(editor:EntityFieldEditor){
 if(!/^[a-z0-9_.-]+:[a-z0-9/._-]+$/.test(editor.id)||entries.some(e=>e.id===editor.id))throw Error(`实体字段编辑器 ID 无效或重复：${editor.id}`)
 if(!editor.fields.length||new Set(editor.fields).size!==editor.fields.length||editor.fields.some(k=>!k||['__proto__','constructor','prototype'].includes(k))||entries.some(e=>e.fields.some(k=>editor.fields.includes(k))))throw Error(`实体字段所有权重复或无效：${editor.id}`)
 entries=[...entries,editor].sort((a,b)=>(a.order??100)-(b.order??100)||a.id.localeCompare(b.id));listeners.forEach(f=>f())
 return ()=>{entries=entries.filter(e=>e!==editor);listeners.forEach(f=>f())}
}
export const entityFieldEditors=()=>entries
export function subscribeEntityFieldEditors(f:()=>void){listeners.add(f);return()=>{listeners.delete(f)}}
export function applyEntityFieldEdit(original:Readonly<Record<string,NbtValue>>,owned:readonly string[],next:Readonly<Record<string,NbtValue>>){
 const result={...original};for(const key of owned){if(Object.hasOwn(next,key))Object.defineProperty(result,key,{value:next[key],writable:true,configurable:true,enumerable:true});else delete result[key]}return result
}
