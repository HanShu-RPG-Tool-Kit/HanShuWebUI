import './EntityEditor.css'
import {useEffect,useId,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import type {EntityDocument} from './entityDoc'
import {entityFingerprint,readEntitySnapshot,entitySnapshotRevision,subscribeEntitySnapshots} from './entitySnapshot'
import {attachEntityPreview,updateEntityPreview,entityPreviewInput,resetEntityPreview,type PreviewAnimation,type PreviewStatus} from '../../gameDevServer/entityPreviewStream'

export function EntityPreviewSurface({template,active=true,animation='idle',interactive=false,onResetId}:{template:EntityDocument;active?:boolean;animation?:PreviewAnimation;interactive?:boolean;onResetId?:(id:string)=>void}){
 const id=useId(),canvas=useRef<HTMLCanvasElement>(null),drag=useRef<{x:number;y:number;button:number}|null>(null)
 const [status,setStatus]=useState<PreviewStatus>({online:false,running:false,error:''}),[image,setImage]=useState<string|null>(null)
 const revision=useSyncExternalStore(subscribeEntitySnapshots,entitySnapshotRevision)
 const fingerprint=useMemo(()=>entityFingerprint(template),[template])
 const width=interactive?640:256,height=interactive?480:192
 const spec={id,template,width,height,animation},latest=useRef(spec);latest.current=spec
 useEffect(()=>{let live=true;setImage(null);void readEntitySnapshot(fingerprint).then(png=>{if(live)setImage(png)});return()=>{live=false}},[fingerprint,revision])
 useEffect(()=>{onResetId?.(id)},[id,onResetId])
 useEffect(()=>{if(!active||!canvas.current)return;return attachEntityPreview(latest.current,canvas.current,setStatus)},[id,active])
 useEffect(()=>{updateEntityPreview(latest.current)},[id,fingerprint,animation,width,height])
 return <div className="entity-preview-surface" title={status.error||(!status.online?'游戏离线 · 显示本机快照':undefined)} onContextMenu={interactive?e=>e.preventDefault():undefined}>
  <canvas ref={canvas} width={width} height={height} aria-label="实体串流画面" style={{display:status.running&&active?'block':'none'}} onPointerDown={interactive?e=>{if(e.button!==0&&e.button!==2)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,button:e.button}}:undefined} onPointerMove={interactive?e=>{const d=drag.current;if(!d)return;const r=e.currentTarget.getBoundingClientRect();entityPreviewInput(id,d.button===2?'pan':'rotate',(e.clientX-d.x)/r.width,(e.clientY-d.y)/r.height);drag.current={...d,x:e.clientX,y:e.clientY}}:undefined} onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}} onPointerCancel={()=>{drag.current=null}} onWheel={interactive?e=>{e.preventDefault();entityPreviewInput(id,'zoom',0,-Math.sign(e.deltaY)*.12)}:undefined}/>
  {(!status.running||!active)&&(image?<img alt="实体展示快照" src={image} draggable={false}/>:<span>{status.error?'预览暂不可用':status.online?'正在准备预览…':'游戏离线 · 暂无快照'}</span>)}
 </div>
}
export function EntityPreview({template,active=true}:{template:EntityDocument;active?:boolean}){
 const [animation,setAnimation]=useState<PreviewAnimation>('idle'),[id,setId]=useState('')
 return <section className="entity-preview" aria-label="实体预览"><header><strong>实体预览</strong><div className="entity-preview-tools"><select aria-label="预览动画" value={animation} onChange={e=>setAnimation(e.target.value as PreviewAnimation)}>{([['idle','闲置'],['walk','行走'],['run','奔跑'],['attack','攻击'],['spin','旋转']] as const).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select><button type="button" title="重置视图" aria-label="重置视图" onClick={()=>void resetEntityPreview(id).catch(()=>{})}>↺</button></div></header>
  <div className="entity-preview-image"><EntityPreviewSurface template={template} active={active} animation={animation} interactive onResetId={setId}/></div><small>左键旋转 · 右键平移 · 滚轮缩放</small>
 </section>
}
