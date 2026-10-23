import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
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
import { encodeItemLinkPayload, ITEM_LINK_MIME, normalizeItemRef } from './kit'
import './ItemEditor.css'
import './KitEditor.css'

type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'

function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  return 'object'
}

function defaultForType(type: JsonType): unknown {
  switch (type) {
    case 'string': return ''
    case 'number': return 0
    case 'boolean': return false
    case 'object': return {}
    case 'array': return []
    case 'null': return null
  }
}

function typeLabel(type: JsonType, value: unknown): string {
  if (type === 'array') return `Array[${Array.isArray(value) ? value.length : 0}]`
  if (type === 'object') {
    const keys = isPlainObject(value) ? Object.keys(value).length : 0
    return `Object{${keys}}`
  }
  return type.charAt(0).toUpperCase() + type.slice(1)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

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
  const locale = getCachedDisplaySync(itemFingerprint(item))?.locale
  if (status === 'none') return <span className="item-badge is-muted">无快照</span>
  if (status === 'queued') return <span className="item-badge is-muted" title="游戏开发服务器未连接">待同步</span>
  if (status === 'pending') return <span className="item-badge is-muted">快照刷新中…</span>
  if (status === 'fresh') {
    return <span className="item-badge is-ok" title={locale ? `locale ${locale}` : undefined}>
      游戏快照{locale ? ` · ${locale}` : ''}
    </span>
  }
  return <span className="item-badge is-warn" title="id / components 已变或待向客户端刷新">快照过期 · WebUI 渲染</span>
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

type TreePath = (string | number)[]

function setAtPath(root: unknown, path: TreePath, next: unknown): unknown {
  if (path.length === 0) return next
  const [head, ...rest] = path
  if (typeof head === 'number') {
    const list = Array.isArray(root) ? [...root] : []
    list[head] = setAtPath(list[head], rest, next)
    return list
  }
  const obj = isPlainObject(root) ? { ...root } : {}
  obj[head] = setAtPath(obj[head], rest, next)
  return obj
}

function deleteAtPath(root: unknown, path: TreePath): unknown {
  if (path.length === 0) return root
  const [head, ...rest] = path
  if (rest.length === 0) {
    if (typeof head === 'number' && Array.isArray(root)) {
      return root.filter((_, index) => index !== head)
    }
    if (typeof head === 'string' && isPlainObject(root)) {
      const next = { ...root }
      delete next[head]
      return next
    }
    return root
  }
  if (typeof head === 'number' && Array.isArray(root)) {
    const list = [...root]
    list[head] = deleteAtPath(list[head], rest)
    return list
  }
  if (typeof head === 'string' && isPlainObject(root)) {
    return { ...root, [head]: deleteAtPath(root[head], rest) }
  }
  return root
}

function renameObjectKey(root: unknown, path: TreePath, from: string, to: string): unknown {
  const targetPath = path.slice(0, -1)
  const parent = targetPath.length === 0 ? root : (() => {
    let cur: unknown = root
    for (const key of targetPath) {
      if (typeof key === 'number') cur = Array.isArray(cur) ? cur[key] : undefined
      else cur = isPlainObject(cur) ? cur[key] : undefined
    }
    return cur
  })()
  if (!isPlainObject(parent) || !(from in parent) || !to || to === from || to in parent) return root
  const rebuilt: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parent)) {
    rebuilt[key === from ? to : key] = value
  }
  return setAtPath(root, targetPath, rebuilt)
}

function PrimitiveEditor({ value, type, disabled, onChange }: {
  value: unknown
  type: 'string' | 'number' | 'boolean' | 'null'
  disabled?: boolean
  onChange: (value: unknown) => void
}) {
  if (type === 'boolean') {
    return <select
      className="item-tree-input is-bool"
      disabled={disabled}
      value={value === true ? 'true' : 'false'}
      onChange={(event) => onChange(event.target.value === 'true')}
      aria-label="布尔值"
    >
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  }
  if (type === 'null') {
    return <span className="item-tree-null">null</span>
  }
  if (type === 'number') {
    return <input
      className="item-tree-input is-num"
      type="text"
      inputMode="decimal"
      disabled={disabled}
      value={typeof value === 'number' && Number.isFinite(value) ? String(value) : '0'}
      onChange={(event) => {
        const raw = event.target.value.trim()
        if (raw === '' || raw === '-' || raw === '.' || raw === '-.') return
        const next = Number(raw)
        if (Number.isFinite(next)) onChange(next)
      }}
      aria-label="数值"
    />
  }
  return <input
    className="item-tree-input is-str"
    type="text"
    disabled={disabled}
    value={typeof value === 'string' ? value : ''}
    onChange={(event) => onChange(event.target.value)}
    aria-label="字符串"
  />
}

