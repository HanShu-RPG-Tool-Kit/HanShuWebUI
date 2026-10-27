import { type MouseEvent } from 'react'
import { PageTabScroller } from '../../ui/PageTabScroller'

export type EditorPage = { kind: 'script' | 'asset'; id: string }

const STORAGE_KEY = 'hanshu.stageplayOpenPages.v1'

export function editorPageKey(page: EditorPage): string {
  return `${page.kind}:${page.id}`
}

export function parseEditorPageKey(key: string): EditorPage | null {
  const index = key.indexOf(":")
  if (index <= 0) return null
  const kind = key.slice(0, index)
  const id = key.slice(index + 1)
  if ((kind !== "script" && kind !== "asset") || !id) return null
  return { kind, id }
}

export function loadOpenPages(): EditorPage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is EditorPage =>
        !!item &&
        typeof item === 'object' &&
        ((item as EditorPage).kind === 'script' || (item as EditorPage).kind === 'asset') &&
        typeof (item as EditorPage).id === 'string',
    )
  } catch {
    return []
  }
}

export function saveOpenPages(pages: EditorPage[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pages))
}

export function sameOpenPages(a: EditorPage[], b: EditorPage[]): boolean {
  return a.length === b.length && a.every((page, index) => editorPageKey(page) === editorPageKey(b[index]!))
}

/** 打开页列表的持久化仍在这里。标签条本身由 EditorDock 停靠，放不下时继续用同一条拉条横滑。 */
export function EditorTabs({
  pages,
  activeKey,
  labelOf,
  onSelect,
  onClose,
}: {
  pages: EditorPage[]
  activeKey: string | null
  labelOf: (page: EditorPage) => string
  onSelect: (page: EditorPage) => void
  onClose: (page: EditorPage) => void
}) {
  if (pages.length === 0) return null
  return (
    <PageTabScroller activeKey={activeKey} itemCount={pages.length} label="已打开的文件">
      {pages.map((page) => {
        const key = editorPageKey(page)
        const label = labelOf(page)
        const active = key === activeKey
        return (
          <div
            key={key}
            data-page-key={key}
            className={`flow-page-tab${active ? ' is-active' : ''}`}
            role="tab"
            aria-selected={active}
            onMouseDown={(event) => {
              if (event.button !== 0) return
              if ((event.target as HTMLElement).closest('.flow-page-tab-close')) return
              onSelect(page)
            }}
            onAuxClick={(event: MouseEvent) => {
              if (event.button !== 1) return
              event.preventDefault()
              onClose(page)
            }}
          >
            <button type="button" className="flow-page-tab-name" title={label} onClick={() => onSelect(page)}>
              <span>{label}</span>
            </button>
            <button
              type="button"
              className="flow-page-tab-close"
              aria-label={`关闭 ${label}`}
              title="关闭"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => onClose(page)}
            >
              ×
            </button>
          </div>
        )
      })}
    </PageTabScroller>
  )
}