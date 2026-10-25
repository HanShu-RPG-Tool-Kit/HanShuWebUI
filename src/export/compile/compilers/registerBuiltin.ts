import {kitCompiler} from './kitScripts'
import { listFileCompilers, listPackagePasses, listLocaleExportRules, registerFileCompiler, registerPackagePass, registerLocaleExportRule } from '../registry'
import type { LocaleExportRule } from '../localization'
import { activeSkinsPass } from './activeSkins'
import { hanshuCompiler } from './hanshu'
import { identityCompiler } from './identity'
import { entityCompiler } from './entity'
import { itemCompiler } from './item'
import { localeAssetsPass } from './localeAssets'

const builtinLocaleRules: LocaleExportRule[] = [
  { id: 'hs', sourceExt: 'hs',
    text: { plane: 'client', keys: 'referenced', keyCase: 'insensitive' },
    voice: { plane: 'client', keys: 'referenced', keyCase: 'insensitive' },
  },
  { id: 'char', sourceExt: 'char', text: { plane: 'client', keys: 'all' }, voice: { plane: 'client', keys: 'all' } },
  ...['kit', 'progress', 'hflow', 'nav'].map((sourceExt): LocaleExportRule => ({
    id: sourceExt, sourceExt, text: { plane: 'shared', keys: 'all' },
  })),
]

/** Idempotent by id; also reinstalls builtins after clearCompileRegistry without replacing overrides. */
export function ensureBuiltinCompilers(): void {
  for (const compiler of [hanshuCompiler, itemCompiler, entityCompiler, kitCompiler, identityCompiler]) {
    if (!listFileCompilers().some((entry) => entry.id === compiler.id)) registerFileCompiler(compiler)
  }
  for (const pass of [localeAssetsPass, activeSkinsPass]) {
    if (!listPackagePasses().some((entry) => entry.id === pass.id)) registerPackagePass(pass)
  }
  for (const rule of builtinLocaleRules) {
    if (!listLocaleExportRules().some((entry) => entry.id === rule.id)) registerLocaleExportRule(rule)
  }
}
