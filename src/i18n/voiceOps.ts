/**
 * 配音资产的**写、删、引用** —— 与界面无关的那一半。
 *
 * 这些逻辑原先住在 `ScriptWorkspace`（三千九百多行的组件）里，只因为要取
 * `workspaceRef` / `commitWorkspace` / `activePackage` 这几个闭包变量。
 * 但它们是**领域逻辑**，不是界面逻辑：
 * - 「一个键只有一个来源」这条规矩（写 `.ogg` 清 `.ref`，写 `.ref` 清 `.ogg`）；
 * - 写引用 = 对等位置一个 `.ref` 文本，**不拷贝字节**；
 * - 删除要连**磁盘副本**一起删 —— 否则重开工程会被 `loadAssetsFromDisk` 读回来；
 * - 删除引用**只解除引用**，被引用的那份音频是共享的，不动。
 *
 * 宿主（组件）通过 `VoiceOpsHost` 注入那几件它才做得到的事：读/提交工作区、
 * 取活动包、拿工程句柄、报进度与提示。这样这套逻辑可以脱离 React 单独推理，
 * 而组件里只剩接线。
 */

import { deleteAssetBlob, putAssetBlob } from '../assets/idb'
import { isAudioAsset, normalizeAssetPath } from '../assets/paths'
import { createVoiceDiskSink } from '../project/voiceDiskSink'
import {
  registerAsset,
  removeAssetMeta,
  type AssetFile,
  type Workspace,
} from '../workspace'
import { stringifyVoiceRefContent } from './voiceMap'
import type { VoiceLibrary } from './voiceLibrary'

/** 活动包：这几个操作都只作用在它上面 */
export type VoiceOpsPackage = { id: string; assets: readonly AssetFile[] }

export type VoiceOpsHost = {
  /** 当前工作区（**每次现取**：写操作会一路替换它，缓存住就会覆盖掉别人刚提交的改动） */
  getWorkspace(): Workspace
  /** 提交新工作区 */
  commit(next: Workspace): void
  /** 当前活动包；没有就返回 null */
  activePackage(): VoiceOpsPackage | null
  /** 已绑定的工程目录句柄（null = 虚拟工作区，磁盘写穿是 no-op） */
  projectHandle(): FileSystemDirectoryHandle | null
  /** 当前配音库；没有（不是剧本）就 null */
  library(): VoiceLibrary | null
  /** 配音相关资产变更后，让解析层与编辑器按钮刷新 */
  refresh(): void
  /** 一条轻提示（录音棚与资源管理器共用那条） */
  notify(message: string, ok: boolean): void
}

export type VoiceOps = {
  /**
   * 彻底删掉一批资产：blob + 磁盘副本（元数据由调用方先删）。
   *
   * 三步缺一不可，尤其磁盘那步：配音是写穿到工程目录的，只删应用内的话，
   * **下次打开工程又会被读回来**（`loadAssetsFromDisk` 扫整个 `assets/`），
   * 表现就是"删了没删掉"。
   *
   * 磁盘失败只 `console.warn` 不回滚：IndexedDB 是权威，「保存工程」还会整树重写磁盘。
   */
  removeAssetEverywhere(packageId: string, paths: readonly string[]): void
  /** 清掉某个键对等位置上**另一种形式**的绑定（写 `.ogg` 前清 `.ref`，反之亦然） */
  clearPeerBindingOf(key: string, keep: 'file' | 'ref'): void
  /** 把一个或多个键的配音设成「引用资产」（对等位置写 `.ref`，不拷贝字节） */
  referenceForKeys(keys: string[], targetPath: string): void
  /** 删掉某个键的配音：**绑定文件本身**（实文件删 `.ogg`，引用只删 `.ref`） */
  deleteVoice(key: string): boolean
  /** 菜单里的「删除配音」：带确认（引用与实文件两种文案） */
  confirmAndDeleteVoice(key: string): void
  /** 录音棚的「清除配音」：一次确认，逐个删 */
  deleteVoices(keys: string[]): void
}

