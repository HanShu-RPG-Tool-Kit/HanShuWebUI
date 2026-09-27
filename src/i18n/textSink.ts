import type { BoundProject } from '../project'
import { readTextFile } from '../project/directoryIo'
import { createFileSink } from '../project/fileSink'
import type { TextSink } from './textMap'

/**
 * 语言文本的落盘选择：
 * - 绑定了文件夹工程 → 读写**真实磁盘文件** `assets/<语言标签>/lang_<后缀>/<脚本目录>/<剧本名>.lang`
 *   （路径由 `localeLayout` 统一给出，不再与剧本同级）
 * - 未绑定（浏览器虚拟工作区）→ 退回包内虚拟文件（同一个包内相对路径）
 *
 * 磁盘**读**发生在建映射之前，所以 `TextSink` 仍是同步接口。
 * 磁盘**写**交给通用写盘层 `fileSink`：串行队列 + 写前申请权限 + `.new` → 删旧 → 改名
 * 的原子替换（改值改到一半崩了不会把语言文件截断）。
 *
 * 工程模式下每次写还会**镜像进工作区模型**：否则资源管理器里看不到这个文件
 * （它结尾是语言标签、不在后缀白名单里，工程加载另有一处例外判断）。
 * 每次写入的结果通过 `onWriteResult` 上报（成功 null / 失败 error），
 * 失败不影响内存缓存（缓存始终权威），但必须能被界面看见。
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
