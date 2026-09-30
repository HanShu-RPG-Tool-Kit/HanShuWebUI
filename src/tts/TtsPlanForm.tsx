/**
 * `.tts` 的**图形化设置页** —— 打开这个文件时取代代码编辑器。
 *
 * 一份方案由若干条**自给自足**的语言组成(规范 §4.2):每条自己带服务、音色、语速。
 * 所以界面就是一张张语言卡片,而不是"全局设置 + 例外"。
 *
 * 改动一律先拼出完整方案再 `stringifyVoicePlan` 写回 —— 未知键跟着 `extra` 回去,
 * 表单只管它认识的那些。
 *
 * 音色一律是**厂商账号下的 id**,克隆也不例外 —— 克隆在厂商控制台做(实测见
 * `voices.ts` 头注释):ElevenLabs 的控制台音色能被 `GET /v1/voices` 列出,所以
 * 这家给「拉取音色」;MiniMax 列不全,但 T2A 会精确报 `2054`,所以给「验证」。
 */

import { useMemo, useState } from 'react'
import {
  PROTOCOLS,
  characterNameOfFileName,
  type Issue,
  type ProtocolId,
} from './spec'
import {
  readVoicePlan,
  stringifyVoicePlan,
  validateVoicePlanSemantics,
  type VoicePlan,
  type VoicePlanEntry,
} from './plan'
import type { ResolvedService } from './service'
import { createCredentialResolver, createLocalBackend } from './credentials'
import { canListVoices, listVoices, probeVoice, type VoiceInfo } from './voices'
import { createFetchTransport } from './transport'
import './form.css'

type VoiceListEntry =
  | { kind: 'busy' }
  | { kind: 'done'; voices: VoiceInfo[] }
  | { kind: 'done'; error: string }

type ProbeState =
  | { locale: string; kind: 'busy' }
  | { locale: string; kind: 'done'; ok: boolean; message: string }

export type TtsPlanFormProps = {
  fileName: string
  text: string
  services: ReadonlyMap<string, ResolvedService>
  /** 工程的**语言表**（`assets/<locale>/lang_*` 真实存在过的那些）—— 语言从它里面选 */
  projectLocales: readonly string[]
  /** 新建一个服务定义文件，返回新服务的 id；取消或名字不合法时返回 null。**不切换文件** */
  createService(): string | null
  /** 打开某个服务定义（切到它的设置页） */
  openService(id: string): void
  onChange(next: string): void
  onSwitchToRaw(): void
  onOpenCredentials(): void
}

