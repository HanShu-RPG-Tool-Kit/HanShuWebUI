import {
  defaultPlaneForFile,
  isHanshuFile,
  isMetaFile,
  sourceKindOf,
  sourcePathOf,
} from '../../../workspace'
import type { FileCompiler } from '../types'

/** 未由专用编译器接手的 `src/` 源文件：原样写入对应 kind 目录（`.py` → script/ 或 goal/） */
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
    const path = rel.startsWith('src/') ? rel.slice('src/'.length) : rel
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
                  id: file.name.replace(/\.py$/i, '').toLowerCase(),
                },
              ],
            }
          : {}),
      },
    ]
  },
}
