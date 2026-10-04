/**
 * `.ttsservice` 的**图形化设置页** —— 打开这个文件时取代代码编辑器。
 *
 * 用户面对的是"选一家供应商、填一个 API KEY、端点要不要覆盖"，不是 JSON。文件仍然是
 * 真相：每一处改动都先在内存里拼出完整的服务定义，再由 `stringifyServiceDefinition`
 * 写回去 —— 所以**不认识的内容会原样保留**（规范 §9），表单只管它认识的键。
 *
 * ## 界面上的三条约定
 *
 * - **检查结论贴在出问题的那一行下面**（`RowNote`），页面顶部不攒问题清单。
 * - **没有副标题、没有汇总条、没有重复回显**。"现在实际用的是哪个端点"由输入框的
 *   占位符与「用默认」表示，不再单开一行复述一遍。
 * - **措辞简短、术语固定**：供应商 / 协议 / 端点 / 模型 / API KEY / 本地缓存。
 *
 * ## 两处刻意的做法
 *
 * - **"留空 = 跟随预设"**：端点、模型都不写也能工作，那时取预设的默认值。
 *   所以留空时占位符显示的就是那个默认值，覆盖时给一个「用默认」清回去。
 * - **凭据名允许为空，但不写半截引用**。`app:` 后面什么都没有不是合法引用
 *   （规范 §5.3 的 `^…:[A-Za-z0-9_.-]+$`），把它写进文件等于给校验器塞一条错误；
 *   空名字的语义是"未填写"，那就**删掉这个键**，让校验器说"缺少 API KEY，不能省"。
 */

import { useMemo, useState, type ReactNode } from 'react'
import {
  AUTH_SHAPES,
  CREDENTIAL_NAME_RE,
  PROTOCOLS,
  defaultCredentialRef,
  isValidBaseUrl,
  serviceIdOfFileName,
  type ProtocolId,
} from './spec'
import { resolvePresets } from './providers'
import { isProtocolImplemented } from './protocols'
import {
  readServiceDefinition,
  stringifyServiceDefinition,
  type AuthSpec,
  type ServiceDefinition,
} from './service'
import {
  createCredentialResolver,
  createLocalBackend,
  parseCredentialRef,
  type CredentialScheme,
} from './credentials'
import './form.css'

/** 不是预设、自己填协议的档（规范 §4.4） */
const TEMPLATE_ID = 'template'

/** 正在输入的凭据引用（输入期间用草稿，别把半截值写进文件） */
type AuthEdit = { key: string; scheme: CredentialScheme; name: string }

export type TtsServiceFormProps = {
  fileName: string
  text: string
  /** 写回文件（由外层落进编辑器正文并保存） */
  onChange(next: string): void
  onSwitchToRaw(): void
  onOpenCredentials(): void
}

/** 就地说明：贴在出问题的那一行下面，而不是攒到页面顶部 */
function RowNote({ tone, children }: { tone: 'danger' | 'warn' | 'ok'; children: ReactNode }) {
  return (
    <div className="tts-row is-note">
      <span className="tts-row-label" />
      <div className="tts-control">
        <span className={`tts-hint is-${tone}`}>{children}</span>
      </div>
    </div>
  )
}

