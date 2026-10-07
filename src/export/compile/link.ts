import type { CompileArtifact, CompileDiagnostic, Plane, SymbolRef } from './types'

function symKey(ref: SymbolRef): string {
  return `${ref.kind}:${ref.id.toLowerCase()}`
}

function planeOfProvider(
  providers: Map<string, { plane: Plane; deprecated?: boolean; path: string }>,
  key: string,
): Plane | null {
  return providers.get(key)?.plane ?? null
}

/**
 * 全局接线：缺失 / 重复 / 跨平面非法依赖 / 弃用引用。
 * client↔server 直接依赖为 error；两侧都可依赖 shared。
 */
export function linkArtifacts(artifacts: CompileArtifact[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = []
  const providers = new Map<
    string,
    { plane: Plane; deprecated?: boolean; path: string; packageName: string }
  >()

  for (const art of artifacts) {
    for (const p of art.provides ?? []) {
      const key = symKey(p)
      const prev = providers.get(key)
      if (prev) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate_provide',
          message: `符号 ${key} 重复提供：${prev.path} 与 ${art.path}`,
          sourcePath: art.sourcePath ?? art.path,
          packageName: art.packageName,
        })
        continue
      }
      providers.set(key, {
        plane: art.plane,
        deprecated: p.deprecated,
        path: art.path,
        packageName: art.packageName,
      })
    }
  }

  const required = new Set<string>()
  for (const art of artifacts) {
    for (const r of art.requires ?? []) {
      const key = symKey(r)
      required.add(key)
      const hit = providers.get(key)
      if (!hit) {
        // 本地化键缺失：历史行为是仍导出 .hsc，只是包里没有译文/配音 → warning
        const severity = r.kind === 'localeKey' ? 'warning' : 'error'
        diagnostics.push({
          severity,
          code: 'missing_require',
          message: `${art.path} 需要 ${key}，但没有产物提供`,
          sourcePath: art.sourcePath ?? art.path,
          packageName: art.packageName,
        })
        continue
      }
      if (hit.deprecated || r.deprecated) {
        diagnostics.push({
          severity: 'deprecation',
          code: 'deprecated_symbol',
          message: `${art.path} 引用了弃用符号 ${key}`,
          sourcePath: art.sourcePath ?? art.path,
          packageName: art.packageName,
        })
      }
      const providerPlane = planeOfProvider(providers, key)
      if (
        providerPlane &&
        ((art.plane === 'client' && providerPlane === 'server') ||
          (art.plane === 'server' && providerPlane === 'client'))
      ) {
        diagnostics.push({
          severity: 'error',
          code: 'cross_plane',
          message:
            `${art.path}（${art.plane}）依赖 ${key}（${providerPlane}）—— ` +
            'client 与 server 不能直接互引，请升为 shared 契约',
          sourcePath: art.sourcePath ?? art.path,
          packageName: art.packageName,
        })
      }
    }
  }

  for (const [key, info] of providers) {
    if (required.has(key)) continue
    // localeKey 由裁剪逻辑按需提供，未引用是预期（死资源 warning 已在 locale pass 处理）
    if (key.startsWith('localeKey:')) continue
    // hsInject 可为引擎入口，不必被 `:>>` 引用
    if (key.startsWith('hsInject:')) continue
    diagnostics.push({
      severity: 'warning',
      code: 'unused_provide',
      message: `符号 ${key} 已提供但未被引用（${info.path}）`,
      sourcePath: info.path,
      packageName: info.packageName,
    })
  }

  return diagnostics
}

export function hasLinkErrors(diagnostics: CompileDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error')
}
