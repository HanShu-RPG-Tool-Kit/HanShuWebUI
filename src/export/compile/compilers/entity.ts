import {parseEntity,stringifyEntity,runtimeEntity} from '../../../workspaces/quest/entityDoc'
import {sourcePathOf} from '../../../workspace'
import type {FileCompiler} from '../types'
import {displayTextReferences} from '../../../workspaces/quest/displayTextLocale'
export const entityCompiler:FileCompiler={id:'entity',match:file=>file.name.toLowerCase().endsWith('.entity'),async compile(file,ctx){try{
 const doc=parseEntity(file.content),path=sourcePathOf(file).replace(/^src\//,'')
 if(!/^entities\/[^/\\:]+\.entity$/i.test(path))throw Error('实体模板需要扁平文件名')
 const bindings=displayTextReferences('entity',doc)
 return [{path,bytes:stringifyEntity(runtimeEntity(doc)),plane:'server',packageName:ctx.index.package.name,sourcePath:file.name,requires:bindings.map(binding=>({kind:'localeKey',id:binding.semanticKey})),provides:[...new Set(bindings.map(binding=>binding.runtimeKey))].map(id=>({kind:'displayTextKey',id}))}]
}catch(e){ctx.report({severity:'error',code:'entity_compile',message:String(e),sourcePath:file.name,packageName:ctx.index.package.name});return []}}}
