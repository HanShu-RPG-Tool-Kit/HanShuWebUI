import type { ReactNode } from 'react'
import type { LevelCustomData } from './levelDoc'
import {
  customKindLabel,
  customPathKey,
  customPathLabel,
  customValueKind,
  isCustomRecord,
  ownCustomEntries,
  summarizeCustomValue,
  type CustomAddDraft,
  type CustomLeafDraft,
  type CustomPath,
  type CustomValueKind,
} from './levelCustomPath'

export type CustomTreeApi = {
  disabled?: boolean
  reservedKeys: readonly string[]
  leaves: Record<string, CustomLeafDraft>
  blurred: Record<string, boolean>
  adds: Record<string, CustomAddDraft>
  onLeaf: (path: CustomPath, kind: 'string' | 'number', raw: string) => void
  onBlurLeaf: (path: CustomPath, kind: 'string' | 'number') => void
  onToggle: (path: CustomPath, value: boolean) => void
  onRemove: (path: CustomPath) => void
  onAddPatch: (container: CustomPath, mode: 'key' | 'item', patch: Partial<Pick<CustomAddDraft, 'name' | 'kind' | 'raw'>>) => void
  onAddCommit: (container: CustomPath) => void
  onAddCancel: (container: CustomPath) => void
}

const KINDS: CustomValueKind[] = ['string', 'number', 'boolean', 'null', 'object', 'array']

function visibleName(path: CustomPath): string {
  const leaf = path[path.length - 1]
  return typeof leaf === 'number' ? `[${leaf}]` : String(leaf ?? '')
}

export function CustomTree({ custom, api }: { custom: LevelCustomData; api: CustomTreeApi }) {
  return (
    <div className="level-custom-tree">
      <CustomNodes value={custom} path={[]} atRoot api={api} />
      <AddRow container={[]} mode="key" api={api} />
    </div>
  )
}

function CustomNodes({ value, path, atRoot, api }: { value: object; path: CustomPath; atRoot: boolean; api: CustomTreeApi }) {
  const reserved = new Set(atRoot ? api.reservedKeys : [])
  return ownCustomEntries(value)
    .filter(([key]) => !reserved.has(key))
    .map(([key, item]) => <CustomNode key={key} value={item} path={[...path, key]} api={api} />)
}

function CustomNode({ value, path, api }: { value: unknown; path: CustomPath; api: CustomTreeApi }) {
  const kind = customValueKind(value)
  if (kind === 'object' && isCustomRecord(value)) {
    return (
      <Branch path={path} kind="object" value={value} api={api}>
        <CustomNodes value={value} path={path} atRoot={false} api={api} />
        <AddRow container={path} mode="key" api={api} />
      </Branch>
    )
  }
  if (kind === 'array' && Array.isArray(value)) {
    return (
      <Branch path={path} kind="array" value={value} api={api}>
        {value.map((item, index) => <CustomNode key={index} value={item} path={[...path, index]} api={api} />)}
        <AddRow container={path} mode="item" api={api} />
      </Branch>
    )
  }
  return <ScalarRow path={path} value={value} api={api} />
}

function Branch({ path, kind, value, api, children }: {
  path: CustomPath
  kind: 'object' | 'array'
  value: unknown
  api: CustomTreeApi
  children: ReactNode
}) {
  const label = customPathLabel(path)
  return (
    <div className="level-custom-branch" style={{ marginLeft: Math.max(0, path.length - 1) * 8 }}>
      <details className="level-custom-node">
        <summary>
          <span className="level-custom-key" title={label}>{visibleName(path)}</span>
          <span className="level-custom-kind">{customKindLabel(kind)}</span>
          <span className="level-custom-summary">{summarizeCustomValue(value)}</span>
        </summary>
        <div className="level-custom-children">{children}</div>
      </details>
      <button type="button" className="level-custom-remove" aria-label={`移除 ${label}`} disabled={api.disabled} onClick={() => api.onRemove(path)}>移除</button>
    </div>
  )
}

