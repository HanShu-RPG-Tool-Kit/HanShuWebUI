import type { AssetFile, Project, SourceFile, Workspace } from '../../workspace'

/** PAK 平面：产物落哪个包 */
export type Plane = 'client' | 'server' | 'shared'

/** 跨文件接线用的符号 */
export type SymbolRef = {
  kind: string
  id: string
  /** 弃用时 LinkChecker 报 deprecation */
  deprecated?: boolean
}

export type CompileDiagnostic = {
  severity: 'error' | 'warning' | 'deprecation'
  code: string
  message: string
  sourcePath?: string
  packageName?: string
}

export type CompileArtifact = {
  /** pak 内相对路径 */
  path: string
  bytes: Uint8Array | string
  plane: Plane
  packageName: string
  sourcePath?: string
  provides?: SymbolRef[]
  requires?: SymbolRef[]
}

export type CompileIndex = {
  workspace: Workspace
  package: Project
  scriptsByName: Map<string, SourceFile>
  assetsByPath: Map<string, AssetFile>
}

export type CompileContext = {
  index: CompileIndex
  report(d: CompileDiagnostic): void
}

/** 单文件编译器 */
export type FileCompiler = {
  id: string
  match(file: SourceFile, index: CompileIndex): boolean
  compile(file: SourceFile, ctx: CompileContext): Promise<CompileArtifact[]>
}

/**
 * 包级后处理（在全部文件编译器跑完之后）。
 * 用于依赖「其它产物 requires」的资产裁剪，如 lang / voice。
 */
export type PackagePass = {
  id: string
  run(
    prior: CompileArtifact[],
    ctx: CompileContext,
  ): Promise<CompileArtifact[]>
}

export type CompileGraph = {
  artifacts: CompileArtifact[]
  diagnostics: CompileDiagnostic[]
}
