import { useId, useState, type DragEvent } from 'react'
import { Panel, RemoveButton } from './KitEditor'
import { IconButton, JsonRepairPane, PendingBanner, RefBadge, errorText, useSheetDraft } from './SheetParts'
import {
  createScriptLoad,
  parseScriptLoad,
  readScriptLoadSource,
  stringifyScriptLoad,
  scriptLoadLabel,
  type ScriptLoadDocument,
  type ScriptLoadType,
} from './scriptLoad'
import './ActorEditor.css'

export type ScriptLoadOption = { ref: string; label: string; key?: string; builtin?: boolean }

const ENTRY_MIME = 'application/x-hanshu-progress-entry'
const ORDER_MIME = 'application/x-hanshu-script-load-order'

function swap<T>(list: T[], index: number, delta: number): T[] {
  const next = [...list]
  const target = index + delta
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}

function dragTypes(transfer: DataTransfer): string[] {
  return Array.from(transfer.types as unknown as ArrayLike<string>)
}

function hasScriptLoadDrag(transfer: DataTransfer) {
  const types = dragTypes(transfer)
  return types.includes(ENTRY_MIME) || types.includes(ORDER_MIME)
}

function hasOrderDrag(transfer: DataTransfer) {
  return dragTypes(transfer).includes(ORDER_MIME)
}

const TYPE_HINT: Record<ScriptLoadType, string> = {
  common: '同 priority 内按此顺序挂载 · 空列表表示不自动启用',
  player: '同 hook／priority 内按此顺序挂载 · 空列表表示不自动启用',
}

