import type { ProjectDirectory } from './serviceClient'
import { createFileSink } from './fileSink'

/** Voice asset submissions use the same checked server file commands as every other resource.
 * S owns atomic persistence; failed submissions throw while C retains its cache/draft.
 */

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
  handle: ProjectDirectory | null,
  /** 写/删的结果回调：失败时给了它就不会被静默吞掉 */
  onWriteResult?: (path: string, error: unknown) => void,
): VoiceDiskSink {
  const sink = createFileSink({ handle, onWriteResult })

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
