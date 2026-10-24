import type { SourceFile } from '../../workspace'
import type { CompileArtifact, CompileIndex, Plane } from './types'

/** A source must have at least one emitted runtime artifact before its locale assets are exported. */
export type LocaleExportOwner = {
  source: SourceFile
  artifacts: readonly CompileArtifact[]
  index: CompileIndex
}

export type LocaleAssetExportPolicy = Readonly<{
  plane: Plane
  /** all: document-local semantic table; referenced: keep only explicitly used keys. */
  keys: 'all' | 'referenced'
  /** Defaults to localeKey requirements on the owner's compiled artifacts. */
  references?: (owner: LocaleExportOwner) => Iterable<string>
  /** HS hex keys are insensitive; semantic keys default to exact spelling. */
  keyCase?: 'sensitive' | 'insensitive'
}>

export type LocaleExportRule = Readonly<{
  id: string
  /** Source extension without a dot. Paths use i18n/localeLayout, not a second layout convention. */
  sourceExt: string
  text?: LocaleAssetExportPolicy
  voice?: LocaleAssetExportPolicy
}>
