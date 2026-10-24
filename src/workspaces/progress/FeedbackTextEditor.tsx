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
import type { ItemTextSegment } from './itemstack'
import {
  FEEDBACK_COLOR_SWATCHES,
  FEEDBACK_STYLE_KEYS,
  applyFeedbackStyleRange,
  clearFeedbackStyles,
  flatFeedbackText,
  parseFeedbackText,
  replaceFeedbackPlainText,
  stringifyFeedbackText,
  type FeedbackStyleKey,
  type FeedbackStylePatch,
} from './feedbackText'

type Tone = 'message' | 'title' | 'subtitle'

const STYLE_TOGGLES: {
  key: FeedbackStyleKey
  label: string
  title: string
}[] = [
  { key: 'bold', label: 'B', title: '粗体' },
  { key: 'italic', label: 'I', title: '斜体' },
  { key: 'underlined', label: 'U', title: '下划线' },
  { key: 'strikethrough', label: 'S', title: '删除线' },
  { key: 'obfuscated', label: '§k', title: '混淆' },
]

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

function colorInputValue(color: string | undefined): string {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) return color
  return '#FFFFFF'
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
  const points: { node: Text; offset: number }[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text
      for (let i = 0; i <= text.data.length; i++) {
        points.push({ node: text, offset: i })
      }
      return
    }
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  if (points.length === 0) {
    root.focus()
    return
  }
  const clamp = (value: number) =>
    Math.max(0, Math.min(value, points.length - 1))
  const a = points[clamp(start)]
  const b = points[clamp(end)]
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

function segmentsToHtml(segments: ItemTextSegment[]): string {
  const flat = flatFeedbackText(segments)
  if (!flat) return ''
  return segments
    .map((segment) => {
      if (!segment.text) return ''
      const styles: string[] = [`color:${segment.color || '#FFFFFF'}`]
      if (segment.bold) styles.push('font-weight:700')
      if (segment.italic) styles.push('font-style:italic')
      const decorations = [
        segment.underlined ? 'underline' : '',
        segment.strikethrough ? 'line-through' : '',
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
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  let pos = 0
  let color: string | undefined
  let colorSet = false
  const flags: Partial<Record<FeedbackStyleKey, boolean | undefined>> = {}
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
        const on = Boolean(segment[key])
        if (flags[key] === undefined) flags[key] = on
        else if (flags[key] !== on) flags[key] = false
      }
    }
    pos = next
  }

  const out: {
    color?: string
  } & Partial<Record<FeedbackStyleKey, boolean>> = {}
  if (color) out.color = color
  for (const key of FEEDBACK_STYLE_KEYS) {
    if (flags[key]) out[key] = true
  }
  return out
}

export function FeedbackTextEditor({
  label,
  value,
  placeholder,
  disabled,
  tone = 'message',
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  disabled?: boolean
  tone?: Tone
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
    root.innerHTML = segmentsToHtml(next)
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
    const nextHtml = segmentsToHtml(segments)
    if (root.innerHTML === nextHtml) return
    root.innerHTML = nextHtml
  }, [segments])

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

            <div
              className="kit-feedback-toolbar"
              onPointerDown={(event) => event.preventDefault()}
            >
              <label className="kit-feedback-color" title="颜色（hex）">
                <input
                  type="color"
                  aria-label={`${label} 颜色`}
                  value={colorInputValue(active.color)}
                  onChange={(event) =>
                    applyPatch({ color: event.target.value.toUpperCase() })
                  }
                />
                <input
                  className="kit-feedback-hex"
                  aria-label={`${label} hex`}
                  value={active.color ?? ''}
                  placeholder="#FFFFFF"
                  spellCheck={false}
                  onChange={(event) => {
                    const raw = event.target.value.trim()
                    if (!raw) {
                      applyPatch({ color: null })
                      return
                    }
                    applyPatch({ color: raw })
                  }}
                  onBlur={(event) => {
                    const raw = event.target.value.trim()
                    if (!raw) return
                    if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
                      applyPatch({ color: raw.toUpperCase() })
                    }
                  }}
                />
              </label>
              <div
                className="kit-feedback-swatches"
                role="listbox"
                aria-label="命名色"
              >
                {FEEDBACK_COLOR_SWATCHES.map((swatch) => (
                  <button
                    key={swatch.id}
                    type="button"
                    role="option"
                    className={`kit-feedback-swatch${
                      active.color?.toUpperCase() === swatch.hex
                        ? ' is-active'
                        : ''
                    }`}
                    title={`${swatch.label} ${swatch.hex}`}
                    aria-label={swatch.label}
                    style={{ background: swatch.hex }}
                    onClick={() => applyPatch({ color: swatch.hex })}
                  />
                ))}
              </div>
              <div
                className="kit-feedback-toggles"
                role="group"
                aria-label="样式"
              >
                {STYLE_TOGGLES.map((toggle) => (
                  <button
                    key={toggle.key}
                    type="button"
                    className={`kit-feedback-toggle${
                      active[toggle.key] ? ' is-on' : ''
                    }`}
                    aria-pressed={Boolean(active[toggle.key])}
                    title={toggle.title}
                    onClick={() =>
                      applyPatch({
                        [toggle.key]: !active[toggle.key],
                      })
                    }
                  >
                    {toggle.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="kit-feedback-clear"
                  title="清除选区样式（未选中则清除全文）"
                  onClick={clearStyles}
                >
                  清除样式
                </button>
              </div>
            </div>
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
