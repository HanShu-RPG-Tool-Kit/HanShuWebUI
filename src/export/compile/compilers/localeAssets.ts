import { getAssetBlob } from '../../../assets/idb'
import { parseLocaleAssetPath, normalizeSourcePath, sourceLogicalPath, sourceExtension } from '../../../i18n/localeLayout'
import { isVoiceRefPath, voiceAssetExtension } from '../../../i18n/voiceMap'
import { listLocaleExportRules } from '../registry'
import type { LocaleAssetExportPolicy, LocaleExportOwner } from '../localization'
import type { CompileArtifact, PackagePass } from '../types'

type TextTable = Record<string, string>
type ResolvedAsset = {
  path: string
  locale: string
  key?: string
  kind: 'text' | 'voice'
  policy: LocaleAssetExportPolicy
  owner: LocaleExportOwner
}

function parseTextTable(raw: string, path: string, warn: (message: string) => void): TextTable {
  try {
    const data: unknown = JSON.parse(raw.trim() || '{}')
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('根节点必须是对象')
    const result: TextTable = {}
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') result[key] = value
      else warn(`${path}: 键 ${key} 的值须为字符串，已跳过`)
    }
    return result
  } catch (error) {
    warn(`${path}: ${error instanceof Error ? error.message : 'JSON 解析失败'}`)
    return {}
  }
}

