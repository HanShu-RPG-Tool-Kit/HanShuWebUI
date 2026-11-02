import type * as Monaco from 'monaco-editor'
import {getProjectSession,subscribeProjectSession} from '../../project/projectSession'
import {controlRequest,isControlConnected,subscribeControlHub,subscribeControlNotify,controlConnectionGeneration} from '../../gameDevServer/controlHub'
import {effectiveBuiltinScripts,type ScriptType} from '../../scriptResources'
import {transformDialect} from './dialect'
import {TsserverClient} from './tsserverClient'
import {buildJavaFiles,type JavaStub,type StubResponse,javaModule} from './stubs'
import {javascriptProfile} from './profiles'
type M=typeof Monaco
const services=new Map<string,{service:JavaScriptLanguage;refs:number}>(),projects=new WeakMap<object,number>();let projectSeq=0
const LANGUAGE='hanshu-javascript'
const registered=new WeakSet<object>()
function register(monaco:M){if(registered.has(monaco))return;registered.add(monaco);monaco.languages.register({id:LANGUAGE,extensions:['.js']});monaco.languages.setMonarchTokensProvider(LANGUAGE,{tokenizer:{root:[[/\/\/.*$/,'comment'],[/\/\*/,'comment','@comment'],[/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/,'string'],[/\x40(?:hook|goal|config|state|subscribe)\b/,'annotation'],[/\b(?:function|var|return|if|else|for|while|new|throw|try|catch|import|require|from|true|false|null)\b/,'keyword'],[/\b\d+(?:\.\d+)?\b/,'number']],comment:[[/[^/*]+/,'comment'],[/\*\//,'comment','@pop'],[/[/*]/,'comment']]}});monaco.languages.setLanguageConfiguration(LANGUAGE,{comments:{lineComment:'//',blockComment:['/*','*/']},brackets:[['{','}'],['[',']'],['(',')']],autoClosingPairs:[{open:'{',close:'}'},{open:'[',close:']'},{open:'(',close:')'},{open:'"',close:'"'},{open:"'",close:"'"}]})}
export function attachJavaScript(monaco:M,model:Monaco.editor.ITextModel,report:(e:unknown)=>void,type:ScriptType='common'){
 register(monaco);monaco.editor.setModelLanguage(model,LANGUAGE)
 const project=getProjectSession().binding?.handle.client;if(project&&!projects.has(project))projects.set(project,++projectSeq)
 const key=`${project?projects.get(project):'unbound'}:${type}`
 let shared=services.get(key);if(!shared){shared={service:new JavaScriptLanguage(monaco,report,type),refs:0};services.set(key,shared)}shared.refs++
 const detach=shared.service.attach(model)
 return {dispose(){detach();if(--shared.refs===0){shared.service.dispose();services.delete(key)}}}
}
export async function refreshJavaScriptImports(model:Monaco.editor.ITextModel){await Promise.all([...services.values()].map(s=>s.service.refreshImports(model)))}
export class JavaScriptLanguage {
 readonly client=new TsserverClient();readonly documents=new Map<string,{model:Monaco.editor.ITextModel;file:string;source:string;refs:number;listener:Monaco.IDisposable;timer?:ReturnType<typeof setTimeout>}>()
 private disposables:(()=>void)[]=[];private classes=new Map<string,JavaStub>();private javaFiles:Record<string,string>={};private projectFiles:Record<string,string>={};private runtime='';private disposed=false;private hooks:string[]=[];private sequence=0;private generation=0;private queued:Promise<unknown>=Promise.resolve()
 private profile:ReturnType<typeof javascriptProfile>;private connected=false;private hookRevision=-1;private hookRuntime='';private hookClasses=new Map<string,string>();private project=getProjectSession().binding?.handle.client
 private monaco:M; private report:(e:unknown)=>void; private type:ScriptType
 constructor(monaco:M,report:(e:unknown)=>void,type:ScriptType='common'){
  this.monaco=monaco;this.report=error=>{if(!this.disposed)report(error)};this.type=type
  register(monaco);this.profile=javascriptProfile(type)
  void this.client.writeFiles({'/host.d.ts':this.profile.source,...buildJavaFiles([])}).catch(this.report)
  const completion=monaco.languages.registerCompletionItemProvider(LANGUAGE,{triggerCharacters:['.','"',"'"],provideCompletionItems:(model,position)=>this.provide<Monaco.languages.CompletionList>(model,{suggestions:[]},async()=>{
   const doc=this.documents.get(model.uri.toString());if(!doc)return {suggestions:[]}
   const word=model.getWordUntilPosition(position),range=new monaco.Range(position.lineNumber,word.startColumn,position.lineNumber,word.endColumn)
   if(/@hook\(\s*["'][^"']*$/.test(model.getLineContent(position.lineNumber).slice(0,position.column-1)))return {suggestions:this.hooks.map(h=>({label:h,insertText:h,kind:monaco.languages.CompletionItemKind.Event,range}))}
   await this.update(doc);await this.hydrate(doc,position);const values=await this.client.request('completion',{file:doc.file,line:position.lineNumber,column:position.column})
   return {suggestions:values.map((e:{name:string;insertText?:string;sortText:string;kind:string})=>({label:e.name,insertText:e.insertText??e.name,sortText:e.sortText,kind:e.kind==='method'||e.kind==='function'?monaco.languages.CompletionItemKind.Function:monaco.languages.CompletionItemKind.Property,range}))}
  })})
  const hover=monaco.languages.registerHoverProvider(LANGUAGE,{provideHover:(model,position)=>this.provide<Monaco.languages.Hover|null>(model,null,async()=>{const doc=this.documents.get(model.uri.toString());if(!doc)return null;await this.update(doc);await this.hydrate(doc,position);const h=await this.client.request('hover',{file:doc.file,line:position.lineNumber,column:position.column});return h?{contents:[{value:'```javascript\n'+h.text+'\n```'},{value:h.documentation}]}:null})})
  const signatures=monaco.languages.registerSignatureHelpProvider(LANGUAGE,{signatureHelpTriggerCharacters:['(',','],signatureHelpRetriggerCharacters:[')'],provideSignatureHelp:(model,position)=>this.provide<Monaco.languages.SignatureHelpResult|null>(model,null,async()=>{const doc=this.documents.get(model.uri.toString());if(!doc)return null;await this.update(doc);await this.hydrate(doc,position);const value=await this.client.request('signature',{file:doc.file,line:position.lineNumber,column:position.column});return value?{value,dispose(){}}:null})})
  this.disposables.push(()=>completion.dispose(),()=>hover.dispose(),()=>signatures.dispose())
  const sync=()=>{void this.syncProject().catch(this.report)},connection=()=>{void this.reconnect().catch(this.report)}
  this.disposables.push(subscribeProjectSession(sync),subscribeControlHub(connection),subscribeControlNotify(note=>{if(note.method===`javascript.${type}Hooks.changed`)void this.loadHooks().catch(this.report)}))
  sync();connection()
 }
 private async provide<T>(model:Monaco.editor.ITextModel,empty:T,request:()=>Promise<T>):Promise<T>{
  try{return await request()}catch(error){if(this.disposed||model.isDisposed()||!this.documents.has(model.uri.toString()))return empty;throw error}
 }
 private async syncProject(){
  if(this.disposed||getProjectSession().binding?.handle.client!==this.project)return
  const scripts=getProjectSession().workspace.packages.flatMap(p=>p.scripts).filter(s=>s.name.endsWith('.js')&&s.srcKind==='common'),next:Record<string,string>={}
  for(const s of effectiveBuiltinScripts(scripts).filter(s=>s.type==='common'))next[`/common/${s.name.slice(0,-3)}.ts`]=transformDialect(s.source,'editor').source
  for(const s of scripts)next[`/common/${s.name.slice(0,-3)}.ts`]=transformDialect(s.content,'editor').source
  next['/common.d.ts']=`interface CommonModules {${Object.keys(next).map(path=>`${JSON.stringify(path.slice(8,-3))}:typeof import(${JSON.stringify(path.slice(0,-3))});`).join('')}} declare function __require<K extends keyof CommonModules>(id:K):CommonModules[K];`
  const changes:Record<string,string|null>={...next};for(const path of Object.keys(this.projectFiles))if(!(path in next))changes[path]=null
  this.projectFiles=next;await this.client.writeFiles(changes)
 }
 private async reconnect(){
  const generation=controlConnectionGeneration(),connected=isControlConnected();if(this.generation===generation&&this.connected===connected)return;this.generation=generation;this.connected=connected
  this.classes.clear();this.runtime='';this.hooks=[];this.hookClasses.clear();this.hookRevision=-1;this.hookRuntime='';await this.publishJava()
  if(this.disposed)return
  if(!isControlConnected()){for(const doc of this.documents.values()){await this.update(doc);this.monaco.editor.setModelMarkers(doc.model,'hanshu-tsserver',[])}return}
  await this.fetchClasses(this.profile.requiredClasses);await this.loadHooks()
  for(const doc of this.documents.values()){await this.refreshImports(doc.model);await this.diagnose(doc)}
 }
 private async loadHooks(){
  if(!isControlConnected()||!['actor','player'].includes(this.type))return
  const generation=controlConnectionGeneration(),r=await controlRequest(`javascript.${this.type}Hooks`,{}) as {schemaVersion:number;runtimeId:string;revision:number;hooks:{id:string;cancellable:boolean;eventClass?:string}[]}
  if(this.disposed||generation!==controlConnectionGeneration())return
  if(r.schemaVersion!==1||typeof r.runtimeId!=='string'||!Number.isSafeInteger(r.revision)||!Array.isArray(r.hooks)||r.hooks.some(h=>typeof h.id!=='string'||typeof h.cancellable!=='boolean'))throw Error('不兼容的 hook 注册表')
  if(this.hookRuntime===r.runtimeId&&this.hookRevision>=r.revision)return
  this.hookRuntime=r.runtimeId;this.hookRevision=r.revision;this.hooks=r.hooks.map(h=>h.id)
  this.hookClasses=new Map(r.hooks.filter(h=>typeof h.eventClass==='string').map(h=>[h.id,h.eventClass!]))
  for(const doc of this.documents.values()){await this.refreshImports(doc.model);await this.update(doc)}
 }
 private async hydrate(doc:{file:string;model:Monaco.editor.ITextModel},position:Monaco.Position){
  if(!isControlConnected())return
  await this.refreshImports(doc.model)
  const line=doc.model.getLineContent(position.lineNumber),positions=[...line.slice(0,position.column).matchAll(/[A-Za-z_$][\w$]*/g)].map(m=>m.index!+1).slice(-24)
  for(let round=0;round<4;round++){
   const modules=new Set(await this.client.request('types',{file:doc.file,line:position.lineNumber,positions}) as string[]),names=new Set<string>()
   for(const c of this.classes.values())for(const dependency of c.dependencies)if(modules.has(javaModule(dependency))&&!this.classes.has(dependency))names.add(dependency)
   if(!names.size)break;await this.fetchClasses([...names])
  }
 }
 private async publishJava(){const next=buildJavaFiles(this.classes.values()),changes:Record<string,string|null>={...next};for(const path of Object.keys(this.javaFiles))if(!(path in next))changes[path]=null;this.javaFiles=next;await this.client.writeFiles(changes)}
 private async fetchClasses(names:string[]){
  if(!isControlConnected()||this.disposed)return
  const generation=controlConnectionGeneration(),missing=names.filter(n=>!this.classes.has(n))
  if(!missing.length&&this.runtime)return
  for(let i=0;i<Math.max(1,missing.length);i+=24){const r=await controlRequest('javascript.stubs',{classes:missing.slice(i,i+24)}) as StubResponse
   if(this.disposed||generation!==controlConnectionGeneration())return
   if(r.schemaVersion!==1||!Array.isArray(r.classes)||typeof r.runtimeId!=='string')throw Error('不兼容的 JavaScript 类型库协议')
   if(this.runtime&&this.runtime!==r.runtimeId)this.classes.clear();this.runtime=r.runtimeId;for(const c of r.classes)this.classes.set(c.name,c)
  }await this.publishJava()
 }
 async refreshImports(model:Monaco.editor.ITextModel){if(!this.documents.has(model.uri.toString()))return;const result=transformDialect(model.getValue()),names=[...result.imports,...result.hooks.map(h=>this.hookClasses.get(h.hook)).filter((n):n is string=>!!n)];this.queued=this.queued.catch(()=>{}).then(()=>this.fetchClasses([...this.profile.requiredClasses,...names]));await this.queued}
 attach(model:Monaco.editor.ITextModel){
  const existing=this.documents.get(model.uri.toString());if(existing){existing.refs++;return ()=>this.detach(model)}
  const file=`/${this.type==='common'?'common-edit':'documents'}/${++this.sequence}.ts`,doc={model,file,source:'',refs:1,listener:null! as Monaco.IDisposable,timer:undefined as ReturnType<typeof setTimeout>|undefined};this.documents.set(model.uri.toString(),doc)
  const sync=()=>{clearTimeout(doc.timer);void this.update(doc).catch(this.report);doc.timer=setTimeout(()=>{void this.refreshImports(model).then(()=>this.diagnose(doc)).catch(this.report)},250)}
  doc.listener=model.onDidChangeContent(sync);sync()
  return ()=>this.detach(model)
 }
 private detach(model:Monaco.editor.ITextModel){const doc=this.documents.get(model.uri.toString());if(!doc||--doc.refs>0)return;clearTimeout(doc.timer);doc.listener.dispose();this.documents.delete(model.uri.toString());void this.client.writeFiles({[doc.file]:null}).catch(()=>{});if(!model.isDisposed()){this.monaco.editor.setModelMarkers(model,'hanshu-dialect',[]);this.monaco.editor.setModelMarkers(model,'hanshu-tsserver',[])}}
 private async update(doc:{model:Monaco.editor.ITextModel;file:string;source:string}){
  if(doc.model.isDisposed()||this.disposed)return
  const value=doc.model.getValue(),result=transformDialect(value,'editor')
  if(this.type==='goal'&&!result.goal)result.diagnostics.push({line:1,message:'目标定义必须声明 @goal / @config / @state 文件级元数据块'})
  if(this.type!=='goal'&&result.goal)result.diagnostics.push({line:result.goal.line,message:'Goal 元数据只允许出现在目标定义脚本中'})
  if(this.hookRevision>=0)for(const hook of result.hooks)if(!this.hooks.includes(hook.hook))result.diagnostics.push({line:hook.line,message:`当前 ${this.type} 宿主未注册 hook：${hook.hook}`})
  this.monaco.editor.setModelMarkers(doc.model,'hanshu-dialect',result.diagnostics.map(d=>({severity:this.monaco.MarkerSeverity.Error,message:d.message,startLineNumber:d.line,endLineNumber:d.line,startColumn:1,endColumn:doc.model.getLineMaxColumn(d.line)})))
  if(doc.source!==result.source){doc.source=result.source;await this.client.writeFiles({[doc.file]:result.source})}
 }
 private async diagnose(doc:{model:Monaco.editor.ITextModel;file:string;source:string}){
  if(this.disposed||doc.model.isDisposed())return;const version=doc.model.getVersionId();await this.update(doc)
  const diagnostics=await this.client.request('diagnostics',{file:doc.file})
  if(this.disposed||doc.model.isDisposed()||version!==doc.model.getVersionId())return
  this.monaco.editor.setModelMarkers(doc.model,'hanshu-tsserver',diagnostics.map((d:{message:string;start:{line:number;column:number};end:{line:number;column:number};error:boolean})=>({message:d.message,severity:d.error?this.monaco.MarkerSeverity.Error:this.monaco.MarkerSeverity.Warning,startLineNumber:d.start.line,startColumn:Math.min(d.start.column,doc.model.getLineMaxColumn(d.start.line)),endLineNumber:d.end.line,endColumn:Math.min(d.end.column,doc.model.getLineMaxColumn(d.end.line)),source:'TypeScript'})))
 }
 dispose(){this.disposed=true;for(const d of this.documents.values()){clearTimeout(d.timer);d.listener.dispose()}this.documents.clear();for(const dispose of this.disposables)dispose();this.client.dispose()}
}
