import { useMemo, useState, type CSSProperties } from 'react'
import {
  isSnapshotFresh,
  itemStackIconSrc,
  segmentPlainText,
} from './itemstack'
import { presentItem, type ItemPresentation } from './itemTooltip'
import { ItemHoverTipTarget } from './itemHoverTip'
import { isItemDocument } from './library'
import { itemRefFromFileName } from './kit'
import { itemPresentable, readItemSource, type ItemDocument } from './itemDoc'
import type { FlowDocument } from './storage'
import './KitEditor.css'
import './ItemLibraryTable.css'

const TAG_VISIBLE = 2

export type ItemLibraryRow = {
  key: string
  fileName: string
  ref: string
  folderPath: string
  doc: ItemDocument | null
  error: string
  id: string
  tags: string[]
  componentCount: number
  snapshot: 'none' | 'fresh' | 'stale'
  displayName: string
  titleName: string
  iconSrc: string
  foil: boolean
  iconStale: boolean
  presentation: ItemPresentation | null
}

function snapshotOf(doc: ItemDocument | null): ItemLibraryRow['snapshot'] {
  if (!doc?.display) return 'none'
  return isSnapshotFresh(doc.item) ? 'fresh' : 'stale'
}

function buildRows(
  documents: FlowDocument[],
  folderLabel: (document: FlowDocument) => string,
): ItemLibraryRow[] {
  const rows: ItemLibraryRow[] = []
  for (const document of documents) {
    if (!isItemDocument(document)) continue
    const ref = itemRefFromFileName(document.name)
    const parsed = readItemSource(document.source)
    const doc = parsed.error ? null : parsed.doc
    const presentable = doc ? itemPresentable(doc) : null
    const presentation = presentable ? presentItem(presentable) : null
    const icon = doc?.display?.icon
    const displayName = presentation ? segmentPlainText(presentation.name) : ''
    const titleName = displayName || document.name.replace(/\.item$/i, '') || document.name
    rows.push({
      key: document.key,
      fileName: document.name,
      ref,
      folderPath: folderLabel(document),
      doc,
      error: parsed.error,
      id: doc?.item.id ?? '',
      tags: doc?.tags ?? [],
      componentCount: doc ? Object.keys(doc.item.components).length : 0,
      snapshot: snapshotOf(doc),
      displayName,
      titleName,
      iconSrc: icon ? itemStackIconSrc(icon) : '',
      foil: presentation?.foil === true,
      iconStale: presentation?.iconStale === true,
      presentation,
    })
  }
  rows.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-CN', { numeric: true }))
  return rows
}

