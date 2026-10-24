import type { LocaleExportRule } from './localization'
import type { FileCompiler, PackagePass } from './types'

const fileCompilers: FileCompiler[] = []
const packagePasses: PackagePass[] = []
const localeExportRules: LocaleExportRule[] = []

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

/** Same id replaces a rule; two different rules cannot silently claim the same extension. */
export function registerLocaleExportRule(rule: LocaleExportRule): void {
  const ext = rule.sourceExt.toLowerCase()
  if (!rule.id.trim() || !/^[a-z0-9]+$/.test(ext)) throw new Error('Invalid locale export rule id/sourceExt')
  if (!rule.text && !rule.voice) throw new Error('A locale export rule needs text or voice policy')
  for (const policy of [rule.text, rule.voice]) {
    if (!policy) continue
    const validPlane = ['client', 'server', 'shared'].includes(policy.plane)
    const validKeys = ['all', 'referenced'].includes(policy.keys)
    const validCase = policy.keyCase === undefined || ['sensitive', 'insensitive'].includes(policy.keyCase)
    if (!validPlane || !validKeys || !validCase) {
      throw new Error('Invalid locale asset export policy')
    }
  }
  if (localeExportRules.some((entry) => entry.id !== rule.id && entry.sourceExt === ext)) {
    throw new Error(`Locale export source extension already registered: ${ext}`)
  }
  const entry = Object.freeze({
    ...rule,
    sourceExt: ext,
    text: rule.text ? Object.freeze({ ...rule.text }) : undefined,
    voice: rule.voice ? Object.freeze({ ...rule.voice }) : undefined,
  })
  const index = localeExportRules.findIndex((entry) => entry.id === rule.id)
  if (index >= 0) localeExportRules[index] = entry
  else localeExportRules.push(entry)
}

export function listLocaleExportRules(): readonly LocaleExportRule[] {
  return localeExportRules.slice()
}

/** 测试或热重载用：清空注册表 */
export function clearCompileRegistry(): void {
  fileCompilers.length = 0
  packagePasses.length = 0
  localeExportRules.length = 0
}
