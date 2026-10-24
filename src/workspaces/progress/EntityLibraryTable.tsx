import {useEffect,useMemo,useState,useSyncExternalStore} from 'react'
import type {FlowDocument} from './storage'
import {isEntityDocument} from './library'
import {parseEntity,type EntityDocument} from './entityDoc'
import {entityFingerprint,readEntitySnapshot,entitySnapshotRevision,subscribeEntitySnapshots} from './entitySnapshot'
import './EntityLibraryTable.css'
type Row={key:string;name:string;document:EntityDocument|null;error:string}
function EntityTile({row,onOpen}:{row:Row;onOpen:(key:string)=>void}){
 const revision=useSyncExternalStore(subscribeEntitySnapshots,entitySnapshotRevision)
 const fingerprint=useMemo(()=>row.document?entityFingerprint(row.document):'',[row.document])
 const [snapshot,setSnapshot]=useState<{key:string;png:string}|null>(null)
 useEffect(()=>{let live=true;if(fingerprint)void readEntitySnapshot(fingerprint).then(png=>{if(live)setSnapshot(png?{key:fingerprint,png}:null)});return()=>{live=false}},[fingerprint,revision])
 const image=snapshot?.key===fingerprint?snapshot.png:null
 return <button type="button" className={`entity-library-tile${row.error?' has-error':''}`} onClick={()=>onOpen(row.key)} title={row.error||row.name} aria-label={`打开实体 ${row.name}`}>
  <div className="entity-library-thumbnail">{image?<img src={image} alt="" draggable={false}/>:<span>{row.error?'数据有误':'暂无快照'}</span>}</div>
  <div className="entity-library-caption"><strong>{row.name.replace(/\.entity$/i,'')}</strong><span>{row.document?.entity.id??'无法解析'}</span><div className="entity-library-tags">{row.document?.tags.slice(0,3).map(t=><small key={t}>{t}</small>)}{(row.document?.tags.length??0)>3&&<small>+{row.document!.tags.length-3}</small>}</div></div>
 </button>
}
/** Only this page's tiles mount/read image cache. No hidden live previews or infinite scrolling. */
export function EntityLibraryTable({documents,onOpen}:{documents:FlowDocument[];onOpen:(key:string)=>void}){
 const [query,setQuery]=useState(''),[size,setSize]=useState(12),[page,setPage]=useState(0)
 const rows=useMemo(()=>documents.filter(isEntityDocument).map(d=>{try{return {key:d.key,name:d.name,document:parseEntity(d.source),error:''}}catch(e){return {key:d.key,name:d.name,document:null,error:String(e)}}}).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true})),[documents])
 const filtered=useMemo(()=>{const q=query.trim().toLocaleLowerCase();return rows.filter(r=>!q||[r.name,r.document?.entity.id,...(r.document?.tags??[])].join(' ').toLocaleLowerCase().includes(q))},[rows,query])
 const pages=Math.max(1,Math.ceil(filtered.length/size)),current=Math.min(page,pages-1),visible=filtered.slice(current*size,(current+1)*size)
 return <section className="entity-library-table" aria-label="实体库网格表"><header><div><strong>实体库</strong><span>{filtered.length} 个实体</span></div><input type="search" aria-label="搜索实体" placeholder="搜索名称、类型或标签" value={query} onChange={e=>{setQuery(e.target.value);setPage(0)}}/></header>
 <div className="entity-library-grid">{visible.map(row=><EntityTile key={row.key} row={row} onOpen={onOpen}/>)}{!visible.length&&<p className="entity-library-empty">{query?'没有匹配的实体':'在资源管理器的实体库中新建或导入 .entity'}</p>}</div>
 <footer><label>每页<select aria-label="实体每页数量" value={size} onChange={e=>{setSize(Number(e.target.value));setPage(0)}}>{[12,24,48].map(n=><option key={n}>{n}</option>)}</select></label><nav aria-label="实体库分页"><button type="button" aria-label="实体上一页" disabled={current===0} onClick={()=>setPage(current-1)}>‹</button><span>{current+1} / {pages}</span><button type="button" aria-label="实体下一页" disabled={current+1>=pages} onClick={()=>setPage(current+1)}>›</button></nav></footer></section>
}
