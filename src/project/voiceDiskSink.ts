import type { ProjectDirectory } from './serviceClient'
import type { FileEdit } from './serviceClient'

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
  /** 一次提交同一配音绑定的替换与对等文件删除。 */
  replace(path: string, bytes: Uint8Array, mime: string, removePaths: readonly string[], onProgress?: (ratio: number) => void): Promise<void>
  /** 一次提交完整变更集。未绑定工程时仅由调用方维护本地草稿。 */
  apply(edits: FileEdit[], label: string): Promise<void>
  remove(path: string): Promise<void>
  removeMany(paths: readonly string[]): Promise<void>
}

export function createVoiceDiskSink(
  handle: ProjectDirectory | null,
  /** 写/删的结果回调：失败时给了它就不会被静默吞掉 */
  onWriteResult?: (path: string, error: unknown) => void,
): VoiceDiskSink {
  const apply = async (edits: FileEdit[], label: string) => {
    if (!handle) return
    const commands = edits.map(edit => ({ ...edit, path: handle.resolve(edit.path) }))
      .filter(edit => edit.op !== 'remove' || handle.client.entry(edit.path))
    if (!commands.length) return
    const drafts = handle.client.transactions?.stagedWrites() ?? []
    if (commands.some(edit => edit.op === 'remove' && drafts.some(draft => draft.path === edit.path || draft.path.startsWith(`${edit.path}/`)))) {
      throw new Error('待删除资源还有未保存的修改，请先保存或处理提交记录')
    }
    try {
      await handle.client.apply(commands, label)
      for (const edit of commands) onWriteResult?.(edit.path, null)
    } catch (error) {
      for (const edit of commands) onWriteResult?.(edit.path, error)
      throw error
    }
  }
  const removeMany = (paths: readonly string[]) => apply([...new Set(paths)].map(path => ({ op: 'remove', path })), '删除配音资源')
  const replace = async (path: string, bytes: Uint8Array, mime: string, removePaths: readonly string[], progress?: (ratio: number) => void) => {
    await apply([
      ...[...new Set(removePaths)].filter(peer => peer !== path).map(peer => ({ op: 'remove' as const, path: peer })),
      { op: 'write', path, data: new Blob([bytes as BlobPart], { type: mime }) },
    ], '替换配音绑定')
    progress?.(1)
  }

  return {
    enabled: !!handle,

    async write(path, bytes, mime, onProgress) {
      await replace(path, bytes, mime, [], onProgress)
    },

    async remove(path) {
      await removeMany([path])
    },
    replace,
    apply,
    removeMany,
  }
}
