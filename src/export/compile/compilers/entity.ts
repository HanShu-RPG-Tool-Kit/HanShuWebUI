import {parseEntity,stringifyEntity} from '../../../workspaces/progress/entityDoc'
import {sourcePathOf} from '../../../workspace'
import type {FileCompiler} from '../types'
export const entityCompiler:FileCompiler={id:'entity',match:file=>file.name.toLowerCase().endsWith('.entity'),async compile(file,ctx){try{
 const doc=parseEntity(file.content),path=sourcePathOf(file).replace(/^src\//,'')
 if(!/^entities\/[^/\\:]+\.entity$/i.test(path))throw Error('实体模板需要扁平文件名')
 return [{path,bytes:stringifyEntity(doc),plane:'server',packageName:ctx.index.package.name,sourcePath:file.name}]
}catch(e){ctx.report({severity:'error',code:'entity_compile',message:String(e),sourcePath:file.name,packageName:ctx.index.package.name});return []}}}
