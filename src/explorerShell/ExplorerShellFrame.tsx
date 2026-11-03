import type { ReactNode } from 'react'
import { dockTitleHint, type ExplorerDockProps } from './shellModel'

/** 各工作区沿用自己的皮肤类名；壳只统一结构与行为。 */
export type ExplorerShellClasses = {
  root: string
  heading: string
  title?: string
  tools: string
  redock?: string
}

const INTERACTIVE = 'button, input, label, a, textarea, select'

/**
 * 资源管理器外框：标题栏（dock 拖动、停靠回边缘、工具按钮）+ 正文。
 * 树、菜单、领域视图都由调用方放进 `children`；外框不认识任何资源类型。
 */
export function ExplorerShellFrame({
  label,
  title = '资源管理器',
  titleTag = 'strong',
  classes,
  dock,
  tools,
  children,
}: {
  label: string
  title?: string
  titleTag?: 'strong' | 'span'
  classes: ExplorerShellClasses
  dock: ExplorerDockProps
  tools?: ReactNode
  children: ReactNode
}) {
  const Title = titleTag
  return (
    <aside className={classes.root} aria-label={label}>
      <div
        className={`${classes.heading}${dock.onTitlePointerDown ? ' is-draggable' : ''}`}
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return
          dock.onTitlePointerDown?.(event)
        }}
      >
        <Title className={classes.title} title={dockTitleHint(dock)}>
          {title}
        </Title>
        <div className={classes.tools}>
          {dock.onRedock && (
            <button
              type="button"
              className={classes.redock ?? 'panel-dock-redock'}
              title="停靠回上次的边缘"
              onClick={dock.onRedock}
            >
              停靠
            </button>
          )}
          {tools}
        </div>
      </div>
      {children}
    </aside>
  )
}
