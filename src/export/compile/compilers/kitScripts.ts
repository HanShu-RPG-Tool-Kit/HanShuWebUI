import type {FileCompiler} from '../types'
import {parseKit,hasKitScript,kitScriptRefs} from '../../../workspaces/gameplay/kit'
export const kitCompiler:FileCompiler={
 id:'kit',match:file=>file.name.toLowerCase().endsWith('.kit'),
 async compile(file,ctx){
  let kit: ReturnType<typeof parseKit>
  try { kit = parseKit(file.content) }
  catch (error) {
   ctx.report({ severity: 'error', code: 'kit_invalid', sourcePath: file.name,
    message: error instanceof Error ? error.message : String(error) })
   return []
  }
  if(typeof kit.script==='string'&&hasKitScript(kit.script))ctx.report({severity:'error',code:'kit_inline_script',sourcePath:file.name,message:'请先将礼包内嵌代码提取为礼包脚本'})
  for(const ref of kitScriptRefs(kit.script))
  if(ref&&!ctx.index.package.scripts.some(s=>s.srcKind==='kit'&&s.name.slice(0,-3)===ref))ctx.report({severity:'error',code:'kit_script_missing',sourcePath:file.name,message:`缺少礼包脚本：${ref}`})
  return [{path:`gift/${file.name}`,bytes:file.content,plane:'server',packageName:ctx.index.package.name,sourcePath:file.name}]
 }
}
