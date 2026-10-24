import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import {controlRequest,getControlHubSnapshot,subscribeControlHub} from '../../gameDevServer'
import {controlWsUrl} from '../../gameDevServer/protocol'
import type {EntityDocument} from './entityDoc'
import {decodeEntityFrame,entityFingerprint,readEntitySnapshot,saveEntitySnapshot} from './entitySnapshot'

type Session={id:string;ws:WebSocket;heartbeat:ReturnType<typeof setInterval>;fingerprint:string;frames:number}
export function EntityPreview({template,active=true}:{template:EntityDocument;active?:boolean}){
 const connection=useSyncExternalStore(subscribeControlHub,getControlHubSnapshot),online=connection.phase==='open'
 const [image,setImage]=useState<{key:string;png:string}|null>(null),[running,setRunning]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const canvas=useRef<HTMLCanvasElement>(null),session=useRef<Session|null>(null),generation=useRef(0),drag=useRef<{x:number;y:number;button:number}|null>(null)
 const fingerprint=useMemo(()=>entityFingerprint(template),[template])
 const pending=useRef<Record<string,{dx:number;dy:number}>>({}),sending=useRef(false)
 const stop=useCallback(()=>{generation.current++;const s=session.current;session.current=null;pending.current={};drag.current=null;if(s){clearInterval(s.heartbeat);s.ws.close();void controlRequest('entities.preview.close',{sessionId:s.id}).catch(()=>{})}setRunning(false);setBusy(false)},[])
 useEffect(()=>{let live=true;void readEntitySnapshot(fingerprint).then(png=>{if(live&&png)setImage({key:fingerprint,png})});return()=>{live=false}},[fingerprint])
 useEffect(()=>{if(!active||!online)stop()},[active,online,stop])
 useEffect(()=>()=>stop(),[stop])
 const request=async(action:string,extra:object={})=>{const s=session.current;if(s)await controlRequest('entities.preview.input',{sessionId:s.id,action,...extra})}
 const flush=async()=>{if(sending.current||!session.current)return;sending.current=true;try{while(session.current&&Object.keys(pending.current).length){const [action,delta]=Object.entries(pending.current)[0];delete pending.current[action];await request(action,delta)}}catch(e){setError(String(e))}finally{sending.current=false}}
 const input=(action:string,dx:number,dy:number)=>{const before=pending.current[action]??{dx:0,dy:0};pending.current[action]={dx:Math.max(-2,Math.min(2,before.dx+dx)),dy:Math.max(-2,Math.min(2,before.dy+dy))};void flush()}
 async function open(){
  if(busy||session.current||!active||!online)return;const epoch=++generation.current;setBusy(true);setError('')
  try{const result=await controlRequest('entities.preview.open',{template}) as {version:number;sessionId:string;streamPath:string};if(result.version!==1||typeof result.sessionId!=='string'||result.streamPath!=='/ws/stream')throw Error('实体预览协议无效');
   if(epoch!==generation.current){void controlRequest('entities.preview.close',{sessionId:result.sessionId}).catch(()=>{});return}
   const {host,port,password}=connection.prefs,url=new URL(controlWsUrl(host,port,password));url.pathname=result.streamPath
   const ws=new WebSocket(url);ws.binaryType='arraybuffer'
   const s:Session={id:result.sessionId,ws,fingerprint,frames:0,heartbeat:setInterval(()=>{void request('heartbeat').catch(()=>stop())},2000)};session.current=s;setRunning(true)
   ws.onmessage=event=>{if(session.current!==s||!(event.data instanceof ArrayBuffer))return;try{const frame=decodeEntityFrame(event.data),c=canvas.current;if(!c)return;c.width=frame.width;c.height=frame.height;c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels),frame.width,frame.height),0,0);s.frames++;if(s.frames===3){const png=c.toDataURL('image/png');setImage({key:s.fingerprint,png});void saveEntitySnapshot(s.fingerprint,png)}}catch(e){setError(String(e));stop()}}
   ws.onclose=()=>{if(session.current===s){setError('预览串流已关闭');stop()}};ws.onerror=()=>{if(session.current===s)setError('无法连接实体画面串流')}
  }catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:String(e))}finally{if(epoch===generation.current)setBusy(false)}
 }
 async function update(){try{await request('update',{template});if(session.current){session.current.fingerprint=fingerprint;session.current.frames=0}setError('')}catch(e){setError(String(e))}}
 return <section className="entity-preview" aria-label="实体预览"><header><strong>实体预览</strong><span>{running?'实时画面':image?'本机快照':'暂无快照'}</span></header>
  <div className="entity-preview-image" onContextMenu={e=>e.preventDefault()}>
   {running?<canvas ref={canvas} aria-label="实体串流画面" onPointerDown={e=>{if(e.button!==0&&e.button!==2)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,button:e.button}}} onPointerMove={e=>{const d=drag.current;if(!d)return;const r=e.currentTarget.getBoundingClientRect();input(d.button===2?'pan':'rotate',(e.clientX-d.x)/r.width,(e.clientY-d.y)/r.height);drag.current={...d,x:e.clientX,y:e.clientY}}} onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}} onPointerCancel={()=>{drag.current=null}} onWheel={e=>{e.preventDefault();input('zoom',0,-Math.sign(e.deltaY)*.12)}}/>:image?<img alt="实体展示快照" src={image.png}/>:<p>连接游戏并开启预览<br/>将根据实体渲染范围自动取景</p>}
  </div>
  {image&&image.key!==fingerprint&&!running&&<small>模板已修改 · 快照待更新</small>}
  <div className="entity-preview-tools">{!running?<button type="button" disabled={!online||!active||busy} onClick={()=>void open()}>{busy?'正在连接…':'开启在线预览'}</button>:<><button type="button" onClick={()=>void update()}>刷新预览</button><button type="button" onClick={()=>void request('reset').catch(e=>setError(String(e)))}>自动取景</button><button type="button" onClick={stop}>关闭</button><select aria-label="预览动画" defaultValue="idle" onChange={e=>void request('animation',{animation:e.target.value}).catch(e=>setError(String(e)))}>{['idle','walk','run','attack','spin'].map(mode=><option key={mode}>{mode}</option>)}</select></>}</div>
  <small>{running?'左键旋转 · 右键平移 · 滚轮缩放':online?'游戏已连接':'游戏开发服务器离线'}</small>
  {error&&<p role="alert">{error}</p>}
 </section>
}
