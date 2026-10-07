import { LOCALE_KEY_TEXT_RE } from '../../../i18n/textMap'
import { compileHsToHsc, hscAssetName } from '../../../hanshu/compiler'
import {
  collectHsInjectJumps,
  collectHsInjectNames,
} from '../../../hanshu/hsSyntaxRules'
import { isHanshuFile } from '../../../workspace'
import type { FileCompiler, SymbolRef } from '../types'

function dedupeRefs(refs: SymbolRef[]): SymbolRef[] {
  const seen = new Set<string>()
  return refs.filter((r) => {
    const key = `${r.kind}:${r.id.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const hanshuCompiler: FileCompiler = {
  id: 'hanshu',
  match(file) {
    return isHanshuFile(file.name)
  },
  async compile(file, ctx) {
    let hsc: string
    try {
      hsc = compileHsToHsc(file.content)
    } catch (err) {
      // 与历史导出一致：单文件编译失败记警告并跳过，不中止整包
      ctx.report({
        severity: 'warning',
        code: 'hs_compile',
        message: err instanceof Error ? err.message : String(err),
        sourcePath: file.name,
        packageName: ctx.index.package.name,
      })
      return []
    }
    const keyPattern = new RegExp(LOCALE_KEY_TEXT_RE.source, 'gi')
    const localeRequires = [...hsc.matchAll(keyPattern)].map((m) => ({
      kind: 'localeKey',
      id: m[0]!.toLowerCase(),
    }))
    const injectProvides = collectHsInjectNames(file.content).map((name) => ({
      kind: 'hsInject',
      id: name,
    }))
    const injectRequires = collectHsInjectJumps(file.content).map((name) => ({
      kind: 'hsInject',
      id: name,
    }))
    return [
      {
        path: `hanshu/${hscAssetName(file.name)}`,
        bytes: hsc,
        plane: 'client',
        packageName: ctx.index.package.name,
        sourcePath: file.name,
        provides: dedupeRefs(injectProvides),
        requires: dedupeRefs([...localeRequires, ...injectRequires]),
      },
    ]
  },
}