function RowIcon({ row }: { row: ItemLibraryRow }) {
  const src = row.iconSrc
  const mask = src ? { WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")` } as CSSProperties : undefined
  return <span className={`kit-item-icon${src ? '' : ' is-empty'}${row.iconStale ? ' is-stale' : ''}`}>
    {src
      ? <img src={src} alt="" width={28} height={28} draggable={false} />
      : <span className="kit-item-icon-fallback" aria-hidden />}
    {row.foil && <span className={`kit-item-glint${src ? '' : ' is-unmasked'}`} style={mask} aria-hidden />}
    {row.iconStale && <span className="kit-item-stale" aria-label="图标为旧快照" />}
  </span>
}

function TagCell({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="item-table-muted">—</span>
  const shown = tags.slice(0, TAG_VISIBLE)
  const rest = tags.length - shown.length
  return <div className="item-table-tag-list" title={tags.join(', ')}>
    {shown.map((tag) => (
      <span key={tag.toLowerCase()} className="item-table-tag-chip">{tag}</span>
    ))}
    {rest > 0 && <span className="item-table-tag-more">+{rest}</span>}
  </div>
}

function StatusCell({ row }: { row: ItemLibraryRow }) {
  if (row.error) return <span className="item-table-error" title={row.error}>解析失败</span>
  const snap = row.snapshot === 'fresh' ? '快照' : row.snapshot === 'stale' ? '过期' : '无'
  const snapClass = row.snapshot === 'fresh' ? 'is-fresh' : row.snapshot === 'stale' ? 'is-stale' : 'is-none'
  return <span className="item-table-status" title={`${row.componentCount} 个组件 · 快照：${snap}`}>
    <span className="item-table-status-count">{row.componentCount}</span>
    <span className="item-table-status-sep" aria-hidden>·</span>
    <span className={`item-table-snap ${snapClass}`}>{snap}</span>
  </span>
}

function metaTitle(row: ItemLibraryRow): string {
  const parts = [
    row.fileName,
    row.ref ? `引用 ${row.ref}` : '',
    row.folderPath ? `位置 ${row.folderPath}` : '',
    row.tags.length ? `标签 ${row.tags.join(', ')}` : '',
    row.error || '',
  ].filter(Boolean)
  return parts.join('\n')
}

function IdentityCell({ row }: { row: ItemLibraryRow }) {
  const body = <>
    <RowIcon row={row} />
    <div className="item-table-identity-text">
      <span className="item-table-title">{row.titleName}</span>
      <span className="item-table-sub">
        {row.error
          ? <span className="item-table-error">解析失败</span>
          : <>
            <code className="item-table-mono">{row.id || '—'}</code>
            {row.ref ? <span className="item-table-sub-sep">·</span> : null}
            {row.ref ? <code className="item-table-mono is-ref">{row.ref}</code> : null}
          </>}
      </span>
    </div>
  </>

  if (!row.presentation || row.error) {
    return <div className="item-table-identity">{body}</div>
  }

  return <ItemHoverTipTarget
    className="item-table-identity item-table-identity-tip"
    id={row.id}
    presentation={row.presentation}
    locale={row.doc?.display?.locale}
  >
    {body}
  </ItemHoverTipTarget>
}

export function ItemLibraryTable({ documents, folderLabel, onOpen }: {
  documents: FlowDocument[]
  folderLabel: (document: FlowDocument) => string
  onOpen: (key: string) => void
}) {
  const [query, setQuery] = useState('')
  const rows = useMemo(() => buildRows(documents, folderLabel), [documents, folderLabel])
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return rows
    return rows.filter((row) =>
      row.fileName.toLocaleLowerCase().includes(q)
      || row.ref.toLocaleLowerCase().includes(q)
      || row.id.toLocaleLowerCase().includes(q)
      || row.displayName.toLocaleLowerCase().includes(q)
      || row.titleName.toLocaleLowerCase().includes(q)
      || row.folderPath.toLocaleLowerCase().includes(q)
      || row.error.toLocaleLowerCase().includes(q)
      || row.tags.some((tag) => tag.toLocaleLowerCase().includes(q)),
    )
  }, [rows, query])

  return <div className="item-table">
    <header className="item-table-head">
      <div>
        <h2>物品库表视图</h2>
        <p>共 {rows.length} 个物品{query.trim() ? ` · 显示 ${filtered.length}` : ''} · 悬停预览 · 点击打开</p>
      </div>
      <input
        className="item-table-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="筛选名称 / ID / 标签…"
        aria-label="筛选物品"
      />
    </header>

    {filtered.length === 0 ? (
      <p className="item-table-empty">{rows.length === 0 ? '物品库还没有 .item，可在左侧新建或拖入 .itemstack。' : '没有匹配的物品。'}</p>
    ) : (
      <div className="item-table-scroll">
        <table className="item-table-grid">
          <colgroup>
            <col className="item-table-col-identity" />
            <col className="item-table-col-tags" />
            <col className="item-table-col-status" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">物品</th>
              <th scope="col">标签</th>
              <th scope="col" className="is-status">状态</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr
                key={row.key}
                className={row.error ? 'is-error' : undefined}
                tabIndex={0}
                title={row.presentation && !row.error ? undefined : metaTitle(row)}
                onClick={() => onOpen(row.key)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onOpen(row.key)
                  }
                }}
              >
                <td><IdentityCell row={row} /></td>
                <td><TagCell tags={row.tags} /></td>
                <td className="is-status"><StatusCell row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
}
