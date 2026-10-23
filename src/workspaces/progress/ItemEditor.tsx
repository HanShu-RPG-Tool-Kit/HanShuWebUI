import { ItemSyncEditor } from './ItemSyncEditor'
import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  getCachedDisplaySync,
} from './itemSnapshotCache'
import {
  itemFingerprint,
  itemStackIconSrc,
  type ItemTextSegment,
} from './itemstack'
import {
  useItemPresentation,
  useItemSnapshotStatus,
} from './itemPresentation'
import { type ItemPresentation } from './itemTooltip'
import {
  DEFAULT_ITEM_ID,
  itemPresentable,
  normalizeItemTag,
  stringifyItem,
  unionItemTags,
  type ItemDocument,
} from './itemDoc'
import { ItemComponentCards } from './itemComponents/ItemComponentCards'
import { ComponentsTree } from './NbtComponentsEditor'
import './ItemEditor.css'
import './KitEditor.css'

function Segments({ segments, fallback = '#FFFFFF' }: { segments: ItemTextSegment[]; fallback?: string }) {
  return <>
    {segments.map((segment, index) => {
      const color = segment.color || fallback
      return <span
        key={index}
        style={{
          color,
          fontWeight: segment.bold ? 700 : undefined,
          fontStyle: segment.italic ? 'italic' : undefined,
          textDecoration: [segment.underlined && 'underline', segment.strikethrough && 'line-through'].filter(Boolean).join(' ') || undefined,
        }}
      >{segment.text}</span>
    })}
  </>
}

function PreviewIcon({ presentation, fingerprint }: {
  presentation: ItemPresentation
  fingerprint: string
}) {
  const icon = getCachedDisplaySync(fingerprint)?.icon
  const src = icon ? itemStackIconSrc(icon) : ''
  const mask = src ? { WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")` } as CSSProperties : undefined
  return <span className={`kit-item-icon item-preview-icon${icon ? '' : ' is-empty'}${presentation.iconStale ? ' is-stale' : ''}`}>
    {icon
      ? <img src={src} alt="" width={48} height={48} draggable={false} />
      : <span className="kit-item-icon-fallback" aria-hidden />}
    {presentation.foil && <span className={`kit-item-glint${src ? '' : ' is-unmasked'}`} style={mask} aria-hidden />}
    {presentation.iconStale && <span className="kit-item-stale" aria-label="图标为旧快照" />}
  </span>
}

function SnapshotBadge({ item }: { item: ItemDocument['item'] }) {
  const status = useItemSnapshotStatus(item)
  if (status === 'none') return <span className="item-badge is-muted">无快照</span>
  if (status === 'queued') return <span className="item-badge is-muted" title="游戏开发服务器未连接">待同步</span>
  if (status === 'pending') return <span className="item-badge is-muted">快照刷新中…</span>
  if (status === 'fresh') return <span className="item-badge is-ok">已同步</span>
  return <span className="item-badge is-warn" title="物品已修改，可在编辑菜单中刷新快照">待刷新</span>
}

function ItemTagField({ tags, disabled, onChange }: {
  tags: string[]
  disabled?: boolean
  onChange: (tags: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const selected = unionItemTags(tags)

  const addTag = (raw: string) => {
    if (disabled) return
    const tag = normalizeItemTag(raw)
    if (!tag) return
    onChange(unionItemTags(selected, [tag]))
    setDraft('')
  }

  const removeTag = (name: string) => {
    if (disabled) return
    onChange(selected.filter((item) => item.toLowerCase() !== name.toLowerCase()))
    inputRef.current?.focus()
  }

  return <div className="kit-tags-row item-tags-row">
    <span className="kit-tags-label" title="游戏标签：引擎可按标签查询物品；与礼包 tags 规则相同">标签</span>
    <div
      className={`kit-tag-picker${disabled ? ' is-disabled' : ''}${selected.length === 0 && !draft ? ' is-empty' : ''}`}
      onClick={() => { if (!disabled) inputRef.current?.focus() }}
    >
      {selected.map((name) => (
        <span key={name.toLowerCase()} className="kit-tag-chip">
          <span className="kit-tag-chip-label">{name}</span>
          <button
            type="button"
            className="kit-tag-chip-remove"
            aria-label={`移除标签 ${name}`}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => { event.stopPropagation(); removeTag(name) }}
          >×</button>
        </span>
      ))}
      {!disabled && (
        <input
          ref={inputRef}
          type="text"
          className="kit-tag-input"
          value={draft}
          disabled={disabled}
          placeholder={selected.length === 0 ? '输入标签后回车，如 reward 或 event/summer' : ''}
          aria-label="添加物品标签"
          onChange={(event) => setDraft(event.target.value.replace(/[\r\n]/g, ''))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              addTag(draft)
              return
            }
            if (event.key === 'Backspace' && draft.length === 0 && selected.length > 0) {
              event.preventDefault()
              removeTag(selected[selected.length - 1]!)
            }
          }}
          onBlur={() => { if (draft.trim()) addTag(draft) }}
        />
      )}
      {disabled && selected.length === 0 && <span className="kit-tag-empty">无</span>}
    </div>
  </div>
}

