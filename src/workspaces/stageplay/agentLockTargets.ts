/**
 * Agent 锁 → UI 目标的纯映射（阶段 1-D2 的「锁只对被锁的文件生效」）。
 *
 * 视图的 `lockedPaths` 同时装着两类路径：
 * - 源文件逻辑名（`lock_source`，如 `序章.hs`）；
 * - 工程相对资产路径（`lock_lang`，如 `assets/zh_cn/lang_hs/序章.lang`）。
 *
 * UI 需要三种不同口径，混用会 over-block（阶段 1-C 的教训）：
 * 1. `sourceNames`：源文件锁 → 只让源编辑器只读；
 * 2. `assetPaths`：资产锁 → 只让该资产（`.lang`）只读；
 * 3. `autoKeyBlockedSources`：自动成键抑制 = 源文件锁 + 派生 `.lang` 锁所属的源文件
 *    （lang 锁期间源正文仍可编辑，只是不能再自动成键）。
 *
 * 这里是纯函数：不碰 React / 工作区，`scripts/verify-agent-lock-targets.ts` 可直接测。
 */

import {
  normalizeSourcePath,
  parseLocaleAssetPath,
  TEXT_ASSET_EXTENSION,
} from '../../i18n/localeLayout'

/** `.lang` 资产路径 → 所属源文件的逻辑名；其它资产 / 非法布局返回 null */
export function sourceNameFromLangAssetPath(path: string): string | null {
  const parsed = parseLocaleAssetPath(path)
  if (!parsed || parsed.kind !== 'text') return null
  const suffix = `.${TEXT_ASSET_EXTENSION}`
  if (!parsed.rest.toLowerCase().endsWith(suffix)) return null
  const stem = parsed.rest.slice(0, -suffix.length)
  return stem ? `${stem}.${parsed.sourceExt}` : null
}

export type AgentLockTargets = {
  /** 源文件锁（`lock_source`）：只用于源编辑器只读 */
  sourceNames: Set<string>
  /** 资产锁路径（`lock_lang` 的 `.lang` 等）：只用于该资产只读 */
  assetPaths: Set<string>
  /** 自动成键抑制：源文件锁 + 派生 `.lang` 锁所属的源文件 */
  autoKeyBlockedSources: Set<string>
}

/**
 * 拆分 `AgentRuntimeView.lockedPaths`。
 *
 * `resolveSourceName` 由工作区提供，用来把模型可能传的 `src/…` 路径或跨包同名解析到
 * 实际脚本名；解析失败/歧义时退回原样，保证精确匹配的文件仍会被挡住。
 */
export function splitAgentLockPaths(
  paths: readonly string[],
  resolveSourceName?: (candidate: string) => string | null,
): AgentLockTargets {
  const sourceNames = new Set<string>()
  const assetPaths = new Set<string>()
  const autoKeyBlockedSources = new Set<string>()

  const rememberSource = (candidate: string) => {
    let resolved = candidate
    if (resolveSourceName) {
      try {
        resolved = resolveSourceName(candidate) ?? candidate
      } catch {
        // 同名跨包等歧义：退回原样，至少精确匹配的文件仍会只读
      }
    }
    sourceNames.add(resolved)
    autoKeyBlockedSources.add(resolved)
  }

  for (const raw of paths) {
    const path = normalizeSourcePath(raw)
    if (!path) continue
    if (path.startsWith('assets/')) {
      assetPaths.add(path)
      // 只有语言文本锁才映射回源文件（语音等资产没有「源正文自动成键」概念）
      const sourceName = sourceNameFromLangAssetPath(path)
      if (sourceName) autoKeyBlockedSources.add(sourceName)
      continue
    }
    rememberSource(path)
  }

  return { sourceNames, assetPaths, autoKeyBlockedSources }
}

/** 资产是否被锁（调用方路径可能是未规范化的相对路径，按规范化后的路径比） */
export function isLockedAssetPath(
  lockedAssetPaths: ReadonlySet<string>,
  path: string,
): boolean {
  if (lockedAssetPaths.has(path)) return true
  const normalized = normalizeSourcePath(path)
  return Boolean(normalized && lockedAssetPaths.has(normalized))
}

/** 目录内（含子目录）是否有被锁资产：删除目录会连带删除被锁的语言文件 */
export function folderHasLockedAsset(
  lockedAssetPaths: ReadonlySet<string>,
  folderPath: string,
): boolean {
  const folder = normalizeSourcePath(folderPath)
  if (!folder) return false
  const prefix = `${folder.replace(/\/+$/, '')}/`
  for (const locked of lockedAssetPaths) {
    if (locked === folder || locked.startsWith(prefix)) return true
  }
  return false
}
