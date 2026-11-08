/** TypeScript's tsserver language-service engine, with an in-memory browser host. */
import ts from 'typescript'
import {readableJavaTypes} from './typeDisplay'
import es5 from 'typescript/lib/lib.es5.d.ts?raw'
import decorators from 'typescript/lib/lib.decorators.d.ts?raw'
import decoratorsLegacy from 'typescript/lib/lib.decorators.legacy.d.ts?raw'
const files=new Map<string,{text:string;version:number}>([['/lib.es5.d.ts',{text:es5,version:1}],['/lib.decorators.d.ts',{text:decorators,version:1}],['/lib.decorators.legacy.d.ts',{text:decoratorsLegacy,version:1}]])
/** CommonJS assignments need an explicit TS export surface once author documents are TS. */
function commonModule(text:string):string {
 const source=ts.createSourceFile('common.ts',text,ts.ScriptTarget.ES5,true,ts.ScriptKind.TS),edits:{at:number;text:string}[]=[],exported=new Set<string>()
 let sequence=0
 for(const statement of source.statements){
  if(!ts.isExpressionStatement(statement)||!ts.isBinaryExpression(statement.expression)||statement.expression.operatorToken.kind!==ts.SyntaxKind.EqualsToken)continue
  const left=statement.expression.left
  if(!ts.isPropertyAccessExpression(left)||!ts.isIdentifier(left.expression)||left.expression.text!=='exports'||exported.has(left.name.text))continue
  exported.add(left.name.text)
  let alias:string;do{alias=`__hanshu_export_${++sequence}`}while(text.includes(alias))
  edits.push({at:statement.getStart(source),text:`var ${alias} = `},{at:statement.end,text:`; export {${alias} as ${left.name.text}};`})
 }
 for(const edit of edits.sort((a,b)=>b.at-a.at))text=text.slice(0,edit.at)+edit.text+text.slice(edit.at)
 return text
}
const host:ts.LanguageServiceHost={
 getCompilationSettings:()=>({noEmit:true,target:ts.ScriptTarget.ES5,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,moduleDetection:ts.ModuleDetectionKind.Force,skipLibCheck:true,strict:false}),
 getScriptKind:()=>ts.ScriptKind.TS,
 getScriptFileNames:()=>[...files.keys()],getScriptVersion:name=>String(files.get(name)?.version??0),
 getScriptSnapshot:name=>{const file=files.get(name);return file?ts.ScriptSnapshot.fromString(file.text):undefined},
 getCurrentDirectory:()=> '/',getDefaultLibFileName:()=>'/lib.es5.d.ts',fileExists:name=>files.has(name),readFile:name=>files.get(name)?.text,
 readDirectory:()=>[...files.keys()],directoryExists:()=>true,
}
const service=ts.createLanguageService(host)
function completionEntries(file:string,pos:number){
 const program=service.getProgram(),source=program?.getSourceFile(file),checker=program?.getTypeChecker()
 let receiver:ts.Expression|undefined
 if(source)source.forEachChild(function visit(node){
  if(node.getFullStart()>pos||node.end<pos)return
  if(ts.isPropertyAccessExpression(node)&&pos>=node.expression.end&&pos<=node.end)receiver=node.expression
  node.forEachChild(visit)
 })
 const receiverType=receiver&&checker?checker.getTypeAtLocation(receiver):undefined
 return service.getCompletionsAtPosition(file,pos,{includeCompletionsForModuleExports:false,includeCompletionsWithInsertText:true})?.entries.map(entry=>{
  const symbol=receiverType&&checker?checker.getPropertyOfType(receiverType,entry.name):undefined
  const signatures=symbol&&checker&&receiver?checker.getTypeOfSymbolAtLocation(symbol,receiver).getCallSignatures():[]
  return {name:entry.name,kind:entry.kind,insertText:entry.insertText,sortText:entry.sortText,callable:signatures.length>0||entry.kind===ts.ScriptElementKind.memberFunctionElement||entry.kind===ts.ScriptElementKind.functionElement,member:!!receiver,parameterCount:signatures.length?Math.max(...signatures.map(signature=>signature.getParameters().length)):undefined}
 })??[]
}
function point(file:string,offset:number){const s=ts.createSourceFile(file,files.get(file)?.text??'',ts.ScriptTarget.ES5);const p=s.getLineAndCharacterOfPosition(offset);return {line:p.line+1,column:p.character+1}}
function offset(file:string,line:number,column:number){const source=files.get(file)?.text??'',lines=source.split('\n');return lines.slice(0,line-1).reduce((n,l)=>n+l.length+1,0)+Math.min(column-1,lines[line-1]?.length??0)}
function formatSettings(options?:{tabSize?:number;insertSpaces?:boolean;newLineCharacter?:string}):ts.FormatCodeSettings{
 const defaults=ts.getDefaultFormatCodeSettings(options?.newLineCharacter??'\n')
 return {...defaults,tabSize:options?.tabSize??defaults.tabSize,indentSize:options?.tabSize??defaults.indentSize,convertTabsToSpaces:options?.insertSpaces??defaults.convertTabsToSpaces}
}
function formatEdits(file:string,edits:readonly ts.TextChange[]){
 return edits.map(edit=>({start:point(file,edit.span.start),end:point(file,edit.span.start+edit.span.length),newText:edit.newText}))
}
self.onmessage=({data})=>{
 const {id,method,params}=data
 try{
  let result:unknown
  if(method==='files'){for(const [name,text] of Object.entries(params as Record<string,string|null>))if(text===null)files.delete(name);else files.set(name,{text:name.startsWith('/common/')||name.startsWith('/common-edit/')?commonModule(text):text,version:(files.get(name)?.version??0)+1});result=true}
  else if(method==='snapshot')result={typescriptVersion:ts.version,compilerOptions:host.getCompilationSettings(),files:[...files].map(([name,file])=>({name,version:file.version,characters:file.text.length,...name.startsWith('/lib.')?{builtin:true}:{text:file.text}}))}
  else if(method==='format'){
   // Format author source, not the editor-transform virtual document, so dialect lines stay intact.
   const file='/format.ts',source=String(params.source??''),settings=formatSettings(params.options)
   files.set(file,{text:source,version:(files.get(file)?.version??0)+1})
   try{
    const edits=params.endLine==null
     ?service.getFormattingEditsForDocument(file,settings)
     :service.getFormattingEditsForRange(file,offset(file,params.startLine??1,params.startColumn??1),offset(file,params.endLine,params.endColumn??1),settings)
    result=formatEdits(file,edits)
   }finally{files.delete(file)}
  }
  else{
   const file=params.file,pos=offset(file,params.line??1,params.column??1)
   if(method==='diagnostics')result=[...service.getSyntacticDiagnostics(file),...service.getSemanticDiagnostics(file)].map(d=>({code:d.code,message:readableJavaTypes(ts.flattenDiagnosticMessageText(d.messageText,'\n')),start:point(file,d.start??0),end:point(file,(d.start??0)+(d.length??1)),error:d.category===ts.DiagnosticCategory.Error}))
   else if(method==='completion')result=completionEntries(file,pos)
   else if(method==='callbackLocations'){
    const source=service.getProgram()?.getSourceFile(file),locations:{line:number;column:number}[]=[]
    source?.forEachChild(function visit(node){
     if(locations.length>=256)return
     if(ts.isCallExpression(node)&&node.arguments.some(argument=>{while(ts.isParenthesizedExpression(argument))argument=argument.expression;return ts.isFunctionExpression(argument)})){
      const collect=(part:ts.Node)=>{if(locations.length>=256)return;if(ts.isIdentifier(part))locations.push(point(file,part.getStart(source)));part.forEachChild(collect)}
      collect(node.expression)
     }
     node.forEachChild(visit)
    });result=locations
   }
   else if(method==='hover'){const h=service.getQuickInfoAtPosition(file,pos);result=h?{text:readableJavaTypes(ts.displayPartsToString(h.displayParts)),documentation:ts.displayPartsToString(h.documentation)}:null}
   else if(method==='types'){
    const names=new Set<string>()
    const locations=(params.locations??(params.positions as number[]).map(column=>({line:params.line,column}))) as {line:number;column:number}[]
    for(const location of locations){
     const at=offset(file,location.line,location.column),h=service.getQuickInfoAtPosition(file,at)
     for(const name of ts.displayPartsToString(h?.displayParts).match(/jvm_[A-Za-z0-9_]+/g)??[])names.add(name)
     for(const d of service.getTypeDefinitionAtPosition(file,at)??[])if(d.fileName.startsWith('/java/'))names.add(d.fileName.slice(6,-5))
    }result=[...names]
   }
   else if(method==='signature'){const h=service.getSignatureHelpItems(file,pos,undefined);result=h?{activeSignature:h.selectedItemIndex,activeParameter:h.argumentIndex,signatures:h.items.map(s=>({label:readableJavaTypes(ts.displayPartsToString(s.prefixDisplayParts)+s.parameters.map(p=>ts.displayPartsToString(p.displayParts)).join(ts.displayPartsToString(s.separatorDisplayParts))+ts.displayPartsToString(s.suffixDisplayParts)),documentation:ts.displayPartsToString(s.documentation),parameters:s.parameters.map(p=>({label:readableJavaTypes(ts.displayPartsToString(p.displayParts)),documentation:ts.displayPartsToString(p.documentation)}))}))}:null}
  }
  self.postMessage({id,result})
 }catch(error){self.postMessage({id,error:String(error)})}
}
