/**
 * `.tts` 的**图形化设置页** —— 打开这个文件时取代代码编辑器。
 *
 * 一份方案由若干条**自给自足**的语言组成(规范 §4.2):每条自己带服务、音色来源、语速。
 * 所以界面就是一张张语言卡片,而不是"全局设置 + 例外"。
 *
 * 改动一律先拼出完整方案再 `stringifyVoicePlan` 写回 —— 未知键跟着 `extra` 回去,
 * 表单只管它认识的那些。
 *
 * 克隆的样本从**工程里已有的音频资产**里选,不让人手打路径 ——
 * 手打一个不存在的路径,要等到点"登记音色"才知道写错了。
 */

import { useMemo, useState } from 'react'
import {
  PROTOCOLS,
  characterNameOfFileName,
  isValidConsentRef,
  type Issue,
  type ProtocolId,
} from './spec'
import {
  readVoicePlan,
  stringifyVoicePlan,
  validateVoicePlanSemantics,
  type CloneSource,
  type VoicePlan,
  type VoicePlanEntry,
} from './plan'
import type { ResolvedService } from './service'
import { createCredentialResolver, createLocalBackend } from './credentials'
import { ensureClonedVoice, type CloneSample } from './clone'
import { createCloneRegistry, useCloneRegistryEntries } from './cloneRegistry'
import { createFetchTransport } from './transport'
import './form.css'

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

export type TtsPlanFormProps = {
  fileName: string
  text: string
  services: ReadonlyMap<string, ResolvedService>
  /** 工程里已有的音频资产 —— 克隆样本从这里选 */
  audioAssets: readonly string[]
  /** 工程的**语言表**（`assets/<locale>/lang_*` 真实存在过的那些）—— 语言从它里面选 */
  projectLocales: readonly string[]
  /** 新建一个服务定义文件，返回新服务的 id；取消或名字不合法时返回 null。**不切换文件** */
  createService(): string | null
  /** 打开某个服务定义（切到它的设置页） */
  openService(id: string): void
  onChange(next: string): void
  onSwitchToRaw(): void
  onOpenCredentials(): void
  readAssetBytes(path: string): Promise<Uint8Array | null>
}

