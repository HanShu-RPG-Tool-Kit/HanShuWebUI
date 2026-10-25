import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import type { TextSegment as ItemTextSegment } from './codec'
import { decodeTextValue } from './codec'
import { RichTextToolbar } from './RichTextToolbar'
import './textComponent.css'
import {
  FEEDBACK_STYLE_KEYS,
  FEEDBACK_COLOR_SWATCHES,
  applyFeedbackStyleRange,
  clearFeedbackStyles,
  flatFeedbackText,
  parseFeedbackText,
  replaceFeedbackPlainText,
  stringifyFeedbackText,
  type FeedbackStyleKey,
  type FeedbackStylePatch,
} from './model'

type Tone = 'message' | 'title' | 'subtitle'

const DROPDOWN_GAP = 4
const DROPDOWN_MAX_WIDTH = 420
const DROPDOWN_MIN_WIDTH = 280
/** 样式用 innerHTML 重绘会清掉浏览器撤销栈，本编辑器自行维护。 */
const LOCAL_HISTORY_LIMIT = 50
const LOCAL_TYPE_GROUP_MS = 600

type LocalHistory = {
  past: string[]
  future: string[]
  lastEdit: number
  lastKind: 'type' | 'style' | null
}

function emptyLocalHistory(): LocalHistory {
  return { past: [], future: [], lastEdit: 0, lastKind: null }
}

function hasRichStyle(segments: ItemTextSegment[]): boolean {
  return (
    segments.length > 1 ||
    segments.some((segment) => {
      if (segment.color) return true
      return FEEDBACK_STYLE_KEYS.some((key) => Boolean(segment[key]))
    })
  )
}

function placeDropdown(
  anchor: DOMRect,
  panel: DOMRect | null,
): CSSProperties {
  const width = Math.min(
    DROPDOWN_MAX_WIDTH,
    Math.max(DROPDOWN_MIN_WIDTH, anchor.width),
  )
  let left = anchor.left
  if (left + width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - 8 - width)
  }
  let top = anchor.bottom + DROPDOWN_GAP
  const height = panel?.height ?? 120
  if (top + height > window.innerHeight - 8) {
    const above = anchor.top - DROPDOWN_GAP - height
    if (above >= 8) top = above
    else top = Math.max(8, window.innerHeight - 8 - height)
  }
  return {
    position: 'fixed',
    left,
    top,
    width,
    maxHeight: Math.min(280, window.innerHeight - 16),
  }
}

function selectionOffsets(
  root: HTMLElement,
): { start: number; end: number } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null

  const measure = (node: Node, offset: number) => {
    const probe = document.createRange()
    probe.selectNodeContents(root)
    probe.setEnd(node, offset)
    return probe.toString().length
  }

  try {
    const start = measure(range.startContainer, range.startOffset)
    const end = measure(range.endContainer, range.endOffset)
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
    }
  } catch {
    return null
  }
}

