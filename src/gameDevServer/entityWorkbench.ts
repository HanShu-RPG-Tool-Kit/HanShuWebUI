import {notify} from '../activity'
import {randomId} from '../project/crypto'
import {getProjectSession,setProjectSession,subscribeProjectSession} from '../project/projectSession'
import type {ProjectClient} from '../project/serviceClient'
import {normalizeResourceName,sourcePathOf} from '../workspace'
import {parseEntity,stringifyEntity,type EntityDocument} from '../workspaces/progress/entityDoc'
import {entityFingerprint} from '../workspaces/progress/entitySnapshot'
import {controlRequest,getControlHubSnapshot,subscribeControlHub,subscribeControlNotify} from './controlHub'

let receiver:{token:string;client:ProjectClient}|null=null
let started=false
const pending=new Map<string,{client:ProjectClient;documentKey:string;hash:string;receiver:string;result?:EntityDocument}>()
const imports=new Map<string,{promise:Promise<unknown>;settled:boolean}>()
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('实体消息无效');return value as Record<string,unknown>}
function currentClient(){return getProjectSession().binding?.handle.client??null}
function ensureReceiver(){const client=currentClient();if(!client?.writable)return null;if(receiver?.client!==client)receiver={token:randomId(),client};return receiver}
function bind(claim:boolean){
 const old=receiver,r=ensureReceiver()
 if(!r){receiver=null;if(old&&getControlHubSnapshot().phase==='open')void controlRequest('entities.receiver.bind',{receiver:old.token,enabled:false}).catch(()=>{});return}
 if(getControlHubSnapshot().phase==='open')void controlRequest('entities.receiver.bind',{receiver:r.token,claim}).catch(()=>{})
}
export function acceptsEntityImport(params:unknown){try{return object(params).receiver===receiver?.token&&!!receiver&&currentClient()===receiver.client}catch{return false}}
function assertClient(client:ProjectClient){if(currentClient()!==client)throw Error('工程已切换，未将实体写入另一个工程');if(!client.writable)throw Error('工程离线或只读，无法保存实体')}
export function importEntityFromGame(params:unknown):Promise<unknown>{
 const p=object(params);if(!acceptsEntityImport(p)||p.version!==1||typeof p.requestId!=='string'||!p.requestId||p.requestId.length>128)return Promise.reject(Error('实体接收目标或协议无效'))
 const key=String(p.receiver)+'/'+p.requestId,previous=imports.get(key);if(previous)return previous.promise
 if(imports.size>=64){for(const [id,row] of imports){if(row.settled){imports.delete(id);break}}if(imports.size>=64)return Promise.reject(Error('复制请求过多，请稍后重试'))}
 const row={promise:Promise.resolve<unknown>(null),settled:false};row.promise=importEntity(p).finally(()=>{row.settled=true});imports.set(key,row);return row.promise
}
async function importEntity(p:Record<string,unknown>){
 const r=receiver!,client=r.client;assertClient(client)
 if(typeof p.name!=='string'||!p.name.trim()||p.name.length>160)throw Error('实体文件名无效')
 const stem=p.name.trim().replace(/\.entity$/i,'');if(stem.length>128)throw Error('实体文件名过长');const name=normalizeResourceName(stem+'.entity');if(!name)throw Error('实体文件名无效')
 const doc=parseEntity(JSON.stringify(p.template)),content=stringifyEntity(doc)
 await client.refresh();assertClient(client)
 const initial=getProjectSession(),pkg=initial.workspace.packages[0];if(!pkg)throw Error('请先打开工程')
 let path=sourcePathOf({name});const entry=client.tree.entries.find(e=>e.path.toLocaleLowerCase()===path.toLocaleLowerCase())
 if(entry?.kind==='directory')throw Error('同名路径是目录')
 if(entry)path=entry.path
 const existing=pkg.scripts.find(s=>sourcePathOf(s).toLocaleLowerCase()===path.toLocaleLowerCase())
 const version=entry?(await client.readSnapshot(path,false)).version:null
 assertClient(client)
 const latest=getProjectSession(),livePkg=latest.workspace.packages.find(p=>p.id===pkg.id)!;const live=livePkg.scripts.find(s=>s.id===existing?.id)
 if(live?.content!==existing?.content)throw Error('确认前本机文件已修改，请重新复制')
 const dirty=!!live&&live.content!==client.texts.get(path)
 if((entry||existing)&&!window.confirm(`「${existing?.name??name}」已存在，确定用游戏实体覆盖吗？${dirty?'\n该文件还有未保存的本机修改，确认后会一并替换。':''}`))return {version:1,cancelled:true}
 assertClient(client)
 const fileName=path.split('/').at(-1)!,source={id:existing?.id??randomId(),name:fileName,content,updatedAt:Date.now()}
 // Mirror the incoming payload before submit so rejection/unknown results remain recoverable drafts.
 setProjectSession({workspace:{...latest.workspace,packages:latest.workspace.packages.map(p=>p.id===pkg.id?{...p,scripts:existing?p.scripts.map(s=>s.id===existing.id?source:s):[...p.scripts,source]}:p)}})
 try{await client.apply([{op:'write',path,data:content,version}],`从游戏复制实体 ${fileName}`)}catch(error){notify(`实体保存未完成，输入和提交记录已保留：${String(error)}`,{kind:'warning',source:'entities'});throw error}
 if(currentClient()===client){setProjectSession({workspace:getProjectSession().workspace});notify(`已保存实体 ${fileName}`,{kind:'success',source:'entities'})}
 return {version:1,saved:true,path}
}
export async function openEntityEditInGame(documentKey:string,template:EntityDocument){
 const r=ensureReceiver();if(!r||!r.client.writable)throw Error('请先打开可写工程')
 if(getControlHubSnapshot().phase!=='open')throw Error('游戏开发服务器离线')
 const source=getProjectSession().workspace.packages.flatMap(p=>p.scripts).find(s=>s.id===documentKey)
 if(!source||entityFingerprint(parseEntity(source.content))!==entityFingerprint(template))throw Error('实体草稿已改变，请重试')
 if(pending.size>=64)throw Error('待接收的游戏编辑过多，请先完成已有编辑')
 const editId=randomId(),hash=entityFingerprint(template)
 pending.set(editId,{client:r.client,documentKey,hash,receiver:r.token})
 try{const result=object(await controlRequest('entities.edit.open',{version:1,editId,hash,receiver:r.token,template}));if(result.version!==1||result.opened!==true||result.editId!==editId)throw Error('无法打开 IBE 实体编辑器');for(const [id,entry] of pending){if(id!==editId&&!entry.result)pending.delete(id)}}
 catch(error){pending.delete(editId);throw error}
}
function applyReadyEdits(){
 const session=getProjectSession(),client=session.binding?.handle.client;if(!client?.writable)return
 for(const [id,p] of pending){
  if(p.client!==client||!p.result)continue
  pending.delete(id)
  const pkg=getProjectSession().workspace.packages[0];if(!pkg)continue
  const source=pkg.scripts.find(s=>s.id===p.documentKey)
  let unchanged=false;try{unchanged=!!source&&entityFingerprint(parseEntity(source.content))===p.hash}catch{/* retain malformed source */}
  let next
  if(unchanged&&source){const old=parseEntity(source.content);next={...source,content:stringifyEntity({...p.result,tags:old.tags}),updatedAt:Date.now()}}
  else{
   const stem=(source?.name??'实体').replace(/\.entity$/i,'')+'-游戏编辑结果';let name=stem+'.entity',i=2;while(pkg.scripts.some(s=>s.name.toLocaleLowerCase()===name.toLocaleLowerCase()))name=stem+'-'+i++ +'.entity'
   next={id:randomId(),name,content:stringifyEntity(p.result),updatedAt:Date.now()}
  }
  const latest=getProjectSession();setProjectSession({workspace:{...latest.workspace,packages:latest.workspace.packages.map(pack=>pack.id===pkg.id?{...pack,scripts:unchanged?pack.scripts.map(s=>s.id===p.documentKey?next:s):[...pack.scripts,next]}:pack)}})
  notify(unchanged?'已应用游戏中的实体编辑，请保存工程':'实体已在本机修改，游戏结果保留为独立 .entity 草稿',{kind:unchanged?'success':'warning',source:'entities'})
 }
}
export function receiveEntityEditDone(params:unknown){
 try{const p=object(params),entry=typeof p.editId==='string'?pending.get(p.editId):undefined;if(!entry||p.version!==1||entry.receiver!==p.receiver||entry.hash!==p.hash)return;entry.result=parseEntity(JSON.stringify(p.template));applyReadyEdits()}catch(error){notify(`实体编辑结果无效：${String(error)}`,{kind:'warning',source:'entities'})}
}
export function ensureEntityWorkbenchStarted(){
 if(started)return;started=true
 let phase=getControlHubSnapshot().phase,lastClient=currentClient(),writable=lastClient?.writable
 subscribeControlNotify(note=>{if(note.method==='entities.edit.done')receiveEntityEditDone(note.params)})
 subscribeControlHub(()=>{const next=getControlHubSnapshot().phase;if(next!==phase){phase=next;if(phase==='open')bind(document.hasFocus())}})
 subscribeProjectSession(()=>{const c=currentClient(),w=c?.writable;if(c!==lastClient||w!==writable){lastClient=c;writable=w;bind(document.hasFocus())}applyReadyEdits()})
 window.addEventListener('focus',()=>bind(true));setInterval(()=>bind(false),30000);bind(document.hasFocus())
}
