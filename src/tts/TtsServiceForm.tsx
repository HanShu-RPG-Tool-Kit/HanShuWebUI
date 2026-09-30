/**
 * `.ttsservice` 的**图形化设置页** —— 打开这个文件时取代代码编辑器。
 *
 * 用户面对的是"选一家供应商、贴一个 Key、要不要开克隆",不是 JSON。文件仍然是真相:
 * 每一处改动都先在内存里拼出完整的服务定义,再由 `stringifyServiceDefinition` 写回去
 * —— 所以**不认识的内容会原样保留**(规范 §9):表单只管它认识的那些键。
 *
 * "留空 = 跟随预设"是刻意的:端点、模型、能力三项都不写也能工作,
 * 那时取预设的默认值。所以每一项都显示"现在实际用的是哪个",以及一个「用默认」把它清回去。
 */

import { useMemo } from 'react'
import {
  AUTH_SHAPES,
  PROTOCOLS,
  defaultCredentialRef,
  serviceIdOfFileName,
  type Issue,
  type ProtocolId,
} from './spec'
import { resolvePresets } from './providers'
import {
  readServiceDefinition,
  resolveService,
  stringifyServiceDefinition,
  type ServiceDefinition,
} from './service'
import {
  createCredentialResolver,
  createLocalBackend,
  parseCredentialRef,
} from './credentials'
import './form.css'

/** 不是预设、自己填协议的档（规范 §4.4） */
const TEMPLATE_ID = 'template'

export type TtsServiceFormProps = {
  fileName: string
  text: string
  /** 写回文件（由外层落进编辑器正文并保存） */
  onChange(next: string): void
  onSwitchToRaw(): void
  onOpenCredentials(): void
}

