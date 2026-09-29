import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { branches, displayText, type ProgressFlow, type FlowSelection } from './model'
import { NodeContextMenu } from './NodeContextMenu'
import './ProgressGraph.css'

type TreeView = { id: string; root: string; nodes: ProgressFlow['nodes']; edges: ReturnType<typeof treeView>['edges'] }
function treeView(flow: ProgressFlow) {
  return { id: flow.id, root: flow.root, nodes: flow.nodes, edges: branches(flow).map(({ parent, branch }) => ({ id: branch.id, from: parent, to: branch.target, label: displayText(branch.title), conditions: branch.conditions.items, unconditional: !branch.conditions.items.length, conditionMode: branch.conditions.mode, trigger: branch.trigger })) }
}

type Position = { x: number; y: number; reachable: boolean }

const NODE_WIDTH = 190
const NODE_HEIGHT = 108
const COLUMN_WIDTH = 386
const ROW_HEIGHT = 158
const PADDING = 40

/** A spanning forest keeps partially edited graphs finite, including cycles and missing endpoints. */
function layoutTree(tree: TreeView) {
  const ids = Object.keys(tree.nodes)
  const known = new Set(ids)
  const outgoing = new Map(ids.map((id) => [id, [] as number[]]))
  const incoming = new Map(ids.map((id) => [id, 0]))
  tree.edges.forEach((edge, index) => {
    outgoing.get(edge.from)?.push(index)
    if (known.has(edge.from) && known.has(edge.to)) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  })

  const roots: string[] = []
  const children = new Map(ids.map((id) => [id, [] as string[]]))
  const depth = new Map<string, number>()
  const reachable = new Set<string>()
  const treeEdges = new Set<number>()
  const candidates = [tree.root, ...ids.filter((id) => incoming.get(id) === 0), ...ids]
  for (const root of candidates) {
    if (!known.has(root) || depth.has(root)) continue
    roots.push(root)
    depth.set(root, 0)
    const isReachable = root === tree.root
    const queue = [root]
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor]
      if (isReachable) reachable.add(id)
      for (const index of outgoing.get(id) ?? []) {
        const target = tree.edges[index].to
        if (!known.has(target) || depth.has(target)) continue
        depth.set(target, (depth.get(id) ?? 0) + 1)
        children.get(id)?.push(target)
        treeEdges.add(index)
        queue.push(target)
      }
    }
  }

  const positions = new Map<string, Position>()
  let nextRow = 0
  let width = 480
  let height = 240
  for (const root of roots) {
    const stack = [{ id: root, expanded: false }]
    while (stack.length > 0) {
      const entry = stack.pop()!
      const childIds = children.get(entry.id) ?? []
      if (!entry.expanded && childIds.length > 0) {
        stack.push({ id: entry.id, expanded: true })
        for (let i = childIds.length - 1; i >= 0; i--) stack.push({ id: childIds[i], expanded: false })
        continue
      }
      const y = childIds.length > 0
        ? (positions.get(childIds[0])!.y + positions.get(childIds[childIds.length - 1])!.y) / 2
        : PADDING + nextRow++ * ROW_HEIGHT
      const x = PADDING + (depth.get(entry.id) ?? 0) * COLUMN_WIDTH
      positions.set(entry.id, { x, y, reachable: reachable.has(entry.id) })
      width = Math.max(width, x + NODE_WIDTH + PADDING)
      height = Math.max(height, y + NODE_HEIGHT + PADDING)
    }
    nextRow++
  }

  return { ids, positions, outgoing, treeEdges, width, height }
}

function graphPath(from: Position, to: Position, tree: boolean) {
  const sx = from.x + NODE_WIDTH
  const sy = from.y + NODE_HEIGHT / 2
  const tx = to.x
  const ty = to.y + NODE_HEIGHT / 2
  if (tree) return `M ${sx} ${sy} C ${sx + 24} ${sy}, ${sx + 24} ${ty}, ${sx + 54} ${ty} L ${tx} ${ty}`
  if (from === to) return `M ${sx} ${sy - 20} C ${sx + 90} ${sy - 100}, ${sx + 90} ${sy + 100}, ${sx} ${sy + 20}`
  const bend = Math.max(from.y, to.y) + NODE_HEIGHT + 28
  return `M ${sx - 24} ${from.y + NODE_HEIGHT} C ${sx - 24} ${bend}, ${tx + 24} ${bend}, ${tx + 24} ${to.y + NODE_HEIGHT}`
}

