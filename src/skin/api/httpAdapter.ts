/**
 * HTTP adapter — SkinApi 的浏览器实现。与 Tauri adapter 行为一致:
 * 相同的查询参数、相同的错误码、相同的事件流。
 */

import { SkinApiError } from '../contracts/types.ts'
import type { SkinApi } from './SkinApi.ts'
import type {
  BatchPatchRequest,
  BatchPatchResponse,
  Capabilities,
  CreateFolderRequest,
  CreateTagRequest,
  EntryExport,
  FolderNode,
  FolderTreeResponse,
  ImportJob,
  LibraryEntry,
  LibraryPage,
  LibraryQuery,
  PatchEntryRequest,
  PatchFolderRequest,
  PatchTagRequest,
  SaveEntryRequest,
  SkinEvent,
  SkinModel,
  TagNode,
  TagTreeResponse,
  UsableManifest,
} from '../contracts/types.ts'

const DEFAULT_BASE = '/api/skin/v1'

export interface HttpAdapterOptions {
  baseUrl?: string
  /** Optional auth token provider (e.g. from bootstrap). */
  token?: () => string | null
}

async function request<T>(
  base: string,
  path: string,
  init?: RequestInit,
  token?: () => string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  }
  const t = token?.()
  if (t) headers['Authorization'] = `Bearer ${t}`
  const res = await fetch(`${base}${path}`, { ...init, headers })
  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = res.statusText
    let retryAfterMs: number | undefined
    try {
      const body = await res.json()
      if (body && typeof body === 'object') {
        code = body.code ?? code
        message = body.message ?? message
        retryAfterMs = body.retryAfterMs
      }
    } catch {
      // ignore non-JSON error bodies
    }
    throw new SkinApiError({ code, message, retryAfterMs })
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    return res.json() as Promise<T>
  }
  return res as unknown as T
}

async function requestBinary(
  base: string,
  path: string,
  init?: RequestInit,
  token?: () => string | null,
): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {}
  const t = token?.()
  if (t) headers['Authorization'] = `Bearer ${t}`
  const res = await fetch(`${base}${path}`, { ...init, headers })
  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = res.statusText
    let retryAfterMs: number | undefined
    try {
      const body = await res.json()
      if (body && typeof body === 'object') {
        code = body.code ?? code
        message = body.message ?? message
        retryAfterMs = body.retryAfterMs
      }
    } catch {
      // ignore
    }
    throw new SkinApiError({ code, message, retryAfterMs })
  }
  return res.arrayBuffer()
}

