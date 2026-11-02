import {transformDialect} from './dialect'
export type JavaStub={name:string;module:string;symbol:string;source:string;dependencies:string[]}
export type StubResponse={schemaVersion:1;runtimeId:string;classes:JavaStub[];missing:string[]}
export const javaModule=(name:string)=>`jvm_${name.replaceAll('_','__').replaceAll('.','_d_').replaceAll('$','_s_')}`
export const javaSymbol=(name:string)=>name.split(/[.$]/).at(-1)!
export const importedJavaClasses=(source:string)=>transformDialect(source).imports
export const BASE_TYPES=`interface JavaTypeMap {}\ndeclare const Java: {type<K extends keyof JavaTypeMap>(name:K):JavaTypeMap[K];type(name:string):any};\ndeclare function print(...values:any[]):void;\n`
export function buildJavaFiles(stubs:Iterable<JavaStub>):Record<string,string>{
 const all=[...stubs],known=new Set(all.map(s=>s.name)),files:Record<string,string>={'/java/base.d.ts':BASE_TYPES}
 for(const stub of all){files[`/java/${stub.module}.d.ts`]=stub.source;for(const name of stub.dependencies)if(!known.has(name))files[`/java/${javaModule(name)}.d.ts`]=`declare namespace ${javaModule(name)} { class ${javaSymbol(name)} {} }`}
 return files
}
