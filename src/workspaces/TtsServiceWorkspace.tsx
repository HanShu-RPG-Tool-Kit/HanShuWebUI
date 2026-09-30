/**
 * TTS 服务编辑器 —— **工作区形态,等效直接编辑文件**。
 *
 * 它不持有第二份配置:左列是工程里 `meta/voice/service/*.ttsservice` 的文件清单,
 * 右边就是那个文件的正文。改动经 `ScriptWorkspace` 的包内文件通道写回工程,
 * 与手工在资源树里编辑同一个文件**完全等价** —— 包括"要保存工程才落盘"这件事。
 *
 * 顶部那个供应商下拉不是另一套状态,它只是**改文件里的 `provider` 字段**并重新序列化,
 * 所以用它改和手打一行 `"provider": "minimax"` 的结果一模一样。
 *
 * 校验用 `readServiceDefinition`(规范 §7.3),凭据状态用本机凭据库 —— 都不落盘。
 */

import { useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import { HANSHU_THEME_ID, registerHanshuLanguage } from '../monaco/hanshuLanguage'
import {
  AUTH_SHAPES,
  PROTOCOLS,
  serviceFileName,
  serviceIdOfFileName,
  type Issue,
} from '../tts/spec'
import { BUILTIN_PRESETS, resolvePresets } from '../tts/providers'
import {
  readServiceDefinition,
  stringifyServiceDefinition,
  type ServiceDefinition,
} from '../tts/service'
import { createCredentialResolver, createLocalBackend } from '../tts/credentials'
import { TtsCredentialsModal } from '../TtsCredentialsModal'
import type { ScriptWorkspaceHandle } from './scriptTypes'
import { usePackageFiles } from './usePackageFiles'
import { usePackageSnapshot } from './packageBus'
import './TtsServiceWorkspace.css'

/** 不是预设、自己填协议的档（见规范 §4.4） */
const TEMPLATE_ID = 'template'

const SERVICE_DIR = 'meta/voice/service'

/** 凭据字段名 → 新建时的后缀，让新文件的引用名一眼能认出来 */
const AUTH_SUFFIX: Record<string, string> = {
  apiKeyRef: '',
  accessKeyRef: '-access',
  secretKeyRef: '-secret',
  serviceAccountRef: '-sa',
}

function templateFor(provider: string, id: string): ServiceDefinition {
  if (provider === TEMPLATE_ID) {
    return {
      version: 1,
      label: id,
      provider: TEMPLATE_ID,
      protocol: 'openai-compatible',
      auth: { apiKeyRef: `app:${id}` },
      baseUrl: '',
      extra: {},
    }
  }

  const preset = BUILTIN_PRESETS.find((item) => item.id === provider) ?? BUILTIN_PRESETS[0]
  const fields = AUTH_SHAPES[PROTOCOLS[preset.protocol].authShape]
  const auth: Record<string, string> = {}
  for (const field of fields) {
    auth[field.key] = `app:${id}${AUTH_SUFFIX[field.key] ?? ''}`
  }

  // 预设没有默认端点时（Azure / Polly 按区域部署）留空：让它报"必须填"，
  // 比塞一个猜的地址然后请求失败强
  return { version: 1, label: preset.label, provider: preset.id, auth, extra: {} }
}

export function TtsServiceWorkspace({
  active,
  scriptRef,
}: {
  active: boolean
  scriptRef: { current: ScriptWorkspaceHandle | null }
}) {
  const presets = useMemo(() => resolvePresets().presets, [])
  const resolver = useMemo(
    () => createCredentialResolver({ backend: createLocalBackend() }),
    [],
  )
  const store = usePackageFiles({ active, scriptRef, extension: '.ttsservice' })
  const [showCredentials, setShowCredentials] = useState(false)

  const parsed = useMemo(() => {
    if (!store.selected) return null
    const id = serviceIdOfFileName(store.selected) ?? store.selected
    return { id, read: readServiceDefinition(store.text, id, presets) }
  }, [store.selected, store.text, presets])

  const issues: Issue[] = parsed?.read.issues ?? []

  // 整个工程用到的凭据引用 —— 凭据库据此列出"还缺哪几个"
  const snapshot = usePackageSnapshot()
  const requiredRefs = useMemo(() => {
    const refs: string[] = []
    for (const file of snapshot) {
      if (!file.name.toLowerCase().endsWith('.ttsservice')) continue
      const id = file.name.slice(0, file.name.length - '.ttsservice'.length).trim()
      const read = readServiceDefinition(file.content, id, presets)
      if (!read.ok) continue
      refs.push(...Object.values(read.value.auth))
    }
    return refs
  }, [snapshot, presets])

  const createService = (name: string, provider: string) => {
    if (!name) return
    const fileName = serviceFileName(name)
    if (!serviceIdOfFileName(fileName)) {
      window.alert('名字不能为空，也不能含 \\ / : * ? " < > |')
      return
    }
    store.create(fileName, stringifyServiceDefinition(templateFor(provider, name)))
  }

  /** 换供应商：就是改文件里的 `provider` 字段再写回去 */
  const changeProvider = (provider: string) => {
    if (!parsed?.read.ok) return
    const definition: ServiceDefinition = { ...parsed.read.value, provider }
    // 预设档的协议是派生值，换预设就该跟着换；留着上一次的会自相矛盾
    if (provider !== TEMPLATE_ID) {
      delete definition.protocol
    } else if (!definition.protocol) {
      definition.protocol = 'openai-compatible'
    }
    store.update(stringifyServiceDefinition(definition))
  }

  return (
    <div className="tts-service">
      <aside className="tts-service-list">
        <NewServiceForm presets={presets} onSubmit={createService} />

        {store.reject && <p className="tts-service-empty">{store.reject}</p>}

        {store.files.length === 0 ? (
          <p className="tts-service-empty">
            工程里还没有服务定义。
            <br />
            上面填个名字、选一家供应商，就会在 <code>{SERVICE_DIR}/</code> 下建一个文件。
          </p>
        ) : (
          <ul className="tts-service-files">
            {store.files.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  aria-current={name === store.selected}
                  onClick={() => store.select(name)}
                  title={name}
                >
                  {serviceIdOfFileName(name) ?? name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="tts-service-detail">
        {!store.selected || !parsed ? (
          <p className="tts-service-empty">左边选一个服务，或新建一个。</p>
        ) : (
          <>
            <div className="tts-service-head">
              <span className="tts-service-path" title={`${SERVICE_DIR}/${store.selected}`}>
                {SERVICE_DIR}/{store.selected}
              </span>
              <select
                value={parsed.read.value.provider || ''}
                onChange={(event) => changeProvider(event.target.value)}
                disabled={!parsed.read.ok}
                title={parsed.read.ok ? '改 `provider` 字段' : '文件有错，先改对了再说'}
              >
                {!presets.some((preset) => preset.id === parsed.read.value.provider) && (
                  <option value={parsed.read.value.provider}>
                    {parsed.read.value.provider || '（未填）'}
                  </option>
                )}
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
                <option value={TEMPLATE_ID}>template（自己选协议）</option>
              </select>
              <button
                type="button"
                className="tts-service-btn"
                onClick={() => setShowCredentials(true)}
              >
                凭据库
              </button>
              <span className="tts-service-saved">
                {store.savedAt ? '已写入工程（保存工程后落盘）' : '未改动'}
              </span>
            </div>

            <div className="tts-service-editor">
              <Editor
                height="100%"
                language="json"
                theme={HANSHU_THEME_ID}
                value={store.text}
                beforeMount={registerHanshuLanguage}
                onChange={(next) => store.update(next ?? '')}
                options={{
                  minimap: { enabled: false },
                  tabSize: 2,
                  scrollBeyondLastLine: false,
                }}
              />
            </div>

            <div className="tts-service-panel">
              {issues.length === 0 ? (
                <p className="tts-service-ok">这项服务定义没有问题。</p>
              ) : (
                <ul className="tts-service-issues">
                  {issues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`} className={`level-${issue.level}`}>
                      <code>{issue.path}</code> {issue.message}
                    </li>
                  ))}
                </ul>
              )}

              {parsed.read.ok && (
                <ul className="tts-service-auth">
                  {Object.entries(parsed.read.value.auth).map(([key, ref]) => {
                    const ready = resolver.has(ref)
                    return (
                      <li key={key} className={ready ? undefined : 'missing'}>
                        凭据 <code>{ref}</code>{' '}
                        {ready ? (
                          '已配置'
                        ) : (
                          <button
                            type="button"
                            className="tts-service-link"
                            onClick={() => setShowCredentials(true)}
                          >
                            本机没有 —— 去填一份
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {!parsed.read.ok && (
                <p className="tts-service-ok">
                  读不懂的时候，只有「由程序重写文件」这件事会被拦住（供应商下拉因此不生效）。
                  你在编辑器里手改的正文照样保存 —— 那是在编辑文件，不是在让程序猜。
                </p>
              )}
            </div>
          </>
        )}
      </section>

      {showCredentials && (
        <TtsCredentialsModal
          onClose={() => setShowCredentials(false)}
          requiredRefs={requiredRefs}
        />
      )}
    </div>
  )
}

/** 新建服务的一行表单（名字 + 供应商） */
function NewServiceForm({
  presets,
  onSubmit,
}: {
  presets: readonly { id: string; label: string }[]
  onSubmit: (name: string, provider: string) => void
}) {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState(presets[0]?.id ?? TEMPLATE_ID)

  return (
    <div className="tts-service-create">
      <input
        value={name}
        placeholder="服务名（即文件名）"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onSubmit(name.trim(), provider)
            setName('')
          }
        }}
      />
      <select value={provider} onChange={(event) => setProvider(event.target.value)}>
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
        <option value={TEMPLATE_ID}>template（自己选协议）</option>
      </select>
      <button
        type="button"
        onClick={() => {
          onSubmit(name.trim(), provider)
          setName('')
        }}
        disabled={!name.trim()}
      >
        新建服务
      </button>
    </div>
  )
}
