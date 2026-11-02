import {codeMask} from './dialect'
export type JavaClassEntry={name:string;symbol:string;packageName:string;origin:string}
export type ImportPlan={insertAt:number;replaceEnd:number;text:string;binding:string;reused:boolean;preview:string}
export function javaImportReferenceMatches(source:string,start:number,end:number,entry:JavaClassEntry){return !!codeMask(source).slice(start,end).trim()&&(source.slice(start,end)===entry.name||source.slice(start,end)===entry.symbol||entry.symbol.startsWith(source.slice(start,end)))}
export function planJavaImport(source:string,entry:JavaClassEntry,requestedAlias=''):ImportPlan {
 const valid=(s:string)=>/^[A-Za-z_$][\w$]*$/.test(s)&&!new Set('var let const function class new return import require export default if else for while switch break throw try catch true false null this'.split(' ')).has(s)
 if(!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(entry.name))throw Error('Java 类名无效')
 if(requestedAlias&&!valid(requestedAlias))throw Error('别名必须是 JavaScript 标识符')
 const names=new Set(codeMask(source).match(/[A-Za-z_$][\w$]*/g)??[])
 for(const m of source.matchAll(/^\s*import\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/gm))if(m[2]===entry.name&&(!requestedAlias||m[1]===requestedAlias))return {insertAt:0,replaceEnd:0,text:'',binding:m[1],reused:true,preview:m[0].trim()}
 let binding=requestedAlias||entry.symbol
 if(requestedAlias&&names.has(binding))throw Error(`名称 ${binding} 已被占用`)
 if(!valid(binding))binding='JavaClass'
 const base=binding;for(let i=2;names.has(binding);i++)binding=base+i
 const insertAt=source.charCodeAt(0)===0xfeff?1:0,preview=`import ${binding} from ${JSON.stringify(entry.name)}`
 return {insertAt,replaceEnd:insertAt,text:preview+(source.includes('\r\n')?'\r\n':'\n'),binding,reused:false,preview}
}
