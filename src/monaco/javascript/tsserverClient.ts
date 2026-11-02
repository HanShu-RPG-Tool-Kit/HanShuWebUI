import Worker from './tsserver.worker?worker'
export class TsserverClient {
 private worker:Worker;private sequence=0;private disposed=false
 private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
 constructor(worker:Worker=new Worker()){this.worker=worker;this.worker.onmessage=({data})=>{const p=this.pending.get(data.id);if(!p)return;this.pending.delete(data.id);if(data.error)p.reject(Error(data.error));else p.resolve(data.result)};this.worker.onerror=e=>{for(const p of this.pending.values())p.reject(Error(e.message));this.pending.clear()}}
 request(method:string,params:unknown):Promise<any>{if(this.disposed)return Promise.reject(Error('语言服务已关闭'));const id=++this.sequence;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,method,params})})}
 writeFiles(files:Record<string,string|null>){return this.request('files',files)}
 dispose(){this.disposed=true;this.worker.terminate();for(const p of this.pending.values())p.reject(Error('语言服务已关闭'));this.pending.clear()}
}