export function TtsServiceForm({
  fileName,
  text,
  onChange,
  onSwitchToRaw,
  onOpenCredentials,
}: TtsServiceFormProps) {
  const presets = useMemo(() => resolvePresets().presets, [])
  const backend = useMemo(() => createLocalBackend(), [])
  const resolver = useMemo(
    () => createCredentialResolver({ backend }),
    [backend],
  )
  /**
   * 本机已有的缓存名。
   *
   * `app:` 那一栏是**从已有缓存里选**，不是自由输入：一份 key 只能先在缓存里存在，
   * 才谈得上被引用；新增走"编辑本地缓存"。
   *
   * 每次渲染现读，不做 memo —— 名单什么时候变由那个对话框决定，与其维护一张依赖表，
   * 不如跟 `resolver.has` 一样现问一次（关闭对话框会让这一层重渲染，名单随之刷新）。
   */
  const cachedNames = backend.names().sort((a, b) => a.localeCompare(b))
  const [authEdit, setAuthEdit] = useState<AuthEdit | null>(null)

  const id = serviceIdOfFileName(fileName) ?? fileName
  const read = useMemo(() => readServiceDefinition(text, id, presets), [text, id, presets])
  const definition = read.value

  /**
   * 内容根本不是 JSON（或者文件还是空的）。
   *
   * 这种情况**不当死路**：读不出任何设置，那就从零填 —— `read.value` 已经是一份
   * 空的服务定义(`toServiceDefinition(null)`)，表单照着它渲染即可。
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
  const isTemplate = definition.provider === TEMPLATE_ID

  /** 改一处 → 拼出完整定义 → 写回文件。未知键在 `extra` 里，跟着一起回去 */
  const patch = (partial: Partial<ServiceDefinition>) => {
    onChange(stringifyServiceDefinition({ ...definition, ...partial }))
  }

  const authFields = info ? AUTH_SHAPES[info.authShape] : []
  const expectedAuthKeys = new Set<string>(authFields.map((field) => field.key))
  const strayAuthKeys = Object.keys(definition.auth).filter((key) => !expectedAuthKeys.has(key))

  /** 能在页面上找到位置的路径 —— 其余只有两种去处：页面级错误、页脚计数 */
  const isPlaced = (path: string) =>
    path === 'label' ||
    path === 'provider' ||
    path === 'protocol' ||
    path === 'baseUrl' ||
    path === 'model' ||
    path.startsWith('auth.')

  const issuesAt = (path: string) => read.issues.filter((issue) => issue.path === path)
  const fileErrors = unreadable
    ? []
    : read.issues.filter((issue) => issue.level === 'error' && !isPlaced(issue.path))
  const foreignWarnings = unreadable
    ? 0
    : read.issues.filter((issue) => issue.level === 'warning' && !isPlaced(issue.path)).length

  const notesFor = (path: string) => {
    const list = issuesAt(path)
    if (list.length === 0) return null
    return (
      <RowNote tone={list.some((issue) => issue.level === 'error') ? 'danger' : 'warn'}>
        {list.map((issue) => issue.message).join('；')}
      </RowNote>
    )
  }

  /** 凭据引用：草稿优先，其次是文件里写的 */
  const authRefOf = (fieldKey: string): { scheme: CredentialScheme; name: string } => {
    if (authEdit?.key === fieldKey) {
      return { scheme: authEdit.scheme, name: authEdit.name }
    }
    const parsed = parseCredentialRef(definition.auth[fieldKey] ?? '')
    return { scheme: parsed?.scheme ?? 'app', name: parsed?.name ?? '' }
  }

  /**
   * 写回一条凭据引用。
   *
   * 名字为空 → **删掉这个键**（"未填写"的正确表示，见文件头注释）；
   * 名字非法 → 只留草稿、不写文件，让用户看得到自己在敲什么。
   */
  const writeAuthRef = (fieldKey: string, scheme: CredentialScheme, name: string) => {
    const auth: AuthSpec = { ...definition.auth }
    if (!name) delete auth[fieldKey]
    else if (CREDENTIAL_NAME_RE.test(name)) auth[fieldKey] = `${scheme}:${name}`
    else return
    patch({ auth })
  }

  const baseUrlInvalid =
    definition.baseUrl !== undefined &&
    definition.baseUrl.trim() !== '' &&
    !isValidBaseUrl(definition.baseUrl)

  return (
    <div className="tts-form">
      <header className="tts-page-head">
        <div className="tts-page-head-inner">
          <span className="tts-page-name">
            服务设置 · {definition.label?.trim() || id}
          </span>
          <span className="tts-page-actions">
            <button
              type="button"
              className="tts-btn"
              onClick={onOpenCredentials}
              title="查看与增删本机保存的 API KEY"
            >
              编辑本地缓存
            </button>
            <button type="button" className="tts-btn is-ghost" onClick={onSwitchToRaw}>
              以文本方式编辑
            </button>
          </span>
        </div>
      </header>

      <div className="tts-form-inner">
        {unreadable ? (
          <p className="tts-note is-warn">
            {text.trim()
              ? '文件不是合法 JSON，读不出设置 —— 下面从零填，保存会覆盖原内容。'
              : '文件是空的 —— 从下面开始填。'}
          </p>
        ) : (
          fileErrors.length > 0 && (
            <p className="tts-note is-danger">
              {fileErrors.map((issue) => `${issue.path} ${issue.message}`).join('；')}
            </p>
          )
        )}

        <section className="tts-card" aria-label="供应商">
          <div className="tts-card-head">
            <span className="tts-page-name">供应商</span>
          </div>
          <div className="tts-card-body">
            <div className="tts-row">
              <label className="tts-row-label" htmlFor="tts-svc-label">
                名称
              </label>
              <div className="tts-control">
                <input
                  id="tts-svc-label"
                  type="text"
                  value={definition.label ?? ''}
                  placeholder={id}
                  onChange={(event) => patch({ label: event.target.value || undefined })}
                />
              </div>
            </div>
            {notesFor('label')}

            <div className="tts-row">
              <label className="tts-row-label" htmlFor="tts-svc-provider">
                预设
              </label>
              <div className="tts-control">
                <select
                  id="tts-svc-provider"
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
                    // 换供应商 = 换鉴权形态：**只保留新形态要的那几个引用**，
                    // 其余是死键（Polly 的 secretKeyRef 在 apiKey 下没有任何意义）。
                    // 同一个键上已有的值不动 —— 那是用户填过的。
                    const shape = AUTH_SHAPES[PROTOCOLS[next.protocol].authShape]
                    const auth: AuthSpec = {}
                    for (const field of shape) {
                      const current = definition.auth[field.key]
                      auth[field.key] = current?.trim()
                        ? current
                        : defaultCredentialRef(id, field.key)
                    }
                    patch({ provider, protocol: undefined, auth })
                    setAuthEdit(null)
                  }}
                >
                  {/* 空 provider（手写的半成品文件）不能让下拉默认停在第一项上 ——
                      那会显示 OpenAI 而文件里什么都没有 */}
                  {!definition.provider && (
                    <option value="" disabled>
                      （未选）
                    </option>
                  )}
                  {definition.provider &&
                    !presets.some((item) => item.id === definition.provider) &&
                    !isTemplate && (
                      <optgroup label="当前值">
                        <option value={definition.provider}>{definition.provider}</option>
                      </optgroup>
                    )}
                  <optgroup label="内置">
                    {presets
                      .filter((item) => item.builtin)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                  </optgroup>
                  {presets.some((item) => !item.builtin) && (
                    <optgroup label="自定义预设">
                      {presets
                        .filter((item) => !item.builtin)
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                    </optgroup>
                  )}
                  <option value={TEMPLATE_ID}>template（自行指定协议）</option>
                </select>
              </div>
            </div>
            {notesFor('provider')}

            <div className="tts-row">
              <span className="tts-row-label">协议</span>
              <div className="tts-control">
                {isTemplate ? (
                  <select
                    value={definition.protocol ?? ''}
                    aria-label="协议"
                    onChange={(event) =>
                      patch({ protocol: event.target.value as ProtocolId })
                    }
                  >
                    {(Object.keys(PROTOCOLS) as ProtocolId[]).map((key) => (
                      <option key={key} value={key}>
                        {PROTOCOLS[key].label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="tts-static">
                    <code>{info?.label ?? '（未定）'}</code>
                  </span>
                )}
              </div>
            </div>
            {notesFor('protocol')}
            {/*
              协议还没实现的预设（Google / Polly 要 OAuth2 / SigV4 签名）：
              在这里就说清。配好一半、点合成才炸，是最难查的那种失败。
            */}
            {protocol && !isProtocolImplemented(protocol) && (
              <RowNote tone="danger">
                {PROTOCOLS[protocol].label} 的鉴权要签名，尚未实现 —— 先换一家
              </RowNote>
            )}
          </div>
        </section>

        <section className="tts-card" aria-label="连接">
          <div className="tts-card-head">
            <span className="tts-page-name">连接</span>
          </div>
          <div className="tts-card-body">
            <div className="tts-row">
              <label className="tts-row-label" htmlFor="tts-svc-baseurl">
                端点
              </label>
              <div className="tts-control">
                <input
                  id="tts-svc-baseurl"
                  className="is-wide"
                  type="text"
                  value={definition.baseUrl ?? ''}
                  placeholder={preset?.baseUrl ?? 'https://'}
                  aria-invalid={baseUrlInvalid}
                  onChange={(event) => patch({ baseUrl: event.target.value || undefined })}
                />
                {definition.baseUrl !== undefined && (
                  <button
                    type="button"
                    className="tts-btn is-ghost"
                    onClick={() => patch({ baseUrl: undefined })}
                    title={preset?.baseUrl ? `默认 ${preset.baseUrl}` : '这家没有默认端点'}
                  >
                    用默认
                  </button>
                )}
              </div>
            </div>
            {baseUrlInvalid ? (
              <RowNote tone="danger">
                必须是 <code>https://</code> 端点（localhost 可用 http://）
              </RowNote>
            ) : definition.baseUrl === undefined && preset && !preset.baseUrl ? (
              <RowNote tone="danger">该供应商没有默认端点</RowNote>
            ) : (
              notesFor('baseUrl')
            )}

            <div className="tts-row">
              <label className="tts-row-label" htmlFor="tts-svc-model">
                模型
              </label>
              <div className="tts-control">
                <input
                  id="tts-svc-model"
                  className="is-wide"
                  type="text"
                  value={definition.model ?? ''}
                  placeholder={preset?.model ?? '可留空'}
                  list={preset?.models ? 'tts-svc-models' : undefined}
                  onChange={(event) => patch({ model: event.target.value || undefined })}
                />
                {preset?.models && (
                  <datalist id="tts-svc-models">
                    {preset.models.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                )}
                {definition.model !== undefined && (
                  <button
                    type="button"
                    className="tts-btn is-ghost"
                    onClick={() => patch({ model: undefined })}
                    title={preset?.model ? `默认 ${preset.model}` : '这家没有默认模型'}
                  >
                    用默认
                  </button>
                )}
              </div>
            </div>
            {notesFor('model')}
          </div>
        </section>

        <section className="tts-card" aria-label="API KEY">
          <div className="tts-card-head">
            <span className="tts-page-name">API KEY</span>
          </div>
          <div className="tts-card-body">
            <p className="tts-hint">密钥只存在本机，不写入工程文件。</p>

            {authFields.length === 0 ? (
              <RowNote tone="warn">先选预设</RowNote>
            ) : (
              authFields.map((field) => {
                const { scheme, name } = authRefOf(field.key)
                const ref = definition.auth[field.key] ?? ''
                const ready = ref.trim() !== '' && resolver.has(ref)
                const nameInvalid = name !== '' && !CREDENTIAL_NAME_RE.test(name)
                /*
                 * **一个字段只出一条结论。**
                 *
                 * 这里刻意不去渲染校验器给 `auth.<键>` 的消息：键被清空时它会说
                 * "缺少 API KEY，不能省"，而那不是用户眼前这件事（他只是把名字删了）。
                 * 只有"文件里写着一个格式不对的引用"才用它的原话 —— 那是文件的问题。
                 */
                const refMalformed = ref.trim() !== '' && parseCredentialRef(ref) === null
                /** 文件里引用的名字本机没有（协作者的文件、或缓存被删过） */
                const notCached =
                  scheme === 'app' && name !== '' && !cachedNames.includes(name)
                return (
                  <div key={field.key}>
                    <div className="tts-row">
                      <label className="tts-row-label" htmlFor={`tts-svc-auth-${field.key}`}>
                        {field.label}
                      </label>
                      <div className="tts-control">
                        <select
                          value={scheme}
                          aria-label={`${field.label} 来源`}
                          onChange={(event) => {
                            const next = event.target.value as CredentialScheme
                            /*
                             * 换来源时**留着名字**：两个来源常常用同一个名字
                             * （`env:MINIMAX_API_KEY` 与缓存里的 `MINIMAX_API_KEY`）。
                             * 名字在目标来源里不存在时，那一栏会说清"本机没有"，不藏起来。
                             */
                            setAuthEdit({ key: field.key, scheme: next, name })
                            writeAuthRef(field.key, next, name)
                          }}
                        >
                          <option value="app">本地缓存</option>
                          <option value="env">环境变量</option>
                        </select>
                        {scheme === 'app' ? (
                          /*
                           * **只列已有的缓存**。以前这里是自由输入 —— 打一个缓存里没有的
                           * 名字等于写了一行永远不会通过的引用，而"加一份 key"本来就不是
                           * 这一栏的职责（那是"编辑本地缓存"）。
                           */
                          <select
                            id={`tts-svc-auth-${field.key}`}
                            value={name}
                            aria-label={`${field.label} 本地缓存`}
                            aria-invalid={refMalformed}
                            onChange={(event) => {
                              const next = event.target.value
                              setAuthEdit({ key: field.key, scheme, name: next })
                              writeAuthRef(field.key, scheme, next)
                            }}
                          >
                            <option value="">
                              {cachedNames.length === 0 ? '（本地缓存是空的）' : '选择 API KEY'}
                            </option>
                            {notCached && <option value={name}>{name}（本机没有）</option>}
                            {cachedNames.map((entry) => (
                              <option key={entry} value={entry}>
                                {entry}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id={`tts-svc-auth-${field.key}`}
                            type="text"
                            value={name}
                            placeholder="MINIMAX_API_KEY"
                            aria-invalid={nameInvalid || refMalformed}
                            onChange={(event) => {
                              const next = event.target.value
                              setAuthEdit({ key: field.key, scheme, name: next })
                              writeAuthRef(field.key, scheme, next)
                            }}
                            onBlur={() =>
                              setAuthEdit((current) =>
                                current?.key === field.key ? null : current,
                              )
                            }
                          />
                        )}
                        {/*
                          入口只在**缓存**这一侧：选环境变量时这个名字不在本地缓存里，
                          摆一个"编辑本地缓存"只会让人以为还得去那儿补一份。
                        */}
                        {scheme === 'app' && (
                          <button
                            type="button"
                            className="tts-btn is-ghost"
                            onClick={onOpenCredentials}
                            title="打开本地缓存，增删或修改这里引用的 API KEY"
                          >
                            编辑本地缓存
                          </button>
                        )}
                      </div>
                    </div>
                    {nameInvalid ? (
                      <RowNote tone="danger">
                        名字只能用字母、数字、<code>_</code>、<code>.</code>、<code>-</code>
                      </RowNote>
                    ) : refMalformed ? (
                      <RowNote tone="danger">
                        引用必须是 <code>env:名字</code> 或 <code>app:名字</code>
                      </RowNote>
                    ) : ref.trim() === '' ? (
                      <RowNote tone="danger">
                        {scheme === 'app' ? '未选择' : '未填写'}
                      </RowNote>
                    ) : scheme === 'env' ? (
                      <RowNote tone="warn">环境变量：当前窗口读不到</RowNote>
                    ) : ready ? (
                      <RowNote tone="ok">已配置</RowNote>
                    ) : (
                      /* 动作就是旁边那个按钮，这里不再挂一个同义的链接 */
                      <RowNote tone="warn">
                        {notCached ? (
                          <>
                            本机没有 <code>{name}</code>
                          </>
                        ) : (
                          '未配置'
                        )}
                      </RowNote>
                    )}
                  </div>
                )
              })
            )}

            {strayAuthKeys.length > 0 && (
              <RowNote tone="warn">
                当前协议用不到 <code>{strayAuthKeys.join('、')}</code>
                <button
                  type="button"
                  className="tts-form-link"
                  onClick={() => {
                    const auth: AuthSpec = {}
                    for (const key of expectedAuthKeys) {
                      const current = definition.auth[key]
                      if (current !== undefined) auth[key] = current
                    }
                    patch({ auth })
                  }}
                >
                  清除
                </button>
              </RowNote>
            )}
          </div>
        </section>

        <p className="tts-hint">
          未在此页管理的字段会原样保留
          {foreignWarnings > 0 ? `（另有 ${foreignWarnings} 处）` : ''}。
        </p>
      </div>
    </div>
  )
}
