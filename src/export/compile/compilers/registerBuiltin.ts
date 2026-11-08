import {kitCompiler} from './kitScripts'
import {actorCompiler} from './actor'
import {bossbarCompiler} from './bossbar'
import {reputationCompiler} from './reputation'
import {shopCompiler} from './shop'
import {levelArtifactPass, levelCompiler, navigationCompiler} from './level'
import { listLocaleExportRules, registerFileCompiler, registerPackagePass, registerLocaleExportRule } from '../registry'
import type { LocaleExportRule } from '../localization'
import { activeSkinsPass } from './activeSkins'
import { hanshuCompiler } from './hanshu'
import { identityCompiler } from './identity'
import { entityCompiler } from './entity'
import { itemCompiler } from './item'
import { localeAssetsPass } from './localeAssets'
import { regionEffectAssetsPass } from './regionEffectAssets'
import { questCompiler } from './quest'
import { scriptLoadCompiler } from './scriptLoad'
import { questCatalogCompiler } from './questCatalog'
import { displayTextReferences, displayTextRuntimeTranslations, type DisplayTextKind } from '../../../workspaces/gameplay/displayTextLocale'
import { parseItem } from '../../../workspaces/gameplay/itemDoc'
import { parseEntity } from '../../../workspaces/gameplay/entityDoc'

const displayBindings = (kind: DisplayTextKind, content: string) => displayTextReferences(kind, kind === 'item' ? parseItem(content) : parseEntity(content))

const builtinLocaleRules: LocaleExportRule[] = [
  { id: 'hs', sourceExt: 'hs',
    text: { plane: 'client', keys: 'referenced', keyCase: 'insensitive' },
    voice: { plane: 'client', keys: 'referenced', keyCase: 'insensitive' },
  },
  { id: 'char', sourceExt: 'char', text: { plane: 'client', keys: 'all' }, voice: { plane: 'client', keys: 'all' } },
  ...['kit', 'quest', 'level', 'nav', 'shop', 'rep'].map((sourceExt): LocaleExportRule => ({
    id: sourceExt, sourceExt, text: { plane: 'shared', keys: 'all' },
  })),
  ...(['item', 'entity'] as const).map((kind): LocaleExportRule => ({
    id: kind, sourceExt: kind,
    text: {
      plane: 'shared', keys: 'referenced',
      references: owner => displayBindings(kind, owner.source.content).map(binding => binding.semanticKey),
      transformText: (table, owner) => displayTextRuntimeTranslations(displayBindings(kind, owner.source.content), table),
    },
  })),
]

/**
 * 挂上 / 刷新内置编译器与包级 pass：同 id 一律覆盖，避免 Vite HMR 后
 * 仍沿用首次注册的旧 `compile` 闭包（例如旁表字段修过但导出仍写 functionLine）。
 * 本地化规则仍「缺则补」，保留测试/调用方对 builtin id 的显式覆盖。
 */
export function ensureBuiltinCompilers(): void {
  for (const compiler of [hanshuCompiler, itemCompiler, entityCompiler, kitCompiler, shopCompiler, actorCompiler, bossbarCompiler, reputationCompiler, questCompiler, questCatalogCompiler, levelCompiler, navigationCompiler, scriptLoadCompiler, identityCompiler]) {
    registerFileCompiler(compiler)
  }
  for (const pass of [localeAssetsPass, activeSkinsPass, levelArtifactPass, regionEffectAssetsPass]) {
    registerPackagePass(pass)
  }
  for (const rule of builtinLocaleRules) {
    if (!listLocaleExportRules().some((entry) => entry.id === rule.id)) registerLocaleExportRule(rule)
  }
}