function setSelectionOffsets(
  root: HTMLElement,
  start: number,
  end: number,
): void {
  const nodes: Text[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) nodes.push(node as Text)
    else for (const child of node.childNodes) walk(child)
  }
  walk(root)
  if (!nodes.length) { root.focus(); return }
  const point = (position: number) => {
    let remaining = Math.max(0, position)
    for (const node of nodes) {
      if (remaining <= node.data.length) return { node, offset: remaining }
      remaining -= node.data.length
    }
    const node = nodes[nodes.length - 1]
    return { node, offset: node.data.length }
  }
  const a = point(start)
  const b = point(end)
  const range = document.createRange()
  range.setStart(a.node, a.offset)
  range.setEnd(b.node, b.offset)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function readSurfaceText(root: HTMLElement): string {
  return (root.innerText || '')
    .replace(/\u200b/g, '')
    .replace(/\r/g, '')
    .replace(/\n/g, '')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function segmentsToHtml(segments: ItemTextSegment[], baseStyle: Omit<ItemTextSegment, 'text'> = {}): string {
  const flat = flatFeedbackText(segments)
  if (!flat) return ''
  return segments
    .map((segment) => {
      if (!segment.text) return ''
      const baseColor = FEEDBACK_COLOR_SWATCHES.find(color => color.id === baseStyle.color)?.hex
        ?? (baseStyle.color && /^#[0-9a-fA-F]{6}$/.test(baseStyle.color) ? baseStyle.color : '#FFFFFF')
      const flag = (key: FeedbackStyleKey) => segment[key] ?? baseStyle[key]
      const styles: string[] = [`color:${segment.color || baseColor}`]
      if (flag('bold') !== undefined) styles.push(`font-weight:${flag('bold') ? '700' : '400'}`)
      if (flag('italic') !== undefined) styles.push(`font-style:${flag('italic') ? 'italic' : 'normal'}`)
      const decorations = [
        flag('underlined') ? 'underline' : '',
        flag('strikethrough') ? 'line-through' : '',
      ].filter(Boolean)
      if (decorations.length) {
        styles.push(`text-decoration:${decorations.join(' ')}`)
      }
      return `<span style="${styles.join(';')}">${escapeHtml(segment.text)}</span>`
    })
    .join('')
}

function uniformStyle(
  segments: ItemTextSegment[],
  start: number,
  end: number,
): {
  color?: string
} & Partial<Record<FeedbackStyleKey, boolean>> {
  if (segments.every(segment => !segment.text)) {
    const { text: _empty, ...style } = segments[0] ?? { text: '' }
    void _empty
    return style
  }
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  let pos = 0
  let color: string | undefined
  let colorSet = false
  const flags: Partial<Record<FeedbackStyleKey, boolean | undefined>> = {}
  let overlaps = 0
  for (const key of FEEDBACK_STYLE_KEYS) flags[key] = undefined

  for (const segment of segments) {
    const next = pos + segment.text.length
    const overlapFrom = Math.max(pos, from)
    const overlapTo = Math.min(next, to)
    if (overlapFrom < overlapTo) {
      if (!colorSet) {
        color = segment.color
        colorSet = true
      } else if (color !== segment.color) {
        color = undefined
      }
      for (const key of FEEDBACK_STYLE_KEYS) {
        if (overlaps === 0) flags[key] = segment[key]
        else if (flags[key] !== segment[key]) flags[key] = undefined
      }
      overlaps++
    }
    pos = next
  }

  const out: {
    color?: string
  } & Partial<Record<FeedbackStyleKey, boolean>> = {}
  if (color) out.color = color
  for (const key of FEEDBACK_STYLE_KEYS) {
    if (flags[key] !== undefined) out[key] = flags[key]
  }
  return out
}

function EditableRichTextSurface({
  label,
  value,
  placeholder,
  disabled,
  tone = 'message',
  baseStyle,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  disabled?: boolean
  tone?: Tone
  /** Display-only inherited style; never becomes part of the edited value. */
  baseStyle?: Omit<ItemTextSegment, 'text'>
  onChange: (next: string) => void
}) {
  const statusId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef(false)
  const segmentsRef = useRef<ItemTextSegment[]>([{ text: '' }])
  const valueRef = useRef(value)
  const ownedValueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const historyRef = useRef<LocalHistory>(emptyLocalHistory())
  valueRef.current = value
  onChangeRef.current = onChange
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<CSSProperties>({
    position: 'fixed',
    left: 0,
    top: 0,
    width: DROPDOWN_MIN_WIDTH,
  })
  const [range, setRange] = useState<{ start: number; end: number } | null>(
    null,
  )
  const segments = useMemo(() => parseFeedbackText(value), [value])
  segmentsRef.current = segments
  const display = flatFeedbackText(segments)
  const rich = hasRichStyle(segments)

  const commit = (next: ItemTextSegment[]) => {
    if (disabled) return
    const serialized = stringifyFeedbackText(next)
    valueRef.current = serialized
    ownedValueRef.current = serialized
    onChangeRef.current(serialized)
  }

  const paintSurface = (next: ItemTextSegment[], restore?: { start: number; end: number } | null) => {
    const root = surfaceRef.current
    if (!root) return
    root.innerHTML = segmentsToHtml(next, baseStyle)
    if (restore) setSelectionOffsets(root, restore.start, restore.end)
  }

  const pushHistory = (before: string, kind: 'type' | 'style') => {
    const history = historyRef.current
    const now = Date.now()
    const coalesce =
      kind === 'type' &&
      history.lastKind === 'type' &&
      now - history.lastEdit <= LOCAL_TYPE_GROUP_MS
    if (!coalesce) {
      if (history.past[history.past.length - 1] !== before) {
        history.past = [
          ...history.past.slice(-(LOCAL_HISTORY_LIMIT - 1)),
          before,
        ]
      }
      history.future = []
    }
    history.lastEdit = kind === 'type' ? now : 0
    history.lastKind = kind
  }

  const restoreValue = (raw: string) => {
    const next = parseFeedbackText(raw)
    segmentsRef.current = next
    valueRef.current = raw
    ownedValueRef.current = raw
    paintSurface(next)
    onChangeRef.current(raw)
    setRange(null)
  }

  const undoLocal = (redo = false) => {
    if (disabled) return
    const history = historyRef.current
    const stack = redo ? history.future : history.past
    const raw = stack.pop()
    if (raw === undefined) return
    ;(redo ? history.past : history.future).push(valueRef.current)
    history.lastEdit = 0
    history.lastKind = null
    restoreValue(raw)
  }

  const captureRange = () => {
    const root = surfaceRef.current
    if (!root) return
    const next = selectionOffsets(root)
    if (!next || next.start === next.end) {
      setRange(null)
      return
    }
    setRange(next)
  }

  const effectiveRange = () => {
    const length = display.length
    if (!length) return { start: 0, end: 0 }
    if (range && range.start !== range.end) {
      return {
        start: Math.max(0, Math.min(range.start, length)),
        end: Math.max(0, Math.min(range.end, length)),
      }
    }
    return { start: 0, end: length }
  }

  const applyPatch = (patch: FeedbackStylePatch) => {
    const { start, end } = effectiveRange()
    const nextRange =
      range && range.start !== range.end
        ? range
        : { start: 0, end: display.length }
    const next = applyFeedbackStyleRange(segmentsRef.current, start, end, patch)
    const serialized = stringifyFeedbackText(next)
    if (serialized === valueRef.current) return
    pushHistory(valueRef.current, 'style')
    segmentsRef.current = next
    valueRef.current = serialized
    ownedValueRef.current = serialized
    // 聚焦时 React 不回写 DOM：样式操作在这里直接刷，再 commit
    paintSurface(next, nextRange)
    onChangeRef.current(serialized)
  }

  const clearStyles = () => {
    const { start, end } = effectiveRange()
    const nextRange =
      range && range.start !== range.end
        ? range
        : { start: 0, end: display.length }
    const next = clearFeedbackStyles(segmentsRef.current, start, end)
    const serialized = stringifyFeedbackText(next)
    if (serialized === valueRef.current) return
    pushHistory(valueRef.current, 'style')
    segmentsRef.current = next
    valueRef.current = serialized
    ownedValueRef.current = serialized
    paintSurface(next, nextRange)
    onChangeRef.current(serialized)
  }

  const active = uniformStyle(
    segments,
    effectiveRange().start,
    effectiveRange().end || display.length,
  )

  const updatePlace = () => {
    const anchor = surfaceRef.current?.getBoundingClientRect()
    if (!anchor) return
    setPlace(
      placeDropdown(anchor, panelRef.current?.getBoundingClientRect() ?? null),
    )
  }

  // 未聚焦时用 props 刷 DOM；聚焦中交给浏览器，避免 React 回写把按键打成双份。
  useLayoutEffect(() => {
    const root = surfaceRef.current
    if (!root || focusedRef.current) return
    const nextHtml = segmentsToHtml(segments, baseStyle)
    if (root.innerHTML === nextHtml) return
    root.innerHTML = nextHtml
  }, [segments, baseStyle])

  // 外部换值（切文案键 / 重载）时清空本地撤销栈；本编辑器写出的值不重置。
  useEffect(() => {
    if (value === ownedValueRef.current) return
    ownedValueRef.current = value
    historyRef.current = emptyLocalHistory()
  }, [value])

  useLayoutEffect(() => {
    if (!open) return
    updatePlace()
  }, [open, value])

  useEffect(() => {
    if (!open) return
    const onReposition = () => updatePlace()
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setOpen(false)
      setRange(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setRange(null)
        surfaceRef.current?.blur()
        return
      }
      if (event.defaultPrevented) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      // 样式重绘会清掉浏览器撤销栈；打开本字段时统一走本地栈（含工具栏焦点）。
      event.preventDefault()
      undoLocal(event.shiftKey || key === 'y')
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, disabled])

  const dropdown =
    open && !disabled
      ? createPortal(
          <div
            ref={panelRef}
            className="kit-feedback-dropdown"
            role="dialog"
            aria-label={`${label} 样式`}
            style={place}
          >
            <p className="kit-feedback-hint" id={statusId}>
              在上方正文里拖选后点样式
              {range && range.start !== range.end
                ? `（已选 ${range.end - range.start} 字）`
                : '；未选中则作用于全文'}
            </p>

            <RichTextToolbar label={label} active={active} applyPatch={applyPatch} clearStyles={clearStyles}/>
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <div
        ref={rootRef}
        className={`kit-field kit-feedback-field${disabled ? ' is-disabled' : ''}${open ? ' is-open' : ''}${rich ? ' is-rich' : ''}`}
      >
        <span>{label}</span>
        <div className="kit-feedback-surface-wrap">
          <div
            ref={surfaceRef}
            className={`kit-feedback-surface is-${tone}${!display ? ' is-empty' : ''}`}
            role="textbox"
            aria-multiline="false"
            aria-label={label}
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-describedby={open ? statusId : undefined}
            aria-placeholder={placeholder}
            aria-disabled={disabled || undefined}
            contentEditable={!disabled}
            suppressContentEditableWarning
            spellCheck={false}
            onFocus={() => {
              focusedRef.current = true
              if (!disabled) setOpen(true)
            }}
            onBlur={() => {
              focusedRef.current = false
              // 失焦后用权威分段刷一次，清掉浏览器残留节点
              paintSurface(segmentsRef.current)
            }}
            onMouseUp={captureRange}
            onKeyUp={captureRange}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault()
            }}
            onInput={() => {
              const root = surfaceRef.current
              if (!root) return
              const text = readSurfaceText(root)
              const prev = flatFeedbackText(segmentsRef.current)
              if (text === prev) return
              pushHistory(valueRef.current, 'type')
              const next = replaceFeedbackPlainText(segmentsRef.current, text)
              segmentsRef.current = next
              commit(next)
              setRange(null)
            }}
            onPaste={(event) => {
              event.preventDefault()
              const text = event.clipboardData
                .getData('text/plain')
                .replace(/\n/g, '')
              document.execCommand('insertText', false, text)
            }}
          />
          {!display && (
            <span className="kit-feedback-surface-placeholder" aria-hidden>
              {placeholder || '（空）'}
            </span>
          )}
        </div>
      </div>
      {dropdown}
    </>
  )
}

export type RichTextSurfaceProps = {
  label: string
  value: string
  placeholder?: string
  disabled?: boolean
  tone?: Tone
  /** Display-only inherited style; never becomes part of the edited value. */
  baseStyle?: Omit<ItemTextSegment, 'text'>
  onChange: (next: string) => void
}

export function RichTextSurface(props: RichTextSurfaceProps) {
  const decoded = decodeTextValue(props.value)
  if (!decoded.editable) return <div className="kit-field kit-feedback-field is-disabled">
    <span>{props.label}</span>
    <p role="status">高级文本，请在组件树或源码中编辑。</p>
    <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{props.value}</pre>
  </div>
  return <EditableRichTextSurface {...props}/>
}
