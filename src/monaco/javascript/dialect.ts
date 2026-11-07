import {parse,tokenizer} from 'acorn'
export type Hook={hook:string;function:string;line:number;functionLine:number;eventType:string;cancellable:boolean|null;priority:string;receiveCancelled:boolean}
/** PAK `.hooks.json` hook 行：与 RPGToolKit `JavaScriptDialect.Hook` 字段一致（不含编辑器专用字段）。 */
export type PakHook={hook:string;function:string;line:number;cancellable:boolean|null;priority:string;receiveCancelled:boolean}
export type GoalField={name:string;type:string;required:boolean;defaultValue:string|number|boolean|null}
export type GoalSubscription={event:string;function:string;line:number;priority:string;receiveCancelled:boolean}
export type GoalMetadata={id:string;line:number;configLine:number;stateLine:number;config:GoalField[];state:GoalField[];handlers:GoalSubscription[]}
export type DialectDiagnostic={line:number;message:string}
export type PakScriptMetadata={version:2;hooks:PakHook[];goal:GoalMetadata|null}
/** 导出旁表：去掉 `functionLine` / `eventType`，避免加载器 JSON 全等比对失败而 RETAINED。 */
export function pakScriptMetadata(hooks:Hook[],goal:GoalMetadata|null):PakScriptMetadata{
 return {version:2,hooks:hooks.map(({hook,function:fn,line,cancellable,priority,receiveCancelled})=>({hook,function:fn,line,cancellable,priority,receiveCancelled})),goal}
}
const ident='[A-Za-z_$][\\w$]*',typeName=`${ident}(?:\\.${ident})*(?:\\[\\])?`
const declaration=new RegExp(`^(import|require)\\s+(${ident})\\s+from\\s+(["'])([^"'\\r\\n]+)\\3\\s*;?\\s*(?://.*)?$`)
const fqcn=/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
const commonId=/^[^/\\:."'\x00-\x1f\x7f]+$/
const priorities=['HIGHEST','HIGH','NORMAL','LOW','LOWEST']
export function codeMask(source:string):string{
 const chars:string[]=source.split('').map(c=>c==='\n'||c==='\r'?c:' ')
 try{for(const token of tokenizer(source.replaceAll('@',' '),{ecmaVersion:'latest',allowHashBang:false})){
  if(['string','regexp','template','`'].includes(token.type.label))continue
  for(let i=token.start;i<token.end;i++)chars[i]=source[i]
  if(token.start>0&&source[token.start-1]==='@')chars[token.start-1]='@'
 }}catch{/* The runtime ES5 parser reports invalid source. */}
 return chars.join('')
}
function withoutLineComment(text:string):string{
 let quote='',escape=false
 for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote=''}else if(c==='"'||c==="'")quote=c;else if(c==='/'&&text[i+1]==='/')return text.slice(0,i).trimEnd()}
 return text
}
function split(text:string):string[]{
 if(!text.trim())return []
 const out:string[]=[];let start=0,quote='',escape=false,depth=0
 for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote='';continue}
  if(c==='"'||c==="'")quote=c;else if('({['.includes(c))depth++;else if(')}]'.includes(c)){if(--depth<0)throw Error('Unbalanced metadata expression')}
  else if(c===','&&depth===0){out.push(text.slice(start,i).trim());start=i+1}
 }
 if(quote||depth!==0)throw Error('Unbalanced metadata expression')
 const last=text.slice(start).trim();if(last)out.push(last);else if(start===0)out.push('')
 if(out.some(x=>!x))throw Error('Empty metadata argument')
 return out
}
function literal(text:string):string|number|boolean|null{
 const s=text.trim()
 if(s==='null')return null;if(s==='true')return true;if(s==='false')return false
 if(/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)){const n=Number(s);if(Number.isFinite(n))return n}
 if((s[0]==='"'||s[0]==="'")&&s.at(-1)===s[0]){
  const ast=parse(`var value=${s};`,{ecmaVersion:5}) as unknown as {body:{type:string;declarations?:{init:{type:string;value:unknown;start:number;end:number}}[]}[]}
  const declaration=ast.body.length===1&&ast.body[0].type==='VariableDeclaration'?ast.body[0].declarations:undefined
  const node=declaration?.length===1?declaration[0].init:undefined
  if(node?.type==='Literal'&&typeof node.value==='string'&&node.start===10&&node.end===10+s.length)return node.value
 }
 throw Error('Metadata accepts only string, number, boolean or null literals')
}
function options(text:string|undefined,allowed:string[]):Record<string,string|number|boolean|null>{
 if(text===undefined)return {}
 if(!text.startsWith('{')||!text.endsWith('}'))throw Error('Options must be a literal object')
 const out:Record<string,string|number|boolean|null>={}
 for(const item of split(text.slice(1,-1))){const m=/^([A-Za-z_$][\w$]*|"[^"]+"|'[^']+')\s*:\s*(.*)$/.exec(item);if(!m)throw Error('Invalid metadata option')
  const key=m[1][0]==='"'||m[1][0]==="'"?String(literal(m[1])):m[1]
  if(!allowed.includes(key)||Object.prototype.hasOwnProperty.call(out,key))throw Error('Unknown or duplicate metadata option: '+key)
  out[key]=literal(m[2])
 }
 return out
}
function booleanOption(o:Record<string,unknown>,key:string,fallback:boolean):boolean{if(!(key in o))return fallback;if(typeof o[key]!=='boolean')throw Error(key+' must be boolean');return o[key] as boolean}
function fields(text:string):GoalField[]{
 const result:GoalField[]=[]
 for(const call of split(text)){const match=/^field\s*\((.*)\)$/.exec(call);if(!match)throw Error('Only field(name, type, defaultLiteral) is allowed')
  const args=split(match[1]);if(args.length<2||args.length>4)throw Error('Invalid field argument count')
  const name=literal(args[0]),type=literal(args[1]);if(typeof name!=='string'||!name.trim()||typeof type!=='string'||!['int','string','double','bool'].includes(type))throw Error('Invalid field name or type')
  if(result.some(f=>f.name===name))throw Error('Duplicate field: '+name)
  const defaultValue=args.length>=3?literal(args[2]):null,required=booleanOption(options(args[3],['required']),'required',args.length===2)
  if(defaultValue!==null&&(type==='string'?typeof defaultValue!=='string':type==='bool'?typeof defaultValue!=='boolean':typeof defaultValue!=='number'||(type==='int'&&!Number.isInteger(defaultValue))))throw Error('Field default does not match type: '+name)
  result.push({name,type,required,defaultValue})
 }
 return result
}
type Signature={name:string;params:string[];paramTypes:string[];typed:boolean;valid:boolean;runtime:string;length:number;line:number;column:number}
function signature(text:string,line:number):Signature|null{
 const m=new RegExp(`^function\\s+(${ident})\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{}]+?))?\\s*\\{`).exec(text);if(!m)return null
 const params=m[2].trim()?m[2].split(',').map(x=>x.trim()):[],names:string[]=[],paramTypes:string[]=[];let valid=true,typed=!!m[3]
 for(const param of params){const p=new RegExp(`^(${ident})\\s*:\\s*(${typeName})$`).exec(param);if(p){names.push(p[1]);paramTypes.push(p[2]);typed=true}else{names.push(param);paramTypes.push('');valid=false}}
 if(!m[3]||!new RegExp(`^${typeName}$`).test(m[3].trim()))valid=false
 return {name:m[1],params:names,paramTypes,typed,valid,runtime:`function ${m[1]}(${names.join(', ')}) {`,length:m[0].length,line,column:0}
}
/** Author-only front end: typed signatures stay in the editor, and are erased only for runtime. */
export function transformDialect(source:string,mode:'runtime'|'editor'='runtime',_eventType?:string|((hook:string)=>string)){
 const lines=source.split('\n'),masked=codeMask(source).split('\n'),runtime=[...lines],editor=[...lines],hooks:Hook[]=[],diagnostics:DialectDiagnostic[]=[],imports:string[]=[],aliases=new Map<string,string>(),signatures:Signature[]=[]
 let depth=0,business=false,phase=0,goal:GoalMetadata|null=null
 const error=(line:number,message:string)=>diagnostics.push({line,message})
 const comment=(raw:string)=>raw.slice(0,raw.indexOf(raw.trimStart()))+'//'+raw.trimStart()
 const nextFunction=(index:number)=>{const s=signature((lines[index+1]??'').trimStart(),index+2);if(!s||!s.valid||s.params.length!==2)throw Error('Annotation requires the next line to be a named typed function with two parameters');return s}
 for(let index=0;index<lines.length;index++){
  const raw=lines[index],code=masked[index]??'',trimmed=raw.trim(),line=index+1,top=depth===0
  try{
   if(phase>0&&phase<3&&!code.trim()&&trimmed&&!trimmed.startsWith('//'))throw Error('Only blank lines and // comments may separate goal/config/state')
   if(/^\s*(?:import|require)\b(?!\s*:)/.test(code)){
    if(!top||phase>0)throw Error('Imports must precede the goal metadata block')
    const m=declaration.exec(trimmed);if(!m)throw Error('Expected one-line import/require Ident from literal')
    const [,kind,binding,,id]=m;if(kind==='import'?!fqcn.test(id):!id.trim()||!commonId.test(id))throw Error('Invalid Java FQCN or common script id')
    runtime[index]=raw.slice(0,raw.indexOf(raw.trimStart()))+`var ${binding} = ${kind==='import'?'Java.type':'__require'}(${JSON.stringify(id)});`+(raw.endsWith('\r')?'\r':'')
    editor[index]=runtime[index]
    if(kind==='import'){imports.push(id);aliases.set(binding,id);const module='jvm_'+id.replaceAll('_','__').replaceAll('.','_d_').replaceAll('$','_s_'),symbol=id.split(/[.$]/).at(-1)!
     editor[index]=runtime[index].replace(/\r?$/,` type ${binding} = ${module}.${symbol};`+(raw.endsWith('\r')?'\r':''))}
   }else if(/^\s*@/.test(code)){
    if(!top)throw Error('Annotations must be at file scope')
    const m=/^@(hook|goal|config|state|subscribe)\s*\((.*)\)\s*;?\s*$/.exec(withoutLineComment(trimmed));if(!m)throw Error('Unknown or multiline annotation')
    const [,kind,body]=m
    if(phase>0&&phase<3&&kind!==(phase===1?'config':'state'))throw Error('Expected @goal → @config → @state in one block')
    if(kind==='goal'){
     if(phase!==0||business||hooks.length)throw Error('@goal must appear once after the prologue and before business code')
     const args=split(body);if(args.length!==1)throw Error('Invalid @goal arguments');const id=literal(args[0]);if(typeof id!=='string'||!id.trim())throw Error('Goal id must be a nonempty string')
     goal={id,line,configLine:0,stateLine:0,config:[],state:[],handlers:[]};phase=1
    }else if(kind==='config'||kind==='state'){
     if(!goal||phase!==(kind==='config'?1:2))throw Error('Expected @goal → @config → @state in one block')
     goal[kind]=fields(body);if(kind==='config'){goal.configLine=line;phase=2}else{goal.stateLine=line;phase=3}
    }else if(kind==='hook'){
     if(goal)throw Error('@hook is not allowed in a goal file')
     const args=split(body);if(args.length<1||args.length>2)throw Error('Invalid @hook arguments');const name=literal(args[0]);if(typeof name!=='string'||!name)throw Error('Hook id must be a nonempty string')
     const fn=nextFunction(index),o=options(args[1],['cancellable','priority','receiveCancelled']),priority=o.priority===undefined?'NORMAL':o.priority;if(typeof priority!=='string'||!priorities.includes(priority))throw Error('Invalid event priority')
     const cancellable=o.cancellable===null||o.cancellable===undefined?null:booleanOption(o,'cancellable',false)
     if(hooks.some(h=>h.function===fn.name))throw Error('Duplicate hook function')
     hooks.push({hook:name,function:fn.name,line,functionLine:fn.line,eventType:fn.paramTypes[0]??'',cancellable,priority,receiveCancelled:booleanOption(o,'receiveCancelled',false)});business=true
    }else{
     if(!goal||phase!==3)throw Error('@subscribe requires a complete goal metadata block')
     const args=split(body);if(args.length<1||args.length>2||!aliases.has(args[0]))throw Error('@subscribe requires an imported Java event alias')
     const fn=nextFunction(index),o=options(args[1],['priority','receiveCancelled']),priority=o.priority===undefined?'NORMAL':o.priority;if(typeof priority!=='string'||!priorities.includes(priority))throw Error('Invalid event priority')
     if(goal.handlers.some(h=>h.function===fn.name))throw Error('Duplicate subscription function')
     goal.handlers.push({event:aliases.get(args[0])!,function:fn.name,line,priority,receiveCancelled:booleanOption(o,'receiveCancelled',false)});business=true
    }
    runtime[index]=editor[index]=comment(raw)
   }else{
    if(phase>0&&phase<3&&code.trim())throw Error('Expected a continuous @goal → @config → @state block')
    if(code.trim())business=true
    for(const token of code.matchAll(/\b(?:import|require|load|loadWithNewGlobal|field)\b/g)){
     const before=code.slice(0,token.index).trimEnd(),after=code.slice(token.index!+token[0].length).trimStart()
     if(before.endsWith('.')||after.startsWith(':'))continue
     if(token[0]==='field'&&!after.startsWith('('))continue
     throw Error('Unsupported module/loading/field call outside its dialect declaration')
    }
    if(code.includes('@'))throw Error('Unknown annotation')
    // Named functions at brace depth zero are candidates. The ES5 AST below distinguishes
    // declarations from named expressions; only declarations require author signatures.
    let localDepth=depth;const replacements:{start:number;end:number;text:string}[]=[]
    for(let at=0;at<code.length;at++){
     if(localDepth===0&&code.slice(at).match(/^function\b/) && (at===0||!/[\w$]/.test(code[at-1]))){
      const fn=signature(raw.slice(at),line);if(fn){fn.column=at+replacements.reduce((delta,r)=>delta+r.text.length-(r.end-r.start),0);signatures.push(fn);if(fn.typed){replacements.push({start:at,end:at+fn.length,text:fn.runtime})} }
     }
     if(code[at]==='{')localDepth++;else if(code[at]==='}')localDepth--
    }
    for(const r of replacements.reverse())runtime[index]=runtime[index].slice(0,r.start)+r.text+runtime[index].slice(r.end)
   }
  }catch(cause){error(line,cause instanceof Error?cause.message:String(cause))}
  depth+=(code.match(/\{/g)?.length??0)-(code.match(/\}/g)?.length??0)
 }
 const transformed=runtime.join('\n'),functions=new Map<string,Signature>(),declarations=new Set<Signature>()
 try{
  const ast=parse(transformed,{ecmaVersion:5,sourceType:'script',locations:true}) as unknown as {body:{type:string;id?:{name:string};loc:{start:{line:number;column:number}}}[]}
  for(const node of ast.body)if(node.type==='FunctionDeclaration'){
   const fn=signatures.find(s=>s.name===node.id?.name&&s.line===node.loc.start.line&&s.column===node.loc.start.column)
   if(!fn||!fn.valid)error(node.loc.start.line,'Every top-level function parameter and return value requires a single-line type signature')
   else {functions.set(fn.name,fn);declarations.add(fn)}
  }
  for(const fn of signatures)if(fn.typed&&!declarations.has(fn))error(fn.line,'Types are supported only on top-level function declarations')
 }catch(cause){const e=cause as {loc?:{line:number};message:string};error(e.loc?.line??1,`Nashorn ES5: ${e.message}`)}
 if(goal){
  if(phase!==3)error(goal.line,'Goal requires @goal, @config and @state in order')
  if(!goal.handlers.length)error(goal.line,'Goal requires at least one @subscribe handler')
  for(const [name,count] of [['update_state',1],['localize',2],['deliver',2]] as const){const fn=functions.get(name);if(name==='update_state'&&!fn)error(goal.line,'Goal requires update_state(instance)');if(fn&&fn.params.length!==count)error(fn.line,`${name} requires ${count} parameters`)}
 }
 return {source:mode==='editor'?editor.join('\n'):transformed,hooks,goal,diagnostics,imports:[...new Set(imports)],aliases:Object.fromEntries(aliases)}
}
