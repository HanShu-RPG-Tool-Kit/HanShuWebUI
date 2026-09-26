import type { BoundProject } from '../project'
import { readTextFile, writeTextFile } from '../project/directoryIo'
import type { LangTextSink } from './langTextMap'

/**
 * 语言文本的落盘选择：
 * - 绑定了文件夹工程 → 读写**真实磁盘同级文件** `<剧本名>.lang.<语言标签>`（与剧本同目录）
 * - 未绑定（浏览器虚拟工作区）→ 退回包内虚拟文件
 *
 * 磁盘**读**发生在建映射之前，所以 `LangTextSink` 仍是同步接口。
 * 磁盘**写**是异步的，但按调用顺序**串行**执行：`writeTextFile` 内部有三步 await，
 * 并发写会让落盘顺序变成「完成顺序」，把新内容覆盖成旧快照。
 * 工程模式下每次写还会**镜像进工作区模型**：否则资源管理器里看不到这个文件
 * （它结尾是语言标签、不在后缀白名单里，工程加载另有一处例外判断）。
 * 每次写入的结果通过 `onWriteResult` 上报（成功 null / 失败 error），
 * 失败不影响内存缓存（缓存始终权威），但必须能被界面看见。
 */

export type LangTextSinkTarget = {
  /** 当前绑定的文件夹工程；null = 虚拟工作区 */
  project: BoundProject | null
  /** 语言文本文件名，如 `cp1.lang.zh_cn` */
  fileName: string
  /** 虚拟工作区实现（未绑定工程时使用） */
  virtual: LangTextSink
  /** 每次磁盘写入结束回调：成功传 null，失败传错误；未提供时失败只 console.warn */
  onWriteResult?: (error: unknown | null) => void
}

export async function createLangTextSink(
  target: LangTextSinkTarget,
): Promise<LangTextSink> {
  const { project, fileName, virtual } = target
  if (!project) return virtual

  const handle = project.handle
  const diskText = await readTextFile(handle, fileName)

  const report = (error: unknown | null) => {
    if (target.onWriteResult) target.onWriteResult(error)
    else if (error) console.warn(`[hanshu] 写入语言文本文件失败：${fileName}`, error)
  }

  // 串行队列；每次写各自吞掉失败，避免一次失败毒化后续的写
  let queued: Promise<void> = Promise.resolve()
  const enqueue = (content: string) => {
    queued = queued.then(() =>
      writeTextFile(handle, fileName, content).then(
        () => report(null),
        (error: unknown) => report(error),
      ),
    )
  }

  return {
    // 磁盘上还没有这个文件时，退回虚拟工作区里可能已有的内容
    read: () => diskText ?? virtual.read(),
    // 工程模式：先镜像进工作区模型，再写真实磁盘文件。
    // 镜像让它立刻出现在资源管理器里、也让正常的保存路径认得它；
    // 磁盘写异步串行执行，结果逐次上报。
    write: (content: string) => {
      virtual.write(content)
      enqueue(content)
    },
  }
}
