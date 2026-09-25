import type { BoundProject } from '../project'
import { readTextFile, writeTextFile } from '../project/directoryIo'
import type { LangTextSink } from './langTextMap'

/**
 * 语言文本的落盘选择：
 * - 绑定了文件夹工程 → 读写**真实磁盘同级文件** `<剧本名>.lang.<语言标签>`（与剧本同目录）
 * - 未绑定（浏览器虚拟工作区）→ 退回包内虚拟文件
 *
 * 磁盘**读**发生在建映射之前，所以 `LangTextSink` 仍是同步接口；
 * 磁盘**写**是异步的，失败只告警，不影响内存缓存（缓存始终是权威）。
 */

export type LangTextSinkTarget = {
  /** 当前绑定的文件夹工程；null = 虚拟工作区 */
  project: BoundProject | null
  /** 语言文本文件名，如 `cp1.lang.zh_cn` */
  fileName: string
  /** 虚拟工作区实现（未绑定工程时使用） */
  virtual: LangTextSink
  /** 磁盘写入失败回调（默认 console.warn） */
  onWriteError?: (error: unknown) => void
}

export async function createLangTextSink(
  target: LangTextSinkTarget,
): Promise<LangTextSink> {
  const { project, fileName, virtual } = target
  if (!project) return virtual

  const handle = project.handle
  const diskText = await readTextFile(handle, fileName)

  return {
    // 磁盘上还没有这个文件时，退回虚拟工作区里可能已有的内容
    read: () => diskText ?? virtual.read(),
    write: (content: string) => {
      void writeTextFile(handle, fileName, content).catch((error: unknown) => {
        if (target.onWriteError) target.onWriteError(error)
        else console.warn(`[hanshu] 写入语言文本文件失败：${fileName}`, error)
      })
    },
  }
}
