/**
 * 角色配音方案编辑器 —— 工作区形态,等效直接编辑 `meta/voice/<角色>.tts`。
 *
 * 与服务编辑器同一套骨架(见 `usePackageFiles`),差别只在**校验要多一级**:
 * `.tts` 的结构问题自己就能判,但"这个服务文件在不在""这个服务有没有开克隆能力"
 * 要读工程里的其它文件。所以这里顺手把 `meta/voice/service/*.ttsservice` 读一遍,
 * 解析成生效值再交给 `validateVoicePlanSemantics`。
 *
 * 底下的"可选语言"一览不是预览图,它就是录音棚第②级的可选列表 —— 没配的语言
 * 不出现在这里,也不出现在那里(规范 §7.4)。
 */

import { useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import { HANSHU_THEME_ID, registerHanshuLanguage } from '../monaco/hanshuLanguage'
import { characterNameOfFileName, planFileName, type Issue } from '../tts/spec'
import { resolvePresets } from '../tts/providers'
import {
  readVoicePlan,
  validateVoicePlanSemantics,
  type VoicePlanEntry,
} from '../tts/plan'
import {
  readServiceDefinition,
  resolveService,
  type ResolvedService,
} from '../tts/service'
import { auditCredentials, createCredentialResolver, createLocalBackend } from '../tts/credentials'
import { ensureClonedVoice, type CloneSample } from '../tts/clone'
import { createCloneRegistry, useCloneRegistryEntries } from '../tts/cloneRegistry'
import { createFetchTransport } from '../tts/transport'
import { usePackageSnapshot } from './packageBus'
import type { ScriptWorkspaceHandle } from './scriptTypes'
import { usePackageFiles } from './usePackageFiles'
import './TtsServiceWorkspace.css'

const PLAN_DIR = 'meta/voice'

/** 样本的 content-type —— 上传时要声明，服务端据此判断格式 */
const SAMPLE_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
}

function sampleMime(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path.trim())?.[1]?.toLowerCase() ?? ''
  return SAMPLE_MIME[ext] ?? 'application/octet-stream'
}

type CloneState =
  | { locale: string; kind: 'busy'; message: string }
  | { locale: string; kind: 'done'; ok: boolean; message: string }

const NEW_PLAN_TEMPLATE = `{
  "version": 1,
  "voices": {
    "zh_cn": { "service": "改成一个服务 id", "voice": "音色 id" }
  }
}
`

