import Worker from './tsserver.worker?worker'
import {diagnosticValue, recordLanguageDiagnostic} from './diagnostics'
let clientSequence = 0
type Pending = {resolve:(value:any)=>void;reject:(error:Error)=>void;method:string;params:unknown;started:number;timer?:ReturnType<typeof setTimeout>}
export class TsserverClient {
 readonly diagnosticId=`worker-${++clientSequence}`
 private worker:Worker;private sequence=0;private disposed=false
 private pending=new Map<number,Pending>()
 private files=new Map<string,string>()
 constructor(worker:Worker=new Worker()){
  this.worker=worker;recordLanguageDiagnostic(this.diagnosticId,'created')
  this.worker.onmessage=({data})=>this.finish(data.id,data.error?Error(data.error):null,data.result)
  this.worker.onerror=e=>{recordLanguageDiagnostic(this.diagnosticId,'worker-error',{message:e.message,filename:e.filename,line:e.lineno,column:e.colno});this.rejectAll(Error(e.message||'语言服务 Worker 异常'))}
  this.worker.onmessageerror=()=>{recordLanguageDiagnostic(this.diagnosticId,'message-error');this.rejectAll(Error('语言服务响应无法读取'))}
 }
 private finish(id:number,error:Error|null,result?:unknown){
  const p=this.pending.get(id);if(!p)return
  this.pending.delete(id);clearTimeout(p.timer)
  recordLanguageDiagnostic(this.diagnosticId,error?'request-error':'response',{id,method:p.method,durationMs:Date.now()-p.started,...error?{error:diagnosticValue(error)}:{result:p.method==='snapshot'?{captured:true}:result}})
  if(error)p.reject(error);else p.resolve(result)
 }
 private rejectAll(error:Error){for(const id of [...this.pending.keys()])this.finish(id,error)}
 request(method:string,params:unknown,timeoutMs?:number):Promise<any>{
  if(this.disposed)return Promise.reject(Error('语言服务已关闭'))
  const id=++this.sequence,summary=method==='files'?Object.fromEntries(Object.entries(params as Record<string,string|null>).map(([name,text])=>[name,text===null?null:{characters:text.length}])):params
  recordLanguageDiagnostic(this.diagnosticId,'request',{id,method,params:summary})
  return new Promise((resolve,reject)=>{
   const pending:Pending={resolve,reject,method,params:summary,started:Date.now()};this.pending.set(id,pending)
   if(timeoutMs!==undefined)pending.timer=setTimeout(()=>this.finish(id,Error(`语言服务 ${method} 请求超时（${timeoutMs}ms）`)),timeoutMs)
   try{this.worker.postMessage({id,method,params})}catch(error){this.finish(id,error instanceof Error?error:Error(String(error)))}
  })
 }
 writeFiles(files:Record<string,string|null>){if(!this.disposed)for(const [name,text]of Object.entries(files))if(text===null)this.files.delete(name);else this.files.set(name,text);return this.request('files',files)}
 diagnosticSnapshot(){return {id:this.diagnosticId,disposed:this.disposed,pending:[...this.pending].map(([id,p])=>({id,method:p.method,params:p.params,elapsedMs:Date.now()-p.started})),submittedFiles:Object.fromEntries(this.files)}}
 dispose(){if(this.disposed)return;this.disposed=true;recordLanguageDiagnostic(this.diagnosticId,'disposed',{pending:this.pending.size});this.worker.terminate();this.rejectAll(Error('语言服务已关闭'));this.files.clear()}
}
