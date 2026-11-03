import type { PointerEvent as ReactPointerEvent } from 'react'
import type { DockPlacement } from '../ui/panelDockModel'

/** PanelDock 交给资源管理器的标题栏接线；三端共用同一套拖动 / 停靠语义。 */
export type ExplorerDockProps = {
  placement?: DockPlacement
  onTitlePointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
  onRedock?: () => void
}

export function dockTitleHint(dock: ExplorerDockProps): string {
  if (!dock.onTitlePointerDown) return '资源管理器'
  return dock.placement === 'float'
    ? '拖动标题可停靠到边缘；松手在中间则保持弹层'
    : '拖动标题可停靠到左、右、上、下，拖到中间变成弹层'
}

export type ExplorerRowState = {
  selected?: boolean
  /** 当前编辑器打开的资源 */
  open?: boolean
  dropTarget?: boolean
  /** 只读视图项（内置、固定分类、表视图等） */
  builtin?: boolean
  detached?: boolean
}

/** 状态类名固定，各工作区皮肤按同一组名字着色。 */
export function explorerRowClassName(base: string, state: ExplorerRowState = {}): string {
  return `${base}${state.selected ? ' selected' : ''}${state.open ? ' is-open' : ''}${state.dropTarget ? ' drop-target' : ''}${state.builtin ? ' is-builtin' : ''}${state.detached ? ' is-detached' : ''}`
}
