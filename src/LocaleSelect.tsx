import { useEffect, useRef, useState } from 'react'
import { ALL_LOCALES, getLocaleGroups, resolveLocale } from './i18n/locales'

type Props = {
  /** 当前语言标签，如 `zh_cn` */
  value: string
  /** 选择变化（回传的已是格式化标签） */
  onChange: (tag: string) => void
  /**
   * 本工程里出现过的语言标签。表里没有的（例如 agent 写下的 `en`）会被列进
   * 「本工程」分组 —— 否则这些标签在下拉里根本选不到，译文等于够不着。
   */
  projectLocales?: readonly string[]
}

/**
 * 语言下拉框。挂在剧本编辑器底部状态栏右侧（`汉书` / `UTF-8` 之后），
 * 因为状态栏在窗口底部，下拉向上弹出（见 App.css 里的 `.statusbar .lang-select`）。
 * 顺序：「本工程」（仅表里没有的标签）→「常用语言」→ 全部语言（按英文名）。
 */
export function LocaleSelect({ value, onChange, projectLocales }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = resolveLocale(value)

  const knownTags = new Set(ALL_LOCALES.map((entry) => entry.tag))
  const projectExtra = (projectLocales ?? [])
    .filter((tag) => !knownTags.has(tag))
    .map((tag) => resolveLocale(tag))
  const groups = projectExtra.length
    ? [{ label: '本工程', items: projectExtra }, ...getLocaleGroups()]
    : getLocaleGroups()

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
