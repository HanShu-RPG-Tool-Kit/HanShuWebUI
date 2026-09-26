/**
 * File System Access SkinApi — 数据落在当前工程 `.hanshu/skinmanager`
 */

import { getBoundProjectHandle } from '../../project'
import { SkinApiError } from '../contracts/types'
import type { SkinApi } from './SkinApi.ts'
import type {
  BatchPatchRequest,
  CreateFolderRequest,
  PatchEntryRequest,
  PatchFolderRequest,
  SaveEntryRequest,
  SkinEvent,
  SkinModel,
} from '../contracts/types'
import { SkinLibrarySession } from '../local/SkinLibrary'
import { SCHEMA_VERSION, SKIN_ROOT } from '../local/paths'

let session: SkinLibrarySession | null = null
let sessionRoot: FileSystemDirectoryHandle | null = null
/** Serialize init so concurrent list/create never sees a half-ready session. */
let sessionInit: Promise<SkinLibrarySession> | null = null

async function getSession(): Promise<SkinLibrarySession> {
  const handle = getBoundProjectHandle()
  if (!handle) {
    throw new SkinApiError({
      code: 'PROJECT_REQUIRED',
      message:
        '请先在「剧本」工作区打开或新建工程。皮肤库保存在工程目录的 .hanshu/skinmanager。',
    })
  }
  if (session && sessionRoot === handle && session.isReady()) {
    return session
  }
  if (sessionInit && sessionRoot === handle) {
    return sessionInit
  }

  session?.dispose()
  session = null
  sessionRoot = handle
  const created = new SkinLibrarySession(handle)
  sessionInit = created
    .init()
    .then(() => {
      session = created
      sessionInit = null
      return created
    })
    .catch((e) => {
      sessionInit = null
      session = null
      sessionRoot = null
      throw e
    })
  return sessionInit
}

export function resetFsaSkinSession(): void {
  session?.dispose()
  session = null
  sessionRoot = null
  sessionInit = null
}

export function createFsaSkinApi(): SkinApi {
  return {
    capabilities: async () => {
      try {
        const s = await getSession()
        return s.capabilities()
      } catch (e) {
        if (e instanceof SkinApiError && e.code === 'PROJECT_REQUIRED') {
          return {
            toolVersion: 'hanshu-fsa',
            apiVersion: '1',
            librarySchemaVersion: SCHEMA_VERSION,
            formatVersion: 1,
            importKinds: [
              'png-file',
              'png-url',
              'player-name',
              'skin-code',
              'skin-file',
            ],
            liveApply: false,
            features: { batchActive: true, httpApi: false },
          }
        }
        throw e
      }
    },

    listEntries: async (query) => (await getSession()).listEntries(query),
    getEntry: async (entryId) => (await getSession()).getEntry(entryId),
    listTags: async () => (await getSession()).listTags(),
    renameTag: async (from, to) => (await getSession()).renameTag(from, to),
    deleteTag: async (name) => (await getSession()).deleteTag(name),
    listFolders: async () => (await getSession()).listFolders(),
    createFolder: async (body: CreateFolderRequest) =>
      (await getSession()).createFolder(body),
    patchFolder: async (folderId: string, body: PatchFolderRequest) =>
      (await getSession()).patchFolder(folderId, body),
    deleteFolder: async (folderId) =>
      (await getSession()).deleteFolder(folderId),

    saveEntry: async (body: SaveEntryRequest) =>
      (await getSession()).saveEntry(body),
    patchEntry: async (entryId: string, body: PatchEntryRequest) =>
      (await getSession()).patchEntry(entryId, body),
    batchPatchEntries: async (body: BatchPatchRequest) =>
      (await getSession()).batchPatchEntries(body),
    deleteEntry: async (entryId) => (await getSession()).deleteEntry(entryId),

    startImport: async (kind, text, model?: SkinModel) => {
      const s = await getSession()
      if (kind === 'skin-code') return s.startImportSkinCode(text)
      if (kind === 'png-url') return s.startImportFromUrl(text, model)
      if (kind === 'player-name') return s.startImportFromPlayerName(text)
      if (kind === 'skin-file') {
        throw new SkinApiError({
          code: 'BAD_REQUEST',
          message: '请使用文件选择导入 .hskin / PNG',
        })
      }
      throw new SkinApiError({
        code: 'BAD_REQUEST',
        message: `未知导入类型: ${kind}`,
      })
    },

    importFile: async () => {
      throw new SkinApiError({
        code: 'UNSUPPORTED',
        message: '请使用文件选择（浏览器无法读原生路径）',
      })
    },

    importFileBlob: async (file: File, model?: SkinModel) => {
      const s = await getSession()
      const buf = new Uint8Array(await file.arrayBuffer())
      const name = file.name.toLowerCase()
      if (name.endsWith('.hskin') || name.endsWith('.txt')) {
        const text = new TextDecoder().decode(buf)
        if (text.trim().startsWith('hskin1:')) {
          return s.startImportSkinCode(text)
        }
      }
      return s.startImportFromPng(buf, file.name, model)
    },

    getImport: async (jobId) => (await getSession()).getImport(jobId),
    listImports: async () => (await getSession()).listImports(),
    cancelImport: async (jobId) => (await getSession()).cancelImport(jobId),

    getPreviewUrl: async (skinId) => (await getSession()).getPreviewUrl(skinId),
    getSkinCode: async (skinId) => (await getSession()).getSkinCode(skinId),
    exportSkin: async (skinId, format) =>
      (await getSession()).exportSkin(skinId, format),
    exportEntry: async (entryId, format) =>
      (await getSession()).exportEntry(entryId, format),
    exportUsableManifest: async () =>
      (await getSession()).exportUsableManifest(),

    saveExportFile: async (skinId, format) => {
      const s = await getSession()
      if (format === 'png') {
        const { pngBase64 } = await s.exportSkin(skinId, 'png')
        if (!pngBase64) return
        const bin = atob(pngBase64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const blob = new Blob([bytes], { type: 'image/png' })
        triggerDownload(blob, `${skinId.slice(0, 8)}.png`)
        return
      }
      const { text } = await s.exportSkin(skinId, 'hskin')
      if (!text) return
      triggerDownload(
        new Blob([text], { type: 'text/plain' }),
        `${skinId.slice(0, 8)}.hskin`,
      )
    },

    subscribe: async (listener: (event: SkinEvent) => void) => {
      const s = await getSession()
      return s.subscribe(listener)
    },
  }
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

export const FSA_SKIN_ROOT_LABEL = SKIN_ROOT
