import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { FlowCanvasNote, FlowPosition } from './model'
import './CanvasNote.css'

export type NoteDraft = Pick<FlowCanvasNote, 'title' | 'text'>
type Resize = { pointer: number; x: number; y: number; width: number; height: number; size: { width: number; height: number } }

export function CanvasNote({ id, note, position, zoom, selected, dragging, disabled, draft, bodyRef, onEdit, onDraft, onFinish, onSelect, onDelete, onUpdate, onSizePreview, onPointerDown, onPointerMove, onPointerUp, onContextMenu }: {
  id: string; note: FlowCanvasNote; position: FlowPosition; zoom: number; selected: boolean; dragging: boolean; disabled: boolean
  draft: NoteDraft | null; bodyRef: (element: HTMLButtonElement | null) => void
  onEdit: () => void; onDraft: (draft: NoteDraft) => void; onFinish: (save: boolean, restoreFocus?: boolean) => void; onSelect: () => void; onDelete: () => void
  onUpdate: (patch: Partial<FlowCanvasNote>) => void; onSizePreview: (size: { width: number; height: number } | null) => void
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void; onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>, cancel?: boolean) => void
  onContextMenu: (origin: HTMLButtonElement, x: number, y: number) => void
}) {
  const textarea = useRef<HTMLTextAreaElement>(null), resize = useRef<Resize | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const editing = draft !== null
  useLayoutEffect(() => { if (editing) textarea.current?.focus({ preventScroll: true }) }, [editing])

  function resizeMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = resize.current
    if (!current || current.pointer !== event.pointerId) return
    current.size = { width: Math.max(160, current.width + (event.clientX - current.x) / zoom), height: Math.max(96, current.height + (event.clientY - current.y) / zoom) }
    setSize(current.size); onSizePreview(current.size)
  }
  function resizeEnd(event: ReactPointerEvent<HTMLButtonElement>, cancel = false) {
    const current = resize.current
    if (!current || current.pointer !== event.pointerId) return
    if (!cancel) resizeMove(event)
    resize.current = null; setSize(null); onSizePreview(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!cancel && !disabled) onUpdate(current.size)
  }
  function openMenu(origin: HTMLButtonElement, x = 0, y = 0) {
    const rect = origin.getBoundingClientRect()
    onContextMenu(origin, x || rect.left + 20, y || rect.top + 20)
  }

  return <div data-canvas-node={id} className={`flow-graph-note is-${note.color}${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}${editing ? ' is-editing' : ''}`} style={{ left: position.x, top: position.y, width: size?.width ?? note.width, height: size?.height ?? note.height }}>
    {draft ? <div className="flow-note-editor" onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onFinish(true, false) }} onKeyDown={event => {
      event.stopPropagation()
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) { event.preventDefault(); onFinish(event.key !== 'Escape') }
    }}>
      <input aria-label="注释标题" value={draft.title} placeholder="注释" onChange={event => onDraft({ ...draft, title: event.target.value })} />
      <textarea ref={textarea} aria-label="注释内容" value={draft.text} placeholder="写下设计说明…" onChange={event => onDraft({ ...draft, text: event.target.value })} />
      <span className="flow-note-edit-hint">Ctrl+Enter 确认 · Esc 取消</span>
    </div> : <button type="button" ref={bodyRef} className="flow-note-body" disabled={disabled} aria-label={`${note.title || '注释'}，画布注释`} aria-pressed={selected} aria-haspopup="menu" title="拖动移动 · 双击编辑 · 右下角调整大小" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={event => onPointerUp(event)} onPointerCancel={event => onPointerUp(event, true)} onLostPointerCapture={event => onPointerUp(event, true)} onDoubleClick={onEdit} onClick={event => { if (event.detail === 0) onSelect() }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openMenu(event.currentTarget, event.clientX, event.clientY) }} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); event.stopPropagation(); onEdit() }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); onDelete() }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); event.stopPropagation(); openMenu(event.currentTarget) }
    }}><span className="flow-note-title">{note.title || '注释'}</span><span className={`flow-note-text${note.text ? '' : ' is-empty'}`}>{note.text || '双击写下说明…'}</span></button>}
    {!editing && <button type="button" className="flow-note-resize" disabled={disabled} aria-label="调整注释大小" onPointerDown={event => {
      if (event.button !== 0 || disabled) return
      event.preventDefault(); event.stopPropagation(); onSelect()
      resize.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: note.width, height: note.height, size: { width: note.width, height: note.height } }
      event.currentTarget.setPointerCapture(event.pointerId)
    }} onPointerMove={resizeMove} onPointerUp={event => resizeEnd(event)} onPointerCancel={event => resizeEnd(event, true)} onLostPointerCapture={event => resizeEnd(event, true)} onKeyDown={event => {
      if (event.key === 'Escape' && resize.current) { event.preventDefault(); event.stopPropagation(); const pointer = resize.current.pointer; resize.current = null; setSize(null); onSizePreview(null); if (event.currentTarget.hasPointerCapture(pointer)) event.currentTarget.releasePointerCapture(pointer) }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 40 : 10; onUpdate({ width: note.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), height: note.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) }) }
    }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 13 8-8m-3 8 3-3" /></svg></button>}
  </div>
}
