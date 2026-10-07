import { getAssetBlob } from '../../../assets/idb'
import { isVoiceRefPath, voiceAssetExtension } from '../../../i18n/voiceMap'
import type { CompileArtifact, PackagePass } from '../types'

type HashMap = Record<string, string>

function parseHashMap(
  raw: string,
  fileName: string,
  report: (msg: string) => void,
): HashMap {
  if (!raw.trim()) return {}
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      report(`${fileName}: 根节点必须是对象`)
      return {}
    }
    const out: HashMap = {}
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') out[k] = v
      else report(`${fileName}: 键 ${k} 的值须为字符串，已跳过`)
    }
    return out
  } catch {
    report(`${fileName}: JSON 解析失败`)
    return {}
  }
}

function parseTextAssetLocale(name: string): string | null {
  const parts = name.trim().replace(/\\/g, '/').split('/')
  if (parts.length < 4) return null
  if (parts[0]?.toLowerCase() !== 'assets') return null
  if (!/^lang_[a-z0-9]+$/i.test(parts[2] ?? '')) return null
  return parts[1]!.toLowerCase()
}

function parseVoiceAssetKey(
  path: string,
): { locale: string; key: string; kind: 'file' | 'ref' } | null {
  const parts = path.trim().replace(/\\/g, '/').split('/')
  if (parts.length < 4) return null
  if (parts[0]?.toLowerCase() !== 'assets') return null
  if (!/^voice_[a-z0-9]+$/i.test(parts[2] ?? '')) return null
  const file = parts[parts.length - 1] ?? ''
  const locale = parts[1]!.toLowerCase()
  if (/\.ref$/i.test(file)) {
    return { locale, key: file.replace(/\.ref$/i, ''), kind: 'ref' }
  }
  if (!/\.ogg$/i.test(file)) return null
  return { locale, key: file.replace(/\.ogg$/i, ''), kind: 'file' }
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * 按 prior 产物里的 `localeKey` requires 裁剪 lang / 落地 voice。
 * `.ref` 解析失败抛错（与历史 resourcePack 一致）。
 */
export const localeAssetsPass: PackagePass = {
  id: 'locale-assets',
  async run(prior, ctx) {
    const pkg = ctx.index.package
    const markedKeys = new Set<string>()
    for (const art of prior) {
      for (const r of art.requires ?? []) {
        if (r.kind === 'localeKey') markedKeys.add(r.id.toLowerCase())
      }
    }

    const out: CompileArtifact[] = []
    const seenVoice = new Set<string>()
    const pendingRefs: string[] = []
    const warn = (message: string) =>
      ctx.report({
        severity: 'warning',
        code: 'locale_asset',
        message,
        packageName: pkg.name,
      })

    for (const asset of pkg.assets) {
      const assetPathInPack = asset.path.replace(/\\/g, '/')

      if (parseTextAssetLocale(asset.path)) {
        const blob = await getAssetBlob(pkg.id, asset.path)
        if (!blob) {
          warn(`IndexedDB 无数据: ${asset.path}`)
          continue
        }
        const map = parseHashMap(await blob.text(), asset.path, warn)
        const ordered: HashMap = {}
        for (const k of Object.keys(map).sort((a, b) => a.localeCompare(b))) {
          if (!markedKeys.has(k.toLowerCase())) continue
          ordered[k] = map[k]!
        }
        if (Object.keys(ordered).length === 0) continue
        const provides = Object.keys(ordered).map((k) => ({
          kind: 'localeKey',
          id: k.toLowerCase(),
        }))
        out.push({
          path: assetPathInPack,
          bytes: `${JSON.stringify(ordered, null, 2)}\n`,
          plane: 'client',
          packageName: pkg.name,
          sourcePath: asset.path,
          provides,
        })
        continue
      }

      const parsed = parseVoiceAssetKey(asset.path)
      if (!parsed) continue
      if (parsed.kind === 'ref') {
        pendingRefs.push(assetPathInPack)
        continue
      }
      const { locale, key } = parsed
      if (!markedKeys.has(key.toLowerCase())) continue
      const dedupe = `${key}.${locale}`
      if (seenVoice.has(dedupe)) {
        warn(`${asset.path}: ${dedupe} 重复`)
        continue
      }
      seenVoice.add(dedupe)
      const blob = await getAssetBlob(pkg.id, asset.path)
      if (!blob) {
        warn(`IndexedDB 无数据: ${asset.path}`)
        continue
      }
      out.push({
        path: assetPathInPack,
        bytes: await blobToBytes(blob),
        plane: 'client',
        packageName: pkg.name,
        sourcePath: asset.path,
        provides: [{ kind: 'localeKey', id: key.toLowerCase() }],
      })
    }

    for (const refPathInPack of pendingRefs) {
      const parsed = parseVoiceAssetKey(refPathInPack)!
      const { locale, key } = parsed
      if (!markedKeys.has(key.toLowerCase())) continue
      const dedupe = `${key}.${locale}`
      if (seenVoice.has(dedupe)) continue
      seenVoice.add(dedupe)

      const refAsset = pkg.assets.find(
        (item) => item.path.replace(/\\/g, '/') === refPathInPack,
      )
      const target = refAsset?.refTarget ?? null
      const hit = target
        ? pkg.assets.find(
            (item) => item.path.toLowerCase() === target.toLowerCase(),
          )
        : undefined

      if (!target || !hit) {
        throw new Error(
          `${refPathInPack} 的引用解析不出来 —— ` +
            (target
              ? `指向的资产不在这个包里：${target}`
              : '正文里没有可用的路径（应为一行 assets/… 路径）'),
        )
      }
      if (isVoiceRefPath(hit.path)) {
        throw new Error(
          `${refPathInPack} 指向了另一个引用（${hit.path}）—— ` +
            '引用只能指向音频文件',
        )
      }
      if (!hit.path.toLowerCase().endsWith('.ogg')) {
        const ext = voiceAssetExtension(hit.path) || '无后缀'
        throw new Error(
          `${refPathInPack} 引用的目标不是 .ogg（当前是 ${ext}）：` +
            `${hit.path} —— 引擎只认对等位置上的单通道 ogg`,
        )
      }

      const blob = await getAssetBlob(pkg.id, hit.path)
      if (!blob) {
        throw new Error(
          `${refPathInPack} 引用的目标在应用内资源里没有数据：${hit.path}`,
        )
      }
      out.push({
        path: refPathInPack.replace(/\.ref$/i, '.ogg'),
        bytes: await blobToBytes(blob),
        plane: 'client',
        packageName: pkg.name,
        sourcePath: refPathInPack,
        provides: [{ kind: 'localeKey', id: key.toLowerCase() }],
      })
    }

    return out
  },
}
