/**
 * 标签嵌在输入框内：chip 与输入同行，整框可点聚焦；回车添加，× 删除。
 */

import { useRef, useState } from 'react'
import type { CollectedTag } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

export interface TagPickerProps {
  /** Reserved for callers; suggestions kept light / unused in chrome. */
  tags?: CollectedTag[]
  selected: string[]
  onChange: (tags: string[]) => void
  disabled?: boolean
  placeholder?: string
}

function normalize(name: string): string | null {
  const n = name.trim().normalize('NFC')
  return n.length > 0 ? n : null
}

export function TagPicker({
  selected,
  onChange,
  disabled,
  placeholder = '输入后回车',
}: TagPickerProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const isSelected = (name: string) =>
    selected.some((s) => s.toLowerCase() === name.toLowerCase())

  const addTag = (raw: string) => {
    if (disabled) return
    const n = normalize(raw)
    if (!n) return
    if (!isSelected(n)) onChange([...selected, n])
    setDraft('')
  }

  const removeTag = (name: string) => {
    if (disabled) return
    onChange(selected.filter((s) => s.toLowerCase() !== name.toLowerCase()))
    inputRef.current?.focus()
  }

  return (
    <div
      className={`skinTagPicker ${styles.tagPicker}${disabled ? ` ${styles.tagPickerDisabled}` : ''}`}
      onClick={() => {
        if (!disabled) inputRef.current?.focus()
      }}
    >
      {selected.map((name) => (
        <span key={name} className={styles.tagChip}>
          <span className={styles.tagChipLabel}>{name}</span>
          <button
            type="button"
            className={styles.tagChipRemove}
            aria-label={`移除 ${name}`}
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation()
              removeTag(name)
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        className={styles.tagInput}
        value={draft}
        disabled={disabled}
        placeholder={selected.length === 0 ? placeholder : ''}
        onChange={(e) => setDraft(e.target.value.replace(/[\r\n]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            addTag(draft)
            return
          }
          if (e.key === 'Backspace' && draft.length === 0 && selected.length > 0) {
            e.preventDefault()
            removeTag(selected[selected.length - 1]!)
          }
        }}
        onBlur={() => {
          if (draft.trim()) addTag(draft)
        }}
        aria-label="添加标签"
      />
    </div>
  )
}