/** Policy selects content; layout, ownership, blob reads and .ref materialization are shared mechanisms. */
export const localeAssetsPass: PackagePass = {
  id: 'locale-assets',
  async run(prior, ctx) {
    const pkg = ctx.index.package
    const rules = new Map(listLocaleExportRules().map((rule) => [rule.sourceExt, rule]))
    const sourceArtifacts = new Map<string, CompileArtifact[]>()
    for (const artifact of prior) {
      if (!artifact.sourcePath) continue
      const key = normalizeSourcePath(artifact.sourcePath)
      const entries = sourceArtifacts.get(key) ?? []
      entries.push(artifact)
      sourceArtifacts.set(key, entries)
    }
    const owners = new Map<string, LocaleExportOwner>()
    for (const source of pkg.scripts) {
      const artifacts = sourceArtifacts.get(normalizeSourcePath(source.name))
      if (!artifacts?.length || !rules.has(sourceExtension(source.name))) continue
      owners.set(sourceLogicalPath(source.name), { source, artifacts, index: ctx.index })
    }
    const out: CompileArtifact[] = []
    const references = new Map<LocaleExportOwner, Map<LocaleAssetExportPolicy, Set<string>>>()
    const seenVoice = new Set<string>()
    const pendingRefs: ResolvedAsset[] = []
    const warn = (message: string) => ctx.report({
      severity: 'warning', code: 'locale_asset', message, packageName: pkg.name,
    })
    const normalizeKey = (key: string, policy: LocaleAssetExportPolicy) =>
      policy.keyCase === 'insensitive' ? key.toLowerCase() : key
    function keep(key: string, asset: ResolvedAsset): boolean {
      if (asset.policy.keys === 'all') return true
      let policies = references.get(asset.owner)
      if (!policies) { policies = new Map(); references.set(asset.owner, policies) }
      let keys = policies.get(asset.policy)
      if (!keys) {
        const used = asset.policy.references?.(asset.owner) ?? asset.owner.artifacts.flatMap((artifact) =>
          (artifact.requires ?? []).filter((ref) => ref.kind === 'localeKey').map((ref) => ref.id))
        keys = new Set(Array.from(used, (value) => normalizeKey(value, asset.policy)))
        policies.set(asset.policy, keys)
      }
      return keys.has(normalizeKey(key, asset.policy))
    }
    function resolve(path: string): ResolvedAsset | null {
      const parsed = parseLocaleAssetPath(path)
      if (!parsed) return null
      const rule = rules.get(parsed.sourceExt)
      if (!rule) { warn(`${path}: .${parsed.sourceExt} 未注册本地化导出规则，已跳过`); return null }
      const policy = rule[parsed.kind]
      if (!policy) { warn(`${path}: 规则 ${rule.id} 未声明 ${parsed.kind} 导出，已跳过`); return null }
      let stem: string, key: string | undefined
      if (parsed.kind === 'text') {
        if (!/\.lang$/i.test(parsed.rest)) return null
        stem = parsed.rest.replace(/\.lang$/i, '')
      } else {
        if (!/\.(ogg|ref)$/i.test(parsed.rest)) return null
        const slash = parsed.rest.lastIndexOf('/')
        if (slash < 1) { warn(`${path}: 配音路径缺少所属文档目录，已跳过`); return null }
        stem = parsed.rest.slice(0, slash)
        key = parsed.rest.slice(slash + 1).replace(/\.(ogg|ref)$/i, '')
      }
      const owner = owners.get(`${stem}.${parsed.sourceExt}`)
      if (!owner) { warn(`${path}: 找不到已导出的所属源文件，已跳过`); return null }
      return { path: normalizeSourcePath(path), locale: parsed.locale.replace(/-/g, '_').toLowerCase(), kind: parsed.kind, key, policy, owner }
    }
    function localization(asset: ResolvedAsset, keys: string[]) {
      return { sourcePath: asset.owner.source.name, locale: asset.locale, kind: asset.kind,
        keys, keyCase: asset.policy.keyCase ?? 'sensitive' as const }
    }
    function voiceIdentity(asset: ResolvedAsset) {
      return JSON.stringify([asset.locale, asset.owner.source.name, normalizeKey(asset.key!, asset.policy)])
    }
    for (const entry of pkg.assets) {
      const asset = resolve(entry.path)
      if (!asset) continue
      if (asset.kind === 'text') {
        const blob = await getAssetBlob(pkg.id, entry.path)
        if (!blob) { warn(`IndexedDB 无数据: ${entry.path}`); continue }
        const table = parseTextTable(await blob.text(), entry.path, warn)
        const selected: TextTable = {}
        for (const key of Object.keys(table).sort((a, b) => a.localeCompare(b))) {
          if (keep(key, asset)) selected[key] = table[key]!
        }
        const keys = Object.keys(selected)
        const runtimeTable = asset.policy.transformText?.(selected, asset.owner) ?? selected
        if (keys.length) out.push({
          path: asset.path, bytes: `${JSON.stringify(runtimeTable, null, 2)}\n`, plane: asset.policy.plane,
          packageName: pkg.name, sourcePath: entry.path, localization: localization(asset, keys),
        })
      } else {
        if (!keep(asset.key!, asset)) continue
        if (isVoiceRefPath(asset.path)) { pendingRefs.push(asset); continue }
        const identity = voiceIdentity(asset)
        if (seenVoice.has(identity)) { warn(`${entry.path}: 同文档的同语种配音键重复，已跳过`); continue }
        const blob = await getAssetBlob(pkg.id, entry.path)
        if (!blob) { warn(`IndexedDB 无数据: ${entry.path}`); continue }
        seenVoice.add(identity)
        out.push({ path: asset.path, bytes: new Uint8Array(await blob.arrayBuffer()), plane: asset.policy.plane,
          packageName: pkg.name, sourcePath: entry.path, localization: localization(asset, [asset.key!]),
        })
      }
    }
    // Materialize references after direct OGGs so .ogg always wins over a matching .ref.
    for (const asset of pendingRefs) {
      const identity = voiceIdentity(asset)
      if (seenVoice.has(identity)) continue
      const reference = pkg.assets.find((entry) => normalizeSourcePath(entry.path) === asset.path)
      const target = reference?.refTarget
      const hit = target ? pkg.assets.find((entry) => normalizeSourcePath(entry.path) === normalizeSourcePath(target)) : undefined
      if (!target || !hit) throw new Error(`${asset.path} 的引用解析不出来：${target ?? '没有目标路径'}`)
      if (isVoiceRefPath(hit.path)) throw new Error(`${asset.path} 指向了另一个引用（${hit.path}）—— 引用只能指向音频文件`)
      if (voiceAssetExtension(hit.path).toLowerCase() !== 'ogg') throw new Error(`${asset.path} 引用的目标不是 .ogg：${hit.path}`)
      const blob = await getAssetBlob(pkg.id, hit.path)
      if (!blob) throw new Error(`${asset.path} 引用目标在应用内资源里没有数据：${hit.path}`)
      seenVoice.add(identity)
      out.push({ path: asset.path.replace(/\.ref$/i, '.ogg'), bytes: new Uint8Array(await blob.arrayBuffer()),
        plane: asset.policy.plane, packageName: pkg.name, sourcePath: asset.path,
        localization: localization(asset, [asset.key!]),
      })
    }
    return out
  },
}