export function TtsPlanWorkspace({
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
  const store = usePackageFiles({ active, scriptRef, extension: '.tts' })

  // 工程里的服务定义 → 生效值。语义校验全靠它。
  //
  // 从**快照**推导,不读 ref、也不在 effect 里 setState:包是外部系统,
  // 所以正文与这里的一切都跟着快照走(见 `packageBus`)。
  const snapshot = usePackageSnapshot()

  const services = useMemo(() => {
    const map = new Map<string, ResolvedService>()
    for (const file of snapshot) {
      if (!file.name.toLowerCase().endsWith('.ttsservice')) continue
      const id = file.name.slice(0, file.name.length - '.ttsservice'.length).trim()
      if (!id) continue
      const read = readServiceDefinition(file.content, id, presets)
      if (!read.ok) continue
      map.set(id, resolveService(read.value, id, presets))
    }
    return map
  }, [snapshot, presets])

  const parsed = useMemo(() => {
    if (!store.selected) return null
    return readVoicePlan(store.text, store.selected)
  }, [store.selected, store.text])

  const semantics: Issue[] = useMemo(() => {
    if (!parsed?.ok) return []
    return validateVoicePlanSemantics(parsed.value, { services })
  }, [parsed, services])

  const issues: Issue[] = [...(parsed?.issues ?? []), ...semantics]

  // 开工前的凭据体检：这个工程用到的引用里，本机缺哪几个（规范 §10.3）
  const audit = useMemo(() => {
    const refs = [...services.values()].flatMap((service) =>
      service.auth.map((field) => field.value),
    )
    return auditCredentials(refs, resolver)
  }, [services, resolver])

  const locales: [string, VoicePlanEntry][] = parsed?.ok
    ? Object.entries(parsed.value.voices).sort(([a], [b]) => a.localeCompare(b))
    : []

  // ===== 克隆登记 =====
  //
  // 克隆是**一次性登记**（规范 §5.6）：上传样本换一个 `voice_id`，之后合成走普通端点。
  // `.tts` 里存的是样本而不是 id，所以换账号/换机器之后重新克隆即可，工程文件一个字都不用改。
  //
  // 它要花钱、还会在厂商账号下建东西，所以**不自动做**：点了才做，且先问一句。

  const registry = useMemo(() => createCloneRegistry(), [])
  const transport = useMemo(() => createFetchTransport(), [])
  const [cloneState, setCloneState] = useState<CloneState | null>(null)

  // 登记表可订阅，所以登记成功之后这个列表自己就变了 —— 不需要拿 `cloneState` 当失效信号
  const entries = useCloneRegistryEntries()
  const registered = entries.filter((entry) => services.has(entry.serviceId))

  const cloneFor = async (
    locale: string,
    entry: VoicePlanEntry,
    service: ResolvedService,
  ) => {
    if (!entry.clone) return
    const samples = entry.clone.samples
    const confirmed = window.confirm(
      `克隆会把 ${samples.length} 个样本上传到 ${service.label}，并在你的账号下建一个音色。\n` +
        `这通常会计费，而且只有你已经拿到这个人的声音授权才该做。\n\n继续？`,
    )
    if (!confirmed) return

    setCloneState({ locale, kind: 'busy', message: '正在读取样本…' })

    const payload: CloneSample[] = []
    for (const path of samples) {
      const bytes = await scriptRef.current?.readAssetBytes(path)
      if (!bytes) {
        setCloneState({
          locale,
          kind: 'done',
          ok: false,
          message: `样本「${path}」读不到 —— 确认它还在 assets 里`,
        })
        return
      }
      payload.push({ path, bytes, contentType: sampleMime(path) })
    }

    const result = await ensureClonedVoice(
      {
        service,
        credential: resolver.resolve,
        // ElevenLabs 侧显示用；MiniMax 的 voice_id 由样本指纹派生，不看这个名字
        name: `${characterNameOfFileName(store.selected ?? '') ?? service.label}-${locale}`,
        samples: payload,
        registry,
      },
      {
        transport,
        onStep: (label) => setCloneState({ locale, kind: 'busy', message: label }),
      },
    )

    setCloneState(
      result.ok
        ? {
            locale,
            kind: 'done',
            ok: true,
            message: result.cloned
              ? `已登记为 ${result.voiceId}`
              : `这批样本早就登记过：${result.voiceId}`,
          }
        : {
            locale,
            kind: 'done',
            ok: false,
            message: result.failure.hint
              ? `${result.failure.message} —— ${result.failure.hint}`
              : result.failure.message,
          },
    )
  }

  return (
    <div className="tts-service">
      <aside className="tts-service-list">
        <NewPlanForm
          onSubmit={(character) => {
            const fileName = planFileName(character)
            if (!characterNameOfFileName(fileName)) {
              window.alert('角色名不能为空，也不能含 \\ / : * ? " < > |')
              return
            }
            store.create(fileName, NEW_PLAN_TEMPLATE)
          }}
        />

        {store.reject && <p className="tts-service-empty">{store.reject}</p>}

        {store.files.length === 0 ? (
          <p className="tts-service-empty">
            工程里还没有配音方案。
            <br />
            上面填个角色名（要和剧本里的说话人一致），就会建出{' '}
            <code>{PLAN_DIR}/&lt;角色&gt;.tts</code>。
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
                  {characterNameOfFileName(name) ?? name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="tts-service-detail">
        {!store.selected || !parsed ? (
          <p className="tts-service-empty">左边选一个角色，或新建一个。</p>
        ) : (
          <>
            <div className="tts-service-head">
              <span className="tts-service-path" title={`${PLAN_DIR}/${store.selected}`}>
                {PLAN_DIR}/{store.selected}
              </span>
              <span className="tts-service-saved">
                {locales.length > 0 ? `${locales.length} 个语言可生成` : '还没有可选语言'}
              </span>
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
                <p className="tts-service-ok">这份配音方案没有问题。</p>
              ) : (
                <ul className="tts-service-issues">
                  {issues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`} className={`level-${issue.level}`}>
                      <code>{issue.path}</code> {issue.message}
                    </li>
                  ))}
                </ul>
              )}

              {locales.length > 0 && (
                <ul className="tts-service-auth">
                  {locales.map(([locale, entry]) => {
                    const service = services.get(entry.service)
                    const source = entry.clone
                      ? `克隆（${entry.clone.samples.length} 个样本）`
                      : `音色 ${entry.voice ?? '（缺）'}`
                    const busy = cloneState?.locale === locale && cloneState.kind === 'busy'
                    return (
                      <li key={locale}>
                        <code>{locale}</code> → {service ? service.label : `服务「${entry.service}」`} ·{' '}
                        {source}
                        {entry.speed !== undefined ? ` · 语速 ${entry.speed}` : ''}
                        {entry.clone && service && (
                          <button
                            type="button"
                            className="tts-service-link"
                            disabled={busy}
                            onClick={() => void cloneFor(locale, entry, service)}
                          >
                            {busy ? '克隆中…' : '登记音色'}
                          </button>
                        )}
                        {cloneState?.locale === locale && cloneState.kind === 'busy' && (
                          <span className="tts-clone-note">{cloneState.message}</span>
                        )}
                        {cloneState?.locale === locale && cloneState.kind === 'done' && (
                          <span
                            className={`tts-clone-note${cloneState.ok ? '' : ' is-error'}`}
                          >
                            {cloneState.message}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {registered.length > 0 && (
                <ul className="tts-service-auth">
                  {registered.map((entry) => (
                    <li key={`${entry.serviceId}-${entry.voiceId}`}>
                      本机已登记 <code>{entry.serviceId}</code> → <code>{entry.voiceId}</code>
                    </li>
                  ))}
                </ul>
              )}

              {(audit.missing.length > 0 || audit.invalid.length > 0) && (
                <ul className="tts-service-auth">
                  {audit.missing.map((ref) => (
                    <li key={ref} className="missing">
                      本机缺凭据 <code>{ref}</code> —— 这个角色生成时会失败
                    </li>
                  ))}
                  {audit.invalid.map((ref) => (
                    <li key={ref} className="missing">
                      <code>{ref}</code> 不是一个凭据引用（应为 <code>env:</code> /{' '}
                      <code>app:</code>）
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

/** 新建方案的一行表单（只需要角色名 —— 文件名就是角色名） */
function NewPlanForm({ onSubmit }: { onSubmit: (character: string) => void }) {
  const [name, setName] = useState('')

  return (
    <div className="tts-service-create">
      <input
        value={name}
        placeholder="角色名（与剧本一致）"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onSubmit(name.trim())
            setName('')
          }
        }}
      />
      <button
        type="button"
        onClick={() => {
          onSubmit(name.trim())
          setName('')
        }}
        disabled={!name.trim()}
      >
        新建方案
      </button>
    </div>
  )
}
