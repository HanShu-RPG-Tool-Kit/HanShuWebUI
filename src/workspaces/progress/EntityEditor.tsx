import {useEffect,useLayoutEffect,useId,useRef,useState,useSyncExternalStore} from 'react'
import {controlRequest,getControlHubSnapshot,subscribeControlHub} from '../../gameDevServer'
import {parseEntity,stringifyEntity,type EntityDocument} from './entityDoc'
import {NbtTree} from './NbtComponentsEditor'
import {EntityFieldCards} from './entityFields/EntityFieldCards'
import {EntityPreview} from './EntityPreview'
import {openEntityEditInGame} from '../../gameDevServer/entityWorkbench'
import './EntityEditor.css'
export function EntityEditor({source,onChange,disabled,active=true,documentKey}:{source:string;onChange:(source:string)=>void;disabled?:boolean;active?:boolean;documentKey?:string}){
 const typesId=useId()
 const connection=useSyncExternalStore(subscribeControlHub,getControlHubSnapshot),online=connection.phase==='open'
 const [types,setTypes]=useState<{id:string;name:string}[]>([]),[error,setError]=useState(''),[capturing,setCapturing]=useState(false)
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const current=useRef({source,onChange,disabled,active});useLayoutEffect(()=>{current.current={source,onChange,disabled,active}},[source,onChange,disabled,active])
 useEffect(()=>{let live=true;if(online)void controlRequest('entities.list',{}).then(raw=>{const r=raw as {version:number;items:{id:string;name:string}[]};if(r.version!==1||!Array.isArray(r.items))throw Error('实体目录无效');if(live)setTypes(r.items)}).catch(e=>{if(live)setError(String(e))});return()=>{live=false}},[online])
 let doc:EntityDocument;try{doc=parseEntity(source)}catch(e){return <div className="entity-editor-error"><p role="alert">{String(e)}</p><textarea aria-label="修复实体模板" value={source} disabled={disabled} onChange={e=>onChange(e.target.value)}/></div>}
 const update=(next:EntityDocument)=>{if(disabled)return;try{const checked=parseEntity(stringifyEntity(next));setError('');onChange(stringifyEntity(checked))}catch(e){setError(String(e))}}
 async function capture(){if(!online||disabled||capturing)return;const original=source;setCapturing(true);setError('');try{const result=await controlRequest('entities.capture',{}) as {version:number;template:unknown};if(result.version!==1)throw Error('实体捕获协议无效');const next=parseEntity(JSON.stringify(result.template));if(!alive.current||current.current.disabled||!current.current.active||current.current.source!==original)throw Error('捕获期间文档已修改，请重新捕获');current.current.onChange(stringifyEntity({...next,tags:doc.tags}))}catch(e){setError(String(e))}finally{setCapturing(false)}}
 return <div className="entity-editor"><aside><EntityPreview template={doc} active={active}/><button type="button" disabled={!online||disabled||capturing||!active} onClick={()=>void capture()}>{capturing?'正在捕获…':'捕获游戏中指向的实体'}</button><button type="button" disabled={!online||disabled||!active||!documentKey} onClick={()=>{if(documentKey)void openEntityEditInGame(documentKey,doc).catch(e=>setError(String(e)))}}>发送到游戏内编辑</button>{error&&<p role="alert">{error}</p>}</aside>
  <main><section className="entity-card"><h3>实体定义</h3><label>实体类型<input list={typesId} aria-label="实体类型" disabled={disabled} key={doc.entity.id} defaultValue={doc.entity.id} onBlur={e=>{if(e.target.value!==doc.entity.id)update({...doc,entity:{...doc.entity,id:e.target.value}})}}/><datalist id={typesId}>{types.map(type=><option value={type.id} key={type.id}>{type.name}</option>)}</datalist></label><label>标签<input aria-label="实体标签" disabled={disabled} defaultValue={doc.tags.join(', ')} key={doc.tags.join(',')} onBlur={e=>update({...doc,tags:[...new Set(e.target.value.split(/[,，]/).map(t=>t.trim()).filter(Boolean))]})}/></label></section>
   <EntityFieldCards document={doc} disabled={!!disabled} onChange={update}/>
   <section className="entity-card"><h3>完整实体数据</h3><NbtTree value={doc.entity.data} disabled={disabled} onChange={data=>{if(data.type==='compound')update({...doc,entity:{...doc.entity,data}})}}/></section>
  </main></div>
}
