import JSZip from 'jszip'
import { getAssetBlob } from '../assets/idb'
import {
  compileHsToHsc,
  compileLinesFromHs,
  hscFileNameForHs,
  linesFileNameForHs,
  stringifyLinesFile,
} from '../hanshu/lines'
import {
  isHanshuFile,
  isLangFile,
  isLinesFile,
  isVoiceMapFile,
  type ScriptPackage,
  type Workspace,
} from '../workspace'

export const RPGTOOLKIT_NAMESPACE = 'rpgtoolkit'

const LOCALE_FILE_RE = /\.lines\.([a-z][a-z0-9_]*)\.(lang|voice)$/i

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

export function parseLinesLocaleFile(
  fileName: string,
): { locale: string; kind: 'lang' | 'voice' } | null {
  const m = fileName.trim().match(LOCALE_FILE_RE)
  if (!m) return null
  return { locale: m[1].toLowerCase(), kind: m[2].toLowerCase() as 'lang' | 'voice' }
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

function findVoiceAssetPath(
  pkg: ScriptPackage,
  locale: string,
  stem: string,
): string | null {
  const want = `assets/${locale}/voice/${stem}.ogg`.toLowerCase()
  const hit = pkg.assets.find(
    (a) => a.path.replace(/\\/g, '/').toLowerCase() === want,
  )
  return hit?.path ?? null
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
    let hasLines = false

    // —— .hs → .lines + .hsc ——
    for (const script of pkg.scripts) {
      if (!isHanshuFile(script.name)) continue
      const lines = compileLinesFromHs(script.content)
      const linesName = linesFileNameForHs(script.name)
      const hscName = hscFileNameForHs(script.name)
      const hsc = compileHsToHsc(script.content, lines)

      zip.file(
        assetPath(pkg.name, `${RPGTOOLKIT_NAMESPACE}/lines/${linesName}`),
        stringifyLinesFile(lines),
      )
      zip.file(
        assetPath(pkg.name, `${RPGTOOLKIT_NAMESPACE}/hanshu/${hscName}`),
        hsc,
      )
      fileCount += 2
      hasLines = true
      hasHanshu = true
    }

    // 工作区里额外的 .lines（无对应 .hs 时仍导出）
    for (const script of pkg.scripts) {
      if (!isLinesFile(script.name)) continue
      const hsName = script.name.replace(/\.lines$/i, '.hs')
      const hasHs = pkg.scripts.some(
        (s) => s.name.toLowerCase() === hsName.toLowerCase(),
      )
      if (hasHs) continue
      zip.file(
        assetPath(pkg.name, `${RPGTOOLKIT_NAMESPACE}/lines/${script.name}`),
        script.content,
      )
      fileCount++
      hasLines = true
    }

    // —— .lang（按包合并 locale）——
    const langByLocale = new Map<string, HashMap>()
    for (const script of pkg.scripts) {
      if (!isLangFile(script.name)) continue
      const parsed = parseLinesLocaleFile(script.name)
      if (!parsed || parsed.kind !== 'lang') {
        warnings.push(
          `[${pkg.name}] ${script.name}: 须为 *.lines.<locale>.lang`,
        )
        continue
      }
      const map = parseHashMap(script.content, script.name, warnings)
      const bucket = langByLocale.get(parsed.locale) ?? {}
      mergeLangMaps(bucket, map, script.name, warnings)
      langByLocale.set(parsed.locale, bucket)
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

    // —— .voice → lines/voice/<hash>.<locale>.ogg ——
    const seenVoice = new Set<string>()
    for (const script of pkg.scripts) {
      if (!isVoiceMapFile(script.name)) continue
      const parsed = parseLinesLocaleFile(script.name)
      if (!parsed || parsed.kind !== 'voice') {
        warnings.push(
          `[${pkg.name}] ${script.name}: 须为 *.lines.<locale>.voice`,
        )
        continue
      }
      const { locale } = parsed
      const map = parseHashMap(script.content, script.name, warnings)

      for (const [hash, stem] of Object.entries(map)) {
        const key = `${hash}.${locale}`
        if (seenVoice.has(key)) {
          warnings.push(`[${pkg.name}] ${script.name}: ${key} 重复`)
          continue
        }
        const stemClean = stem.trim()
        if (!stemClean) {
          warnings.push(`[${pkg.name}] ${script.name}: hash ${hash} stem 为空`)
          continue
        }
        const assetFilePath = findVoiceAssetPath(pkg, locale, stemClean)
        if (!assetFilePath) {
          warnings.push(
            `[${pkg.name}] 缺少音频: assets/${locale}/voice/${stemClean}.ogg（#${hash}）`,
          )
          continue
        }
        const blob = await getAssetBlob(pkg.id, assetFilePath)
        if (!blob) {
          warnings.push(`[${pkg.name}] IndexedDB 无数据: ${assetFilePath}`)
          continue
        }
        zip.file(
          assetPath(
            pkg.name,
            `${RPGTOOLKIT_NAMESPACE}/lines/voice/${hash}.${locale}.ogg`,
          ),
          blob,
        )
        fileCount++
        hasVoice = true
        seenVoice.add(key)
      }
    }

    if (!hasLines) {
      zip.folder(assetPath(pkg.name, `${RPGTOOLKIT_NAMESPACE}/lines`))
    }
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
