import type { BoundProject } from '../project'
import { readTextFile } from '../project/directoryIo'
import type { TextSink } from './textMap'

/** Language changes are staged alongside source drafts. Saving the project waits for
 * their local mirrors, then sends source and language changes in one transaction.
 */

export type TextSinkTarget = {
  /** 当前绑定的文件夹工程；null = 虚拟工作区 */
  project: BoundProject | null
  /** 语言文本的包内相对路径，如 `assets/zh_cn/lang_hs/folder/cp1.lang` */
  fileName: string
  /** 虚拟工作区实现（未绑定工程时使用） */
  virtual: Omit<TextSink, 'write'> & { write(content: string): void | Promise<void> }
  /** 本地镜像完成回调；提交状态由工程事务层统一展示。 */
  onWriteResult?: (error: unknown | null) => void
}

export async function createTextSink(
  target: TextSinkTarget,
): Promise<TextSink> {
  const { project, fileName, virtual } = target
  if (!project) return virtual

  const handle = project.handle
  const diskText = handle.client.transactions.stagedText(handle.resolve(fileName)) ?? await readTextFile(handle, fileName)

  return {
    // 磁盘上还没有这个文件时，退回虚拟工作区里可能已有的内容
    read: () => handle.client.transactions.stagedText(handle.resolve(fileName)) ?? diskText ?? virtual.read(),
    // No independent server write: this translation may be referenced by unsaved source.
    write: (content: string) => {
      handle.client.transactions.stageWrite({ op: 'write', path: handle.resolve(fileName), data: content }, async () => {
        try { await virtual.write(content); target.onWriteResult?.(null) }
        catch (error) { target.onWriteResult?.(error); throw error }
      })
    },
  }
}