function TypeSelect({ value, disabled, onChange }: {
  value: JsonType
  disabled?: boolean
  onChange: (type: JsonType) => void
}) {
  return <select
    className="item-tree-type"
    disabled={disabled}
    value={value}
    onChange={(event) => onChange(event.target.value as JsonType)}
    aria-label="值类型"
  >
    <option value="string">string</option>
    <option value="number">number</option>
    <option value="boolean">boolean</option>
    <option value="object">object</option>
    <option value="array">array</option>
    <option value="null">null</option>
  </select>
}

function TreeNode({
  label,
  value,
  path,
  depth,
  disabled,
  expanded,
  onToggle,
  onChangeRoot,
  canRename,
  canDelete,
}: {
  label: string
  value: unknown
  path: TreePath
  depth: number
  disabled?: boolean
  expanded: Set<string>
  onToggle: (key: string) => void
  onChangeRoot: (mutator: (root: unknown) => unknown) => void
  canRename?: boolean
  canDelete?: boolean
}) {
  const type = jsonTypeOf(value)
  const pathKey = path.join('/')
  const open = expanded.has(pathKey)
  const compound = type === 'object' || type === 'array'
  const [renaming, setRenaming] = useState(false)
  const [draftKey, setDraftKey] = useState(label)

  function commitRename() {
    const next = draftKey.trim()
    setRenaming(false)
    if (!canRename || !next || next === label) {
      setDraftKey(label)
      return
    }
    onChangeRoot((root) => renameObjectKey(root, path, label, next))
  }

  return <div className="item-tree-node" style={{ '--item-depth': depth } as CSSProperties}>
    <div className="item-tree-row">
      <button
        type="button"
        className={`item-tree-twist${compound ? '' : ' is-leaf'}`}
        disabled={!compound}
        aria-label={open ? '折叠' : '展开'}
        aria-expanded={compound ? open : undefined}
        onClick={() => compound && onToggle(pathKey)}
      >{compound ? (open ? '▾' : '▸') : '·'}</button>

      {renaming ? (
        <input
          className="item-tree-key is-edit"
          value={draftKey}
          disabled={disabled}
          autoFocus
          aria-label="组件键名"
          onChange={(event) => setDraftKey(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') commitRename()
            if (event.key === 'Escape') { setDraftKey(label); setRenaming(false) }
          }}
        />
      ) : (
        <button
          type="button"
          className="item-tree-key"
          disabled={disabled || !canRename}
          title={canRename ? '双击重命名' : undefined}
          onDoubleClick={() => {
            if (disabled || !canRename) return
            setDraftKey(label)
            setRenaming(true)
          }}
        >{label}</button>
      )}

      <span className={`item-tree-badge is-${type}`}>{typeLabel(type, value)}</span>

      <span className="item-tree-value">
        {!compound && (
          <PrimitiveEditor
            value={value}
            type={type === 'null' ? 'null' : type === 'boolean' ? 'boolean' : type === 'number' ? 'number' : 'string'}
            disabled={disabled}
            onChange={(next) => onChangeRoot((root) => setAtPath(root, path, next))}
          />
        )}
      </span>

      <TypeSelect
        value={type}
        disabled={disabled}
        onChange={(nextType) => {
          if (nextType === type) return
          onChangeRoot((root) => setAtPath(root, path, defaultForType(nextType)))
        }}
      />

      <span className="item-tree-ops">
        {canDelete ? (
          <button
            type="button"
            className="item-tree-action is-danger"
            disabled={disabled}
            title="删除"
            aria-label={`删除 ${label}`}
            onClick={() => onChangeRoot((root) => deleteAtPath(root, path))}
          >×</button>
        ) : null}
      </span>
    </div>

    {compound && open && (
      <div className="item-tree-children">
        {type === 'object' && isPlainObject(value) && Object.entries(value).map(([key, child]) => (
          <TreeNode
            key={`${pathKey}/${key}`}
            label={key}
            value={child}
            path={[...path, key]}
            depth={depth + 1}
            disabled={disabled}
            expanded={expanded}
            onToggle={onToggle}
            onChangeRoot={onChangeRoot}
            canRename
            canDelete
          />
        ))}
        {type === 'array' && Array.isArray(value) && value.map((child, index) => (
          <TreeNode
            key={`${pathKey}/${index}`}
            label={`[${index}]`}
            value={child}
            path={[...path, index]}
            depth={depth + 1}
            disabled={disabled}
            expanded={expanded}
            onToggle={onToggle}
            onChangeRoot={onChangeRoot}
            canDelete
          />
        ))}
        <div className="item-tree-add" style={{ '--item-depth': depth + 1 } as CSSProperties}>
          {type === 'object' ? (
            <AddEntry
              disabled={disabled}
              existing={isPlainObject(value) ? Object.keys(value) : []}
              onAdd={(key, childType) => onChangeRoot((root) => setAtPath(root, [...path, key], defaultForType(childType)))}
            />
          ) : (
            <button
              type="button"
              className="item-tree-action"
              disabled={disabled}
              onClick={() => onChangeRoot((root) => {
                const current = Array.isArray(value) ? value : []
                return setAtPath(root, path, [...current, ''])
              })}
            >＋ 添加元素</button>
          )}
        </div>
      </div>
    )}
  </div>
}

