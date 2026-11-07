import {
  defaultPlaneForFile,
  isHanshuFile,
  isMetaFile,
  sourceKindOf,
  sourcePathOf,
} from '../../../workspace'
import type { FileCompiler } from '../types'
import {pakScriptMetadata,transformDialect} from '../../../monaco/javascript/dialect'

/** 未由专用编译器接手的 `src/` 源文件：原样写入对应 kind 目录（`.js` → script/<类型>/） */
export const identityCompiler: FileCompiler = {
  id: 'identity',
  match(file) {
    if (isHanshuFile(file.name)) return false
    if (isMetaFile(file.name)) return false
    const kind = sourceKindOf(file.name, file.srcKind)
    return kind !== 'meta' && kind !== 'root'
  },
  async compile(file, ctx) {
    const rel = sourcePathOf(file)
    // `src/<kind>/…` → pak 内 `<kind>/…`
    const path = file.srcKind === 'goal' ? `goal_scripts/${file.name}` : rel.startsWith('src/') ? rel.slice('src/'.length) : rel
    if (file.name.toLowerCase().endsWith('.js')) {
      const result=transformDialect(file.content)
      if(file.srcKind==='goal'&&!result.goal)result.diagnostics.push({line:1,message:'目标定义必须声明 @goal / @config / @state 文件级元数据块'})
      if(file.srcKind!=='goal'&&result.goal)result.diagnostics.push({line:result.goal.line,message:'Goal 元数据只允许出现在目标定义脚本中'})
      for(const diagnostic of result.diagnostics)ctx.report({severity:'error',code:'javascript_dialect',sourcePath:file.name,message:`第 ${diagnostic.line} 行：${diagnostic.message}`})
      if(result.diagnostics.length)return []
      const common={plane:defaultPlaneForFile(file.name),packageName:ctx.index.package.name,sourcePath:file.name}
      return [
        {path,bytes:result.source,...common,...(file.srcKind==='goal'?{provides:[{kind:'goalDefFile' as const,id:file.name.slice(0,-3).toLowerCase()}]}:{})},
        {path:path.slice(0,-3)+'.hooks.json',bytes:JSON.stringify(pakScriptMetadata(result.hooks,result.goal)),...common},
      ]
    }
    return [
      {
        path,
        bytes: file.content,
        plane: defaultPlaneForFile(file.name),
        packageName: ctx.index.package.name,
        sourcePath: file.name,
        ...(file.srcKind === 'goal'
          ? {
              provides: [
                {
                  kind: 'goalDefFile',
                  id: file.name.replace(/\.js$/i, '').toLowerCase(),
                },
              ],
            }
          : {}),
      },
    ]
  },
}
