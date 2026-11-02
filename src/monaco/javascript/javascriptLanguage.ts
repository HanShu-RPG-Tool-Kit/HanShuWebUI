import type * as Monaco from 'monaco-editor'
import {getProjectSession,subscribeProjectSession} from '../../project/projectSession'
import {controlRequest,getControlHubSnapshot,isControlConnected,subscribeControlHub,subscribeControlNotify,controlConnectionGeneration} from '../../gameDevServer/controlHub'
import {effectiveBuiltinScripts,type ScriptType} from '../../scriptResources'
import {transformDialect} from './dialect'
import {TsserverClient} from './tsserverClient'
import {buildJavaFiles,type JavaStub,type StubResponse,javaModule} from './stubs'
import {javascriptProfile} from './profiles'
import {diagnosticValue,languageDiagnosticHistory,recordLanguageDiagnostic} from './diagnostics'
import {javascriptCompletion,type LanguageCompletion} from './completion'
import {libraryKey,readJavaLibrary,readLibraryClasses,subscribeJavaLibrary,type JavaLibrary} from './javaLibrary'
type M=typeof Monaco
type LanguageDocument={model:Monaco.editor.ITextModel;file:string;source:string;refs:number;listener:Monaco.IDisposable;timer?:ReturnType<typeof setTimeout>;diagnosticRun:number}
type TypeDiagnostic={code:number;message:string;start:{line:number;column:number};end:{line:number;column:number};error:boolean}
const services=new Map<string,{service:JavaScriptLanguage;refs:number}>(),projects=new WeakMap<object,number>();let projectSeq=0
const LANGUAGE='hanshu-javascript'
export const JAVASCRIPT_LANGUAGE_ID=LANGUAGE
const registered=new WeakSet<object>()
export function registerJavaScriptLanguage(monaco:M){
 if(registered.has(monaco))return;registered.add(monaco)
 monaco.languages.register({id:LANGUAGE,extensions:['.js']})
 // A built-in JS request started before a model switched languages can finish late.
 // Remove only that provider's stale markers on dialect models; ordinary JS keeps its checks.
 monaco.editor.onDidChangeMarkers(resources=>{
  for(const resource of resources){const model=monaco.editor.getModel(resource);if(model?.getLanguageId()===LANGUAGE&&monaco.editor.getModelMarkers({resource,owner:'javascript'}).length)monaco.editor.setModelMarkers(model,'javascript',[])}
 })
 monaco.languages.setMonarchTokensProvider(LANGUAGE,{tokenizer:{root:[[/\/\/.*$/,'comment'],[/\/\*/,'comment','@comment'],[/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/,'string'],[/\x40(?:hook|goal|config|state|subscribe)\b/,'annotation'],[/\b(?:function|var|return|if|else|for|while|new|throw|try|catch|import|require|from|true|false|null)\b/,'keyword'],[/\b\d+(?:\.\d+)?\b/,'number']],comment:[[/[^/*]+/,'comment'],[/\*\//,'comment','@pop'],[/[/*]/,'comment']]}})
 monaco.languages.setLanguageConfiguration(LANGUAGE,{comments:{lineComment:'//',blockComment:['/*','*/']},brackets:[['{','}'],['[',']'],['(',')']],autoClosingPairs:[{open:'{',close:'}'},{open:'[',close:']'},{open:'(',close:')'},{open:'"',close:'"'},{open:"'",close:"'"}]})
}
export function attachJavaScript(monaco:M,model:Monaco.editor.ITextModel,report:(e:unknown)=>void,type:ScriptType='common'){
 registerJavaScriptLanguage(monaco);monaco.editor.setModelLanguage(model,LANGUAGE);monaco.editor.setModelMarkers(model,'javascript',[])
 const project=getProjectSession().binding?.handle.client;if(project&&!projects.has(project))projects.set(project,++projectSeq)
 const key=`${project?projects.get(project):'unbound'}:${type}`
 let shared=services.get(key);if(!shared){shared={service:new JavaScriptLanguage(monaco,report,type),refs:0};services.set(key,shared)}shared.refs++
 const detach=shared.service.attach(model)
 return {dispose(){detach();if(--shared.refs===0){shared.service.dispose();services.delete(key)}}}
}
export async function refreshJavaScriptImports(model:Monaco.editor.ITextModel){await Promise.all([...services.values()].map(s=>s.service.refreshImports(model)))}
export async function captureJavaScriptDiagnostics(model:Monaco.editor.ITextModel,position:Monaco.Position|null,selection:Monaco.Selection|null){
 const shared=[...services.values()].find(entry=>entry.service.documents.has(model.uri.toString()))
 try{if(shared)return await shared.service.captureDiagnostics(model,position,selection)}catch(error){recordLanguageDiagnostic('export','capture-error',error)}
 const source=model.isDisposed()?null:model.getValue()
 return {format:'hanshu.javascript-language-diagnostics',version:1,capturedAt:new Date().toISOString(),document:{uri:model.uri.with({query:'',fragment:''}).toString(),languageId:model.isDisposed()?null:model.getLanguageId(),position,selection,source,editorTransform:source===null?null:transformDialect(source,'editor'),runtimeTransform:source===null?null:transformDialect(source)},service:{unavailable:true,reason:'No active language service snapshot; inspect lifecycle history'},history:languageDiagnosticHistory()}
}
let languageSequence=0
export class JavaScriptLanguage {
 private readonly diagnosticId=`language-${++languageSequence}`
 readonly client=new TsserverClient();readonly documents=new Map<string,LanguageDocument>()
 private disposables:(()=>void)[]=[];private classes=new Map<string,JavaStub>();private javaFiles:Record<string,string>={};private projectFiles:Record<string,string>={};private runtime='';private disposed=false;private hooks:string[]=[];private sequence=0;private generation=0;private queued:Promise<unknown>=Promise.resolve()
 private profile:ReturnType<typeof javascriptProfile>;private connected=false;private hookRevision=-1;private hookRuntime='';private hookClasses=new Map<string,string>();private project=getProjectSession().binding?.handle.client
 private monaco:M; private report:(e:unknown)=>void; private type:ScriptType
 private missingClasses=new Set<string>()
 private javaRevision=0;private typeDiagnosticsTimer?:ReturnType<typeof setTimeout>
 private library?:JavaLibrary;private libraryReady:Promise<void>=Promise.resolve();private endpoint=''
 constructor(monaco:M,report:(e:unknown)=>void,type:ScriptType='common'){
  this.monaco=monaco;this.report=error=>{recordLanguageDiagnostic(this.diagnosticId,'error',error);if(!this.disposed)report(error)};this.type=type
  recordLanguageDiagnostic(this.diagnosticId,'created',{type,worker:this.client.diagnosticId})
  registerJavaScriptLanguage(monaco);this.profile=javascriptProfile(type)
  void this.client.writeFiles({'/host.d.ts':this.profile.source,...buildJavaFiles([])}).catch(this.report)
  const completion=monaco.languages.registerCompletionItemProvider(LANGUAGE,{triggerCharacters:['.','"',"'"],provideCompletionItems:(model,position)=>this.provide<Monaco.languages.CompletionList>('completion',model,position,{suggestions:[]},async()=>{
   const doc=this.documents.get(model.uri.toString());if(!doc)return {suggestions:[]}
   const word=model.getWordUntilPosition(position),range=new monaco.Range(position.lineNumber,word.startColumn,position.lineNumber,word.endColumn)
   if(/@hook\(\s*["'][^"']*$/.test(model.getLineContent(position.lineNumber).slice(0,position.column-1)))return {suggestions:this.hooks.map(h=>({label:h,insertText:h,kind:monaco.languages.CompletionItemKind.Event,range}))}
   await this.update(doc);await this.hydrate(doc,position);const values=await this.client.request('completion',{file:doc.file,line:position.lineNumber,column:position.column})
   return {suggestions:values.map((entry:LanguageCompletion)=>javascriptCompletion(monaco,model,position,entry))}
  })})
  const hover=monaco.languages.registerHoverProvider(LANGUAGE,{provideHover:(model,position)=>this.provide<Monaco.languages.Hover|null>('hover',model,position,null,async()=>{const doc=this.documents.get(model.uri.toString());if(!doc)return null;await this.update(doc);await this.hydrate(doc,position);const h=await this.client.request('hover',{file:doc.file,line:position.lineNumber,column:position.column});return h?{contents:[{value:'```javascript\n'+h.text+'\n```'},{value:h.documentation}]}:null})})
  const signatures=monaco.languages.registerSignatureHelpProvider(LANGUAGE,{signatureHelpTriggerCharacters:['(',','],signatureHelpRetriggerCharacters:[')'],provideSignatureHelp:(model,position)=>this.provide<Monaco.languages.SignatureHelpResult|null>('signature',model,position,null,async()=>{const doc=this.documents.get(model.uri.toString());if(!doc)return null;await this.update(doc);await this.hydrate(doc,position);const value=await this.client.request('signature',{file:doc.file,line:position.lineNumber,column:position.column});return value?{value,dispose(){}}:null})})
  this.disposables.push(()=>completion.dispose(),()=>hover.dispose(),()=>signatures.dispose())
  const sync=()=>{void this.syncProject().catch(this.report)},connection=()=>{void this.reconnect().catch(this.report)}
  this.disposables.push(subscribeJavaLibrary(()=>{void this.reconnect(true).catch(this.report)}),subscribeProjectSession(sync),subscribeControlHub(connection),subscribeControlNotify(note=>{if(note.method===`javascript.${type}Hooks.changed`)void this.loadHooks().catch(this.report)}))
  sync();connection()
 }
 private async provide<T>(kind:string,model:Monaco.editor.ITextModel,position:Monaco.Position,empty:T,request:()=>Promise<T>):Promise<T>{
  if(model.isDisposed()||!this.documents.has(model.uri.toString()))return empty
  const started=Date.now(),context={kind,uri:model.uri.with({query:'',fragment:''}).toString(),position,version:model.getVersionId()}
  recordLanguageDiagnostic(this.diagnosticId,'provider-start',context)
  try{const result=await request();recordLanguageDiagnostic(this.diagnosticId,'provider-result',{...context,durationMs:Date.now()-started,result});return result}
  catch(error){recordLanguageDiagnostic(this.diagnosticId,'provider-error',{...context,durationMs:Date.now()-started,error:diagnosticValue(error)});if(this.disposed||model.isDisposed()||!this.documents.has(model.uri.toString()))return empty;throw error}
 }
 private async requestControl(method:string,params:unknown){
  const started=Date.now();recordLanguageDiagnostic(this.diagnosticId,'control-request',{method,params})
  try{const result=await controlRequest(method,params),r=(result&&typeof result==='object'?result:{}) as Partial<StubResponse>&{revision?:number;hooks?:unknown[]};recordLanguageDiagnostic(this.diagnosticId,'control-response',{method,durationMs:Date.now()-started,schemaVersion:r.schemaVersion,runtimeId:r.runtimeId,classes:Array.isArray(r.classes)?r.classes.map(c=>c?.name):undefined,missing:r.missing,revision:r.revision,hookCount:Array.isArray(r.hooks)?r.hooks.length:undefined});return result}
  catch(error){recordLanguageDiagnostic(this.diagnosticId,'control-error',{method,durationMs:Date.now()-started,error:diagnosticValue(error)});throw error}
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
 private async reconnect(force=false){
  const generation=controlConnectionGeneration(),connected=isControlConnected(),endpoint=libraryKey();if(!force&&this.endpoint===endpoint&&this.generation===generation&&this.connected===connected)return;this.endpoint=endpoint;this.generation=generation;this.connected=connected
  recordLanguageDiagnostic(this.diagnosticId,'connection',{generation,connected})
  clearTimeout(this.typeDiagnosticsTimer)
  this.classes.clear();this.missingClasses.clear();this.runtime='';this.hooks=[];this.hookClasses.clear();this.hookRevision=-1;this.hookRuntime='';this.library=undefined
  this.libraryReady=readJavaLibrary(endpoint).then(library=>{if(this.endpoint===endpoint&&this.generation===generation)this.library=library}).catch(error=>{recordLanguageDiagnostic(this.diagnosticId,'local-library-error',error);this.library=undefined})
  await this.libraryReady
  await this.publishJava()
  if(this.disposed||this.generation!==generation||this.endpoint!==endpoint)return
  if(!isControlConnected()&&!this.library){for(const doc of this.documents.values()){await this.update(doc);this.monaco.editor.setModelMarkers(doc.model,'hanshu-tsserver',[])}return}
  await this.fetchClasses(this.profile.requiredClasses);await this.loadHooks()
  for(const doc of this.documents.values()){await this.refreshImports(doc.model);await this.diagnose(doc)}
 }
 private async loadHooks(){
  if(this.library){const snapshot=this.type==='actor'?this.library.actor:this.type==='player'?this.library.player:undefined;if(snapshot){this.hookRuntime=snapshot.runtimeId;this.hookRevision=snapshot.revision;this.hooks=snapshot.hooks.map(h=>h.id);this.hookClasses=new Map(snapshot.hooks.filter(h=>h.eventClass).map(h=>[h.id,h.eventClass!]));}return}
  if(!isControlConnected()||!['actor','player'].includes(this.type))return
  const generation=controlConnectionGeneration(),r=await this.requestControl(`javascript.${this.type}Hooks`,{}) as {schemaVersion:number;runtimeId:string;revision:number;hooks:{id:string;cancellable:boolean;eventClass?:string}[]}
  if(this.disposed||generation!==controlConnectionGeneration())return
  if(r.schemaVersion!==1||typeof r.runtimeId!=='string'||!Number.isSafeInteger(r.revision)||!Array.isArray(r.hooks)||r.hooks.some(h=>typeof h.id!=='string'||typeof h.cancellable!=='boolean'))throw Error('不兼容的 hook 注册表')
  if(this.hookRuntime===r.runtimeId&&this.hookRevision>=r.revision)return
  this.hookRuntime=r.runtimeId;this.hookRevision=r.revision;this.hooks=r.hooks.map(h=>h.id)
  this.hookClasses=new Map(r.hooks.filter(h=>typeof h.eventClass==='string').map(h=>[h.id,h.eventClass!]))
  for(const doc of this.documents.values()){await this.refreshImports(doc.model);await this.update(doc)}
 }
 private async hydrate(doc:{file:string;model:Monaco.editor.ITextModel},position:Monaco.Position){
  await this.refreshImports(doc.model)
  const locations=this.receiverLocations(doc.model,[{line:position.lineNumber,column:position.column}])
  await this.hydrateLocations(doc,locations)
 }
 private receiverLocations(model:Monaco.editor.ITextModel,points:{line:number;column:number}[]){
  const seen=new Set<string>(),locations:{line:number;column:number}[]=[]
  for(const point of points){
   if(point.line<1||point.line>model.getLineCount())continue
   const line=model.getLineContent(point.line)
   for(const word of [...line.slice(0,point.column).matchAll(/[A-Za-z_$][\w$]*/g)].slice(-24)){
    const column=word.index!+1,key=`${point.line}:${column}`
    if(!seen.has(key)){seen.add(key);locations.push({line:point.line,column})}
   }
  }
  return locations.slice(0,256)
 }
 private async hydrateLocations(doc:{file:string;model:Monaco.editor.ITextModel},locations:{line:number;column:number}[]){
  if(!locations.length)return
  for(let round=0;round<4;round++){
   if(this.disposed||doc.model.isDisposed()||(!isControlConnected()&&!this.library))return
   const modules=new Set(await this.client.request('types',{file:doc.file,locations}) as string[]),names=new Set<string>()
   for(const c of this.classes.values())for(const dependency of c.dependencies)if(modules.has(javaModule(dependency))&&!this.classes.has(dependency)&&!this.missingClasses.has(dependency))names.add(dependency)
   if(!names.size)break;await this.fetchClasses([...names])
  }
 }
 private async publishJava(){
  const next=buildJavaFiles(this.classes.values()),changes:Record<string,string|null>={}
  for(const [path,text]of Object.entries(next))if(this.javaFiles[path]!==text)changes[path]=text
  for(const path of Object.keys(this.javaFiles))if(!(path in next))changes[path]=null
  if(!Object.keys(changes).length)return
  this.javaFiles=next;await this.client.writeFiles(changes);this.javaRevision++
  if(this.disposed)return
  clearTimeout(this.typeDiagnosticsTimer)
  this.typeDiagnosticsTimer=setTimeout(()=>{for(const doc of this.documents.values())void this.diagnose(doc).catch(this.report)},50)
 }
 private async fetchClasses(names:string[]){
  await this.libraryReady
  if(this.disposed)return
  if(this.library){const library=this.library,missing=[...new Set(names)].filter(n=>!this.classes.has(n)&&!this.missingClasses.has(n)),stubs=await readLibraryClasses(library,missing);if(this.disposed||this.library!==library)return;for(const stub of stubs)this.classes.set(stub.name,stub);for(const name of missing)if(!this.classes.has(name))this.missingClasses.add(name);this.runtime=library.runtimeId;await this.publishJava();return}
  if(!isControlConnected())return
  const generation=controlConnectionGeneration(),missing=[...new Set(names)].filter(n=>!this.classes.has(n)&&!this.missingClasses.has(n))
  if(!missing.length&&this.runtime)return
  for(let i=0;i<Math.max(1,missing.length);i+=24){const r=await this.requestControl('javascript.stubs',{classes:missing.slice(i,i+24)}) as StubResponse
   if(this.disposed||generation!==controlConnectionGeneration())return
   if(r.schemaVersion!==1||!Array.isArray(r.classes)||typeof r.runtimeId!=='string')throw Error('不兼容的 JavaScript 类型库协议')
   if(this.runtime&&this.runtime!==r.runtimeId){this.classes.clear();this.missingClasses.clear()}this.runtime=r.runtimeId;for(const c of r.classes){this.classes.set(c.name,c);this.missingClasses.delete(c.name)}for(const name of r.missing??[])this.missingClasses.add(name)
  }await this.publishJava()
 }
 async refreshImports(model:Monaco.editor.ITextModel){if(!this.documents.has(model.uri.toString()))return;const result=transformDialect(model.getValue()),names=[...result.imports,...result.hooks.map(h=>this.hookClasses.get(h.hook)).filter((n):n is string=>!!n)];this.queued=this.queued.catch(()=>{}).then(()=>this.fetchClasses([...this.profile.requiredClasses,...names]));await this.queued}
 attach(model:Monaco.editor.ITextModel){
  const existing=this.documents.get(model.uri.toString());if(existing){existing.refs++;return ()=>this.detach(model)}
  const file=`/${this.type==='common'?'common-edit':'documents'}/${++this.sequence}.ts`,doc={model,file,source:'',refs:1,diagnosticRun:0,listener:null! as Monaco.IDisposable,timer:undefined as ReturnType<typeof setTimeout>|undefined};this.documents.set(model.uri.toString(),doc)
  const sync=()=>{clearTimeout(doc.timer);void this.update(doc).catch(this.report);doc.timer=setTimeout(()=>{void this.refreshImports(model).then(()=>this.diagnose(doc)).catch(this.report)},250)}
  recordLanguageDiagnostic(this.diagnosticId,'attach',{uri:model.uri.with({query:'',fragment:''}).toString(),file,version:model.getVersionId()})
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
 private async diagnose(doc:LanguageDocument){
  if(this.disposed||doc.model.isDisposed())return
  const version=doc.model.getVersionId(),generation=controlConnectionGeneration(),run=++doc.diagnosticRun
  const current=()=>!this.disposed&&!doc.model.isDisposed()&&this.documents.get(doc.model.uri.toString())===doc&&version===doc.model.getVersionId()&&generation===controlConnectionGeneration()&&run===doc.diagnosticRun
  await this.refreshImports(doc.model);if(!current())return
  await this.update(doc);if(!current())return
  let revision=this.javaRevision,diagnostics=await this.client.request('diagnostics',{file:doc.file}) as TypeDiagnostic[]
  if(!current())return
  // Empty dependency placeholders are not evidence that a real Java member is absent.
  const callbackPoints=await this.client.request('callbackLocations',{file:doc.file}) as {line:number;column:number}[]
  if(!current())return
  const locations=this.receiverLocations(doc.model,[...diagnostics.filter(d=>d.code===2339||d.code===2551).map(d=>({line:d.start.line,column:d.end.column})),...callbackPoints])
  await this.hydrateLocations(doc,locations);if(!current())return
  if(revision!==this.javaRevision){revision=this.javaRevision;diagnostics=await this.client.request('diagnostics',{file:doc.file}) as TypeDiagnostic[]}
  if(!current()||revision!==this.javaRevision)return
  recordLanguageDiagnostic(this.diagnosticId,'diagnostics-published',{file:doc.file,version,javaRevision:revision,count:diagnostics.length})
  this.monaco.editor.setModelMarkers(doc.model,'hanshu-tsserver',diagnostics.map(d=>({code:String(d.code),message:d.message,severity:d.error?this.monaco.MarkerSeverity.Error:this.monaco.MarkerSeverity.Warning,startLineNumber:d.start.line,startColumn:Math.min(d.start.column,doc.model.getLineMaxColumn(d.start.line)),endLineNumber:d.end.line,endColumn:Math.min(d.end.column,doc.model.getLineMaxColumn(d.end.line)),source:'TypeScript'})))
 }
 async captureDiagnostics(model:Monaco.editor.ITextModel,position:Monaco.Position|null,selection:Monaco.Selection|null){
  const doc=this.documents.get(model.uri.toString());if(!doc||model.isDisposed())throw Error('当前脚本已关闭，请重新打开后导出')
  const hub=getControlHubSnapshot(),source=model.getValue()
  const report={format:'hanshu.javascript-language-diagnostics',version:1,capturedAt:new Date().toISOString(),environment:{mode:import.meta.env.MODE,userAgent:navigator.userAgent,language:navigator.language,online:navigator.onLine,pagePath:location.pathname},document:{uri:model.uri.with({query:'',fragment:''}).toString(),scriptType:this.type,languageId:model.getLanguageId(),version:model.getVersionId(),position,selection,source,editorTransform:transformDialect(source,'editor'),runtimeTransform:transformDialect(source),lastSubmittedVirtualSource:doc.source,virtualFile:doc.file},markers:this.monaco.editor.getModelMarkers({resource:model.uri}).map(m=>({owner:m.owner,source:m.source,code:m.code,message:m.message,severity:m.severity,startLineNumber:m.startLineNumber,startColumn:m.startColumn,endLineNumber:m.endLineNumber,endColumn:m.endColumn})),service:{id:this.diagnosticId,disposed:this.disposed,projectBound:!!this.project,connected:isControlConnected(),generation:controlConnectionGeneration(),runtimeId:this.runtime,javaRevision:this.javaRevision,hookRuntimeId:this.hookRuntime,hookRevision:this.hookRevision,hooks:this.hooks,hookClasses:Object.fromEntries(this.hookClasses),loadedClasses:[...this.classes.keys()],missingClasses:[...this.missingClasses],openDocuments:[...this.documents.values()].map(d=>({uri:d.model.uri.with({query:'',fragment:''}).toString(),file:d.file,version:d.model.getVersionId()}))},control:{phase:hub.phase,healthOk:hub.health?.ok??null,statusOk:hub.status?.ok??null},worker:this.client.diagnosticSnapshot(),actualWorker:null as unknown,history:languageDiagnosticHistory()}
  // Export remains available if the Worker is unresponsive; never await import hydration here.
  try{report.actualWorker=await this.client.request('snapshot',{},1500)}catch(error){report.actualWorker={unavailable:true,error:diagnosticValue(error)}}
  report.history=languageDiagnosticHistory()
  return report
 }
 dispose(){this.disposed=true;clearTimeout(this.typeDiagnosticsTimer);recordLanguageDiagnostic(this.diagnosticId,'disposed');for(const d of this.documents.values()){clearTimeout(d.timer);d.listener.dispose()}this.documents.clear();for(const dispose of this.disposables)dispose();this.client.dispose()}
}
