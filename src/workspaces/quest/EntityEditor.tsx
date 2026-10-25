import {useEffect,useId,useState,useSyncExternalStore} from 'react'
import {flushSync} from 'react-dom'
import {controlRequest,getControlHubSnapshot,subscribeControlHub} from '../../gameDevServer'
import {isEntityTypeId,parseEntity,stringifyEntity,type EntityDocument} from './entityDoc'
import {NbtTree} from './NbtComponentsEditor'
import {EntityFieldCards} from './entityFields/EntityFieldCards'
import {EntityPreview} from './EntityPreview'
import {openEntityEditInGame} from '../../gameDevServer/entityWorkbench'
import type {GetTextLocalization} from './displayTextNbt'
import './EntityEditor.css'
export function EntityEditor({source,onChange,disabled,active=true,documentKey,getTextLocalization}:{source:string;onChange:(source:string)=>void;disabled?:boolean;active?:boolean;documentKey?:string;getTextLocalization?:GetTextLocalization}){
 const typesId=useId()
 const connection=useSyncExternalStore(subscribeControlHub,getControlHubSnapshot),online=connection.phase==='open'
 const [types,setTypes]=useState<{id:string;name:string}[]>([]),[error,setError]=useState('')
 const [idDraft,setIdDraft]=useState<string|null>(null)
 const [tagsDraft,setTagsDraft]=useState<string|null>(null)
 useEffect(()=>{let live=true;if(online)void controlRequest('entities.list',{}).then(raw=>{const r=raw as {version:number;items:{id:string;name:string}[]};if(r.version!==1||!Array.isArray(r.items))throw Error('实体目录无效');if(live)setTypes(r.items)}).catch(e=>{if(live)setError(String(e))});return()=>{live=false}},[online])
 // 外部换源（撤销 / 重载）时丢掉未提交草稿
 useEffect(()=>{setIdDraft(null);setTagsDraft(null)},[source])
 let doc:EntityDocument|null=null
 let parseError=''
 try{doc=parseEntity(source)}catch(e){parseError=String(e)}
 if(!doc)return <div className="entity-editor-error"><p role="alert">{parseError}</p><textarea aria-label="修复实体模板" value={source} disabled={disabled} onChange={e=>onChange(e.target.value)}/></div>
 const update=(next:EntityDocument)=>{if(disabled)return false;try{const checked=parseEntity(stringifyEntity(next));setError('');onChange(stringifyEntity(checked));return true}catch(e){setError(String(e));return false}}
 const commitId=(raw:string)=>{
  const next=raw.trim()
  if(next===doc.entity.id){setIdDraft(null);setError('');return}
  if(!isEntityTypeId(next)){setError('实体类型 ID 无效或为玩家');return}
  if(update({...doc,entity:{...doc.entity,id:next}}))setIdDraft(null)
 }
 const commitTags=(raw:string)=>{
  const tags=[...new Set(raw.split(/[,，]/).map(t=>t.trim()).filter(Boolean))]
  const same=tags.length===doc.tags.length&&tags.every((tag,i)=>tag===doc.tags[i])
  if(same){setTagsDraft(null);return}
  if(update({...doc,tags}))setTagsDraft(null)
 }
 return <div className="entity-editor"><aside><EntityPreview template={doc} active={active}/><button type="button" disabled={!online||disabled||!active||!documentKey} onClick={()=>{if(documentKey)void openEntityEditInGame(documentKey,doc).catch(e=>setError(String(e)))}}>发送到游戏内编辑</button>{error&&<p role="alert">{error}</p>}</aside>
  <main><section className="entity-card"><h3>实体定义</h3><label>实体类型<input list={typesId} aria-label="实体类型" disabled={disabled} value={idDraft??doc.entity.id} spellCheck={false} onChange={e=>{const value=e.target.value;setIdDraft(value);if(isEntityTypeId(value.trim())&&value.trim()!==doc.entity.id)flushSync(()=>commitId(value))}} onBlur={e=>flushSync(()=>commitId(e.target.value))} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();(e.target as HTMLInputElement).blur()}}}/><datalist id={typesId}>{types.map(type=><option value={type.id} key={type.id}>{type.name}</option>)}</datalist></label><label>标签<input aria-label="实体标签" disabled={disabled} value={tagsDraft??doc.tags.join(', ')} onChange={e=>setTagsDraft(e.target.value)} onBlur={e=>flushSync(()=>commitTags(e.target.value))} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();(e.target as HTMLInputElement).blur()}}}/></label></section>
   <EntityFieldCards document={doc} disabled={!!disabled} getTextLocalization={getTextLocalization} onChange={update}/>
   <section className="entity-card"><h3>完整实体数据</h3><NbtTree value={doc.entity.data} disabled={disabled} onChange={data=>{if(data.type==='compound')update({...doc,entity:{...doc.entity,data}})}}/></section>
  </main></div>
}
