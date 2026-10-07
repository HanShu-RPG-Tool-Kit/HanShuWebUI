import { registerFileCompiler, registerPackagePass } from '../registry'
import { hanshuCompiler } from './hanshu'
import { identityCompiler } from './identity'
import { localeAssetsPass } from './localeAssets'

let registered = false

/** 幂等：内置编译器 / 包级 pass 只挂一次 */
export function ensureBuiltinCompilers(): void {
  if (registered) return
  registered = true
  // identity 放前面；hanshu 用 match 抢 `.hs`（先匹配先生效）
  registerFileCompiler(hanshuCompiler)
  registerFileCompiler(identityCompiler)
  registerPackagePass(localeAssetsPass)
}
