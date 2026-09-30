/**
 * 工程内存包的只读快照 —— 工具工作区靠它**读到最新内容**。
 *
 * 为什么需要它:工具工作区(配音服务 / 配音方案)要读包内文件,但包的状态住在
 * `ScriptWorkspace` 里。用 ref 在渲染期去问它,是明确的不良模式(React 不保证那时
 * 拿到最新值,编译器也会因此跳过这些组件);在 effect 里 setState 同样被点名。
 *
 * 工程包就是一个**外部系统**,所以用 `useSyncExternalStore` —— 这正是它的用途。
 * 和 `project/bindingBus` 是同一个模式,只是订阅的东西不同。
 *
 * **只读。** 写入仍然走 `ScriptWorkspaceHandle.writePackageText`,不在这里开第二条路。
 */

import { useSyncExternalStore } from 'react'
import type { Workspace } from '../workspace'

export type PackageFile = { name: string; content: string }

/**
 * 快照本身。**引用必须稳定**:`getSnapshot` 在每次渲染都会被调用,
 * 返回新数组会让 React 认为一直在变,于是无限重渲染。所以只在发布时整体换掉。
 */
let snapshot: readonly PackageFile[] = []

const listeners = new Set<() => void>()

export function getPackageSnapshot(): readonly PackageFile[] {
  return snapshot
}

export function subscribePackage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishPackageSnapshot(files: readonly PackageFile[]): void {
  snapshot = files
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('package snapshot listener failed', error)
    }
  }
}

/**
 * 订阅快照。
 *
 * 服务端快照也传同一个函数：这些工作区只在浏览器里跑，没有服务端渲染这一回事，
 * 给一个假的服务端版本只会掩盖问题。
 */
export function usePackageSnapshot(): readonly PackageFile[] {
  return useSyncExternalStore(subscribePackage, getPackageSnapshot, getPackageSnapshot)
}

/** 由工程状态拍一张快照 */
export function packageSnapshotOf(workspace: Workspace): PackageFile[] {
  return workspace.packages.flatMap((pkg) =>
    pkg.scripts.map((script) => ({ name: script.name, content: script.content })),
  )
}
