import {
  ensureReadWritePermission,
  readFileAtPath,
  removeEntryIfExists,
  resolveParentDir,
  writeFileAtPath,
} from './directoryIo'

/**
 * 通用**写盘层**：以后凡是要把某个文件写进「工程目录」的需求，都走这里。
 *
 * 它把每次都会忘、漏一次就出一次事故的几件事一次做对：
 * 1. **权限**：写前 `ensureReadWritePermission`（结果缓存）。冷启动恢复出来的句柄常常是
 *    `prompt` 状态，直接写会 `NotAllowedError`；这里有用户手势时能弹出授权框，拿不到就
 *    如实上报 —— 不静默失败。
 * 2. **原子替换**：默认 `.new` → 删旧 → 改名。`FileSystemFileHandle.move()` 优先（同卷改名
 *    原子），**它抛错或运行时不支持**都降级为「复制到最终名 + 删 `.new`」，绝不会停在
 *    「旧文件已删、只剩 `.new`」。
 * 3. **串行队列**：同一个 sink 的写按调用顺序落盘。并发写会让落盘顺序变成"完成顺序"，
 *    把新内容覆盖成旧快照。
 * 4. **未绑定工程**：`handle` 为 null 时是 no-op 且**不算失败**，同时用 `diskBound` 让界面
 *    能说明"只写进了应用内资源"。
 *
 * 不负责"镜像"（写工作区模型 / IndexedDB）：那是调用方的事，而且必须**先于**磁盘写发生 ——
 * 这样内存态立刻正确，磁盘失败也不必回滚。语言的 `.lang`、配音的 `.ogg`、以后任何新文件
 * 都是同一套用法。
 */

/** 写盘内容 */
export type FileData = string | Uint8Array | Blob

/** 中间文件后缀 */
export const FILE_SINK_TEMP_SUFFIX = '.new'

/** 一次写盘的结果：成功 null，失败为错误对象 */
export type FileWriteError = unknown | null

export type FileSink = {
  /** 是否真的绑定到了磁盘（false = 虚拟工作区，写是 no-op） */
  readonly diskBound: boolean
  /**
   * 写一个文件（权限 + 原子替换 + 串行 + 上报）。
   * 未绑定工程时立刻以 null 结束。`progress` 报 0..1（仅磁盘这一段）。
   */
  write(
    path: string,
    data: FileData,
    options?: { progress?: (ratio: number) => void },
  ): Promise<FileWriteError>
  /** 删文件（连同可能的 `.new` 残留） */
  remove(path: string): Promise<void>
  /** 从磁盘读文本（不存在返回 null） */
  readText(path: string): Promise<string | null>
  /** 等当前队列排空（测试 / 保存流程用） */
  drain(): Promise<void>
}

export type FileSinkOptions = {
  /** 工程根目录；null = 虚拟工作区 */
  handle: FileSystemDirectoryHandle | null
  /** 每次写盘结束回调：成功 error 为 null */
  onWriteResult?: (path: string, error: FileWriteError) => void
  /** 是否用 `.new → 删旧 → 改名` 原子替换（默认 true） */
  atomic?: boolean
  /** 中间文件后缀（默认 `.new`） */
  tempSuffix?: string
}

type MovableFileHandle = FileSystemFileHandle & {
  move?: (name: string) => Promise<void>
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? path
}

/** `writeFileAtPath` 只吃 string | Blob：字节统一包成 Blob */
function toWritable(data: FileData): string | Blob {
  return data instanceof Uint8Array ? new Blob([data as BlobPart]) : data
}

/** `removeEntryIfExists` 收的是「目录 + 文件名」，这里按相对路径解析过去 */
async function removePath(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<void> {
  try {
    const { parent, fileName } = await resolveParentDir(root, relativePath)
    await removeEntryIfExists(parent, fileName)
  } catch {
    // 父目录都不存在 → 本来就没有这个文件
  }
}

/** `.new` → 最终名：`move` 优先，失败/不支持则复制 + 删 */
async function promote(
  root: FileSystemDirectoryHandle,
  from: string,
  to: string,
): Promise<void> {
  const { parent, fileName } = await resolveParentDir(root, from)
  let handle: MovableFileHandle | null = null
  try {
    handle = (await parent.getFileHandle(fileName)) as MovableFileHandle
  } catch {
    handle = null
  }

  if (handle && typeof handle.move === 'function') {
    try {
      await handle.move(baseName(to))
      return
    } catch {
      // move 不被支持 / 目标已存在 / 被拒：落到复制降级
    }
  }

  const data = await readFileAtPath(root, from)
  if (data) await writeFileAtPath(root, to, data)
  await removePath(root, from)
}

export function createFileSink(options: FileSinkOptions): FileSink {
  const root = options.handle
  const atomic = options.atomic !== false
  const tempSuffix = options.tempSuffix ?? FILE_SINK_TEMP_SUFFIX

  /** 串行队列：写按调用顺序落盘（失败不毒化后续） */
  let tail: Promise<void> = Promise.resolve()
  /** 权限只问一次；失败后下次重问（用户可能刚授权） */
  let permissionGranted = false

  const ensurePermission = async (): Promise<boolean> => {
    if (permissionGranted) return true
    if (!root) return false
    permissionGranted = await ensureReadWritePermission(root)
    return permissionGranted
  }

  const performWrite = async (
    path: string,
    data: FileData,
    progress?: (ratio: number) => void,
  ): Promise<FileWriteError> => {
    if (!root) {
      progress?.(1)
      return null
    }
    try {
      if (!(await ensurePermission())) {
        throw new Error('未获得文件夹读写权限')
      }
      progress?.(0)

      if (!atomic) {
        await writeFileAtPath(root, path, toWritable(data))
        progress?.(1)
        return null
      }

      const tempPath = `${path}${tempSuffix}`
      // 写入前就存在 `.new`：直接删掉重写（让重试幂等）
      await removePath(root, tempPath)
      progress?.(0.2)

      // 先落 `.new`：这一步完成前，旧文件一直有效
      await writeFileAtPath(root, tempPath, toWritable(data))
      progress?.(0.6)

      // 删旧
      await removePath(root, path)
      progress?.(0.8)

      // 改名就位
      await promote(root, tempPath, path)
      progress?.(1)
      return null
    } catch (error) {
      // 权限刚失败过：下次重问一次，避免整会话卡在"没权限"
      permissionGranted = false
      return error
    }
  }

  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    diskBound: root != null,

    write(path, data, writeOptions) {
      return enqueue(async () => {
        const error = await performWrite(path, data, writeOptions?.progress)
        options.onWriteResult?.(path, error)
        return error
      })
    },

    async remove(path) {
      if (!root) return
      await enqueue(async () => {
        if (!(await ensurePermission())) {
          options.onWriteResult?.(path, new Error('未获得文件夹读写权限'))
          return
        }
        await removePath(root, path)
        await removePath(root, `${path}${tempSuffix}`)
        options.onWriteResult?.(path, null)
      })
    },

    async readText(path) {
      if (!root) return null
      const file = await readFileAtPath(root, path)
      return file ? file.text() : null
    },

    drain: () => tail,
  }
}
