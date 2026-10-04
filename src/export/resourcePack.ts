import JSZip from 'jszip'
import { getAssetBlob } from '../assets/idb'
import { LOCALE_KEY_TEXT_RE } from '../i18n/textMap'
import { isVoiceRefPath, voiceAssetExtension } from '../i18n/voiceMap'
import {
  compileHsToHsc,
  hscAssetName,
} from '../hanshu/compiler'
import {
  isHanshuFile,
  sourceRelativePath,
  SOURCE_KIND_ORDER,
  type Workspace,
} from '../workspace'

export type ExportWarning = string

export type ExportResult = {
  blob: Blob
  fileCount: number
  warnings: ExportWarning[]
}

type HashMap = Record<string, string>

function parseHashMap(raw: string, fileName: string, warnings: string[]): HashMap {
  if (!raw.trim()) return {}
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      warnings.push(`${fileName}: 根节点必须是对象`)
      return {}
    }
    const out: HashMap = {}
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') {
        out[k] = v
      } else {
        warnings.push(`${fileName}: 键 ${k} 的值须为字符串，已跳过`)
      }
    }
    return out
  } catch {
    warnings.push(`${fileName}: JSON 解析失败`)
    return {}
  }
}

/** `assets/<locale>/lang_<ext>/…/名.lang` → `<locale>`；不合布局返回 null */
function parseTextAssetLocale(name: string): string | null {
  const parts = name.trim().replace(/\\/g, '/').split('/')
  if (parts.length < 4) return null
  if (parts[0]?.toLowerCase() !== 'assets') return null
  if (!/^lang_[a-z0-9]+$/i.test(parts[2] ?? '')) return null
  return parts[1]!.toLowerCase()
}

/**
 * `assets/<locale>/voice_<ext>/…/<键名>.ogg|.ref` → `{ locale, key, kind }`；不合布局返回 null。
 *
 * `.ref`（「引用资产」）也是配音的一种写法，但**导出时它会被落地成对等位置的 `.ogg`** ——
 * 引擎不认识 `.ref`，PAK 里只能有音频。
 */
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

