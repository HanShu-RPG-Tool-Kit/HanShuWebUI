import { registerFileCompiler, registerPackagePass } from '../registry'
import { activeSkinsPass } from './activeSkins'
import { hanshuCompiler } from './hanshu'
import { identityCompiler } from './identity'
import { itemCompiler } from './item'
import { localeAssetsPass } from './localeAssets'

let registered = false

/** 幂等：内置编译器 / 包级 pass 只挂一次 */
export function ensureBuiltinCompilers(): void {
  if (registered) return
  registered = true
  // 专用编译器优先；identity 兜底（buildCompileGraph 会跳过 id=identity 再回退）
  registerFileCompiler(hanshuCompiler)
  registerFileCompiler(itemCompiler)
  registerFileCompiler(identityCompiler)
  registerPackagePass(localeAssetsPass)
  registerPackagePass(activeSkinsPass)
}
