import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { DockPlacement } from './PanelDock'

export interface DockPanelTitleProps {
  title: string
  placement: DockPlacement
  onTitlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onRedock?: () => void
  children?: ReactNode
}

/** Draggable column title for PanelDock. Interactive controls in the title are not drag handles. */
export function DockPanelTitle({
  title,
  placement,
  onTitlePointerDown,
  onRedock,
  children,
}: DockPanelTitleProps) {
  return (
    <div
      className="dock-panel-title is-draggable"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        if (
          event.target instanceof Element &&
          event.target.closest('button, input, label, a, textarea, select')
        ) {
          return
        }
        onTitlePointerDown(event)
      }}
    >
      <span
        className="dock-panel-title-text"
        title={
          placement === 'float'
            ? '拖动标题可停靠到边缘；松手在中间则保持弹层'
            : '拖动标题可停靠到左、右、上、下，拖到中间变成弹层，拖到其他栏目边缘可并排或合并'
        }
      >
        {title}
      </span>
      {children}
      {onRedock && (
        <button type="button" className="panel-dock-redock" title="停靠回上次的边缘" onClick={onRedock}>
          停靠
        </button>
      )}
    </div>
  )
}