export function createHttpSkinApi(options?: HttpAdapterOptions): SkinApi {
  const base = options?.baseUrl ?? DEFAULT_BASE
  const token = options?.token

  return {
    capabilities: () => request<Capabilities>(base, '/capabilities', undefined, token),

    listEntries: (query: LibraryQuery) =>
      request<LibraryPage>(base, '/entries/query', {
        method: 'POST',
        body: JSON.stringify(query),
      }, token),

    getEntry: (entryId: string) =>
      request<LibraryEntry>(base, `/entries/${encodeURIComponent(entryId)}`, undefined, token),

    listTags: () => request<TagTreeResponse>(base, '/tags', undefined, token),

    createTag: (body: CreateTagRequest) =>
      request<TagNode>(base, '/tags', { method: 'POST', body: JSON.stringify(body) }, token),

    patchTag: (tagId: string, body: PatchTagRequest) =>
      request<TagNode>(base, `/tags/${encodeURIComponent(tagId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }, token),

    deleteTag: (tagId: string, mode: 'single' | 'branch', expectedRevision?: number) =>
      request<{ removedTagIds: string[]; affectedEntries: number }>(
        base,
        `/tags/${encodeURIComponent(tagId)}?branch=${mode === 'branch'}${expectedRevision != null ? `&expectedRevision=${expectedRevision}` : ''}`,
        { method: 'DELETE' },
        token,
      ),

    listFolders: () => request<FolderTreeResponse>(base, '/folders', undefined, token),

    createFolder: (body: CreateFolderRequest) =>
      request<FolderNode>(base, '/folders', { method: 'POST', body: JSON.stringify(body) }, token),

    patchFolder: (folderId: string, body: PatchFolderRequest) =>
      request<FolderNode>(base, `/folders/${encodeURIComponent(folderId)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }, token),

    deleteFolder: (folderId: string) =>
      request<{ deleted: boolean }>(base, `/folders/${encodeURIComponent(folderId)}`, {
        method: 'DELETE',
      }, token),

    saveEntry: (body: SaveEntryRequest) =>
      request<LibraryEntry>(base, '/entries/save', { method: 'POST', body: JSON.stringify(body) }, token),

    patchEntry: (entryId: string, body: PatchEntryRequest) =>
      request<LibraryEntry>(
        base,
        `/entries/${encodeURIComponent(entryId)}?expectedRevision=${body.revision}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
        token,
      ),

    batchPatchEntries: (body: BatchPatchRequest) =>
      request<BatchPatchResponse>(base, '/entries:batch', {
        method: 'POST',
        body: JSON.stringify(body),
      }, token),

    deleteEntry: (entryId: string) =>
      request<{ deleted: boolean }>(base, `/entries/${encodeURIComponent(entryId)}`, {
        method: 'DELETE',
      }, token),

    startImport: (
      kind: 'png-url' | 'player-name' | 'skin-code' | 'skin-file',
      text: string,
      model?: SkinModel,
    ) =>
      request<{ jobId: string }>(base, '/imports', {
        method: 'POST',
        body: JSON.stringify({ kind, text, model }),
      }, token),

    importFile: async (_path: string, _model?: SkinModel) => {
      // Browser mode has no native paths; the platform layer hands us a File.
      throw new SkinApiError({
        code: 'UNSUPPORTED',
        message: 'importFile(path) 仅桌面可用;浏览器请使用 importFileBlob。',
      })
    },

    importFileBlob: (file: File, model?: SkinModel) => {
      const form = new FormData()
      form.append('file', file)
      if (model) form.append('model', model)
      return fetch(`${base}/imports/upload`, { method: 'POST', body: form })
        .then(async (res) => {
          if (!res.ok) {
            let code = 'UNKNOWN'
            let message = res.statusText
            try {
              const body = await res.json()
              code = body.code ?? code
              message = body.message ?? message
            } catch {
              /* non-JSON error body */
            }
            throw new SkinApiError({ code, message })
          }
          return (await res.json()) as { jobId: string }
        })
    },

    getImport: (jobId: string) =>
      request<ImportJob>(base, `/imports/${encodeURIComponent(jobId)}`, undefined, token),

    listImports: () => request<ImportJob[]>(base, '/imports', undefined, token),

    cancelImport: (jobId: string) =>
      request<ImportJob>(base, `/imports/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
      }, token),

    getPreviewUrl: async (skinId: string) => {
      const buf = await requestBinary(base, `/skins/${encodeURIComponent(skinId)}/preview.png`, undefined, token)
      return URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
    },

    getSkinCode: (skinId: string) =>
      request<string>(base, `/skins/${encodeURIComponent(skinId)}/code`, undefined, token),

    exportSkin: (skinId: string, format: 'png' | 'hskin' | 'skin-json') =>
      request<{ text?: string; pngBase64?: string }>(
        base,
        `/skins/${encodeURIComponent(skinId)}/export?format=${format}`,
        undefined,
        token,
      ),

    exportEntry: (entryId: string, format?: 'v3' | 'v2') =>
      request<EntryExport>(
        base,
        `/entries/${encodeURIComponent(entryId)}/export?format=${format ?? 'v3'}`,
        undefined,
        token,
      ),

    exportUsableManifest: () =>
      request<UsableManifest>(base, '/usable-manifest', undefined, token),

    saveExportFile: async (skinId: string, format: 'png' | 'hskin') => {
      const buf = await requestBinary(
        base,
        `/skins/${encodeURIComponent(skinId)}/export?format=${format}`,
        undefined,
        token,
      )
      const blob = new Blob([buf], {
        type: format === 'png' ? 'image/png' : 'text/plain',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${skinId.slice(0, 12)}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    },

    subscribe: async (listener: (event: SkinEvent) => void) => {
      const url = `${base}/events`
      const es = new EventSource(url)
      const onJob = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          listener({
            type: 'job-updated',
            jobId: data.jobId,
            seq: data.seq,
            state: data.state,
          })
        } catch {
          // ignore malformed events
        }
      }
      const onLib = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data)
          listener({
            type: 'library-updated',
            revision: data.revision,
            domain: data.domain,
          })
        } catch {
          // ignore malformed events
        }
      }
      es.addEventListener('job-updated', onJob)
      es.addEventListener('library-updated', onLib)
      return () => {
        es.removeEventListener('job-updated', onJob)
        es.removeEventListener('library-updated', onLib)
        es.close()
      }
    },
  }
}