export function ScriptLoadEditor({
  type,
  source,
  disabled,
  scriptOptions,
  onChange,
  onOpenScript,
}: {
  type: ScriptLoadType
  source: string
  disabled?: boolean
  scriptOptions: ScriptLoadOption[]
  onChange: (source: string) => void
  onOpenScript: (key: string) => void
}) {
  const listId = useId()
  const [over, setOver] = useState(false)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [dropHint, setDropHint] = useState('')
  const parsed = readScriptLoadSource(source)
  const [repairing, setRepairing] = useState(false)
  const { pending, commit, discard } = useSheetDraft(source, !!disabled, parseScriptLoad, stringifyScriptLoad, onChange)
  const doc: ScriptLoadDocument = pending?.doc ?? parsed.doc ?? createScriptLoad()
  const error = parsed.error
  const update = (patch: Partial<ScriptLoadDocument>) => commit({ ...doc, ...patch })
  const flashHint = (message: string) => {
    setDropHint(message)
    window.setTimeout(() => setDropHint(current => current === message ? '' : current), 2400)
  }

  if (error || repairing) {
    return <JsonRepairPane
      title={scriptLoadLabel(type)}
      label={`src/script/${type}/load.json`}
      source={source}
      error={error || '手动编辑 JSON'}
      disabled={!!disabled}
      apply={text => {
        try {
          parseScriptLoad(text)
          setRepairing(false)
          onChange(text.endsWith('\n') ? text : `${text}\n`)
        } catch (cause) {
          throw new Error(errorText(cause))
        }
      }}
      onCancel={error ? undefined : () => setRepairing(false)}
    />
  }

  const label = scriptLoadLabel(type)
  const available = scriptOptions.filter(option => !doc.scripts.includes(option.ref))
  const optionByEntry = (entryId: string) => scriptOptions.find(option => option.key && `document:${option.key}` === entryId)

  const clearDrop = () => {
    setOver(false)
    setDropIndex(null)
  }

  const onZoneDragOver = (event: DragEvent, index: number | null = null) => {
    if (disabled || !hasScriptLoadDrag(event.dataTransfer)) return
    // 必须 preventDefault 才会触发 drop；dropEffect 须落在源 effectAllowed 内。
    // 资源树脚本默认是 move／copyMove，勿强行 copy，否则 WebView2／Chrome 会显示禁止投放。
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setOver(true)
    if (dropIndex !== index) setDropIndex(index)
  }

  const addRef = (ref: string, at: number | null = null) => {
    if (disabled || doc.scripts.includes(ref)) return
    if (at == null || at < 0 || at > doc.scripts.length) {
      update({ scripts: [...doc.scripts, ref] })
      return
    }
    const next = [...doc.scripts]
    next.splice(at, 0, ref)
    update({ scripts: next })
  }

  const onZoneDrop = (event: DragEvent, at: number | null = null) => {
    if (disabled) return
    event.preventDefault()
    event.stopPropagation()
    clearDrop()
    if (hasOrderDrag(event.dataTransfer)) {
      let order: { listId: string; index: number }
      try {
        order = JSON.parse(event.dataTransfer.getData(ORDER_MIME))
      } catch {
        return
      }
      if (order.listId !== listId) return
      const from = order.index
      if (!Number.isInteger(from) || from < 0 || from >= doc.scripts.length) return
      const next = [...doc.scripts]
      const [moved] = next.splice(from, 1)
      if (moved == null) return
      if (at == null) next.push(moved)
      else next.splice(Math.min(at, next.length), 0, moved)
      update({ scripts: next })
      return
    }
    const entryId = event.dataTransfer.getData(ENTRY_MIME)
    if (!entryId) return
    const option = optionByEntry(entryId)
    if (!option) {
      flashHint(`只能拖入 ${type} 类型脚本`)
      return
    }
    if (doc.scripts.includes(option.ref)) {
      flashHint(`已在列表中：${option.ref}`)
      return
    }
    addRef(option.ref, at)
  }

  return <div className="flow-kit-pane sheet-editor actor-editor" aria-label={`${label}编辑器`}>
    <div className="kit-editor"><div className="kit-page sheet-page">
      <header className="kit-header sheet-header">
        <div className="sheet-heading">
          <h2>{label}</h2>
          <span className="sheet-kind">load.json</span>
        </div>
        <span className="sheet-header-hint">固定路径 src/script/{type}/load.json · 出现即启用，未列入仅可被 import</span>
        <div className="sheet-header-actions">
          <button type="button" className="sheet-btn is-quiet" disabled={disabled} onClick={() => { discard(); setRepairing(true) }}>编辑 JSON</button>
        </div>
      </header>
      {pending && <PendingBanner issue={pending.issue} onDiscard={discard} />}
      <Panel
        title={label}
        subtitle={TYPE_HINT[type]}
        count={doc.scripts.length}
        className={`actor-scripts${over ? ' is-drop-over' : ''}`}
        action={<select
          className="sheet-select actor-add-select"
          aria-label={`添加${label}脚本`}
          value=""
          disabled={disabled}
          onChange={e => {
            if (e.target.value) addRef(e.target.value)
          }}
        >
          <option value="">{available.length ? '+ 添加脚本…' : scriptOptions.length ? '已全部添加' : '没有可添加的脚本'}</option>
          {available.map(option => (
            <option key={option.ref} value={option.ref}>
              {option.builtin ? `内置 · ${option.label}` : option.label}
            </option>
          ))}
        </select>}
      >
        <div
          className={`actor-script-drop${over ? ' is-over' : ''}`}
          onDragEnter={event => onZoneDragOver(event)}
          onDragOver={event => onZoneDragOver(event)}
          onDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearDrop()
          }}
          onDrop={event => onZoneDrop(event)}
        >
          {doc.scripts.length === 0
            ? <p className="kit-empty">{scriptOptions.length
              ? '列表为空：不会自动挂载任何脚本。从资源树拖入，或从右上角添加。'
              : `项目中还没有 ${type} 脚本。在 src/script/${type}/ 下新建 .js，或等待内置脚本后即可添加。`}</p>
            : <ol className="kit-list actor-script-list">
              {doc.scripts.map((id, index) => {
                const option = scriptOptions.find(item => item.ref === id)
                return <li
                  key={id}
                  className={`kit-row actor-script-row${option ? '' : ' is-missing'}${dropIndex === index ? ' is-drop' : ''}`}
                  draggable={!disabled}
                  onDragStart={event => {
                    event.dataTransfer.setData(ORDER_MIME, JSON.stringify({ listId, index }))
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={event => onZoneDragOver(event, index)}
                  onDrop={event => onZoneDrop(event, index)}
                >
                  <span className="actor-script-grip" title="拖动调整顺序" aria-hidden>⠿</span>
                  <span className="kit-row-index">{index + 1}</span>
                  <span className="actor-script-name">
                    <code>{id}</code>
                    {option?.builtin && <small>内置</small>}
                    {option && !option.builtin && option.label !== id && <small>{option.label}</small>}
                    <RefBadge missing={!option} />
                  </span>
                  {option?.key
                    ? <button type="button" className="sheet-btn is-quiet" onClick={() => onOpenScript(option.key!)}>打开脚本</button>
                    : <span />}
                  <span className="actor-row-tools">
                    <IconButton label={`上移 ${id}`} glyph="↑" disabled={disabled || index === 0} onClick={() => update({ scripts: swap(doc.scripts, index, -1) })} />
                    <IconButton label={`下移 ${id}`} glyph="↓" disabled={disabled || index === doc.scripts.length - 1} onClick={() => update({ scripts: swap(doc.scripts, index, 1) })} />
                    <RemoveButton label={`移除 ${id}`} disabled={disabled} onClick={() => update({ scripts: doc.scripts.filter(item => item !== id) })} />
                  </span>
                </li>
              })}
            </ol>}
          {!disabled && <p className="sheet-note">{dropHint || (over ? `松开以加入${label}` : '可从资源树拖入脚本；拖动行可调整顺序。')}</p>}
        </div>
      </Panel>
      <p className="sheet-note is-info"><span>改名不会自动改写列表；缺失引用导出时记为警告并跳过该项。未列入的脚本仍会进入 PAK，只是不自动挂载，可供 import。内置与工程同名时按覆盖后的有效脚本计入。</span></p>
    </div></div>
  </div>
}
