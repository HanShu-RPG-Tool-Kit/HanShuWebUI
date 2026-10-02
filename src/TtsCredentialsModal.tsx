/**
 * 本地缓存 —— 服务定义里那些 `env:` / `app:` 引用在这里落成 API KEY 真值。
 *
 * **它不进工程。** 工程会给人、会上传、会备份，而 `.ttsservice` 会被导出工程包原样带走、
 * 会被 Agent 读、会进 git 历史 —— 密钥一旦写进文本就收不回来（规范 §1）。
 * 所以这个界面里的东西只活在这台机器上，换个人打开同一个工程，该填的是他自己的一份。
 *
 * 只处理 `app:` 引用。`env:` 指向环境变量，浏览器与 webview 都读不到进程环境变量，
 * 得由桌面壳从 Rust 侧递过来 —— 那一步没做之前，`env:` 在这里只会显示"读不到"。
 *
 * ## 三处刻意的做法
 *
 * - **名字先过关再入库**。名字要能拼进 `app:名字` 才算数（规范 §5.3 的字符集），
 *   存一个引用不到的键只是给缓存添垃圾。
 * - **覆盖与删除都要确认**。删掉一份 API KEY 就得回厂商控制台重签一份 ——
 *   这不是一个可以误点的动作。
 * - **"工程还需要"里的每一项可以一键填**：点一下就把名字带进表单、光标落到密钥那一格。
 *   协作者打开别人的工程时这是唯一必须重做的一步，别让他手抄一遍名字。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createLocalBackend,
  maskSecret,
  parseCredentialRef,
  type CredentialBackend,
} from './tts/credentials'
import { CREDENTIAL_NAME_RE } from './tts/spec'
import './TtsCredentialsModal.css'

export type TtsCredentialsModalProps = {
  onClose(): void
  /**
   * 工程里用到的引用（来自服务定义）。用来列出"这个工程需要、但本机还没有"的那几个 ——
   * 也就是协作者打开工程时唯一必须重做的一步（规范 §10.3）。
   */
  requiredRefs?: readonly string[]
}

/**
 * **由调用方只在需要时挂载**（`{open && <TtsCredentialsModal …/>}`），这里没有 `open` 参数。
 *
 * 这样列表的初值就是挂载那一刻的真实值，增删由用户自己的动作驱动 ——
 * 不需要"用 effect 把自己和存储同步一遍"。
 */
export function TtsCredentialsModal({
  onClose,
  requiredRefs = [],
}: TtsCredentialsModalProps) {
  const backend: CredentialBackend = useMemo(() => createLocalBackend(), [])
  const [names, setNames] = useState<string[]>(() => backend.names().sort())
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [newName, setNewName] = useState('')
  const [newValue, setNewValue] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => setNames(backend.names().sort()), [backend])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** 打开就把光标放到"下一个能填的地方"：还没有就填名称，有就填密钥 */
  useEffect(() => {
    if (backend.names().length === 0) nameRef.current?.focus()
    else valueRef.current?.focus()
  }, [backend])

  /** 工程要的引用里，本机还没有的那些。`env:` 单独说 —— 它不是"没填"，是读不到 */
  const missing = useMemo(() => {
    const have = new Set(names)
    const out: string[] = []
    for (const ref of requiredRefs) {
      const parsed = parseCredentialRef(ref)
      if (parsed && parsed.scheme === 'app' && !have.has(parsed.name) && !out.includes(parsed.name)) {
        out.push(parsed.name)
      }
    }
    return out
  }, [requiredRefs, names])

  const envRefs = useMemo(
    () => requiredRefs.filter((ref) => parseCredentialRef(ref)?.scheme === 'env').length,
    [requiredRefs],
  )

  const trimmedName = newName.trim()
  const nameInvalid = trimmedName !== '' && !CREDENTIAL_NAME_RE.test(trimmedName)
  const exists = names.includes(trimmedName)
  const canSave = trimmedName !== '' && !nameInvalid && newValue.trim() !== ''

  const add = () => {
    if (!canSave) return
    if (exists && !window.confirm(`「${trimmedName}」已存在，覆盖它？`)) return
    backend.set(trimmedName, newValue.trim())
    setNewName('')
    setNewValue('')
    refresh()
    nameRef.current?.focus()
  }

  const remove = (name: string) => {
    if (!window.confirm(`删除本机的「${name}」？工程里的引用不变，下次要用需重新填写。`)) {
      return
    }
    backend.remove(name)
    setRevealed((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    refresh()
  }

  /** 从"工程还需要"点过来：名称预填好，光标直接落到密钥那一格 */
  const fillFor = (name: string) => {
    setNewName(name)
    setNewValue('')
    valueRef.current?.focus()
  }

  return (
    <div className="tts-cred-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="tts-cred"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tts-cred-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="tts-cred-head">
          <h2 id="tts-cred-title">本地缓存</h2>
          <button
            type="button"
            className="tts-cred-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭（Esc）"
          >
            ×
          </button>
        </header>

        <div className="tts-cred-body">
          <p className="tts-cred-hint">密钥只存在本机，不写入工程文件。</p>

          {missing.length > 0 && (
            <div className="tts-cred-todo">
              <div className="tts-cred-todo-head">工程还需要 {missing.length} 个 API KEY</div>
              <ul>
                {missing.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                    <button type="button" className="tts-cred-btn" onClick={() => fillFor(name)}>
                      填写
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="tts-cred-form">
            <input
              ref={nameRef}
              type="text"
              value={newName}
              placeholder="名称"
              aria-invalid={nameInvalid}
              aria-label="名称"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') valueRef.current?.focus()
              }}
            />
            <input
              ref={valueRef}
              type="password"
              value={newValue}
              placeholder="API KEY"
              aria-label="API KEY"
              onChange={(event) => setNewValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') add()
              }}
            />
            <button
              type="button"
              className="tts-cred-btn is-primary"
              onClick={add}
              disabled={!canSave}
            >
              {exists ? '覆盖' : '保存'}
            </button>
          </div>
          {nameInvalid ? (
            <p className="tts-cred-hint is-danger">
              名称只能用字母、数字、<code>_</code>、<code>.</code>、<code>-</code>
            </p>
          ) : exists && newValue.trim() !== '' ? (
            <p className="tts-cred-hint is-warn">已有「{trimmedName}」，保存会覆盖原值</p>
          ) : null}

          <div className="tts-cred-stored">
            <div className="tts-cred-stored-head">已有 {names.length}</div>
            {names.length === 0 ? (
              <p className="tts-cred-empty">本机还没有 API KEY</p>
            ) : (
              <ul className="tts-cred-list">
                {names.map((name) => {
                  const value = backend.get(name) ?? ''
                  const shown = Boolean(revealed[name])
                  return (
                    <li key={name}>
                      <span className="tts-cred-name" title={name}>
                        {name}
                      </span>
                      <span className="tts-cred-value">{shown ? value : maskSecret(value)}</span>
                      <button
                        type="button"
                        className="tts-cred-btn"
                        onClick={() => setRevealed((prev) => ({ ...prev, [name]: !shown }))}
                      >
                        {shown ? '隐藏' : '显示'}
                      </button>
                      <button
                        type="button"
                        className="tts-cred-btn is-danger"
                        onClick={() => remove(name)}
                      >
                        删除
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {envRefs > 0 && (
            <p className="tts-cred-hint is-warn">
              另有 {envRefs} 处使用环境变量引用，当前窗口读不到
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
