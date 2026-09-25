import { useEffect, useRef, useState } from 'react'
import { getLocaleGroups, resolveLocale } from './i18n/locales'

type Props = {
  /** 当前语言标签，如 `zh_cn` */
  value: string
  /** 选择变化（回传的已是格式化标签） */
  onChange: (tag: string) => void
}

/**
 * 标题栏右上角的语言下拉框。
 * 首行是「常用语言」文本标签 + 三个常用语言，其后按名字列出全部语言。
 */
export function LanguageSelect({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = resolveLocale(value)
  const groups = getLocaleGroups()

  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('click', onDocClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', onDocClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="lang-select" ref={rootRef}>
      <button
        type="button"
        className={`lang-trigger${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`当前语言：${current.nativeName}`}
        title="切换语言"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="lang-trigger-name" dir="auto">
          {current.nativeName}
        </span>
        <span className="lang-trigger-tag">{current.tag}</span>
        <span className="lang-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="lang-dropdown" role="listbox" aria-label="语言">
          {groups.map((group, index) => (
            <div className="lang-group" key={group.label ?? `group-${index}`}>
              {group.label && (
                <div className="lang-group-label">{group.label}</div>
              )}
              {index > 0 && <div className="lang-sep" aria-hidden />}
              {group.items.map((entry) => {
                const on = entry.tag === current.tag
                return (
                  <button
                    type="button"
                    key={`${index}-${entry.tag}`}
                    role="option"
                    aria-selected={on}
                    className={`lang-item${on ? ' on' : ''}`}
                    title={entry.chineseName}
                    onClick={() => {
                      onChange(entry.tag)
                      setOpen(false)
                    }}
                  >
                    <span className="lang-item-name" dir="auto">
                      {entry.nativeName}
                    </span>
                    <span className="lang-item-tag">{entry.tag}</span>
                    <span className="lang-item-check" aria-hidden>
                      {on ? '✓' : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
