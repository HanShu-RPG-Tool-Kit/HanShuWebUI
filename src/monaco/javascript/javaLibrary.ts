import {controlConnectionGeneration, controlRequest, getControlHubSnapshot, isControlConnected} from '../../gameDevServer/controlHub'
import type {JavaStub, StubResponse} from './stubs'
import type {JavaClassEntry} from './javaImportPlan'

export type LibraryHooks={schemaVersion:number;runtimeId:string;revision:number;hooks:{id:string;cancellable:boolean;eventClass?:string}[]}
export type JavaLibrary={key:string;id:string;runtimeId:string;capturedAt:string;javaVersion:string;mods:string[];classes:JavaClassEntry[];bytes:number;skipped:number;actor:LibraryHooks;player:LibraryHooks}
const listeners=new Set<()=>void>()
const channel=typeof BroadcastChannel==='undefined'?null:new BroadcastChannel('hanshu.java-library.v1')
if(channel)channel.onmessage=()=>{for(const listener of listeners)listener()}
export const subscribeJavaLibrary=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}}
export function libraryKey(){const {host,port}=getControlHubSnapshot().prefs;return `${host.trim().toLowerCase()}:${port}`}
function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
 const request=indexedDB.open('hanshu.java-library.v1',1)
 request.onupgradeneeded=()=>{request.result.createObjectStore('libraries',{keyPath:'key'});request.result.createObjectStore('classes')}
 request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)
})}
async function transaction<T>(stores:string[],mode:IDBTransactionMode,run:(tx:IDBTransaction,set:(value:T)=>void)=>void):Promise<T>{
 const db=await database()
 return new Promise<T>((resolve,reject)=>{let result:T;const tx=db.transaction(stores,mode);tx.oncomplete=()=>{db.close();resolve(result)};tx.onabort=()=>{db.close();reject(tx.error??Error('本地类型库存储失败'))};tx.onerror=()=>{};try{run(tx,value=>{result=value})}catch(error){tx.abort();reject(error)}})
}
export async function readJavaLibrary(key=libraryKey()):Promise<JavaLibrary|undefined>{
 return transaction(['libraries'],'readonly',(tx,set)=>{const r=tx.objectStore('libraries').get(key);r.onsuccess=()=>set(r.result)})
}
export async function readLibraryClasses(library:JavaLibrary,names:string[]):Promise<JavaStub[]>{
 return transaction(['classes'],'readonly',(tx,set)=>{const values:JavaStub[]=[];set(values);for(const name of new Set(names)){const r=tx.objectStore('classes').get([library.id,name]);r.onsuccess=()=>{if(r.result)values.push(r.result)}}})
}
async function removeSnapshot(id:string){
 await transaction(['classes'],'readwrite',tx=>{tx.objectStore('classes').delete(IDBKeyRange.bound([id,''],[id,'\uffff']))})
}
let syncing=false
async function syncRequest(method:string,params:unknown,signal:AbortSignal):Promise<unknown>{
 let cancel:()=>void=()=>{}
 const aborted=new Promise<never>((_,reject)=>{cancel=()=>reject(Error('已取消同步'));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()})
 try{return await Promise.race([controlRequest(method,params,120000),aborted])}finally{signal.removeEventListener('abort',cancel)}
}
export async function syncJavaLibrary(signal:AbortSignal,progress:(current:number,total:number,classes:number,bytes:number)=>void):Promise<JavaLibrary>{
 if(syncing)throw Error('已有类型库同步正在进行')
 if(!isControlConnected())throw Error('请先连接游戏开发服务器')
 syncing=true
 const key=libraryKey(),generation=controlConnectionGeneration(),id=crypto.randomUUID()
 let committed=false
 const check=()=>{if(signal.aborted)throw Error('已取消同步');if(!isControlConnected()||generation!==controlConnectionGeneration()||key!==libraryKey())throw Error('游戏连接已变化，请重新同步')}
 try{
  const previous=await readJavaLibrary(key),entries:JavaClassEntry[]=[]
  let offset=0,bytes=0,skipped=0,runtimeId='',javaVersion='',mods:string[]=[]
  for(;;){
   check()
   const page=await syncRequest('javascript.library.page',{offset,runtimeId},signal) as StubResponse&{next:number;total:number;done:boolean;javaVersion:string;mods?:string[]}
   check()
   if(page.schemaVersion!==1||!Array.isArray(page.classes)||!Array.isArray(page.missing)||typeof page.runtimeId!=='string'||(runtimeId&&runtimeId!==page.runtimeId)||!Number.isSafeInteger(page.next)||!Number.isSafeInteger(page.total)||page.next<offset||page.next>page.total||(!page.done&&page.next===offset)||page.done!==(page.next===page.total))throw Error('不兼容的完整类型库协议')
   runtimeId=page.runtimeId;javaVersion=page.javaVersion;if(offset===0)mods=page.mods??[]
   for(const stub of page.classes){if(typeof stub.name!=='string'||typeof stub.source!=='string'||typeof stub.module!=='string'||typeof stub.symbol!=='string'||!Array.isArray(stub.dependencies))throw Error('类型声明格式无效');bytes+=new TextEncoder().encode(stub.source).length;entries.push({name:stub.name,symbol:stub.symbol,packageName:stub.name.slice(0,stub.name.lastIndexOf('.')),origin:'本地类型库'})}
   await transaction(['classes'],'readwrite',tx=>{for(const stub of page.classes)tx.objectStore('classes').put(stub,[id,stub.name])})
   skipped+=page.missing.length;offset=page.next;progress(offset,page.total,entries.length,bytes)
   if(page.done)break
  }
  const actor=await syncRequest('javascript.actorHooks',{},signal) as LibraryHooks,player=await syncRequest('javascript.playerHooks',{},signal) as LibraryHooks
  check()
  for(const hooks of [actor,player])if(hooks.schemaVersion!==1||hooks.runtimeId!==runtimeId||!Array.isArray(hooks.hooks))throw Error('hook 快照与类型库不一致')
  const library:JavaLibrary={key,id,runtimeId,capturedAt:new Date().toISOString(),javaVersion,mods,classes:entries,bytes,skipped,actor,player}
  await transaction(['libraries'],'readwrite',tx=>{check();tx.objectStore('libraries').put(library)})
  committed=true;for(const listener of listeners)listener();channel?.postMessage({key,id})
  if(previous)void removeSnapshot(previous.id).catch(()=>{})
  return library
 }finally{syncing=false;if(!committed)await removeSnapshot(id).catch(()=>{})}
}
