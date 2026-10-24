import type { ComponentType, MouseEvent, ReactNode } from 'react'

export type Point = { x: number; y: number }
export type PortSide = 'left' | 'right' | 'top' | 'bottom'
/** Side is visual; input/output remains the semantic connection direction. x/y are node-local pixels. */
export type Port = { id: string; direction: 'input' | 'output'; side?: PortSide; x?: number; y?: number; label: string; kind?: string; color?:string }
export type EditorNode = {
  id: string; type: string; position: Point; width: number; height: number; ports: Port[]
  data: unknown; label: string; className?: string; deletable?: boolean; draggable?: boolean
}
export type EditorEdge = { id: string; source: string; target: string; sourcePort: string; targetPort: string; kind?: string; color?:string; label?: string }
export type EditorGroup = { id: string; name: string; nodes: string[] }
export type EditorSelection = { nodes: string[]; edges: string[] }
export type EditorConnection = Pick<EditorEdge, 'source' | 'target' | 'sourcePort' | 'targetPort'>
export type NodeViewProps = { node: EditorNode; selected: boolean; dragging: boolean; readOnly: boolean }
export type NodeRegistry = Record<string, { component: ComponentType<NodeViewProps> }>
export type MenuItem = { label: string; action: () => void; disabled?: boolean; hint?: string }
export type MenuContext = { kind: 'pane' | 'node' | 'edge' | 'group'; id?: string; position: Point; selection: EditorSelection }
export type EditorFeatures = { groups?: boolean; knife?: boolean; arrange?: boolean; selection?: boolean; connections?: boolean }
export type NodeEditorProps = {
  documentId: string; nodes: EditorNode[]; edges: EditorEdge[]; groups?: EditorGroup[]; registry: NodeRegistry
  interaction?: { panOnDrag?: boolean | number[]; zoomOnScroll?: boolean; minZoom?:number; maxZoom?:number }
  selection?: EditorSelection; active?: boolean; readOnly?: boolean; features?: EditorFeatures; toolbar?: ReactNode
  onSelectionChange?: (selection: EditorSelection) => void
  onMove?: (positions: Record<string, Point>) => void
  onConnect?: (connection: EditorConnection) => void
  canConnect?: (connection: EditorConnection) => boolean
  onDelete?: (selection: EditorSelection) => void
  onCut?: (edgeIds: string[]) => void
  onGroup?: (nodeIds: string[]) => void
  onUngroup?: (groupId: string) => void
  onRenameGroup?: (groupId: string, name: string) => void
  onArrange?: (nodeIds: string[]) => void
  onNodeDoubleClick?: (nodeId: string) => void
  onNodeClick?: (nodeId: string, event: MouseEvent) => void
  onEdgeDoubleClick?: (edgeId: string) => void
  menuItems?: (context: MenuContext) => MenuItem[]
  initialFocusId?: string
  onViewportChange?: (viewport:Point & {zoom:number})=>void
}
export type NodeEditorApi = { fit: () => void; focus: (id: string) => void; zoom: (delta: number) => void; center: () => Point }