export function TtsPlanForm({
  fileName,
  text,
  services,
  projectLocales,
  createService,
  openService,
  onChange,
  onSwitchToRaw,
  onOpenCredentials,
}: TtsPlanFormProps) {
  const resolver = useMemo(
    () => createCredentialResolver({ backend: createLocalBackend() }),
    [],
  )
  const transport = useMemo(() => createFetchTransport(), [])
  /** 已拉取的音色列表，按服务 id 缓存 —— 多条语言共用一家服务时不用重复拉 */
  const [voiceLists, setVoiceLists] = useState<Record<string, VoiceListEntry>>({})
  const [probeState, setProbeState] = useState<ProbeState | null>(null)
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
    // 新的一条抄第一条的服务与音色 —— 从零填一条语言是最容易填错的
    const entry: VoicePlanEntry = first
      ? {
          service: first.service,
          ...(first.voice !== undefined ? { voice: first.voice } : {}),
          extra: {},
        }
      : { service: [...services.keys()][0] ?? '', voice: '', extra: {} }
    write({ ...plan.voices, [tag]: entry })
    setNewLocale('')
  }

  const fetchVoices = async (service: ResolvedService) => {
    setVoiceLists((current) => ({ ...current, [service.id]: { kind: 'busy' } }))
    const result = await listVoices(service, { transport, credential: resolver.resolve })
    setVoiceLists((current) => ({
      ...current,
      [service.id]: result.ok
        ? { kind: 'done', voices: result.voices }
        : {
            kind: 'done',
            error: result.failure.hint
              ? `${result.failure.message} —— ${result.failure.hint}`
              : result.failure.message,
          },
    }))
  }

  const probe = async (locale: string, entry: VoicePlanEntry, service: ResolvedService) => {
    const voice = entry.voice?.trim() ?? ''
    if (!voice) return
    setProbeState({ locale, kind: 'busy' })
    const result = await probeVoice(service, voice, {
      transport,
      credential: resolver.resolve,
    })
    setProbeState(
      result.ok
        ? { locale, kind: 'done', ok: true, message: '音色存在，可以合成' }
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
              你需要为该配音方案添加语言方案
            </p>
          )}
        </>
      )}

      {locales.map((locale) => {
        const entry = plan.voices[locale]
        const service = services.get(entry.service) ?? null
        const protocol: ProtocolId | undefined = service?.protocol ?? undefined
        const range = protocol ? PROTOCOLS[protocol].speedRange : undefined
        const listable = protocol !== undefined && canListVoices(protocol)
        const listState = service ? voiceLists[service.id] : undefined
        const fetchedVoices = listState?.kind === 'done' && 'voices' in listState ? listState.voices : null
        const probing = probeState?.locale === locale && probeState.kind === 'busy'

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
                    <option value={locale}>不存在该语言 {locale}</option>
                  )}
                  {projectLocales.map((tag) => (
                    <option key={tag} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
                {projectLocales.length === 0 && (
                  <span className="tts-form-hint">
                    语言资源缺失
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
                      {entry.service || 'Empty'} —— 无效服务
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
                    {createdService} 缺失有效信息
                  </span>
                  <button
                    type="button"
                    className="tts-form-link"
                    onClick={() => openService(createdService)}
                  >
                    补充信息
                  </button>
                </span>
              </div>
            )}

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
                {listable && service && (
                  <button
                    type="button"
                    className="tts-form-link"
                    disabled={listState?.kind === 'busy'}
                    onClick={() => void fetchVoices(service)}
                  >
                    {listState?.kind === 'busy' ? '拉取中…' : '拉取音色'}
                  </button>
                )}
                <button
                  type="button"
                  className="tts-form-link"
                  disabled={probing || !service || !entry.voice?.trim()}
                  onClick={() => service && void probe(locale, entry, service)}
                >
                  {probing ? '验证中…' : '验证'}
                </button>
                {probeState?.locale === locale && probeState.kind === 'done' && (
                  <span
                    className={probeState.ok ? 'tts-form-hint' : 'tts-form-hint is-warn'}
                  >
                    {probeState.message}
                  </span>
                )}
              </span>
            </div>

            {fetchedVoices && (
              <div className="tts-form-row">
                <span className="tts-form-label" />
                <span className="tts-form-control">
                  <select
                    value={fetchedVoices.some((item) => item.id === entry.voice) ? entry.voice : ''}
                    onChange={(event) => {
                      if (event.target.value) patchEntry(locale, { voice: event.target.value })
                    }}
                  >
                    <option value="">从列表里选一个（{fetchedVoices.length} 个）</option>
                    {fetchedVoices.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name === item.id ? item.id : `${item.name}（${item.id}）`}
                        {item.category && item.category !== 'premade' ? ` · ${item.category}` : ''}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            )}
            {listState?.kind === 'done' && 'error' in listState && (
              <div className="tts-form-row">
                <span className="tts-form-label" />
                <span className="tts-form-control">
                  <span className="tts-form-hint is-warn">{listState.error}</span>
                </span>
              </div>
            )}
            {protocol === 'minimax' && (
              <div className="tts-form-row">
                <span className="tts-form-label" />
                <span className="tts-form-control">
                  <span className="tts-form-hint">
                    克隆到 MiniMax 控制台做；它的音色列表查不全，填好 id 点「验证」确认
                    （试合成两个字符，按合成计费）
                  </span>
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
        <p className="tts-form-section-title">新增语言方案</p>
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
                  ? '没有可选语言'
                  : '选择语言'}
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
              新增
            </button>
            <span className="tts-form-hint">
              新建语言方案会默认继承头条方案的服务与音色
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}
