import {controlRequest,getControlHubSnapshot,subscribeControlHub} from './controlHub'
import {controlWsUrl} from './protocol'
import type {EntityDocument} from '../workspaces/quest/entityDoc'
import {entityFingerprint,readEntityStreamFrame,saveEntitySnapshot} from '../workspaces/quest/entitySnapshot'
export type PreviewAnimation='idle'|'walk'|'run'|'attack'|'spin'
export type PreviewSpec={id:string;template:EntityDocument;width:number;height:number;animation:PreviewAnimation}
export type PreviewStatus={online:boolean;running:boolean;error:string}
type Tile={id:string;x:number;y:number;width:number;height:number}
type Plan={version:1;sessionId?:string;streamPath?:string;width:number;height:number;minFrameId:number;tiles:Tile[]}
type View={spec:PreviewSpec;canvas:HTMLCanvasElement;status:(s:PreviewStatus)=>void;frames:number;fingerprint:string;totals:Record<string,number>;sequence:number;dirty:boolean}
type Session={id:string;ws:WebSocket;plan:Plan;signature:string;latest:ArrayBuffer|null;painting:boolean;paintFrame:number;inputFrame:number;heartbeat:ReturnType<typeof setInterval>;inFlight:number;lastFrame:number}
const views=new Map<string,View>();let session:Session|null=null,working=false,started=false,revision=0,timer:ReturnType<typeof setTimeout>|null=null,epoch=0
const online=()=>getControlHubSnapshot().phase==='open'
const visible=()=>typeof document==='undefined'||document.visibilityState!=='hidden'
function notify(error=''){for(const view of views.values())view.status({online:online(),running:!!session&&session.plan.tiles.some(t=>t.id===view.spec.id),error})}
function schedule(delay=100){if(timer)clearTimeout(timer);timer=setTimeout(()=>{timer=null;void reconcile()},delay)}
function signature(){return JSON.stringify([...views.values()].map(v=>({...v.spec,template:v.fingerprint})))}
function specs(){return [...views.values()].map(v=>v.spec)}
function readPlan(raw:unknown):Plan{
 const p=raw as Plan;if(p?.version!==1||!Number.isInteger(p.width)||!Number.isInteger(p.height)||p.width<1||p.height<1||p.width>2048||p.height>2048||!Number.isInteger(p.minFrameId)||!Array.isArray(p.tiles)||p.tiles.length<1||p.tiles.length>64)throw Error('实体预览布局无效')
 const ids=new Set<string>();for(const t of p.tiles){if(typeof t.id!=='string'||ids.has(t.id)||![t.x,t.y,t.width,t.height].every(Number.isInteger)||t.x<0||t.y<0||t.width<1||t.height<1||t.x+t.width>p.width||t.y+t.height>p.height)throw Error('实体预览区域无效');ids.add(t.id)}return p
}
function stop(){epoch++;const s=session;session=null;if(s){clearInterval(s.heartbeat);cancelAnimationFrame(s.inputFrame);cancelAnimationFrame(s.paintFrame);s.ws.close();void controlRequest('entities.preview.close',{sessionId:s.id}).catch(()=>{})}notify()}
async function reconcile(){
 if(working){schedule();return}
 if(!views.size||!online()||!visible()){stop();return}
 const wanted=signature();if(session?.signature===wanted)return
 working=true;const change=revision,token=epoch
 try{
  if(!session){
   const plan=readPlan(await controlRequest('entities.preview.open',{items:specs()}));if(typeof plan.sessionId!=='string'||plan.streamPath!=='/ws/stream')throw Error('实体预览会话无效')
   if(token!==epoch||!views.size||!online()||!visible()){void controlRequest('entities.preview.close',{sessionId:plan.sessionId}).catch(()=>{});return}
   const prefs=getControlHubSnapshot().prefs,url=new URL(controlWsUrl(prefs.host,prefs.port,prefs.password));url.pathname=plan.streamPath
   const ws=new WebSocket(url);ws.binaryType='arraybuffer'
   for(const v of views.values()){v.totals={};v.sequence=0;v.dirty=false}
   const s:Session={id:plan.sessionId,ws,plan,signature:wanted,latest:null,painting:false,paintFrame:0,inputFrame:0,inFlight:0,lastFrame:plan.minFrameId,heartbeat:setInterval(()=>{void controlRequest('entities.preview.input',{sessionId:s.id,action:'heartbeat'}).catch(()=>{if(session===s){stop();schedule(3000)}})},2000)};session=s
   ws.onmessage=e=>{if(session!==s||!(e.data instanceof ArrayBuffer))return;s.latest=e.data;queuePaint(s)}
   ws.onclose=()=>{if(session===s){stop();schedule(3000)}};ws.onerror=()=>{if(session===s)notify('预览暂不可用，正在重连')}
   const pump=()=>{if(session!==s)return;for(const v of views.values()){if(!v.dirty||s.inFlight>=4||!s.plan.tiles.some(t=>t.id===v.spec.id))continue;v.dirty=false;s.inFlight++;void controlRequest('entities.preview.input',{sessionId:s.id,targetId:v.spec.id,action:'view',sequence:++v.sequence,...v.totals}).catch(e=>{if(session===s)notify(String(e))}).finally(()=>s.inFlight--)}s.inputFrame=requestAnimationFrame(pump)};s.inputFrame=requestAnimationFrame(pump)
  }else{
   const s=session,plan=readPlan(await controlRequest('entities.preview.input',{sessionId:s.id,action:'replace',items:specs()}))
   if(session===s){s.plan=plan;s.lastFrame=plan.minFrameId;s.latest=null;s.signature=wanted}
  }
  notify()
 }catch(error){if(token===epoch){notify(String(error));schedule(3000)}}finally{working=false;if(change!==revision)schedule()}
}
function queuePaint(s:Session){if(!s.painting&&!s.paintFrame)s.paintFrame=requestAnimationFrame(()=>void paint(s))}
async function paint(s:Session){
 s.paintFrame=0;if(session!==s||!s.latest)return;const data=s.latest;s.latest=null;s.painting=true;let bitmap:ImageBitmap|null=null;const plan=s.plan
 try{
  if(data.byteLength<32)return;const frameId=new DataView(data).getUint32(20,true);if(frameId<=s.lastFrame)return
  const frame=readEntityStreamFrame(data);if(frame.width!==plan.width||frame.height!==plan.height)return
  if(frame.encoding==='jpeg')bitmap=await createImageBitmap(new Blob([new Uint8Array(frame.payload)],{type:'image/jpeg'}))
  if(session!==s||s.plan!==plan||s.signature!==signature())return
  let source:CanvasImageSource
  if(bitmap){if(bitmap.width!==frame.width||bitmap.height!==frame.height)throw Error('实体画面尺寸不匹配');source=bitmap}
  else{const c=document.createElement('canvas');c.width=frame.width;c.height=frame.height;c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frame.encoding==='rgba'?frame.pixels:[]),frame.width,frame.height),0,0);source=c}
  s.lastFrame=frameId
  for(const t of plan.tiles){const v=views.get(t.id);if(!v)continue;const c=v.canvas;if(c.width!==t.width)c.width=t.width;if(c.height!==t.height)c.height=t.height;c.getContext('2d')?.drawImage(source,t.x,t.y,t.width,t.height,0,0,t.width,t.height);v.frames++
   if(v.frames===3){const png=c.toDataURL('image/png');void saveEntitySnapshot(v.fingerprint,png)}
  }
 }catch(error){if(session===s)notify(String(error))}finally{bitmap?.close();s.painting=false;if(session===s&&s.latest)queuePaint(s)}
}
function start(){if(started)return;started=true;let phase=getControlHubSnapshot().phase
 subscribeControlHub(()=>{const next=getControlHubSnapshot().phase;if(next!==phase){phase=next;if(!online())stop();schedule();notify()}})
 window.addEventListener('pagehide',()=>stop())
 document.addEventListener('visibilitychange',()=>{if(!visible())stop();schedule()})
}
export function attachEntityPreview(spec:PreviewSpec,canvas:HTMLCanvasElement,status:View['status']){
 start();if(views.has(spec.id))throw Error('实体预览标识重复')
 const view:View={spec,canvas,status,frames:0,fingerprint:entityFingerprint(spec.template),totals:{},sequence:0,dirty:false};views.set(spec.id,view);revision++;notify();schedule()
 return ()=>{if(views.get(spec.id)!==view)return;views.delete(spec.id);revision++;schedule()}
}
export function updateEntityPreview(spec:PreviewSpec){const view=views.get(spec.id);if(!view)return;const next=entityFingerprint(spec.template);if(next!==view.fingerprint){view.frames=0;view.fingerprint=next}view.spec=spec;revision++;schedule()}
export function entityPreviewInput(id:string,action:'rotate'|'pan'|'zoom',dx:number,dy:number){const v=views.get(id);if(!v)return;v.totals[action+'X']=(v.totals[action+'X']??0)+dx;v.totals[action+'Y']=(v.totals[action+'Y']??0)+dy;v.dirty=true}
export async function resetEntityPreview(id:string){const s=session;if(s)await controlRequest('entities.preview.input',{sessionId:s.id,targetId:id,action:'reset'})}
