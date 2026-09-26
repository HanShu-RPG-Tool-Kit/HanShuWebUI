import { createFileSink } from './fileSink'

/**
 * 配音的**磁盘写穿** —— 通用写盘层（`fileSink`）的薄封装。
 *
 * 权限申请、`.new` → 删旧 → 改名、`move` 特性探测与降级、串行队列、结果上报
 * 都在 `fileSink` 里做一次；这里只负责把字节包成 Blob，并保持"失败要抛"的契约，
 * 让上层（ScriptWorkspace）能提示"配音未写入磁盘"。
 *
 * 未绑定工程（虚拟工作区）时 `enabled` 为 false：资产真身只在 IndexedDB 里，
 * 磁盘副本由「保存工程」整树重写。
 */

export { FILE_SINK_TEMP_SUFFIX as VOICE_DISK_TEMP_SUFFIX } from './fileSink'

export type VoiceDiskSink = {
  /** 是否真的会写磁盘（绑定工程才 true） */
  readonly enabled: boolean
  /** 把 bytes 写到 `<root>/<path>`；`onProgress` 报 0..1（仅磁盘这一段） */
  write(
    path: string,
    bytes: Uint8Array,
    mime: string,
    onProgress?: (ratio: number) => void,
  ): Promise<void>
  /** 删除该文件（含 `.new` 残留） */
  remove(path: string): Promise<void>
}

export function createVoiceDiskSink(
  handle: FileSystemDirectoryHandle | null,
): VoiceDiskSink {
  const sink = createFileSink({ handle })

  return {
    enabled: sink.diskBound,

    async write(path, bytes, mime, onProgress) {
      const error = await sink.write(
        path,
        new Blob([bytes as BlobPart], { type: mime }),
        { progress: onProgress },
      )
      if (error) throw error
    },

    async remove(path) {
      await sink.remove(path)
    },
  }
}
