import type { BoundProject } from '../project'
import { readTextFile } from '../project/directoryIo'
import { createFileSink } from '../project/fileSink'
import type { TextSink } from './textMap'

/** Language drafts are mirrored into C's resource model and submitted through FileSink.
 * S validates identity, the source document's write authority and the read version before persisting.
 * A failed submission retains the local draft and is reported through onWriteResult.
 */

export type TextSinkTarget = {
  /** 当前绑定的文件夹工程；null = 虚拟工作区 */
  project: BoundProject | null
  /** 语言文本的包内相对路径，如 `assets/zh_cn/lang_hs/folder/cp1.lang` */
  fileName: string
  /** 虚拟工作区实现（未绑定工程时使用） */
  virtual: TextSink
  /** 每次磁盘写入结束回调：成功传 null，失败传错误；未提供时失败只 console.warn */
  onWriteResult?: (error: unknown | null) => void
}

export async function createTextSink(
  target: TextSinkTarget,
): Promise<TextSink> {
  const { project, fileName, virtual } = target
  if (!project) return virtual

  const handle = project.handle
  const diskText = await readTextFile(handle, fileName)

  const sink = createFileSink({
    handle,
    onWriteResult: (_path, error) => {
      if (target.onWriteResult) target.onWriteResult(error)
      else if (error) console.warn(`[hanshu] 写入语言文本文件失败：${fileName}`, error)
    },
  })

  return {
    // 磁盘上还没有这个文件时，退回虚拟工作区里可能已有的内容
    read: () => diskText ?? virtual.read(),
    // 工程模式：先镜像进工作区模型（同步、立刻生效），再交给写盘层落盘
    write: (content: string) => {
      virtual.write(content)
      void sink.write(fileName, content)
    },
  }
}