export function ProgressGraph({ flow, selection, onSelect, onAddNext, onSetCompletion, active, disabled = false }: {
  flow: ProgressFlow
  selection: FlowSelection
  onSelect: (selection: FlowSelection) => void
  onAddNext: (parent: string) => void
  onSetCompletion: (id: string, finish: boolean) => void
  active: boolean
  disabled?: boolean
}) {
  const tree = useMemo(() => treeView(flow), [flow])
  const [zoom, setZoom] = useState(1)
  const [context, setContext] = useState<{ flow: ProgressFlow; id: string; x: number; y: number; origin: HTMLButtonElement } | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const nodeElements = useRef(new Map<string, HTMLButtonElement>())
  const lastSelection = useRef('')
  const lastZoom = useRef(1)
  const displayedFlow = useRef<string | null>(null)
  const markerId = useId().replace(/:/g, '')
  const layout = useMemo(() => layoutTree(tree), [tree])
  const extraEdges = tree.edges.map((edge, index) => ({ edge, index })).filter(({ index }) => !layout.treeEdges.has(index))
  const menuContext = active && !disabled && context?.flow === flow ? context : null
  const menuNode = menuContext ? flow.nodes[menuContext.id] : undefined

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    if (displayedFlow.current !== tree.id) {
      displayedFlow.current = tree.id
      const root = layout.positions.get(tree.root)
      element.scrollLeft = 0
      element.scrollTop = root ? Math.max(0, (root.y + NODE_HEIGHT / 2) * zoom - element.clientHeight / 2) : 0
    } else if (lastZoom.current !== zoom) {
      const ratio = zoom / lastZoom.current
      element.scrollLeft = (element.scrollLeft + element.clientWidth / 2) * ratio - element.clientWidth / 2
      element.scrollTop = (element.scrollTop + element.clientHeight / 2) * ratio - element.clientHeight / 2
    }
    lastZoom.current = zoom
  }, [tree.id, tree.root, layout, zoom])

  useLayoutEffect(() => {
    if (!active || disabled || menuContext) return
    const key = selection.kind === 'node' ? selection.id : ''
    if (key === lastSelection.current) return
    lastSelection.current = key
    const element = nodeElements.current.get(key)
    if (element) { element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
  }, [active, disabled, selection, menuContext])

  function openNodeMenu(id: string, origin: HTMLButtonElement, x: number, y: number) {
    if (disabled || !active) return
    lastSelection.current = id
    onSelect({ kind: 'node', id })
    setContext({ flow, id, origin, x, y })
  }
  function closeNodeMenu(restoreFocus = true) {
    if (restoreFocus && context?.origin.isConnected) context.origin.focus({ preventScroll: true })
    setContext(null)
  }

  function resetView() {
    setZoom(1)
    requestAnimationFrame(() => {
      const element = viewport.current
      if (!element) return
      const root = layout.positions.get(tree.root)
      element.scrollLeft = 0
      element.scrollTop = root ? Math.max(0, root.y + NODE_HEIGHT / 2 - element.clientHeight / 2) : 0
    })
  }

  return <div className="flow-graph">
    <div className="flow-graph-toolbar">
      <button type="button" className={selection.kind === 'flow' ? 'is-selected' : ''} aria-pressed={selection.kind === 'flow'} disabled={disabled} onClick={() => onSelect({ kind: 'flow' })}>流程信息</button>
      <span className="flow-graph-count">{layout.ids.length} 节点 · {tree.edges.length} 连接</span>
      <div className="flow-graph-zoom" aria-label="流程树缩放">
        <button type="button" aria-label="缩小流程树" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, Math.round((value - 0.1) * 10) / 10))}>−</button>
        <output aria-label="当前缩放">{Math.round(zoom * 100)}%</output>
        <button type="button" aria-label="放大流程树" disabled={zoom >= 1.5} onClick={() => setZoom((value) => Math.min(1.5, Math.round((value + 0.1) * 10) / 10))}>+</button>
        <button type="button" onClick={resetView} title="恢复 100% 并定位起点">重置</button>
      </div>
    </div>
    <div className="flow-graph-viewport" ref={viewport} tabIndex={0} aria-label="流程树画布，可滚动查看节点">
      {layout.ids.length === 0 ? <p className="flow-graph-empty">添加一个阶段，开始构建流程树。</p> : <div className="flow-graph-size" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
        <div className="flow-graph-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
          <svg className="flow-graph-lines" width={layout.width} height={layout.height} aria-hidden="true">
            <defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" /></marker></defs>
            {tree.edges.map((edge, index) => {
              const from = layout.positions.get(edge.from)
              const to = layout.positions.get(edge.to)
              if (!from || !to) return null
              const selected = selection.kind === 'branch' && selection.parent === edge.from && selection.id === edge.id
              const tree = layout.treeEdges.has(index)
              const path = graphPath(from, to, tree)
              return <g key={index} className={`flow-graph-link${selected ? ' is-selected' : ''}${tree ? '' : ' is-extra'}`}>
                <path d={path} markerEnd={`url(#${markerId})`} />
                <path className="flow-graph-link-hit" d={path} onClick={disabled ? undefined : () => onSelect({ kind: 'branch', parent: edge.from, id: edge.id })} />
              </g>
            })}
          </svg>
          {layout.ids.map((id) => {
            const node = tree.nodes[id]
            const position = layout.positions.get(id)!
            const isRoot = tree.root === id
            const isTerminal = node.completion === 'finish'
            const selected = selection.kind === 'node' && selection.id === id
            const outgoingCount = layout.outgoing.get(id)?.length ?? 0
            const title = displayText(node.title)
            const fork = node.branching === 'choice' ? '选择分支' : node.branching === 'priority' ? '按顺序选择' : '并行分支'
            return <button type="button" key={id} ref={(element) => { if (element) nodeElements.current.set(id, element); else nodeElements.current.delete(id) }} className={`flow-graph-node${selected ? ' is-selected' : ''}${isTerminal ? ' is-terminal' : ''}${!position.reachable ? ' is-unreachable' : ''}`} style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }} disabled={disabled} aria-pressed={selected} aria-haspopup="menu" aria-expanded={menuContext?.id === id} aria-label={`${title || id}，阶段 ${id}${isRoot ? '，起点' : ''}${isTerminal ? '，终点' : ''}`} onClick={() => onSelect({ kind: 'node', id })} onContextMenu={(event) => {
              event.preventDefault(); event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              openNodeMenu(id, event.currentTarget, event.clientX || rect.left + 20, event.clientY || rect.top + 20)
            }} onKeyDown={(event) => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
              event.preventDefault(); event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              openNodeMenu(id, event.currentTarget, rect.left + 20, rect.top + 20)
            }}>
              <span className="flow-graph-node-top"><span className="flow-graph-node-id" title={id}>{id}</span>{isRoot && <span className="flow-graph-badge is-root">起点</span>}{isTerminal && <span className="flow-graph-badge is-terminal">终点</span>}</span>
              <span className="flow-graph-node-title" title={title || id}>{title || '未命名阶段'}</span>
              <span className="flow-graph-node-meta">{!position.reachable ? '未连接至起点' : outgoingCount > 1 ? `${fork} · ${outgoingCount} 条` : isTerminal ? '抵达后结束流程' : `${outgoingCount} 条后续连接`}</span>
            </button>
          })}
          {tree.edges.map((edge, index) => {
            if (!layout.treeEdges.has(index)) return null
            const from = layout.positions.get(edge.from)!
            const to = layout.positions.get(edge.to)!
            const selected = selection.kind === 'branch' && selection.parent === edge.from && selection.id === edge.id
            const label = typeof edge.label === 'string' && edge.label.trim() ? edge.label : edge.id
            const conditions = Array.isArray(edge.conditions) ? edge.conditions.length : 0
            return <button type="button" key={index} className={`flow-graph-edge${selected ? ' is-selected' : ''}`} style={{ left: (from.x + NODE_WIDTH + to.x) / 2 - 73, top: to.y + NODE_HEIGHT / 2 - 23 }} disabled={disabled} aria-pressed={selected} aria-label={`连接 ${edge.id}，${edge.from} 到 ${edge.to}，${conditions} 个条件`} onClick={() => onSelect({ kind: 'branch', parent: edge.from, id: edge.id })}>
              <span className="flow-graph-edge-title" title={label}>{label}</span><span>{edge.unconditional ? (edge.trigger === 'confirm' ? '确认后继续' : '直接继续') : `${conditions} 个条件 · ${edge.conditionMode === 'any' ? '任一达成' : '全部达成'}`}</span>
            </button>
          })}
        </div>
      </div>}
    </div>
    {extraEdges.length > 0 && <div className="flow-graph-extra" aria-label="需要检查的连接">
      <span className="flow-graph-extra-heading">需检查的连接</span>
      {extraEdges.map(({ edge, index }) => <button key={index} type="button" className={selection.kind === 'branch' && selection.parent === edge.from && selection.id === edge.id ? 'is-selected' : ''} disabled={disabled} aria-pressed={selection.kind === 'branch' && selection.parent === edge.from && selection.id === edge.id} onClick={() => onSelect({ kind: 'branch', parent: edge.from, id: edge.id })} title={`${edge.from} → ${edge.to}`}>
        <strong>{edge.id || `连接 ${index + 1}`}</strong><span>{edge.from || '未设起点'} → {edge.to || '未设终点'}</span><span>{layout.positions.has(edge.from) && layout.positions.has(edge.to) ? '环或重复入边' : '端点不存在'} · {edge.conditions.length} 个条件</span>
      </button>)}
    </div>}
    <div className="flow-graph-legend"><span><i className="is-root" />起点</span><span><i className="is-terminal" />终点</span><span>点击编辑 · 右键节点新建后续阶段</span></div>
    {menuContext && menuNode && <NodeContextMenu key={menuContext.id} x={menuContext.x} y={menuContext.y} title={displayText(menuNode.title) || menuContext.id} onClose={closeNodeMenu} items={[
      { label: '新建下一节点', disabled: menuNode.completion === 'finish', hint: menuNode.completion === 'finish' ? '先取消结束标记，再添加后续节点' : '创建子节点，并自动连接到当前节点', action: () => onAddNext(menuContext.id) },
      { label: '编辑节点属性', action: () => onSelect({ kind: 'node', id: menuContext.id }) },
      { label: menuNode.completion === 'finish' ? '取消结束标记' : '设为结束节点', disabled: menuNode.completion !== 'finish' && menuNode.children.length > 0, hint: menuNode.children.length ? '已有后续节点，不能设为结束节点' : undefined, action: () => onSetCompletion(menuContext.id, menuNode.completion !== 'finish') },
    ]} />}
  </div>
}
