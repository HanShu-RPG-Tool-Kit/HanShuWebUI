import { useEffect, useRef, useState } from 'react'
import type { LevelCustomData, LevelDocument } from './levelDoc'
import {
  canonicalCustomText,
  customTextStatus,
  readCustomObject,
  type LevelDraftRecord,
} from './levelLayoutModel'
import {
  customPathKey,
  deleteAt,
  foldCustomDrafts,
  setAt,
  type CustomAddDraft,
  type CustomLeafDraft,
  type CustomPath,
} from './levelCustomPath'
import { CustomTree, type CustomTreeApi } from './levelCustomTree'
import './levelCustomData.css'

export function LevelCustomData({
  custom,
  reservedKeys = [],
  disabled,
  order,
  readCustom,
  writeCustom,
  onChange,
  onDraft,
}: {
  custom: LevelCustomData
  reservedKeys?: readonly string[]
  disabled?: boolean
  order: number
  readCustom: (doc: LevelDocument) => LevelCustomData
  writeCustom: (doc: LevelDocument, custom: LevelCustomData) => LevelDocument
  onChange: (custom: LevelCustomData) => void
  onDraft: (draft: LevelDraftRecord | null) => void
}) {
  const [text, setText] = useState(() => canonicalCustomText(custom))
  const [leaves, setLeaves] = useState<Record<string, CustomLeafDraft>>({})
  const [blurred, setBlurred] = useState<Record<string, boolean>>({})
  const [adds, setAdds] = useState<Record<string, CustomAddDraft>>({})
  const [formError, setFormError] = useState('')
  const canonicalRef = useRef(canonicalCustomText(custom))
  const textRef = useRef(text)
  const leafRef = useRef<CustomLeafDraft[]>([])
  const addRef = useRef<CustomAddDraft[]>([])
  const reservedRef = useRef(reservedKeys)
  const onDraftRef = useRef(onDraft)
  const reduceRef = useRef(writeCustom)
  const readRef = useRef(readCustom)
  const mounted = useRef(true)
  const canonical = canonicalCustomText(custom)
  let shownText = text
  if (canonicalRef.current !== canonical) {
    const previous = canonicalRef.current
    canonicalRef.current = canonical
    if (text === previous) {
      shownText = canonical
      setText(canonical)
    }
  }
  textRef.current = shownText
  leafRef.current = Object.values(leaves)
  addRef.current = Object.values(adds)
  reservedRef.current = reservedKeys
  onDraftRef.current = onDraft
  reduceRef.current = writeCustom
  readRef.current = readCustom

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const status = customTextStatus(shownText, custom)
  const folded = foldCustomDrafts(custom, reservedKeys, leafRef.current, addRef.current)
  const message = status.state === 'invalid'
    ? status.message
    : status.state === 'unapplied'
      ? '高级 JSON 尚未应用'
      : folded.message
  const pending = status.state !== 'clean' || folded.pending

  function dropUnder(prefix: CustomPath) {
    setLeaves((current) => {
      const next = { ...current }
      let changed = false
      for (const [id, leaf] of Object.entries(next)) {
        if (pathUnder(leaf.path, prefix)) { delete next[id]; changed = true }
      }
      return changed ? next : current
    })
    setAdds((current) => {
      const next = { ...current }
      let changed = false
      for (const [id, add] of Object.entries(next)) {
        if (pathUnder(add.container, prefix) || customPathKey(add.container) === customPathKey(prefix)) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : current
    })
  }

  function clearSnapshot(leafSnapshot: CustomLeafDraft[], addSnapshot: CustomAddDraft[]) {
    queueMicrotask(() => {
      if (!mounted.current) return
      setLeaves((current) => {
        const next = { ...current }
        let changed = false
        for (const leaf of leafSnapshot) {
          const id = customPathKey(leaf.path)
          const live = next[id]
          if (live && live.raw === leaf.raw && live.kind === leaf.kind) { delete next[id]; changed = true }
        }
        return changed ? next : current
      })
      setAdds((current) => {
        const next = { ...current }
        let changed = false
        for (const add of addSnapshot) {
          const id = customPathKey(add.container)
          const live = next[id]
          if (live && live.name === add.name && live.kind === add.kind && live.raw === add.raw && live.mode === add.mode) {
            delete next[id]
            changed = true
          }
        }
        return changed ? next : current
      })
      setFormError('')
    })
  }

  useEffect(() => {
    if (!pending && !message) {
      onDraftRef.current(null)
      return
    }
    onDraftRef.current({
      order,
      pending: true,
      message,
      reduce: message ? null : (doc) => {
        const live = readRef.current(doc)
        const liveText = customTextStatus(textRef.current, live)
        if (liveText.state === 'invalid') return { blocked: liveText.message }
        if (liveText.state === 'unapplied') return { blocked: '高级 JSON 尚未应用' }
        const leafSnapshot = leafRef.current.map((leaf) => ({ ...leaf, path: [...leaf.path] }))
        const addSnapshot = addRef.current.map((add) => ({ ...add, container: [...add.container] }))
        const next = foldCustomDrafts(live, reservedRef.current, leafSnapshot, addSnapshot)
        if (next.message) return { blocked: next.message }
        if (next.pending) clearSnapshot(leafSnapshot, addSnapshot)
        return reduceRef.current(doc, next.custom)
      },
    })
    return () => onDraftRef.current(null)
  }, [message, order, pending])

  function onLeaf(path: CustomPath, kind: 'string' | 'number', raw: string) {
    setLeaves((current) => ({ ...current, [customPathKey(path)]: { path, kind, raw } }))
  }

  function onBlurLeaf(path: CustomPath, _kind: 'string' | 'number') {
    const id = customPathKey(path)
    setBlurred((current) => ({ ...current, [id]: true }))
    if (disabled) return
    const draft = leafRef.current.find((leaf) => customPathKey(leaf.path) === id)
    if (!draft) return
    const result = foldCustomDrafts(custom, reservedKeys, [draft], [])
    if (result.message) return
    setLeaves((current) => {
      if (!current[id]) return current
      const next = { ...current }
      delete next[id]
      return next
    })
    if (result.pending) onChange(result.custom)
  }

  function onToggle(path: CustomPath, current: boolean) {
    if (disabled) return
    onChange(setAt(custom, path, !current))
  }

  function onRemove(path: CustomPath) {
    if (disabled) return
    dropUnder(path)
    onChange(deleteAt(custom, path))
  }

  function onAddPatch(container: CustomPath, mode: 'key' | 'item', patch: Partial<Pick<CustomAddDraft, 'name' | 'kind' | 'raw'>>) {
    const id = customPathKey(container)
    setAdds((current) => {
      const previous = current[id] ?? { container, mode, name: '', kind: 'string' as const, raw: '' }
      return { ...current, [id]: { ...previous, ...patch, container, mode } }
    })
    setFormError('')
  }

  function onAddCommit(container: CustomPath) {
    if (disabled) return
    const id = customPathKey(container)
    const draft = adds[id]
    if (!draft) {
      setFormError('键名不能为空')
      return
    }
    const result = foldCustomDrafts(custom, reservedKeys, [], [draft])
    if (result.message) { setFormError(result.message); return }
    if (!result.pending) {
      setFormError(draft.mode === 'key' ? '键名不能为空' : '新项尚未添加')
      return
    }
    setAdds((current) => {
      if (!current[id]) return current
      const next = { ...current }
      delete next[id]
      return next
    })
    setFormError('')
    onChange(result.custom)
  }

  function onAddCancel(container: CustomPath) {
    const id = customPathKey(container)
    setAdds((current) => {
      if (!current[id]) return current
      const next = { ...current }
      delete next[id]
      return next
    })
    setFormError('')
  }

  const api: CustomTreeApi = {
    disabled,
    reservedKeys,
    leaves,
    blurred,
    adds,
    onLeaf,
    onBlurLeaf,
    onToggle,
    onRemove,
    onAddPatch,
    onAddCommit,
    onAddCancel,
  }
  const jsonMessage = status.state === 'invalid' ? status.message : status.state === 'unapplied' ? '尚未应用，保存会停在这里' : ''
  const notice = folded.message || formError

  return (
    <section className="level-group" aria-label="自定义数据">
      <h3>自定义数据</h3>
      <CustomTree custom={custom} api={api} />
      {notice && <p className="level-field-error" role="alert">{notice}</p>}
      <details className="level-json level-custom-json">
        <summary>高级 JSON</summary>
        <textarea
          aria-label="custom_data"
          disabled={disabled}
          value={shownText}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="level-custom-json-actions">
          <button
            type="button"
            disabled={disabled || status.state === 'clean' || status.state === 'invalid'}
            onClick={() => {
              const parsed = readCustomObject(text)
              if (!parsed.ok || disabled) return
              onChange(parsed.value)
              const next = canonicalCustomText(parsed.value)
              canonicalRef.current = next
              setText(next)
              setLeaves({})
              setAdds({})
              setBlurred({})
              setFormError('')
            }}
          >
            应用
          </button>
          <button
            type="button"
            disabled={status.state === 'clean'}
            onClick={() => {
              setText(canonical)
              canonicalRef.current = canonical
            }}
          >
            取消
          </button>
          {jsonMessage && <span className="level-field-error" role="status">{jsonMessage}</span>}
        </div>
      </details>
    </section>
  )
}

function pathUnder(path: CustomPath, prefix: CustomPath): boolean {
  if (prefix.length > path.length) return false
  return prefix.every((segment, index) => path[index] === segment)
}