export function TtsPlanForm({
  fileName,
  text,
  services,
  audioAssets,
  projectLocales,
  createService,
  openService,
  onChange,
  onSwitchToRaw,
  onOpenCredentials,
  readAssetBytes,
}: TtsPlanFormProps) {
  const resolver = useMemo(
    () => createCredentialResolver({ backend: createLocalBackend() }),
    [],
  )
  const registry = useMemo(() => createCloneRegistry(), [])
  const transport = useMemo(() => createFetchTransport(), [])
  const [cloneState, setCloneState] = useState<CloneState | null>(null)
  const [newLocale, setNewLocale] = useState('')
  /** 刚在这儿新建的服务 —— 用来提示"它还是默认设置，要不要现在去填" */
  const [createdService, setCreatedService] = useState<string | null>(null)

  const parsed = useMemo(() => readVoicePlan(text, fileName), [text, fileName])
  const plan: VoicePlan = parsed.value

  const semantics: Issue[] = useMemo(
    () => (parsed.ok ? validateVoicePlanSemantics(plan, { services }) : []),
    [parsed, services, plan],
  )

  const character = characterNameOfFileName(fileName) ?? fileName
  const locales = Object.keys(plan.voices).sort()
  const unusedLocales = projectLocales.filter((tag) => !plan.voices[tag])

  /**
   * 内容根本不是 JSON（或者文件还是空的）。
   *
   * **不当死路**：读不出任何设置，那就从零填 —— `parsed.value` 已经是一份空方案
   * (`toVoicePlan(null)`)，表单照着它渲染即可。
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

  const entries = useCloneRegistryEntries()

  /** 整份方案写回。未知键在 `extra` 里，跟着一起回去 */
  const write = (voices: Record<string, VoicePlanEntry>) => {
    onChange(stringifyVoicePlan({ ...plan, voices }))
  }

  const patchEntry = (locale: string, partial: Partial<VoicePlanEntry>) => {
    write({ ...plan.voices, [locale]: { ...plan.voices[locale], ...partial } })
  }

  const removeEntry = (locale: string) => {
    const next = { ...plan.voices }
    delete next[locale]
    write(next)
  }

  const renameEntry = (from: string, to: string) => {
    const tag = to.trim()
    if (!tag || tag === from || plan.voices[tag]) return
    const next: Record<string, VoicePlanEntry> = {}
    for (const [locale, entry] of Object.entries(plan.voices)) {
      next[locale === from ? tag : locale] = entry
    }
    write(next)
  }

  const addEntry = () => {
    const tag = newLocale.trim()
    if (!tag || plan.voices[tag]) return
    const first = Object.values(plan.voices)[0]
    // 新的一条抄第一条的服务与音色来源 —— 从零填一条语言是最容易填错的
    const entry: VoicePlanEntry = first
      ? {
          service: first.service,
          ...(first.voice !== undefined ? { voice: first.voice } : {}),
          ...(first.clone ? { clone: { ...first.clone, samples: [...first.clone.samples] } } : {}),
          extra: {},
        }
      : { service: [...services.keys()][0] ?? '', voice: '', extra: {} }
    write({ ...plan.voices, [tag]: entry })
    setNewLocale('')
  }

  const cloneFor = async (locale: string, entry: VoicePlanEntry, service: ResolvedService) => {
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
      const bytes = await readAssetBytes(path)
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
        name: `${character}-${locale}`,
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
    <div className="tts-form">
      <div className="tts-form-head">
        <span className="tts-form-title">配音方案 · {character}</span>
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
        <>
          {parsed.issues.length + semantics.length > 0 && (
            <ul className="tts-form-issues">
              {[...parsed.issues, ...semantics].map((issue, index) => (
                <li key={`${issue.path}-${index}`} className={`level-${issue.level}`}>
                  <code>{issue.path}</code> {issue.message}
                </li>
              ))}
            </ul>
          )}

          {locales.length === 0 && (
            <p className="tts-form-ok">
              这份方案一条语言都没有 —— 录音棚里第②级将是空的。下面加一条。
            </p>
          )}
        </>
      )}

      {locales.map((locale) => {
        const entry = plan.voices[locale]
        const service = services.get(entry.service) ?? null
        const protocol: ProtocolId | undefined = service?.protocol ?? undefined
        const range = protocol ? PROTOCOLS[protocol].speedRange : undefined
        const busy = cloneState?.locale === locale && cloneState.kind === 'busy'
        // 登记表按**样本指纹**索引，而这里不去读样本字节 —— 所以只能说
        // "这家在本机登记过哪几个音色"，不能说"这一条登记过了没有"。
        // 想知道后者，点一次「登记音色」，它命中登记表会直接告诉你。
        const registered = entries.filter((item) => item.serviceId === entry.service)

        return (
          <div className="tts-lang" key={locale}>
            <div className="tts-lang-head">
              <span className="tts-lang-tag">{locale}</span>
              <span className="tts-form-head-actions">
                <button
                  type="button"
                  className="tts-form-link"
                  onClick={() => removeEntry(locale)}
                >
                  删掉这条
                </button>
              </span>
            </div>

            <div className="tts-form-row">
              <span className="tts-form-label">语言</span>
              <span className="tts-form-control">
                {/* 从**工程的语言表**里选 —— 手打一个工程里没有的语言，
                    生成时会拿不到译文，而那是要等点了才知道的错 */}
                <select value={locale} onChange={(event) => renameEntry(locale, event.target.value)}>
                  {!projectLocales.includes(locale) && (
                    <option value={locale}>{locale}（工程里没有这个语言）</option>
                  )}
                  {projectLocales.map((tag) => (
                    <option key={tag} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
                {projectLocales.length === 0 && (
                  <span className="tts-form-hint">
                    工程的 assets 下还没有语言资源
                  </span>
                )}
              </span>
            </div>

            <div className="tts-form-row">
              <span className="tts-form-label">服务</span>
              <span className="tts-form-control">
                <select
                  value={entry.service}
                  onChange={(event) => patchEntry(locale, { service: event.target.value })}
                >
                  {!services.has(entry.service) && (
                    <option value={entry.service}>
                      {entry.service || '（未填）'} —— 工程里没有这个服务
                    </option>
                  )}
                  {/* 带上 id —— 同一个预设可以建好几个服务，光看显示名分不出是哪一个，
                      而方案里存的正是 id */}
                  {[...services.values()].map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label === item.id ? item.id : `${item.label}（${item.id}）`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="tts-form-link"
                  onClick={() => {
                    const id = createService()
                    if (!id) return
                    // 先写进方案再提示去填 —— 这一刻活动文件还是方案，
                    // 顺序反了会把方案内容写进那个新服务里
                    patchEntry(locale, { service: id })
                    setCreatedService(id)
                  }}
                >
                  新建服务
                </button>
              </span>
            </div>

            {createdService && entry.service === createdService && (
              <div className="tts-form-row">
                <span className="tts-form-label" />
                <span className="tts-form-control">
                  <span className="tts-form-hint">
                    「{createdService}」刚建好，还是默认设置 —— 供应商、端点、凭据都还没定
                  </span>
                  <button
                    type="button"
                    className="tts-form-link"
                    onClick={() => openService(createdService)}
                  >
                    去填它
                  </button>
                </span>
              </div>
            )}

            <div className="tts-form-row">
              <span className="tts-form-label">音色来源</span>
              <span className="tts-form-control">
                <select
                  value={entry.clone ? 'clone' : 'voice'}
                  onChange={(event) => {
                    if (event.target.value === 'clone') {
                      patchEntry(locale, {
                        clone: entry.clone ?? {
                          samples: audioAssets.slice(0, 1),
                          consent: '',
                          extra: {},
                        },
                        voice: undefined,
                      })
                    } else {
                      patchEntry(locale, { clone: undefined, voice: entry.voice ?? '' })
                    }
                  }}
                >
                  <option value="voice">预置音色</option>
                  <option value="clone">克隆音色</option>
                </select>
                {entry.clone ? (
                  <span className="tts-form-hint">
                    样本 {entry.clone.samples.length} 个
                    {registered.length > 0
                      ? ` · ${service?.label ?? entry.service} 在本机登记过 ${registered
                          .map((item) => item.voiceId)
                          .join('、')}`
                      : ' · 这家还没登记过音色'}
                  </span>
                ) : null}
              </span>
            </div>

            {entry.clone ? (
              <>
                <div className="tts-form-row">
                  <span className="tts-form-label">样本</span>
                  <span className="tts-form-control">
                    <span className="tts-form-hint">
                      上传给厂商的就是这几个文件
                    </span>
                  </span>
                </div>
                <ul className="tts-lang-samples">
                  {entry.clone.samples.map((sample, index) => (
                    <li key={`${sample}-${index}`}>
                      <select
                        value={sample}
                        onChange={(event) => {
                          const samples = [...entry.clone!.samples]
                          samples[index] = event.target.value
                          patchEntry(locale, {
                            clone: { ...entry.clone!, samples },
                          })
                        }}
                      >
                        {!audioAssets.includes(sample) && (
                          <option value={sample}>{sample || '（未选）'}</option>
                        )}
                        {audioAssets.map((path) => (
                          <option key={path} value={path}>
                            {path}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="tts-form-link"
                        onClick={() => {
                          const samples = entry.clone!.samples.filter((_, i) => i !== index)
                          patchEntry(locale, { clone: { ...entry.clone!, samples } })
                        }}
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="tts-form-row">
                  <span className="tts-form-label" />
                  <span className="tts-form-control">
                    <button
                      type="button"
                      className="tts-form-link"
                      onClick={() => {
                        const unused = audioAssets.find(
                          (path) => !entry.clone!.samples.includes(path),
                        )
                        patchEntry(locale, {
                          clone: {
                            ...entry.clone!,
                            samples: [...entry.clone!.samples, unused ?? ''],
                          },
                        })
                      }}
                    >
                      加一个样本
                    </button>
                    {audioAssets.length === 0 && (
                      <span className="tts-form-hint">
                        工程里还没有音频资产 —— 先把样本放进 assets
                      </span>
                    )}
                  </span>
                </div>

                <div className="tts-form-row">
                  <span className="tts-form-label">授权书</span>
                  <span className="tts-form-control">
                    <input
                      type="text"
                      value={entry.clone.consent}
                      placeholder="meta/docs/授权书.pdf 或 app:某人-授权"
                      onChange={(event) => {
                        const clone: CloneSource = { ...entry.clone!, consent: event.target.value }
                        patchEntry(locale, { clone })
                      }}
                    />
                    <span
                      className={
                        entry.clone.consent && !isValidConsentRef(entry.clone.consent)
                          ? 'tts-form-hint is-warn'
                          : 'tts-form-hint'
                      }
                    >
                      {!entry.clone.consent
                        ? '必填 —— 没有授权不该克隆'
                        : isValidConsentRef(entry.clone.consent)
                          ? '格式没问题'
                          : '要写成 meta/ 下的路径，或 env: / app: 引用'}
                    </span>
                  </span>
                </div>

                <div className="tts-form-row">
                  <span className="tts-form-label" />
                  <span className="tts-form-control">
                    <button
                      type="button"
                      className="tts-form-btn"
                      disabled={busy || !service}
                      onClick={() => service && void cloneFor(locale, entry, service)}
                    >
                      {busy ? '克隆中…' : '登记音色'}
                    </button>
                    {cloneState?.locale === locale && (
                      <span
                        className={
                          cloneState.kind === 'done' && !cloneState.ok
                            ? 'tts-form-hint is-warn'
                            : 'tts-form-hint'
                        }
                      >
                        {cloneState.message}
                      </span>
                    )}
                  </span>
                </div>
              </>
            ) : (
              <div className="tts-form-row">
                <span className="tts-form-label">音色</span>
                <span className="tts-form-control">
                  <input
                    type="text"
                    value={entry.voice ?? ''}
                    placeholder="音色 id（到厂商控制台查）"
                    onChange={(event) =>
                      patchEntry(locale, { voice: event.target.value || undefined })
                    }
                  />
                </span>
              </div>
            )}

            <div className="tts-form-row">
              <span className="tts-form-label">语速</span>
              <span className="tts-form-control">
                <input
                  type="number"
                  step="0.05"
                  min={range?.[0]}
                  max={range?.[1]}
                  value={entry.speed ?? ''}
                  placeholder="1"
                  onChange={(event) => {
                    const raw = event.target.value.trim()
                    patchEntry(locale, {
                      speed: raw === '' ? undefined : Number(raw),
                    })
                  }}
                />
                <span className="tts-form-hint">
                  {range
                    ? `这家允许 ${range[0]} – ${range[1]}；留空即 1.0`
                    : '留空即 1.0'}
                </span>
              </span>
            </div>
          </div>
        )
      })}

      <div className="tts-form-section">
        <p className="tts-form-section-title">加一条语言</p>
        <div className="tts-form-row">
          <span className="tts-form-label">语言</span>
          <span className="tts-form-control">
            {/* 只列工程里有、这份方案还没配的语言 —— 已经配过的不该还能再选一次 */}
            <select
              value={newLocale}
              disabled={unusedLocales.length === 0}
              onChange={(event) => setNewLocale(event.target.value)}
            >
              <option value="">
                {unusedLocales.length === 0
                  ? '（工程里的语言都配上了）'
                  : '选一个语言'}
              </option>
              {unusedLocales.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="tts-form-btn"
              disabled={!newLocale}
              onClick={addEntry}
            >
              加上
            </button>
            <span className="tts-form-hint">
              新的一条会先抄第一条的服务与音色来源，再改
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}
