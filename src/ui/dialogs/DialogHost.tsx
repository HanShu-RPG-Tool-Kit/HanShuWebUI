import { useEffect, useLayoutEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  finishDialog,
  getDialogSnapshot,
  subscribeDialogs,
  type ChooseDialogRequest,
  type DialogRequest,
  type PromptDialogRequest,
} from './dialogStore'
import './dialogs.css'

/** 全应用只挂一次。调用方用 alertDialog / confirmDialog / promptDialog / chooseDialog。 */
export function DialogHost() {
  const request = useDialogRequest()
  if (!request) return null
  return createPortal(<DialogFrame key={request.id} request={request} />, document.body)
}

function useDialogRequest() {
  return useSyncExternalStore(subscribeDialogs, getDialogSnapshot, getDialogSnapshot)
}

function DialogFrame({ request }: { request: DialogRequest }) {
  const titleId = useId()
  const done = useRef(false)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  const settle = (value: void | boolean | string | null) => {
    if (done.current) return
    done.current = true
    if (request.kind === 'alert') request.resolve()
    else if (request.kind === 'confirm') request.resolve(Boolean(value))
    else request.resolve(typeof value === 'string' ? value : null)
    finishDialog(request.id)
  }

  const cancel = () => settle(request.kind === 'alert' ? undefined : null)

  useLayoutEffect(() => {
    const frame = frameRef.current!
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const siblings = [...document.body.children].filter((element): element is HTMLElement =>
      element instanceof HTMLElement && element !== frame.parentElement,
    )
    const previousInert = siblings.map((element) => element.inert)
    siblings.forEach((element) => { element.inert = true })
    const focusable = () => [...frame.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
    const focusFirst = () => (frame.querySelector<HTMLElement>('[data-dialog-focus]:not(:disabled)') ?? focusable()[0] ?? frame).focus()
    const containFocus = (event: FocusEvent) => {
      if (!frame.contains(event.target as Node)) focusFirst()
    }
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable()
      const index = items.indexOf(document.activeElement as HTMLElement)
      event.preventDefault()
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length
      ;(items[next] ?? frame).focus()
    }
    document.addEventListener('focusin', containFocus)
    frame.addEventListener('keydown', trapTab)
    focusFirst()
    return () => {
      document.removeEventListener('focusin', containFocus)
      frame.removeEventListener('keydown', trapTab)
      siblings.forEach((element, index) => { element.inert = previousInert[index] })
      if (restoreFocus.current?.isConnected) restoreFocus.current.focus()
    }
  }, [])

  return (
    <div
      className="hs-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel()
      }}
    >
      <div
        ref={frameRef}
        tabIndex={-1}
        className={`hs-dialog${request.kind === 'choose' ? ' is-choose' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancel()
          }
        }}
      >
        <h2 id={titleId}>{request.title}</h2>
        {request.message ? <p className="hs-dialog-message">{request.message}</p> : <p className="hs-dialog-message" />}
        {request.kind === 'prompt' ? (
          <PromptBody request={request} onCancel={cancel} onSubmit={(value) => settle(value)} />
        ) : request.kind === 'choose' ? (
          <ChooseBody request={request} onCancel={cancel} onSubmit={(value) => settle(value)} />
        ) : (
          <div className="hs-dialog-actions">
            {request.kind === 'confirm' && (
              <button type="button" onClick={cancel}>
                {request.cancelLabel}
              </button>
            )}
            <button
              type="button"
              className={request.kind === 'confirm' && request.danger ? 'is-danger' : 'is-primary'}
              data-dialog-focus
              onClick={() => settle(request.kind === 'confirm' ? true : undefined)}
            >
              {request.confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function PromptBody({
  request,
  onCancel,
  onSubmit,
}: {
  request: PromptDialogRequest
  onCancel: () => void
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState(request.defaultValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = () => {
    const next = request.validate?.(value) ?? null
    if (next) {
      setError(next)
      return
    }
    onSubmit(value)
  }

  return (
    <>
      <input
        ref={inputRef}
        data-dialog-focus
        type="text"
        value={value}
        placeholder={request.placeholder}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          setValue(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
          }
        }}
      />
      {error ? <p className="hs-dialog-error">{error}</p> : null}
      <div className="hs-dialog-actions">
        <button type="button" onClick={onCancel}>
          {request.cancelLabel}
        </button>
        <button type="button" className="is-primary" onClick={submit}>
          {request.confirmLabel}
        </button>
      </div>
    </>
  )
}

function ChooseBody({
  request,
  onCancel,
  onSubmit,
}: {
  request: ChooseDialogRequest
  onCancel: () => void
  onSubmit: (value: string) => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const needle = query.trim().toLowerCase()
  const options = request.options.filter((option) => {
    if (!needle) return true
    return `${option.label} ${option.detail ?? ''}`.toLowerCase().includes(needle)
  })

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [active, options.length])

  const move = (delta: number) => {
    if (options.length === 0) return
    setActive((current) => {
      let next = current
      for (let step = 0; step < options.length; step += 1) {
        next = (next + delta + options.length) % options.length
        if (!options[next]?.disabled) return next
      }
      return current
    })
  }

  const pick = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onSubmit(option.id)
  }

  return (
    <>
      {request.filterable && (
        <input
          type="text"
          value={query}
          placeholder={request.placeholder}
          aria-label={request.placeholder}
          data-dialog-focus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              move(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              move(-1)
            } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              pick(options[active] && !options[active].disabled ? active : options.findIndex((option) => !option.disabled))
            }
          }}
        />
      )}
      {options.length === 0 ? (
        <p className="hs-dialog-empty">{'\u6ca1\u6709\u5339\u914d\u9879'}</p>
      ) : (
        <ul ref={listRef} className="hs-dialog-choices" role="listbox">
          {options.map((option, index) => (
            <li key={option.id} role="none">
              <button
                type="button"
                role="option"
                className={`hs-dialog-choice${index === active ? ' is-active' : ''}`}
                aria-selected={index === active}
                disabled={option.disabled}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
              >
                <span>{option.label}</span>
                {option.detail ? <small>{option.detail}</small> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="hs-dialog-actions">
        <button type="button" onClick={onCancel}>
          {request.cancelLabel}
        </button>
      </div>
    </>
  )
}
