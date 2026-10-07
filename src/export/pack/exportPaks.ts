import JSZip from 'jszip'
import { SOURCE_KIND_ORDER } from '../../workspace'
import type { Workspace } from '../../workspace'
import {
  buildCompileGraph,
  compileGraphHasErrors,
  formatDiagnostics,
  type CompileDiagnostic,
} from '../compile'
import { aesGcmEncryptor, toArrayBuffer, type Encryptor } from './encrypt'
import {
  filterArtifactsForTarget,
  pakFileSuffix,
  type PackTarget,
} from './planes'
import { forceZipUtf8PathFlags } from './zipUtf8'

export type ExportWarning = string

export type PackPlaneResult = {
  target: PackTarget
  blob: Blob
  fileCount: number
  encrypted: boolean
  fileNameHint: string
}

export type ExportPaksResult = {
  packs: PackPlaneResult[]
  diagnostics: CompileDiagnostic[]
  warnings: ExportWarning[]
}

export type ExportPaksOptions = {
  targets?: PackTarget[]
  /** 对列出的目标整包加密；默认不加密 */
  encrypt?: {
    targets: PackTarget[]
    passphrase: string
    encryptor?: Encryptor
  }
  /** 有 error 诊断时是否中止（默认 true） */
  failOnErrors?: boolean
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
}

async function zipArtifacts(
  artifacts: ReturnType<typeof filterArtifactsForTarget>,
): Promise<{ blob: Blob; fileCount: number }> {
  const zip = new JSZip()
  let fileCount = 0
  let hasAssets = false

  for (const art of artifacts) {
    zip.file(art.path, art.bytes)
    fileCount++
    if (art.path.startsWith('assets/')) hasAssets = true
  }

  for (const dir of SOURCE_KIND_ORDER) {
    zip.folder(dir)
  }
  if (!hasAssets) zip.folder('assets')

  const raw = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
  })
  const bytes = forceZipUtf8PathFlags(raw)
  const blob = new Blob([toArrayBuffer(bytes)], { type: 'application/zip' })
  return { blob, fileCount }
}

/**
 * 编译工作区并按平面打出多个 PAK。
 * 默认 `targets: ['combined']`，行为对齐历史单 pak。
 */
export async function exportPaks(
  workspace: Workspace,
  options: ExportPaksOptions = {},
): Promise<ExportPaksResult> {
  const targets = options.targets?.length
    ? options.targets
    : (['combined'] as PackTarget[])
  const failOnErrors = options.failOnErrors !== false

  const graph = await buildCompileGraph(workspace)
  const warnings = formatDiagnostics(
    graph.diagnostics.filter((d) => d.severity !== 'error'),
  )
  const errorMsgs = formatDiagnostics(
    graph.diagnostics.filter((d) => d.severity === 'error'),
  )

  if (failOnErrors && compileGraphHasErrors(graph)) {
    throw new Error(
      errorMsgs.slice(0, 8).join('\n') +
        (errorMsgs.length > 8 ? `\n…另有 ${errorMsgs.length - 8} 条错误` : ''),
    )
  }

  // 编译错误在 failOnErrors=false 时仍并入 warnings，便于预演
  warnings.push(...errorMsgs)

  const encryptor = options.encrypt?.encryptor ?? aesGcmEncryptor
  const encryptTargets = new Set(options.encrypt?.targets ?? [])
  const passphrase = options.encrypt?.passphrase ?? ''
  const packs: PackPlaneResult[] = []
  const t = stamp()

  for (const target of targets) {
    const arts = filterArtifactsForTarget(graph.artifacts, target)
    let { blob, fileCount } = await zipArtifacts(arts)
    let encrypted = false

    if (encryptTargets.has(target) && passphrase) {
      const plain = new Uint8Array(await blob.arrayBuffer())
      const sealed = await encryptor.encrypt(plain, passphrase)
      blob = new Blob([toArrayBuffer(sealed)], {
        type: 'application/octet-stream',
      })
      encrypted = true
    }

    packs.push({
      target,
      blob,
      fileCount,
      encrypted,
      fileNameHint: `hanshu-${t}-${pakFileSuffix(target)}.pak`,
    })
  }

  return { packs, diagnostics: graph.diagnostics, warnings }
}

/** 多个 pak 打成一个外层 zip，便于一次下载 */
export async function bundlePacksZip(
  packs: PackPlaneResult[],
): Promise<Blob> {
  const zip = new JSZip()
  for (const p of packs) {
    zip.file(p.fileNameHint, p.blob)
  }
  const raw = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
  })
  return new Blob([toArrayBuffer(forceZipUtf8PathFlags(raw))], {
    type: 'application/zip',
  })
}
