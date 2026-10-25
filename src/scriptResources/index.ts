import {SCRIPT_TYPES,scriptType,scriptResourceKey,type ScriptType} from './types'
export * from './types'
export type ScriptResource={type:ScriptType;name:string;source:string}
function collect(modules:Record<string,unknown>):ScriptResource[]{
 return Object.entries(modules).map(([path,source])=>{const parts=path.split('/');if(!SCRIPT_TYPES.includes(parts.at(-2) as ScriptType))throw Error(`未知脚本分类：${path}`);return {type:scriptType(parts.at(-2)),name:parts.at(-1)!,source:String(source).replace(/\r\n/g,'\n')}}).sort((a,b)=>scriptResourceKey(a.type,a.name).localeCompare(scriptResourceKey(b.type,b.name),'en'))
}
export const BUILTIN_SCRIPTS=collect(import.meta.glob('./builtin/*/*.py',{eager:true,query:'?raw',import:'default'}))
export const SCRIPT_TEMPLATES=collect(import.meta.glob('./templates/*/*.py',{eager:true,query:'?raw',import:'default'}))
export function scriptTemplate(type:ScriptType,name='default.py',title='新脚本'):string{
 const template=SCRIPT_TEMPLATES.find(t=>t.type===type&&t.name===name)
 if(!template)throw Error(`未找到脚本模板：${type}/${name}`)
 return template.source.replaceAll('{{name}}',title)
}
/** Same whole-file overlay for authoring catalogs and export. Project files always win. */
export function effectiveBuiltinScripts(project:readonly {name:string;srcKind?:string|null}[]):ScriptResource[]{
 const keys=new Set(project.filter(s=>s.name.toLowerCase().endsWith('.py')).map(s=>scriptResourceKey(scriptType(s.srcKind),s.name)))
 return BUILTIN_SCRIPTS.filter(s=>!keys.has(scriptResourceKey(s.type,s.name)))
}