export function TtsServiceForm({
  fileName,
  text,
  onChange,
  onSwitchToRaw,
  onOpenCredentials,
}: TtsServiceFormProps) {
  const presets = useMemo(() => resolvePresets().presets, [])
  const resolver = useMemo(
    () => createCredentialResolver({ backend: createLocalBackend() }),
    [],
  )

  const id = serviceIdOfFileName(fileName) ?? fileName
  const read = useMemo(() => readServiceDefinition(text, id, presets), [text, id, presets])
  const definition = read.value

  /**
   * 内容根本不是 JSON（或者文件还是空的）。
   *
   * 这种情况**不当死路**：读不出任何设置，那就从零填 —— `read.value` 已经是一份
   * 空的服务定义(`toServiceDefinition(null)`)，表单照着它渲染即可。
   * 把人赶去手写 JSON，等于惩罚他打开了一个坏文件。
   */
  const unreadable = useMemo(() => {
    if (!text.trim()) return true
    try {
      JSON.parse(text)
      return false
    } catch {
      return true
    }
  }, [text])

  const preset = presets.find((item) => item.id === definition.provider) ?? null
  const protocol: ProtocolId | undefined = definition.protocol ?? preset?.protocol
  const info = protocol ? PROTOCOLS[protocol] : null
  const resolved = useMemo(() => resolveService(definition, id, presets), [definition, id, presets])

  /** 改一处 → 拼出完整定义 → 写回文件。未知键在 `extra` 里，跟着一起回去 */
  const patch = (partial: Partial<ServiceDefinition>) => {
    onChange(stringifyServiceDefinition({ ...definition, ...partial }))
  }

  const authFields = info ? AUTH_SHAPES[info.authShape] : []

  return (
    <div className="tts-form">
      <div className="tts-form-head">
        <span className="tts-form-title">服务设置</span>
        <span className="tts-form-subtitle">{fileName}</span>
        <span className="tts-form-head-actions">
          <button type="button" className="tts-form-btn" onClick={onOpenCredentials}>
            凭据库
          </button>
          <button type="button" className="tts-form-link" onClick={onSwitchToRaw}>
            以文本方式编辑
          </button>
        </span>
      </div>

      {unreadable ? (
        <p className="tts-form-notice">
          {text.trim()
            ? '这个文件的内容不是合法 JSON，读不出任何设置 —— 下面是空的，从零填就行。保存会覆盖原来的内容。'
            : '这个文件还是空的 —— 从下面开始填，保存后它就是内容。'}
        </p>
      ) : (
        read.issues.length > 0 && (
          <ul className="tts-form-issues">
            {read.issues.map((issue: Issue, index) => (
              <li key={`${issue.path}-${index}`} className={`level-${issue.level}`}>
                <code>{issue.path}</code> {issue.message}
              </li>
            ))}
          </ul>
        )
      )}

      <div className="tts-form-section">
        <p className="tts-form-section-title">这是什么</p>

        <div className="tts-form-row">
          <span className="tts-form-label">显示名</span>
          <span className="tts-form-control">
            <input
              type="text"
              value={definition.label ?? ''}
              placeholder={id}
              onChange={(event) => patch({ label: event.target.value || undefined })}
            />
          </span>
        </div>

        <div className="tts-form-row">
          <span className="tts-form-label">供应商</span>
          <span className="tts-form-control">
            <select
              value={definition.provider}
              onChange={(event) => {
                const provider = event.target.value
                if (provider === TEMPLATE_ID) {
                  // 预设档的协议是派生值；`template` 要自己选，先给一个
                  patch({ provider, protocol: definition.protocol ?? 'openai-compatible' })
                  return
                }
                const next = presets.find((item) => item.id === provider)
                if (!next) {
                  patch({ provider })
                  return
                }
                // 顺手补上缺的凭据引用名。已有的值不动 —— 换供应商不该把你填好的引用冲掉
                const auth = { ...definition.auth }
                for (const field of AUTH_SHAPES[PROTOCOLS[next.protocol].authShape]) {
                  if (!auth[field.key]) auth[field.key] = defaultCredentialRef(id, field.key)
                }
                patch({ provider, protocol: undefined, auth })
              }}
            >
              {!presets.some((item) => item.id === definition.provider) && (
                <option value={definition.provider}>
                  {definition.provider || '（未填）'}
                </option>
              )}
              {presets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
              <option value={TEMPLATE_ID}>template（自己选协议）</option>
            </select>
          </span>
        </div>

        <div className="tts-form-row">
          <span className="tts-form-label">协议</span>
          <span className="tts-form-control">
            {definition.provider === TEMPLATE_ID ? (
              <select
                value={definition.protocol ?? ''}
                onChange={(event) => patch({ protocol: event.target.value as ProtocolId })}
              >
                {(Object.keys(PROTOCOLS) as ProtocolId[]).map((key) => (
                  <option key={key} value={key}>
                    {PROTOCOLS[key].label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="tts-form-static">
                <code>{info?.label ?? '（未知）'}</code>
                <span className="tts-form-hint"> —— 由预设决定，不用选</span>
              </span>
            )}
          </span>
        </div>

        {info && (
          <div className="tts-form-row">
            <span className="tts-form-label">怎么发</span>
            <span className="tts-form-static tts-form-hint">{info.endpoint}</span>
          </div>
        )}
      </div>

      <div className="tts-form-section">
        <p className="tts-form-section-title">端点与模型</p>

        <div className="tts-form-row">
          <span className="tts-form-label">端点</span>
          <span className="tts-form-control">
            <input
              type="text"
              value={definition.baseUrl ?? ''}
              placeholder={
                preset?.baseUrl || (preset ? '（这家没有默认端点，必填）' : '（协议根地址）')
              }
              onChange={(event) => patch({ baseUrl: event.target.value || undefined })}
            />
            {definition.baseUrl !== undefined && (
              <button
                type="button"
                className="tts-form-link"
                onClick={() => patch({ baseUrl: undefined })}
              >
                用默认
              </button>
            )}
          </span>
        </div>

        <div className="tts-form-row">
          <span className="tts-form-label">模型</span>
          <span className="tts-form-control">
            <input
              type="text"
              value={definition.model ?? ''}
              placeholder={preset?.model ?? '（这家没有默认模型）'}
              onChange={(event) => patch({ model: event.target.value || undefined })}
            />
            {definition.model !== undefined && (
              <button
                type="button"
                className="tts-form-link"
                onClick={() => patch({ model: undefined })}
              >
                用默认
              </button>
            )}
          </span>
        </div>

        <div className="tts-form-row">
          <span className="tts-form-label">实际用的</span>
          <span className="tts-form-static tts-form-hint">
            端点 <code>{resolved.baseUrl || '（还没有）'}</code> · 模型{' '}
            <code>{resolved.model ?? '（还没有）'}</code>
          </span>
        </div>
      </div>

      <div className="tts-form-section">
        <p className="tts-form-section-title">凭据</p>
        <p className="tts-form-hint">
          这里只写「引用」，真值放在本机凭据库 —— 所以工程可以整个发出去，密钥不会跟着走。
        </p>

        {authFields.map((field) => {
          const ref = definition.auth[field.key] ?? ''
          const parsed = parseCredentialRef(ref)
          const scheme = parsed?.scheme ?? 'app'
          const name = parsed?.name ?? ''
          const ready = ref ? resolver.has(ref) : false
          return (
            <div className="tts-form-row" key={field.key}>
              <span className="tts-form-label">{field.label}</span>
              <span className="tts-form-control">
                <select
                  value={scheme}
                  onChange={(event) => patch({ auth: { ...definition.auth, [field.key]: `${event.target.value}:${name}` } })}
                >
                  <option value="app">本机凭据库</option>
                  <option value="env">环境变量</option>
                </select>
                <input
                  type="text"
                  value={name}
                  placeholder={scheme === 'env' ? 'OPENAI_API_KEY' : `${id}`}
                  onChange={(event) =>
                    patch({
                      auth: { ...definition.auth, [field.key]: `${scheme}:${event.target.value}` },
                    })
                  }
                />
                <span className={ready ? 'tts-form-hint' : 'tts-form-hint'}>
                  {!ref ? (
                    '还没填'
                  ) : scheme === 'env' ? (
                    '环境变量（由桌面壳读进来）'
                  ) : ready ? (
                    '已配置'
                  ) : (
                    <button type="button" className="tts-form-link" onClick={onOpenCredentials}>
                      本机没有 —— 去填一份
                    </button>
                  )}
                </span>
              </span>
            </div>
          )
        })}
      </div>

      <div className="tts-form-section">
        <p className="tts-form-section-title">这份文件的其它内容</p>
        <p className="tts-form-ok">
          表单只管它认识的键。文件里如果还有别的键，会「原样保留」，不会被这个页面抹掉。
        </p>
      </div>
    </div>
  )
}