export async function buildResourcePackZip(
  workspace: Workspace,
): Promise<ExportResult> {
  const warnings: ExportWarning[] = []
  const zip = new JSZip()
  let fileCount = 0

  for (const pkg of workspace.packages) {
    let hasLang = false
    let hasVoice = false
    // 这个包的 `.hsc` 真正引用到的键名：lang / voice 只导出被引用到的资源
    const markedKeys = new Set<string>()
    const keyPattern = new RegExp(LOCALE_KEY_TEXT_RE.source, 'gi')

    // —— .hs → .hsc（只导出 .hsc，不带 .hs；不再生成 .lines：键名就在正文里）——
    for (const script of pkg.scripts) {
      if (!isHanshuFile(script.name)) continue
      const hscName = hscAssetName(script.name)
      let hsc: string
      try {
        hsc = compileHsToHsc(script.content)
      } catch (err) {
        warnings.push(
          `[${pkg.name}] ${script.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        continue
      }
      zip.file(`hanshu/${hscName}`, hsc)
      for (const match of hsc.matchAll(keyPattern)) {
        markedKeys.add(match[0].toLowerCase())
      }
      fileCount++
    }

    // —— 其余源文件原样带上：`.char` → character/、`.py` → scripts/ ——
    for (const script of pkg.scripts) {
      const rel = sourceRelativePath(script.name)
      if (!rel.startsWith('src/')) continue
      const kind = rel.split('/')[1] ?? ''
      if (kind === 'hanshu') continue // `.hs` 已经编译成 `.hsc`
      const fileName = rel.slice(`src/${kind}/`.length)
      zip.file(`${kind}/${fileName}`, script.content)
      fileCount++
    }

    // —— 本地化资产：保持 `assets/<locale>/lang_<ext>|voice_<ext>/…` 原布局，
    //      但只导出被 `.hsc` 引用到的键（语言文本按条裁剪，一条不剩就不导出）——
    const seenVoice = new Set<string>()
    /** 要落地成音频的引用：**等所有真文件处理完**再处理（`.ogg` 优先这条规矩导出侧同样成立） */
    const pendingRefs: string[] = []
    for (const asset of pkg.assets) {
      const assetPathInPack = asset.path.replace(/\\/g, '/')

      if (parseTextAssetLocale(asset.path)) {
        const blob = await getAssetBlob(pkg.id, asset.path)
        if (!blob) {
          warnings.push(`[${pkg.name}] IndexedDB 无数据: ${asset.path}`)
          continue
        }
        const map = parseHashMap(await blob.text(), asset.path, warnings)
        const ordered: HashMap = {}
        for (const k of Object.keys(map).sort((a, b) => a.localeCompare(b))) {
          // 只保留被 `.hsc` 引用到的键：未引用的（含写错的无效键）不导出
          if (!markedKeys.has(k.toLowerCase())) continue
          ordered[k] = map[k]
        }
        if (Object.keys(ordered).length === 0) continue
        zip.file(
          assetPathInPack,
          `${JSON.stringify(ordered, null, 2)}\n`,
        )
        fileCount++
        hasLang = true
        continue
      }

      const parsed = parseVoiceAssetKey(asset.path)
      if (!parsed) continue
      if (parsed.kind === 'ref') {
        pendingRefs.push(assetPathInPack)
        continue
      }
      const { locale, key } = parsed
      // 只保留被 `.hsc` 引用到的键（键名就是文件名）
      if (!markedKeys.has(key.toLowerCase())) continue
      const dedupe = `${key}.${locale}`
      if (seenVoice.has(dedupe)) {
        warnings.push(`[${pkg.name}] ${asset.path}: ${dedupe} 重复`)
        continue
      }
      seenVoice.add(dedupe)

      const blob = await getAssetBlob(pkg.id, asset.path)
      if (!blob) {
        warnings.push(`[${pkg.name}] IndexedDB 无数据: ${asset.path}`)
        continue
      }
      zip.file(assetPathInPack, blob)
      fileCount++
      hasVoice = true
    }

    /*
     * 「引用资产」：**落地成对等位置上的真实 ogg**。
     *
     * PAK 是引擎产物，引擎只按对等位置读 `<键名>.ogg` —— 它不认识 `.ref`。
     * 所以引用只存在于创作期：这里把被引用的字节取出来，写到引用自己的位置上（后缀换成 .ogg）。
     *
     * 解析不出来时**直接中止导出**（而不是警告后跳过）：包里少一条配音，进引擎才发现哑了，
     * 那时候已经查不回是哪一步丢的。宁可现在导不出来，也不能导出一个缺配音的包。
     */
    for (const refPathInPack of pendingRefs) {
      const parsed = parseVoiceAssetKey(refPathInPack)!
      const { locale, key } = parsed
      if (!markedKeys.has(key.toLowerCase())) continue
      const dedupe = `${key}.${locale}`
      // 同键已经有真文件（或先处理过的引用）→ `.ogg` 优先，静默让位
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
      // 写到**引用自己的对等位置**上，后缀换成 .ogg；`.ref` 本身不进包
      zip.file(refPathInPack.replace(/\.ref$/i, '.ogg'), blob)
      fileCount++
      hasVoice = true
    }

    // 目录骨架：三类源目录空也占位（顺序来自 SOURCE_KIND_ORDER）
    for (const dir of SOURCE_KIND_ORDER) {
      zip.folder(dir)
    }
    if (!hasLang && !hasVoice) {
      zip.folder('assets')
    }
  }

  if (workspace.packages.length === 0) {
    warnings.push('工作区没有包，导出为空')
  }

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
  })

  return { blob, fileCount, warnings }
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

/** @deprecated */
export function collectLinesPackFiles(_workspace: Workspace) {
  return [] as { path: string; content: string }[]
}
