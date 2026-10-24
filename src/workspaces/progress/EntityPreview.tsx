import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import {controlRequest,getControlHubSnapshot,subscribeControlHub} from '../../gameDevServer'
import {controlWsUrl} from '../../gameDevServer/protocol'
import type {EntityDocument} from './entityDoc'
import {readEntityStreamFrame,entityFingerprint,readEntitySnapshot,saveEntitySnapshot} from './entitySnapshot'

type Session={id:string;ws:WebSocket;heartbeat:ReturnType<typeof setInterval>;fingerprint:string;frames:number;inputFrame:number;paintFrame:number;latest:ArrayBuffer|null;inFlight:number;sequence:number;dirty:boolean;decoding:boolean;totals:Record<string,number>}
export function EntityPreview({template,active=true}:{template:EntityDocument;active?:boolean}){
 const connection=useSyncExternalStore(subscribeControlHub,getControlHubSnapshot),online=connection.phase==='open'
 const [image,setImage]=useState<{key:string;png:string}|null>(null),[running,setRunning]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const canvas=useRef<HTMLCanvasElement>(null),session=useRef<Session|null>(null),generation=useRef(0),drag=useRef<{x:number;y:number;button:number}|null>(null)
 const fingerprint=useMemo(()=>entityFingerprint(template),[template])
 const stop=useCallback(()=>{generation.current++;const s=session.current;session.current=null;drag.current=null;if(s){clearInterval(s.heartbeat);cancelAnimationFrame(s.inputFrame);cancelAnimationFrame(s.paintFrame);s.ws.close();void controlRequest('entities.preview.close',{sessionId:s.id}).catch(()=>{})}setRunning(false);setBusy(false)},[])
 useEffect(()=>{let live=true;void readEntitySnapshot(fingerprint).then(png=>{if(live&&png)setImage({key:fingerprint,png})});return()=>{live=false}},[fingerprint])
 useEffect(()=>{if(!active||!online)stop()},[active,online,stop])
 useEffect(()=>()=>stop(),[stop])
 const request=async(action:string,extra:object={})=>{const s=session.current;if(s)await controlRequest('entities.preview.input',{sessionId:s.id,action,...extra})}
 const input=(action:string,dx:number,dy:number)=>{const s=session.current;if(!s)return;const x=action+'X',y=action+'Y';s.totals[x]=(s.totals[x]??0)+dx;s.totals[y]=(s.totals[y]??0)+dy;s.dirty=true}
 async function open(){
  if(busy||session.current||!active||!online)return;const epoch=++generation.current;setBusy(true);setError('')
  try{const result=await controlRequest('entities.preview.open',{template}) as {version:number;sessionId:string;streamPath:string};if(result.version!==1||typeof result.sessionId!=='string'||result.streamPath!=='/ws/stream')throw Error('实体预览协议无效');
   if(epoch!==generation.current){void controlRequest('entities.preview.close',{sessionId:result.sessionId}).catch(()=>{});return}
   const {host,port,password}=connection.prefs,url=new URL(controlWsUrl(host,port,password));url.pathname=result.streamPath
   const ws=new WebSocket(url);ws.binaryType='arraybuffer'
   const s:Session={id:result.sessionId,ws,fingerprint,frames:0,inputFrame:0,paintFrame:0,latest:null,inFlight:0,sequence:0,dirty:false,decoding:false,totals:{},heartbeat:setInterval(()=>{void request('heartbeat').catch(()=>stop())},2000)};session.current=s;setRunning(true)
   const pump=()=>{
    if(session.current!==s)return
    if(s.dirty&&s.inFlight<4){s.dirty=false;s.inFlight++;void controlRequest('entities.preview.input',{sessionId:s.id,action:'view',sequence:++s.sequence,...s.totals}).catch(e=>{if(session.current===s)setError(String(e))}).finally(()=>{s.inFlight--})}
    s.inputFrame=requestAnimationFrame(pump)
   };s.inputFrame=requestAnimationFrame(pump)
   const paint=async()=>{
    s.paintFrame=0;if(session.current!==s||!s.latest)return;const data=s.latest;s.latest=null;s.decoding=true
    let bitmap:ImageBitmap|null=null
    try{
     const frame=readEntityStreamFrame(data)
     if(frame.encoding==='jpeg'){bitmap=await createImageBitmap(new Blob([new Uint8Array(frame.payload)],{type:'image/jpeg'}));if(bitmap.width!==frame.width||bitmap.height!==frame.height)throw Error('预览压缩帧尺寸不匹配')}
     const c=canvas.current;if(session.current!==s||!c)return
     if(c.width!==frame.width)c.width=frame.width;if(c.height!==frame.height)c.height=frame.height
     const ctx=c.getContext('2d');if(frame.encoding==='rgba')ctx?.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels),frame.width,frame.height),0,0);else if(bitmap)ctx?.drawImage(bitmap,0,0)
     s.frames++;if(s.frames===3){const png=c.toDataURL('image/png');setImage({key:s.fingerprint,png});void saveEntitySnapshot(s.fingerprint,png)}
    }catch(e){if(session.current===s){setError(String(e));stop()}}finally{bitmap?.close();s.decoding=false;if(session.current===s&&s.latest&&!s.paintFrame)s.paintFrame=requestAnimationFrame(()=>void paint())}
   }
   ws.onmessage=event=>{if(session.current!==s||!(event.data instanceof ArrayBuffer))return;s.latest=event.data;if(!s.paintFrame&&!s.decoding)s.paintFrame=requestAnimationFrame(()=>void paint())}
   ws.onclose=()=>{if(session.current===s){setError('预览串流已关闭');stop()}};ws.onerror=()=>{if(session.current===s)setError('无法连接实体画面串流')}
  }catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:String(e))}finally{if(epoch===generation.current)setBusy(false)}
 }
 async function update(){try{await request('update',{template});if(session.current){session.current.fingerprint=fingerprint;session.current.frames=0}setError('')}catch(e){setError(String(e))}}
 return <section className="entity-preview" aria-label="实体预览"><header><strong>实体预览</strong><span>{running?'实时画面':image?'本机快照':'暂无快照'}</span></header>
  <div className="entity-preview-image" onContextMenu={e=>e.preventDefault()}>
   {running?<canvas ref={canvas} aria-label="实体串流画面" onPointerDown={e=>{if(e.button!==0&&e.button!==2)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,button:e.button}}} onPointerMove={e=>{const d=drag.current;if(!d)return;const r=e.currentTarget.getBoundingClientRect();input(d.button===2?'pan':'rotate',(e.clientX-d.x)/r.width,(e.clientY-d.y)/r.height);drag.current={...d,x:e.clientX,y:e.clientY}}} onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}} onPointerCancel={()=>{drag.current=null}} onWheel={e=>{e.preventDefault();input('zoom',0,-Math.sign(e.deltaY)*.12)}}/>:image?<img alt="实体展示快照" src={image.png}/>:<p>连接游戏并开启预览<br/>加载时按实体大小固定取景</p>}
  </div>
  {image&&image.key!==fingerprint&&!running&&<small>模板已修改 · 快照待更新</small>}
  <div className="entity-preview-tools">{!running?<button type="button" disabled={!online||!active||busy} onClick={()=>void open()}>{busy?'正在连接…':'开启在线预览'}</button>:<><button type="button" onClick={()=>void update()}>刷新预览</button><button type="button" onClick={()=>void request('reset').catch(e=>setError(String(e)))}>重置视图</button><button type="button" onClick={stop}>关闭</button><select aria-label="预览动画" defaultValue="idle" onChange={e=>void request('animation',{animation:e.target.value}).catch(e=>setError(String(e)))}>{['idle','walk','run','attack','spin'].map(mode=><option key={mode}>{mode}</option>)}</select></>}</div>
  <small>{running?'左键旋转 · 右键平移 · 滚轮缩放':online?'游戏已连接':'游戏开发服务器离线'}</small>
  {error&&<p role="alert">{error}</p>}
 </section>
}
