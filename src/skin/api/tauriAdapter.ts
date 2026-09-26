/**
 * Tauri adapter — SkinApi 的桌面实现。invoke + listen 全部收敛在这里;
 * 组件不 import @tauri-apps/api。预览 PNG 走二进制 IPC → Blob object URL,
 * 按 skinId 缓存并带 LRU 上限,淘汰时 revokeObjectURL。
 */

import { SkinApiError } from '../contracts/types.ts'
import type { SkinApi } from './SkinApi.ts'

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
type ListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>

/** Injected in production from @tauri-apps/api (keeps this module testable). */
export interface TauriDeps {
  invoke: Invoke
  listen: ListenFn
  /** Native save dialog (tauri-plugin-dialog). Returns a path or null. */
  saveDialog(options: {
    title: string
    defaultName: string
    filters: { name: string; extensions: string[] }[]
  }): Promise<string | null>
}

const PREVIEW_CACHE_LIMIT = 256

class PreviewUrlCache {
  private map = new Map<string, string>()

  async get(skinId: string, fetchPng: () => Promise<ArrayBuffer>): Promise<string> {
    const hit = this.map.get(skinId)
    if (hit) {
      // LRU touch
      this.map.delete(skinId)
      this.map.set(skinId, hit)
      return hit
    }
    const buf = await fetchPng()
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
    this.map.set(skinId, url)
    while (this.map.size > PREVIEW_CACHE_LIMIT) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      const url = this.map.get(oldest)
      this.map.delete(oldest)
      if (url) URL.revokeObjectURL(url)
    }
    return url
  }
}

export function createTauriSkinApi(deps: TauriDeps): SkinApi {
  const previews = new PreviewUrlCache()

  async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return (await deps.invoke(cmd, args)) as T
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
        throw new SkinApiError(e as { code: string; message: string; retryAfterMs?: number })
      }
      throw e
    }
  }

  return {
    capabilities: () => call('skin_get_capabilities'),

    listEntries: (query) => call('skin_list_entries', { query }),
    getEntry: (entryId) => call('skin_get_entry', { entryId }),
    listTags: () => call('skin_list_tags'),
    createTag: (body) => call('skin_create_tag', { body }),
    patchTag: (tagId, body) => call('skin_patch_tag', { tagId, patch: body }),
    deleteTag: (tagId, mode, expectedRevision) =>
      call('skin_delete_tag', { tagId, branch: mode === 'branch', expectedRevision }),
    listFolders: () => call('skin_list_folders'),
    createFolder: (body) => call('skin_create_folder', { body }),
    patchFolder: (folderId, body) => call('skin_patch_folder', { folderId, patch: body }),
    deleteFolder: (folderId) => call('skin_delete_folder', { folderId }),

    saveEntry: (body) => call('skin_save_entry', { body }),
    patchEntry: (entryId, body) =>
      call('skin_patch_entry', { entryId, revision: body.revision, patch: body }),
    batchPatchEntries: (body) => call('skin_batch_patch_entries', { batch: body }),
    deleteEntry: (entryId) => call('skin_delete_entry', { entryId }),

    startImport: (kind, text, model) =>
      call('skin_start_import', { body: { kind, text, model } }),
    importFile: (path, model) => call('skin_import_file', { path, model }),
    importFileBlob: () =>
      Promise.reject(
        new SkinApiError({
          code: 'UNSUPPORTED',
          message: '浏览器文件上传仅在 Web 模式可用;桌面请使用文件对话框。',
        }),
      ),
    getImport: (jobId) => call('skin_get_import', { jobId }),
    listImports: () => call('skin_list_imports'),
    cancelImport: (jobId) => call('skin_cancel_import', { jobId }),

    getPreviewUrl: (skinId) =>
      previews.get(skinId, async () => {
        const resp = (await deps.invoke('skin_get_preview_png', { skinId })) as ArrayBuffer
        return resp
      }),
    getSkinCode: (skinId) => call('skin_get_skin_code', { skinId }),
    exportSkin: (skinId, format) => call('skin_export_skin', { skinId, format }),
    exportEntry: (entryId, format) =>
      call('skin_export_entry', { entryId, format: format ?? 'v3' }),
    exportUsableManifest: () => call('skin_export_usable_manifest'),
    saveExportFile: async (skinId, format) => {
      const defaultName =
        format === 'png' ? `${skinId.slice(0, 12)}.png` : `${skinId.slice(0, 12)}.hskin`
      const path = await deps.saveDialog({
        title: format === 'png' ? '导出 PNG' : '导出 .hskin',
        defaultName,
        filters:
          format === 'png'
            ? [{ name: 'PNG 图像', extensions: ['png'] }]
            : [{ name: 'hskin 皮肤', extensions: ['hskin'] }],
      })
      if (!path) return
      await call('skin_write_export_file', { path, skinId, format })
    },

    subscribe: async (listener) => {
      type JobPayload = { jobId: string; seq: number; state: string }
      type LibPayload = { revision: number; domain: 'entries' | 'tags' | 'folders' }
      const offJob = await deps.listen<JobPayload>('skin://job-updated', (e) => {
        listener({
          type: 'job-updated',
          jobId: e.payload.jobId,
          seq: e.payload.seq,
          state: e.payload.state as 'queued' | 'fetching' | 'validating' | 'ready' | 'failed' | 'cancelled',
        })
      })
      const offLib = await deps.listen<LibPayload>('skin://library-updated', (e) => {
        listener({
          type: 'library-updated',
          revision: e.payload.revision,
          domain: e.payload.domain,
        })
      })
      return () => {
        offJob()
        offLib()
      }
    },
  }
}
