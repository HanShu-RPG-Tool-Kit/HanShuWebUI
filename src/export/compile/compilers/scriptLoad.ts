import { defaultPlaneForFile, sourcePathOf } from '../../../workspace'
import {
  isScriptLoadFileName,
  isScriptLoadType,
  parseScriptLoad,
  scriptLoadCandidateIds,
  type ScriptLoadType,
} from '../../../workspaces/gameplay/scriptLoad'
import type { FileCompiler } from '../types'

export const scriptLoadCompiler: FileCompiler = {
  id: 'script-load',
  match(file) {
    return isScriptLoadFileName(file.name) && isScriptLoadType(file.srcKind)
  },
  async compile(file, ctx) {
    const type = file.srcKind as ScriptLoadType
    let doc: ReturnType<typeof parseScriptLoad>
    try {
      doc = parseScriptLoad(file.content)
    } catch (error) {
      ctx.report({
        severity: 'error',
        code: 'script_load_invalid',
        sourcePath: sourcePathOf(file),
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }
    const ids = scriptLoadCandidateIds(type, ctx.index.package.scripts)
    for (const id of doc.scripts) {
      if (!ids.has(id)) {
        ctx.report({
          severity: 'warning',
          code: 'script_load_missing',
          sourcePath: sourcePathOf(file),
          message: `启动列表缺少脚本：${id}（src/script/${type}/${id}.js）`,
        })
      }
    }
    const rel = sourcePathOf(file)
    return [{
      path: rel.startsWith('src/') ? rel.slice('src/'.length) : rel,
      bytes: file.content,
      plane: defaultPlaneForFile(file.name),
      packageName: ctx.index.package.name,
      sourcePath: file.name,
    }]
  },
}
