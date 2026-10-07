import type { FileCompiler, PackagePass } from './types'

const fileCompilers: FileCompiler[] = []
const packagePasses: PackagePass[] = []

export function registerFileCompiler(compiler: FileCompiler): void {
  const i = fileCompilers.findIndex((c) => c.id === compiler.id)
  if (i >= 0) fileCompilers[i] = compiler
  else fileCompilers.push(compiler)
}

export function registerPackagePass(pass: PackagePass): void {
  const i = packagePasses.findIndex((c) => c.id === pass.id)
  if (i >= 0) packagePasses[i] = pass
  else packagePasses.push(pass)
}

export function listFileCompilers(): readonly FileCompiler[] {
  return fileCompilers
}

export function listPackagePasses(): readonly PackagePass[] {
  return packagePasses
}

/** 测试或热重载用：清空注册表 */
export function clearCompileRegistry(): void {
  fileCompilers.length = 0
  packagePasses.length = 0
}
