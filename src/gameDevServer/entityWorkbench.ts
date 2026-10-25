import {notify} from '../activity'
import {prepareDisplayLocalization,supportsDisplayLocalization,localizedResultEdits,legacyLocalizedResultEdits,commitLocalizedResult,preserveReadOnlyDisplayText,type LocalizationSession} from './displayLocalization'
import {prepareEntityAttributes,supportsEntityAttributes,applyEntityAttributeResult,assertEntityAttributesUnchanged,type EntityAttributeSession} from './entityAttributes'
import {randomId} from '../project/crypto'
import {getProjectSession,setProjectSession,subscribeProjectSession} from '../project/projectSession'
import type {ProjectClient} from '../project/serviceClient'
import {normalizeResourceName,sourcePathOf} from '../workspace'
import {parseEntity,stringifyEntity,type EntityDocument} from '../workspaces/quest/entityDoc'
import {entityFingerprint} from '../workspaces/quest/entitySnapshot'
import {controlRequest,getControlHubSnapshot,subscribeControlHub,subscribeControlNotify} from './controlHub'

let receiver:{token:string;client:ProjectClient}|null=null
let started=false
const pending=new Map<string,{client:ProjectClient;documentKey:string;hash:string;receiver:string;session:LocalizationSession;version:number;localized:boolean;attributes?:EntityAttributeSession;receiving?:boolean}>()
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
 const localizationSession=await prepareDisplayLocalization(documentKey,'entity',template)
 if(entityFingerprint(parseEntity(localizationSession.source))!==entityFingerprint(template))throw Error('实体草稿已改变，请重试')
 const [capable,attributeCapable]=await Promise.all([supportsDisplayLocalization(controlRequest),supportsEntityAttributes(controlRequest)]),version=capable||attributeCapable?2:1
 let attributeIds:string[]|undefined
 if(attributeCapable){
  try{const catalog=object(await controlRequest('entities.attributes.list',{template}));if(catalog.version===1&&Array.isArray(catalog.items))attributeIds=catalog.items.flatMap(row=>{const item=object(row);return typeof item.id==='string'?[item.id]:[]})}catch{/* Older games retain their explicit common/existing field authorization. */}
 }
 const attributes=attributeCapable?prepareEntityAttributes(template,attributeIds):undefined
 if(!attributeCapable)notify('游戏端 IBE 不支持实体属性事务；属性保持只读',{kind:'warning',source:'entities'})
 if(!capable&&localizationSession.localization.readOnlyFields?.length)notify('游戏端 IBE 不支持工程本地化编辑；绑定与高级文本只读，相关修改不会保存',{kind:'warning',source:'entities'})
 const editId=randomId(),hash=entityFingerprint(template)
 pending.set(editId,{client:r.client,documentKey,hash,receiver:r.token,session:localizationSession,version,localized:capable,attributes})
 try{const result=object(await controlRequest('entities.edit.open',{version,editId,hash,receiver:r.token,template,...(capable?{localization:localizationSession.localization}:{}),...(attributes?{attributes:attributes.context}:{})}));if(result.version!==version||result.opened!==true||result.editId!==editId)throw Error('无法打开 IBE 实体编辑器')}
 catch(error){pending.delete(editId);throw error}
}
export async function receiveEntityEditDone(params:unknown){
 let editId:string|undefined
 try{
  const p=object(params),entry=typeof p.editId==='string'?pending.get(p.editId):undefined
  if(!entry||p.version!==entry.version||entry.receiver!==p.receiver||entry.hash!==p.hash||entry.receiving)return
  editId=p.editId as string;entry.receiving=true
  const original=parseEntity(entry.session.source),candidate=parseEntity(JSON.stringify(p.template))
  let result={...candidate,tags:original.tags}
  if(entry.attributes)result=applyEntityAttributeResult(entry.attributes,result,p.attributes)
  else assertEntityAttributesUnchanged(original,result)
  if(!entry.localized)result=preserveReadOnlyDisplayText(entry.session,result,true)
  const edits=entry.localized?localizedResultEdits(entry.session,result,p.localization):legacyLocalizedResultEdits(entry.session,result)
  result=preserveReadOnlyDisplayText(entry.session,result,!entry.localized)
  await commitLocalizedResult(entry.session,stringifyEntity(result),edits)
  notify('已保存游戏中的实体与本地化编辑',{kind:'success',source:'entities'})
 }catch(error){notify(`实体编辑未写回：${String(error)}；提交冲突可在协作面板中恢复`,{kind:'warning',source:'entities'})}
 finally{if(editId)pending.delete(editId)}
}
export function ensureEntityWorkbenchStarted(){
 if(started)return;started=true
 let phase=getControlHubSnapshot().phase,lastClient=currentClient(),writable=lastClient?.writable
 subscribeControlNotify(note=>{if(note.method==='entities.edit.done')void receiveEntityEditDone(note.params)})
 subscribeControlHub(()=>{const next=getControlHubSnapshot().phase;if(next!==phase){phase=next;if(phase==='open')bind(document.hasFocus())}})
 subscribeProjectSession(()=>{const c=currentClient(),w=c?.writable;if(c!==lastClient||w!==writable){lastClient=c;writable=w;bind(document.hasFocus())}})
 window.addEventListener('focus',()=>bind(true));setInterval(()=>bind(false),30000);bind(document.hasFocus())
}
