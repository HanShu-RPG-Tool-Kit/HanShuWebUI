import type { ProjectDirectory } from './serviceClient'
export type FileData = string | Uint8Array | Blob
export type FileWriteError = unknown | null
export type FileSink = {
  readonly diskBound: boolean
  write(path: string, data: FileData, options?: {progress?: (ratio: number) => void}): Promise<FileWriteError>
  remove(path: string): Promise<void>
  readText(path: string): Promise<string | null>
  drain(): Promise<void>
}
export type FileSinkOptions = {
  handle: ProjectDirectory | null
  onWriteResult?: (path: string, error: FileWriteError) => void
}
/** Local draft mirrors are independent; authority and atomic writes live in S. */
export function createFileSink(options: FileSinkOptions): FileSink {
  const root = options.handle
  let tail: Promise<void> = Promise.resolve()
  function enqueue<T>(fn: () => Promise<T>) { const run = tail.then(fn); tail = run.then(() => undefined, () => undefined); return run }
  return {
    diskBound: !!root,
    write(path, data, opts) { return enqueue(async () => {
      try {
        if (root) await root.client.apply([{ op: 'write', path: root.resolve(path), data }])
        opts?.progress?.(1); options.onWriteResult?.(path, null); return null
      } catch (e) { options.onWriteResult?.(path,e); return e }
    }) },
    remove(path) { return enqueue(async () => {
      if (!root || !root.client.entry(root.resolve(path))) return
      try { await root.client.apply([{ op: 'remove', path: root.resolve(path) }]); options.onWriteResult?.(path,null) }
      catch (e) { options.onWriteResult?.(path,e); throw e }
    }) },
    async readText(path) { return root ? root.client.text(root.resolve(path)) : null },
    drain: () => tail,
  }
}