function ScalarRow({ path, value, api }: { path: CustomPath; value: unknown; api: CustomTreeApi }) {
  const label = customPathLabel(path)
  const kind = customValueKind(value)
  const id = customPathKey(path)
  const draft = api.leaves[id]
  const shownKind = kind === 'number' || kind === 'string' ? kind : null
  const fallback = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value : ''
  const raw = draft?.raw
  const shown = raw ?? fallback
  const dirty = raw !== undefined && raw !== fallback
  const invalid = dirty && api.blurred[id] && shownKind === 'number' && raw !== undefined && !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw.trim())
  return (
    <div className="level-custom-row" style={{ marginLeft: Math.max(0, path.length - 1) * 8 }}>
      <span className="level-custom-key" title={label}>{visibleName(path)}</span>
      <span className="level-custom-kind">{kind ? customKindLabel(kind) : '值'}</span>
      {kind === 'boolean' ? (
        <button
          type="button"
          role="switch"
          className="level-custom-switch"
          aria-label={label}
          aria-checked={value === true}
          disabled={api.disabled}
          onClick={() => api.onToggle(path, value === true)}
        >
          {value === true ? '开' : '关'}
        </button>
      ) : kind === 'null' ? (
        <span className="level-custom-null">空值</span>
      ) : shownKind ? (
        <input
          aria-label={label}
          disabled={api.disabled}
          inputMode={shownKind === 'number' ? 'decimal' : 'text'}
          aria-invalid={invalid ? true : undefined}
          value={shown}
          onChange={(event) => api.onLeaf(path, shownKind, event.target.value)}
          onBlur={() => api.onBlurLeaf(path, shownKind)}
        />
      ) : (
        <span className="level-custom-summary">高级 JSON</span>
      )}
      <button type="button" className="level-custom-remove" aria-label={`移除 ${label}`} disabled={api.disabled} onClick={() => api.onRemove(path)}>移除</button>
    </div>
  )
}

function AddRow({ container, mode, api }: { container: CustomPath; mode: 'key' | 'item'; api: CustomTreeApi }) {
  const id = customPathKey(container)
  const draft = api.adds[id]
  const name = draft?.name ?? ''
  const kind = draft?.kind ?? 'string'
  const raw = draft?.raw ?? ''
  const scope = customPathLabel(container)
  const nameLabel = scope ? `新键名 ${scope}` : '新键名'
  const typeLabel = scope ? `${mode === 'item' ? '新项类型' : '新键类型'} ${scope}` : '新键类型'
  const valueLabel = scope ? `${mode === 'item' ? '新项值' : '新键值'} ${scope}` : '新键值'
  const addLabel = scope ? `${mode === 'item' ? '添加项' : '添加键'} ${scope}` : '添加键'
  const cancelLabel = scope ? `${mode === 'item' ? '放弃新项' : '放弃新键'} ${scope}` : '放弃新键'
  const pending = !!draft && (mode === 'item' || name !== '' || raw !== '' || kind !== 'string')
  return (
    <div className="level-custom-add" style={{ marginLeft: container.length * 8 }}>
      {mode === 'key' && (
        <input
          aria-label={nameLabel}
          disabled={api.disabled}
          value={name}
          placeholder="键"
          onChange={(event) => api.onAddPatch(container, mode, { name: event.target.value })}
        />
      )}
      <select
        aria-label={typeLabel}
        disabled={api.disabled}
        value={kind}
        onChange={(event) => api.onAddPatch(container, mode, { kind: event.target.value as CustomValueKind })}
      >
        {KINDS.map((item) => <option key={item} value={item}>{customKindLabel(item)}</option>)}
      </select>
      {kind === 'boolean' ? (
        <button
          type="button"
          role="switch"
          className="level-custom-switch"
          aria-label={valueLabel}
          aria-checked={raw === 'true'}
          disabled={api.disabled}
          onClick={() => api.onAddPatch(container, mode, { raw: raw === 'true' ? 'false' : 'true' })}
        >
          {raw === 'true' ? '开' : '关'}
        </button>
      ) : kind === 'null' ? (
        <span className="level-custom-null">空值</span>
      ) : kind === 'object' || kind === 'array' ? (
        <span className="level-custom-summary">{kind === 'object' ? '空对象' : '空列表'}</span>
      ) : (
        <input
          aria-label={valueLabel}
          disabled={api.disabled}
          value={raw}
          placeholder="值"
          inputMode={kind === 'number' ? 'decimal' : 'text'}
          onChange={(event) => api.onAddPatch(container, mode, { raw: event.target.value })}
        />
      )}
      <button type="button" disabled={api.disabled} aria-label={addLabel} onClick={() => api.onAddCommit(container)}>添加</button>
      <button type="button" disabled={!pending} aria-label={cancelLabel} onClick={() => api.onAddCancel(container)}>放弃</button>
    </div>
  )
}
