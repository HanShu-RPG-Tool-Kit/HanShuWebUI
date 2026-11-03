import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { explorerRowClassName, type ExplorerRowState } from './shellModel'

/**
 * 资源树的一行：缩进、展开箭头、图标、名称槽。选择、拖拽 MIME、菜单内容由调用方经事件处理器决定。
 * `expanded` 省略表示叶子行。
 */
export function ExplorerTreeRow({
  rowRef,
  depth,
  indent = 10,
  baseIndent = 6,
  expanded,
  classes,
  state,
  icon,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style' | 'role' | 'children'> & {
  rowRef?: Ref<HTMLDivElement>
  depth: number
  indent?: number
  baseIndent?: number
  expanded?: boolean
  classes: { row: string; twist: string }
  state?: ExplorerRowState
  icon: ReactNode
  draggable?: boolean
  children: ReactNode
}) {
  return (
    <div
      {...rest}
      ref={rowRef}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expanded}
      aria-selected={state?.selected ?? false}
      className={explorerRowClassName(classes.row, state)}
      style={{ paddingLeft: baseIndent + depth * indent }}
    >
      <span className={classes.twist} aria-hidden>
        {expanded === undefined ? '' : expanded ? '▾' : '▸'}
      </span>
      {icon}
      {children}
    </div>
  )
}