export function createVoiceOps(host: VoiceOpsHost): VoiceOps {
  /**
   * 清掉某个键对等位置上**另一种形式**的绑定。
   *
   * 一个键的对等基名只有一份语义（见 voiceMap：`.ogg` 优先、`.ref` 兜底），所以：
   * - 导入 / 录音 / 合成写 `.ogg` 之前，先把同基名的 `.ref` 清掉；
   * - 写 `.ref` 之前，先把同基名的 `.ogg` 清掉。
   *
   * 不清的后果是"两个来源同时存在"：解析按 `.ogg` 优先，于是用户以为改了引用、其实没生效，
   * 或者反过来 —— 这类幽灵绑定最难查，所以在这里一次做干净（元数据 + blob + 磁盘副本）。
   */
  const clearPeerBindingOf = (key: string, keep: 'file' | 'ref'): void => {
    const library = host.library()
    const pkg = host.activePackage()
    if (!library || !pkg) return

    const peerPath =
      keep === 'ref'
        ? library.targetPathOf(key) // 要留引用 → 清同基名的 `.ogg`
        : library.refPathOf(key) // 要留实文件 → 清同基名的 `.ref`
    const wanted = peerPath.toLowerCase()
    const asset = pkg.assets.find((item) => item.path.toLowerCase() === wanted)
    if (!asset) return

    host.commit(removeAssetMeta(host.getWorkspace(), asset.id))
    removeAssetEverywhere(pkg.id, [asset.path])
  }

  const removeAssetEverywhere = (
    packageId: string,
    paths: readonly string[],
  ): void => {
    if (paths.length === 0) return
    const sink = createVoiceDiskSink(host.projectHandle(), (failedPath, error) => {
      if (error) {
        console.warn('[hanshu] 没能删掉磁盘上的资产文件：', failedPath, error)
      }
    })
    for (const path of paths) {
      void deleteAssetBlob(packageId, path)
      void sink.remove(path)
    }
  }

  /**
   * 把一个或多个键的配音设成**「引用资产」**：对等位置上写一个 `.ref`，正文是目标音频路径。
   *
   * 与音频导入的区别：**不转码、不搬字节** —— 被引用的那份音频就留在原处，
   * 键只是指向它。所以同一份音频可以被多个键引用而不产生多份拷贝。
   *
   * 目标必须是**本包内**的音频资产：跨包引用在这里做不到（资产按包存，
   * 解析也只看当前包，见 voiceMap 的 describeRefTarget）。
   */
  const referenceForKeys = (keys: string[], targetPath: string): void => {
    const library = host.library()
    const pkg = host.activePackage()
    if (!library || !pkg || keys.length === 0) return

    const target = normalizeAssetPath(targetPath)
    const asset = target
      ? pkg.assets.find((item) => item.path.toLowerCase() === target.toLowerCase())
      : null
    if (!asset || !isAudioAsset(asset.path, asset.mime)) {
      window.alert(
        `引用的目标必须是本包内的音频资产。\n当前：${targetPath}\n` +
          '（跨包引用、指向文本或图片都不行）',
      )
      return
    }

    const content = stringifyVoiceRefContent(asset.path)
    const bytes = new TextEncoder().encode(content)
    const blob = new Blob([bytes as BlobPart], { type: 'text/plain' })
    const sink = createVoiceDiskSink(host.projectHandle(), (failedPath, error) => {
      if (!error) return
      console.warn('[hanshu] 引用文件写入磁盘失败', failedPath, error)
    })

    void (async () => {
      for (const key of keys) {
        // 先清掉同基名的 `.ogg`：一个键只该有一个来源（见 clearPeerBindingOf）
        clearPeerBindingOf(key, 'ref')

        const refPath = library.refPathOf(key)
        await putAssetBlob(pkg.id, refPath, blob)

        /*
         * 每次都从**当前**工作区出发：上面那步 `clearPeerBindingOf` 刚提交过一次，
         * 用循环外捕获的旧引用去写会把刚清掉的 `.ogg` 元数据又带回来。
         * 目标路径随元数据一起记下：配音四态是**同步**判定的，不能等到读文件才知道指向谁。
         */
        const result = registerAsset(
          host.getWorkspace(),
          pkg.id,
          refPath,
          'text/plain',
          blob.size,
          asset.path,
        )
        if (result) host.commit(result.workspace)
        if (sink.enabled) await sink.write(refPath, bytes, 'text/plain')
      }

      host.refresh()
      const shown = keys.length === 1 ? `「${keys[0]}」` : `${keys.length} 个键`
      host.notify(`已把 ${shown} 的配音设为引用：${asset.path}`, true)
    })()
  }

  /**
   * 删除某个键的配音（**不做确认**，只是动作本身）。
   *
   * 删的是 `status.path` —— **绑定文件本身**：实文件删 `.ogg`，引用就只删 `.ref`，
   * 被引用的那份音频留在原地（别的键可能还在用它）。
   */
  const deleteVoice = (key: string): boolean => {
    const library = host.library()
    const pkg = host.activePackage()
    if (!library || !pkg) return false
    const status = library.statusOf(key)
    const path = status.path
    if (!path) return false

    // 正在播就先停掉，否则播的是已经被删掉的音频
    if (status.state === 'playing') library.togglePlay(key)

    const asset = pkg.assets.find(
      (item) => item.path.toLowerCase() === path.toLowerCase(),
    )
    if (asset) {
      host.commit(removeAssetMeta(host.getWorkspace(), asset.id))
    }
    // 元数据 + blob + 磁盘副本：删掉才算真的删了（见 removeAssetEverywhere）
    removeAssetEverywhere(pkg.id, [path])
    return true
  }

  /**
   * 删除某个键的配音（右键菜单 Delete Voice）。
   *
   * 两种确认文案：正常情况就是删这个文件；若它是靠"同名回落"从别的目录解析到的，
   * 说明可能有其它脚本的键也在用它，得说清楚影响面。
   */
  const confirmAndDeleteVoice = (key: string): void => {
    const library = host.library()
    if (!library) return
    const status = library.statusOf(key)
    const path = status.path
    if (!path) return

    const targetPath = library.targetPathOf(key)
    const refPath = library.refPathOf(key)
    // 对等位置上那两种写法都算"这个键自己的绑定"：`.ogg` 是实文件，`.ref` 是引用
    const atPeer =
      path.toLowerCase() === targetPath.toLowerCase() ||
      path.toLowerCase() === refPath.toLowerCase()
    if (atPeer) {
      const what = status.source === 'ref' ? '引用' : '配音'
      // 引用的删除**只解除引用**：被引用的那份音频是共享的，别的键可能还在用
      const extra =
        status.source === 'ref'
          ? `\n（只解除引用，不会删掉它指向的音频${
              status.audioPath ? `：${status.audioPath}` : ''
            }）`
          : ''
      if (!window.confirm(`删除${what}「${path}」？${extra}`)) return
    } else if (
      !window.confirm(
        `该配音来自其它目录：${path}\n删除会影响所有引用它的键，确定删除？`,
      )
    ) {
      return
    }

    deleteVoice(key)
  }

  /** 录音棚：清除选中键名的配音（一次确认，逐个删） */
  const deleteVoices = (keys: string[]): void => {
    const library = host.library()
    if (!library || keys.length === 0) return
    const withVoice = keys.filter((key) => library.statusOf(key).path != null)
    if (withVoice.length === 0) {
      window.alert('选中的键都没有配音文件，没什么可清除的')
      return
    }
    const refCount = withVoice.filter(
      (key) => library.statusOf(key).source === 'ref',
    ).length
    if (
      !window.confirm(
        `清除 ${withVoice.length} 个键的配音？\n（对等文件会从应用内资源与工程文件夹一起删掉）` +
          (refCount > 0
            ? `\n（其中 ${refCount} 个是引用：只解除引用，被引用的音频不动）`
            : ''),
      )
    ) {
      return
    }
    for (const key of withVoice) deleteVoice(key)
  }

  return {
    removeAssetEverywhere,
    clearPeerBindingOf,
    referenceForKeys,
    deleteVoice,
    confirmAndDeleteVoice,
    deleteVoices,
  }
}
