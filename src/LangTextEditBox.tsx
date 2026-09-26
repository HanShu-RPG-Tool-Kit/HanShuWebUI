import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type { LangEditMode, LangTextRect } from './monaco/langTextEditor'
import { normalizeLocaleKey } from './i18n/langTextMap'

type Props = {
  mode: LangEditMode
  initial: string
  rect: LangTextRect
  onCommit: (value: string) => void
  onCancel: () => void
}

/**
 * 等位置覆盖的可编辑文本框。
 * - 改键名：单行输入，回车 / 点外部提交（非法键名不提交，标红）
 * - 改映射值：多行输入，回车 / 点外部提交，Shift+回车换行
 * - Esc 取消
 */
export function LangTextEditBox({
  mode,
  initial,
  rect,
  onCommit,
  onCancel,
}: Props) {
  const [draft, setDraft] = useState(initial)
  const [invalid, setInvalid] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (mode === 'key') {
      el.select()
    } else {
      const end = el.value.length
      el.setSelectionRange(end, end)
    }
  }, [mode])

  const commit = () => {
    if (doneRef.current) return
    const next = mode === 'key' ? normalizeLocaleKey(draft) : draft
    if (mode === 'key' && !next) {
      // 键名必须是 8 位十六进制：不提交，标红提示
      setInvalid(true)
      inputRef.current?.focus()
      return
    }
    doneRef.current = true
    onCommit(next)
  }

  const commitRef = useRef(commit)
  const cancelRef = useRef(onCancel)
  useEffect(() => {
    commitRef.current = commit
    cancelRef.current = onCancel
  })

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (root && !root.contains(event.target as Node)) commitRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  const handleChange = (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setDraft(event.target.value)
    if (invalid) setInvalid(false)
  }

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (doneRef.current) return
      doneRef.current = true
      cancelRef.current()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      commitRef.current()
    }
  }

  const width = Math.max(mode === 'key' ? 150 : 210, rect.width)
  const height =
    mode === 'key' ? Math.max(rect.height, 26) : Math.max(rect.height, 84)
  const className = `hs-lang-edit-input${invalid ? ' invalid' : ''}`

  return (
    <div
      className="hs-lang-edit"
      ref={rootRef}
      style={{ left: rect.left, top: rect.top, width, height }}
      title={
        mode === 'key'
          ? '修改键名（8 位十六进制）：回车 / 点击外部提交，Esc 取消'
          : '修改本地化文本：回车 / 点击外部提交，Shift+回车换行，Esc 取消'
      }
    >
      {mode === 'key' ? (
        <input
          className={className}
          ref={(node) => {
            inputRef.current = node
          }}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <textarea
          className={className}
          ref={(node) => {
            inputRef.current = node
          }}
          value={draft}
          spellCheck={false}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
      )}
      {invalid && <div className="hs-lang-edit-hint">键名须为 8 位十六进制</div>}
    </div>
  )
}
