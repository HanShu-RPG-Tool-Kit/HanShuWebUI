/**
 * 凭据库（本机）—— `auth` 里那些 `env:` / `app:` 引用在这里落成真值。
 *
 * **它不进工程。** 工程会给人、会上传、会备份,而 `.ttsservice` 会被导出工程包原样带走、
 * 会被 Agent 读、会进 git 历史 —— 密钥一旦写进文本就收不回来(规范 §1)。
 * 所以这个界面里的东西只活在这台机器上,换个人打开同一个工程,该填的是他自己的一份。
 *
 * 只处理 `app:` 引用。`env:` 指向环境变量,浏览器与 webview 都读不到进程环境变量,
 * 得由桌面壳从 Rust 侧递过来 —— 那一步没做之前,`env:` 在这里只会显示"取不到"。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createLocalBackend,
  maskSecret,
  parseCredentialRef,
  type CredentialBackend,
} from './tts/credentials'
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
 * 这样列表的初值就是挂载那一刻的真实值,增删由用户自己的动作驱动 ——
 * 不需要"用 effect 把自己和存储同步一遍"。那个写法既多一轮渲染,
 * 也正是 React 点名要避免的。
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

  const refresh = useCallback(() => setNames(backend.names().sort()), [backend])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** 工程要的引用里,本机没有的那些。`env:` 单独说 —— 它不是"没填",是取不到 */
  const missing = useMemo(() => {
    const have = new Set(names)
    return requiredRefs
      .map((ref) => ({ ref, parsed: parseCredentialRef(ref) }))
      .filter((item) => item.parsed && item.parsed.scheme === 'app' && !have.has(item.parsed.name))
      .map((item) => item.parsed!.name)
  }, [requiredRefs, names])

  const envRefs = useMemo(
    () =>
      requiredRefs.filter((ref) => parseCredentialRef(ref)?.scheme === 'env').length,
    [requiredRefs],
  )

  const add = () => {
    const name = newName.trim()
    const value = newValue.trim()
    if (!name || !value) return
    backend.set(name, value)
    setNewName('')
    setNewValue('')
    refresh()
  }

  return (
    <div className="tts-cred-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="tts-cred"
        role="dialog"
        aria-modal="true"
        aria-label="凭据库"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="tts-cred-head">
          <h2>凭据库（只在这台机器上）</h2>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="tts-cred-body">
          <p className="tts-cred-note">
            服务定义里只写引用（例如 <code>app:minimax-main</code>），真值放在这里。
            工程因此可以整个发出去，而密钥不会跟着走 —— 协作者打开它时，
            看到的是"这个工程需要一份凭据"，由他自己填一份。
          </p>

          {names.length === 0 ? (
            <p className="tts-cred-empty">本机还没有任何凭据。</p>
          ) : (
            <ul className="tts-cred-list">
              {names.map((name) => {
                const value = backend.get(name) ?? ''
                const shown = revealed[name]
                return (
                  <li key={name}>
                    <span className="tts-cred-name" title={name}>
                      {name}
                    </span>
                    <span className="tts-cred-value">
                      {shown ? value : maskSecret(value)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setRevealed((prev) => ({ ...prev, [name]: !shown }))}
                    >
                      {shown ? '隐藏' : '显示'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        backend.remove(name)
                        setRevealed((prev) => {
                          const next = { ...prev }
                          delete next[name]
                          return next
                        })
                        refresh()
                      }}
                    >
                      删除
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="tts-cred-add">
            <input
              value={newName}
              placeholder="名字（与引用里 app: 后面一致）"
              onChange={(event) => setNewName(event.target.value)}
            />
            <input
              value={newValue}
              placeholder="粘贴密钥"
              type="password"
              onChange={(event) => setNewValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') add()
              }}
            />
            <button type="button" onClick={add} disabled={!newName.trim() || !newValue.trim()}>
              保存
            </button>
          </div>

          {missing.length > 0 && (
            <ul className="tts-cred-missing">
              {missing.map((name) => (
                <li key={name}>
                  这个工程还需要 <code>{name}</code>
                </li>
              ))}
            </ul>
          )}

          {envRefs > 0 && (
            <ul className="tts-cred-missing">
              <li>
                另有 {envRefs} 处用的是 <code>env:</code> 引用 —— 那个指向环境变量，
                浏览器窗口读不到，得由桌面壳递进来。
              </li>
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
