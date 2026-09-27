import JSZip from 'jszip'
import { getAssetBlob } from '../assets/idb'
import {
  compileHsToHsc,
  hscFileNameForHs,
} from '../hanshu/compiler'
import { isHanshuFile, type Workspace } from '../workspace'

export const RPGTOOLKIT_NAMESPACE = 'rpgtoolkit'

export type ExportWarning = string

export type ExportResult = {
  blob: Blob
  fileCount: number
  warnings: ExportWarning[]
}

type HashMap = Record<string, string>

function safePackageDir(name: string): string {
  const s = name.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_')
  return s || 'package'
}

function packRoot(pkgName: string): string {
  return safePackageDir(pkgName)
}

function assetPath(pkgName: string, relativeUnderAssets: string): string {
  // 包名/assets/rpgtoolkit/...
  return `${packRoot(pkgName)}/assets/${relativeUnderAssets.replace(/^\/+/, '')}`
}

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
function localeOfLangAsset(name: string): string | null {
  const parts = name.trim().replace(/\\/g, '/').split('/')
  if (parts.length < 4) return null
  if (parts[0]?.toLowerCase() !== 'assets') return null
  if (!/^lang_[a-z0-9]+$/i.test(parts[2] ?? '')) return null
  return parts[1]!.toLowerCase()
}

/** `assets/<locale>/voice_<ext>/…/<键名>.ogg` → `{ locale, key }`；不合布局返回 null */
function localeOfVoiceAsset(
  path: string,
): { locale: string; key: string } | null {
  const parts = path.trim().replace(/\\/g, '/').split('/')
  if (parts.length < 4) return null
  if (parts[0]?.toLowerCase() !== 'assets') return null
  if (!/^voice_[a-z0-9]+$/i.test(parts[2] ?? '')) return null
  const file = parts[parts.length - 1] ?? ''
  if (!/\.ogg$/i.test(file)) return null
  return { locale: parts[1]!.toLowerCase(), key: file.replace(/\.ogg$/i, '') }
}

function mergeLangMaps(
  into: HashMap,
  from: HashMap,
  fileName: string,
  warnings: string[],
) {
  for (const [hash, text] of Object.entries(from)) {
    if (hash in into && into[hash] !== text) {
      warnings.push(`${fileName}: hash ${hash} 译文冲突，保留先写入的版本`)
      continue
    }
    into[hash] = text
  }
}

function writePackMeta(zip: JSZip, pkgName: string) {
  zip.file(
    `${packRoot(pkgName)}/pack.mcmeta`,
    `${JSON.stringify(
      {
        pack: {
          min_format: [84, 0],
          max_format: [84, 0],
          description: `rpgtoolkit / ${pkgName}`,
        },
      },
      null,
      2,
    )}\n`,
  )
}

export async function buildResourcePackZip(
  workspace: Workspace,
): Promise<ExportResult> {
  const warnings: ExportWarning[] = []
  const zip = new JSZip()
  let fileCount = 0

  for (const pkg of workspace.packages) {
    writePackMeta(zip, pkg.name)
    fileCount++

    let hasLang = false
    let hasVoice = false
    let hasHanshu = false

    // —— .hs → .hsc（不再生成 .lines：键名就在正文里）——
    for (const script of pkg.scripts) {
      if (!isHanshuFile(script.name)) continue
      const hscName = hscFileNameForHs(script.name)
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
      zip.file(
        assetPath(pkg.name, `${RPGTOOLKIT_NAMESPACE}/hanshu/${hscName}`),
        hsc,
      )
      fileCount++
      hasHanshu = true
    }

    // —— 语言文本 `assets/<locale>/lang_<ext>/…/名.lang`（按包合并 locale）——
    const langByLocale = new Map<string, HashMap>()
    for (const script of pkg.scripts) {
      const locale = localeOfLangAsset(script.name)
      if (!locale) continue
      const map = parseHashMap(script.content, script.name, warnings)
      const bucket = langByLocale.get(locale) ?? {}
      mergeLangMaps(bucket, map, script.name, warnings)
      langByLocale.set(locale, bucket)
    }
    for (const [locale, map] of [...langByLocale.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const keys = Object.keys(map).sort((a, b) => a.localeCompare(b))
      const ordered: HashMap = {}
      for (const k of keys) ordered[k] = map[k]
      zip.file(
        assetPath(
          pkg.name,
          `${RPGTOOLKIT_NAMESPACE}/lines/lang/${locale}.lang`,
        ),
        `${JSON.stringify(ordered, null, 2)}\n`,
      )
      fileCount++
      hasLang = true
    }

    // —— 音频 `assets/<locale>/voice_<ext>/…/<键名>.ogg` →
    //      lines/voice/<键名>.<locale>.ogg（键名就是文件名，不再经过映射表）——
    const seenVoice = new Set<string>()
    for (const asset of pkg.assets) {
      const parsed = localeOfVoiceAsset(asset.path)
      if (!parsed) continue
      const { locale, key } = parsed
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
      zip.file(
        assetPath(
          pkg.name,
          `${RPGTOOLKIT_NAMESPACE}/lines/voice/${key}.${locale}.ogg`,
        ),
        blob,
      )
      fileCount++
      hasVoice = true
    }

    // 引擎侧的固定目录：lines 下放 .lang / .voice，hanshu 下放 .hsc
    zip.folder(assetPath(pkg.name, `${RPGTOOLKIT_NAMESPACE}/lines`))
    if (!hasLang) {
      zip.folder(assetPath(pkg.name, `${RPGTOOLKIT_NAMESPACE}/lines/lang`))
    }
    if (!hasVoice) {
      zip.folder(assetPath(pkg.name, `${RPGTOOLKIT_NAMESPACE}/lines/voice`))
    }
    if (!hasHanshu) {
      zip.folder(assetPath(pkg.name, `${RPGTOOLKIT_NAMESPACE}/hanshu`))
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
