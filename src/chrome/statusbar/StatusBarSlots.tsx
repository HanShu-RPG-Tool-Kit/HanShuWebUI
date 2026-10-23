import { createPortal } from 'react-dom'
import { useSyncExternalStore, type ReactNode } from 'react'
import {
  getStatusBarHosts,
  subscribeStatusBarHosts,
} from './statusBarHosts'

export type StatusBarSlotsProps = {
  /** 仅当前活动工作区应写入槽位 */
  active: boolean
  left?: ReactNode
  right?: ReactNode
}

/**
 * 工作区侧把左右内容 portal 进 App 统一状态栏。
 * `active` 为 false 时不渲染，避免多工作区抢槽。
 */
export function StatusBarSlots({ active, left = null, right = null }: StatusBarSlotsProps) {
  const hosts = useSyncExternalStore(
    subscribeStatusBarHosts,
    getStatusBarHosts,
    getStatusBarHosts,
  )

  if (!active) return null

  return (
    <>
      {hosts.left ? createPortal(left, hosts.left) : null}
      {hosts.right ? createPortal(right, hosts.right) : null}
    </>
  )
}