function AddEntry({ disabled, existing, onAdd }: {
  disabled?: boolean
  existing: string[]
  onAdd: (key: string, type: JsonType) => void
}) {
  const [key, setKey] = useState('')
  const [type, setType] = useState<JsonType>('string')
  const taken = new Set(existing)

  function submit() {
    const next = key.trim()
    if (!next || taken.has(next)) return
    onAdd(next, type)
    setKey('')
    setType('string')
  }

  return <div className="item-add-entry">
    <input
      className="item-tree-input is-str"
      placeholder="键名，如 minecraft:lore"
      disabled={disabled}
      value={key}
      onChange={(event) => setKey(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
      aria-label="新键名"
    />
    <TypeSelect value={type} disabled={disabled} onChange={setType} />
    <button type="button" className="item-tree-action" disabled={disabled || !key.trim() || taken.has(key.trim())} onClick={submit}>
      ＋ 添加
    </button>
  </div>
}

function ComponentsTree({ value, disabled, onChange }: {
  value: Record<string, unknown>
  disabled?: boolean
  onChange: (value: Record<string, unknown>) => void
}) {
  const [expanded, setExpanded] = useState(() => new Set<string>())

  function toggle(key: string) {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function changeRoot(mutator: (root: unknown) => unknown) {
    const next = mutator(value)
    onChange(isPlainObject(next) ? next : {})
  }

  const entries = Object.entries(value)

  return <div className="item-tree" role="tree" aria-label="物品组件">
    {entries.length === 0 && <p className="item-tree-empty">暂无组件 · 在下方添加，或从 .itemstack 导入</p>}
    {entries.map(([key, child]) => (
      <TreeNode
        key={key}
        label={key}
        value={child}
        path={[key]}
        depth={0}
        disabled={disabled}
        expanded={expanded}
        onToggle={toggle}
        onChangeRoot={changeRoot}
        canRename
        canDelete
      />
    ))}
    <div className="item-tree-add is-root">
      <AddEntry
        disabled={disabled}
        existing={Object.keys(value)}
        onAdd={(key, type) => onChange({ ...value, [key]: defaultForType(type) })}
      />
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

export function ItemEditor({ doc, error, disabled, selfRef, onChange }: {
  doc: ItemDocument
  error?: string
  disabled?: boolean
  /** 当前资源引用名（文件名去 .item），用于拖到礼包建链接 */
  selfRef?: string
  onChange: (source: string) => void
}) {
  const presentable = useMemo(() => itemPresentable(doc), [doc])
  const presentation = useItemPresentation(presentable)
  const fingerprint = useMemo(() => itemFingerprint(doc.item), [doc.item])
  const linkRef = normalizeItemRef(selfRef || '')

  function update(patch: Partial<ItemDocument> | { item: Partial<ItemDocument['item']> }) {
    if (disabled) return
    const nextItem = 'item' in patch && patch.item
      ? { ...doc.item, ...patch.item }
      : doc.item
    const next: ItemDocument = {
      format: doc.format,
      schemaVersion: doc.schemaVersion,
      tags: 'tags' in patch ? unionItemTags(patch.tags ?? []) : doc.tags,
      item: nextItem,
    }
    onChange(stringifyItem(next))
  }

  function onLinkDragStart(event: DragEvent) {
    if (!linkRef) return
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(ITEM_LINK_MIME, encodeItemLinkPayload(linkRef))
    event.dataTransfer.setData('text/plain', linkRef)
  }

  const tooltipLines = presentation.hidden
    ? [[{ text: '（原版隐藏了此物品的提示框）', color: '#555555', italic: true } as ItemTextSegment]]
    : presentation.tooltip

  return <div className="item-editor">
    <div className="item-page">
      {error && <p className="item-banner is-error" role="alert">无法完整解析物品草稿，已显示可编辑兜底。{error}</p>}

      <header className="item-header">
        <label className="item-id-field">
          <span className="item-id-label">物品 ID</span>
          <input
            className="item-id-input"
            disabled={disabled}
            value={doc.item.id}
            placeholder={DEFAULT_ITEM_ID}
            spellCheck={false}
            aria-label="物品 ID"
            onChange={(event) => update({ item: { id: event.target.value } })}
          />
        </label>
        <div className="item-header-meta">
          <span className="item-badge is-muted">{doc.format}</span>
          <span className="item-badge is-muted">v{doc.schemaVersion}</span>
          <SnapshotBadge item={doc.item} />
          {linkRef && (
            <button
              type="button"
              className="item-drag-chip"
              draggable
              title="拖到礼包物品栏以创建链接"
              aria-label={`拖到礼包：链接 ${linkRef}`}
              onDragStart={onLinkDragStart}
            >
              ⋮⋮ 拖到礼包 · {linkRef}
            </button>
          )}
        </div>
      </header>

      <ItemTagField tags={doc.tags} disabled={disabled} onChange={(tags) => update({ tags })} />

      <div className="item-columns">
        <Section title="预览" hint="快照优先；过期时用 WebUI 近似 · 菜单「编辑 → 刷新物品快照」">
          <div className="item-preview">
            <PreviewIcon presentation={presentation} fingerprint={fingerprint} />
            <div className="item-preview-tip" aria-label="提示框预览">
              {tooltipLines.map((line, lineIndex) => (
                <div key={lineIndex} className="item-preview-tip-line">
                  {line.length ? <Segments segments={line} fallback={presentation.defaultColor} /> : <br />}
                </div>
              ))}
              {doc.item.id && <div className="item-preview-tip-line is-id"><span style={{ color: '#555555' }}>{doc.item.id}</span></div>}
            </div>
            <p className="item-preview-note">
              {presentation.source === 'snapshot' ? '显示游戏快照' : '显示 WebUI 渲染'}
              {presentation.unrendered.length > 0 ? ` · ${presentation.unrendered.length} 个组件未在提示中展开` : ''}
              <span className="item-preview-fp" title="id + components 指纹">{fingerprint}</span>
            </p>
          </div>
        </Section>

        <Section
          title="组件"
          hint="仿 NBT 树编辑 · 双击键名可重命名"
          action={<span className="item-count">{Object.keys(doc.item.components).length}</span>}
        >
          <ComponentsTree
            value={doc.item.components}
            disabled={disabled}
            onChange={(components) => update({ item: { components } })}
          />
        </Section>
      </div>
    </div>
  </div>
}