function Section({ title, hint, action, children }: {
  title: string
  hint?: string
  action?: ReactNode
  children: ReactNode
}) {
  return <section className="item-section">
    <header className="item-section-head">
      <h3>{title}</h3>
      {hint && <span>{hint}</span>}
      {action && <div className="item-section-action">{action}</div>}
    </header>
    <div className="item-section-body">{children}</div>
  </section>
}

export function ItemEditor({ doc, error, disabled, onChange }: {
  doc: ItemDocument
  error?: string
  disabled?: boolean
  onChange: (source: string) => void
}) {
  const presentable = useMemo(() => itemPresentable(doc), [doc])
  const presentation = useItemPresentation(presentable)
  const fingerprint = useMemo(() => itemFingerprint(doc.item), [doc.item])

  function update(patch: Partial<ItemDocument> | { item: Partial<ItemDocument['item']> }) {
    if (disabled || error) return
    const nextItem = 'item' in patch && patch.item
      ? { ...doc.item, ...patch.item }
      : doc.item
    const next: ItemDocument = {
      format: doc.format,
      schemaVersion: doc.schemaVersion,
      tags: 'tags' in patch ? unionItemTags(patch.tags ?? []) : doc.tags,
      item: nextItem,
      sync: 'sync' in patch ? patch.sync : doc.sync,
    }
    onChange(stringifyItem(next))
  }

  const tooltipLines = presentation.hidden
    ? [[{ text: '（原版隐藏了此物品的提示框）', color: '#555555', italic: true } as ItemTextSegment]]
    : presentation.tooltip

  if (error) return <div className="item-editor"><p className="item-banner is-error" role="alert">无法编辑此物品：{error}。请通过「查看源码」修正，或重新导入新格式文件。</p></div>

  return <div className="item-editor">
    <div className="item-page">
      {error && <p className="item-banner is-error" role="alert">无法完整解析物品草稿，已显示可编辑兜底。{error}</p>}

      <div className="item-columns">
        <aside className="item-overview" aria-label="物品概览">
          <div className="item-overview-heading"><span>物品概览</span><SnapshotBadge item={doc.item} /></div>
          <div className="item-icon-stage"><PreviewIcon presentation={presentation} fingerprint={fingerprint} /></div>
          <div className="item-preview-tip" aria-label="提示框预览">
            {tooltipLines.map((line, lineIndex) => (
              <div key={lineIndex} className="item-preview-tip-line">
                {line.length ? <Segments segments={line} fallback={presentation.defaultColor} /> : <br />}
              </div>
            ))}
          </div>
        </aside>
        <div className="item-authoring">
          <Section title="物品定义">
            <label className="item-id-field">
              <span className="item-id-label">物品 ID</span>
              <input className="item-id-input" disabled={disabled} value={doc.item.id}
                placeholder={DEFAULT_ITEM_ID} spellCheck={false} aria-label="物品 ID"
                onChange={(event) => update({ item: { id: event.target.value } })} />
            </label>
            <ItemTagField tags={doc.tags} disabled={disabled} onChange={(tags) => update({ tags })} />
          </Section>
          <ItemComponentCards components={doc.item.components} disabled={disabled}
              onChange={(components) => update({ item: { components } })} />
          <ItemSyncEditor components={doc.item.components} value={doc.sync} disabled={disabled} onChange={(sync) => update({ sync })} />
          <Section title="组件树" hint="右键管理 · 双击键名重命名"
            action={<span className="item-count">{Object.keys(doc.item.components).length}</span>}>
            <ComponentsTree value={doc.item.components} disabled={disabled}
              onChange={(components) => update({ item: { components } })} />
          </Section>
        </div>
      </div>
    </div>
  </div>
}
