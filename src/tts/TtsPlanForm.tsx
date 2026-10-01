/**
 * `.tts` 的**图形化设置页** —— 打开这个文件时取代代码编辑器。
 *
 * 一份方案由若干条**自给自足**的语言组成（规范 §4.2）：每条自己带服务、音色、语速。
 * 所以界面就是一张张语言卡片：卡片头是语言本身，卡片体是那三条设置。
 *
 * 改动一律先拼出完整方案再 `stringifyVoicePlan` 写回 —— 未知键跟着 `extra` 回去，
 * 表单只管它认识的那些。
 *
 * ## 界面上的三条约定
 *
 * - **检查结论贴在出问题的那一行下面**（`RowNote`），页面顶部不攒问题清单 ——
 *   攒在一起的问题是"要人去对位"的，贴在原地的问题才是"照着改"的。
 * - **没有副标题、没有汇总条、没有重复回显**。协议 / 端点 / 模型属于服务设置页，
 *   这里说一遍只是噪音；真正会拦住生成的两件事（服务不存在、缺 API KEY）就地报。
 * - **语言表与编辑器的语言选择器是同一张**（见 `LocaleSelect`）。两边不一致时，编辑器里
 *   选得到的语言在方案里配不了 —— 而配音的语言本来就得和正在编辑的那份 `.lang` 对上。
 * - **措辞简短、术语固定**：服务 / 音色 / 语速 / API KEY / 本地缓存。
 *
 * 音色一律是**厂商账号下的 id**，克隆也不例外 —— 克隆在厂商控制台做（实测见
 * `voices.ts` 头注释）：ElevenLabs 的控制台音色能被 `GET /v1/voices` 列出，所以
 * 这家给「获取音色」；MiniMax 列不全，但 T2A 会精确报 `2054`，所以给「验证」。
 */

import { useMemo, useState, type ReactNode } from 'react'
import {
  AUTH_SHAPES,
  PROTOCOLS,
  characterNameOfFileName,
  type Issue,
  type ProtocolId,
} from './spec'
import { ALL_LOCALES, getLocaleGroups, resolveLocale, type LocaleEntry } from '../i18n/locales'
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
  | { kind: 'ready'; voices: VoiceInfo[] }
  | { kind: 'error'; message: string }

type ProbeState =
  | { locale: string; kind: 'busy' }
  | { locale: string; kind: 'done'; ok: boolean; message: string }

/** 输入期间的语速草稿。只在 `locale` 匹配时生效，输入框失焦即丢掉 */
type SpeedEdit = { locale: string; text: string }

export type TtsPlanFormProps = {
  fileName: string
  text: string
  services: ReadonlyMap<string, ResolvedService>
  /**
   * 工程里出现过的语言标签。**它不是"可选范围"** —— 可选语言是编辑器语言选择器的
   * 那张全表；这个只用来把表里没收录的工程标签补进「本工程」组，免得选不到。
   */
  projectLocales: readonly string[]
  /** 新建一个服务定义文件，返回新服务的 id；取消或名字不合法时返回 null。**不切换文件** */
  createService(): string | null
  /** 打开某个服务定义（切到它的设置页） */
  openService(id: string): void
  onChange(next: string): void
  onSwitchToRaw(): void
  onOpenCredentials(): void
}

/**
 * 语速文本 → 可写入的值。
 *
 * - `''` → `undefined`（**明确清空**：留空即 1.0，与"没写过"同义）
 * - 能解析成有限数 → 那个数
 * - 其余（`1.0.5` / `-` / `Infinity`）→ `null`，调用方据此**不写文件**
 */
function parseSpeed(raw: string): number | null | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : null
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

/** 下拉里的一行：`简体中文 · zh_cn`。表里没有的标签名就是标签本身，别写成 `en · en` */
function localeOptionLabel(entry: LocaleEntry): string {
  return entry.nativeName === entry.tag ? entry.tag : `${entry.nativeName} · ${entry.tag}`
}

type LocaleGroupView = { label: string; items: readonly LocaleEntry[] }

/**
 * 语言选项 = **编辑器语言选择器的同一张表**（见 `LocaleSelect`）。
 *
 * 这里刻意**不**另立一份"能配音的语言"清单：两边不一致时，用户在编辑器里选得到的语言
 * 在配音方案里配不了（反之亦然），而配音的语言本来就必须与编辑器正在编辑的那份 `.lang`
 * 对上。工程里出现过、但表里没收录的标签（例如 agent 写下的 `en`）补进第一组，
 * 否则这些标签在这里根本选不到。
 */
function localeGroupsFor(projectLocales: readonly string[]): LocaleGroupView[] {
  const grouped = getLocaleGroups()
  const common = new Set((grouped[0]?.items ?? []).map((entry) => entry.tag))
  const known = new Set(ALL_LOCALES.map((entry) => entry.tag))

  const groups: LocaleGroupView[] = [
    { label: '常用语言', items: grouped[0]?.items ?? [] },
    // 常用语言已经列过的就不再重复一遍
    { label: '更多语言', items: ALL_LOCALES.filter((entry) => !common.has(entry.tag)) },
  ]

  const extra = projectLocales.filter((tag) => !known.has(tag)).map((tag) => resolveLocale(tag))
  return extra.length ? [{ label: '本工程', items: extra }, ...groups] : groups
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
  /** 已获取的音色列表，按**服务身份**缓存 —— 多条语言共用一家服务时不用重复拉，
   *  换了端点 / 模型的另一份定义也不会拿到上一份的列表 */
  const [voiceLists, setVoiceLists] = useState<Record<string, VoiceListEntry>>({})
  const [probeState, setProbeState] = useState<ProbeState | null>(null)
  const [speedEdit, setSpeedEdit] = useState<SpeedEdit | null>(null)
  const [newLocale, setNewLocale] = useState('')
  /** 刚在这儿新建的服务 —— 用来提示"它还是默认设置" */
  const [createdService, setCreatedService] = useState<string | null>(null)

  const parsed = useMemo(() => readVoicePlan(text, fileName), [text, fileName])
  const plan: VoicePlan = parsed.value

  const semantics: Issue[] = useMemo(
    () => (parsed.ok ? validateVoicePlanSemantics(plan, { services }) : []),
    [parsed, services, plan],
  )

  const character = characterNameOfFileName(fileName) ?? fileName
  const locales = Object.keys(plan.voices).sort()
  const localeGroups = useMemo(() => localeGroupsFor(projectLocales), [projectLocales])
  /** 「新增语言」能选的标签：表里全部（去重），减去这份方案已经配过的 */
  const addableTags = useMemo(() => {
    const used = new Set(Object.keys(plan.voices))
    const out = new Set<string>()
    for (const group of localeGroups) {
      for (const entry of group.items) {
        if (!used.has(entry.tag)) out.add(entry.tag)
      }
    }
    return out
  }, [localeGroups, plan])
  const issues = useMemo(() => [...parsed.issues, ...semantics], [parsed.issues, semantics])

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

  /** 能在卡片里找到位置的那些路径 —— 其余的只有两种去处：页面级错误、页脚计数 */
  const isPlaced = (path: string) =>
    /^voices\.[^.]+$/.test(path) || /^voices\.[^.]+\.(service|voice|speed)$/.test(path)

  const fileErrors = unreadable
    ? []
    : issues.filter((issue) => issue.level === 'error' && !isPlaced(issue.path))
  const foreignWarnings = unreadable
    ? 0
    : issues.filter((issue) => issue.level === 'warning' && !isPlaced(issue.path)).length

  const issuesAt = (path: string) => issues.filter((issue) => issue.path === path)

  /** 整份方案写回。未知键在 `extra` 里，跟着一起回去 */
  const write = (voices: Record<string, VoicePlanEntry>) => {
    onChange(stringifyVoicePlan({ ...plan, voices }))
  }

  const patchEntry = (locale: string, partial: Partial<VoicePlanEntry>) => {
    write({ ...plan.voices, [locale]: { ...plan.voices[locale], ...partial } })
  }

  const removeEntry = (locale: string) => {
    if (!window.confirm(`删除「${locale}」这条语言方案？`)) return
    const next = { ...plan.voices }
    delete next[locale]
    write(next)
    setProbeState((current) => (current?.locale === locale ? null : current))
    setSpeedEdit((current) => (current?.locale === locale ? null : current))
  }

  const renameEntry = (from: string, to: string) => {
    const tag = to.trim()
    if (!tag || tag === from || plan.voices[tag]) return
    const next: Record<string, VoicePlanEntry> = {}
    for (const [locale, entry] of Object.entries(plan.voices)) {
      next[locale === from ? tag : locale] = entry
    }
    write(next)
    setProbeState((current) => (current?.locale === from ? { ...current, locale: tag } : current))
    setSpeedEdit((current) => (current?.locale === from ? { ...current, locale: tag } : current))
  }

  const addEntry = () => {
    const tag = newLocale.trim()
    if (!tag || plan.voices[tag]) return
    const first = plan.voices[locales[0] ?? ''] ?? Object.values(plan.voices)[0]
    // 新的一条复制第一条的服务与音色 —— 从零填一条语言是最容易填错的
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

  /**
   * 把一条语言的服务 / 音色 / 语速应用到其余每条。
   *
   * 规范 §5.5 把"格式里不写继承"换成了"编辑器给一个批量动作"，这就是那个动作：
   * 文件里仍然每条写全，重复由这里一次性消掉。
   */
  const applyToAll = (locale: string) => {
    const source = plan.voices[locale]
    if (!source) return
    const others = locales.filter((tag) => tag !== locale)
    if (others.length === 0) return
    if (
      !window.confirm(
        `把「${locale}」的服务、音色与语速应用到另外 ${others.length} 条语言？\n（${others.join('、')} 当前的设置会被覆盖）`,
      )
    ) {
      return
    }
    const next: Record<string, VoicePlanEntry> = {}
    for (const [tag, entry] of Object.entries(plan.voices)) {
      if (tag === locale) {
        next[tag] = entry
        continue
      }
      // 逐字段覆盖：源里没有的（音色为空、语速留空）目标也要跟着没有，
      // 否则"应用到全部"会留下几条各自为政的旧值
      const merged: VoicePlanEntry = {
        ...entry,
        service: source.service,
        extra: { ...entry.extra },
      }
      if (source.voice === undefined) delete merged.voice
      else merged.voice = source.voice
      if (source.speed === undefined) delete merged.speed
      else merged.speed = source.speed
      next[tag] = merged
    }
    write(next)
  }

  const voiceKeyOf = (service: ResolvedService) =>
    `${service.id}|${service.baseUrl ?? ''}|${service.model ?? ''}`

  const fetchVoices = async (service: ResolvedService) => {
    const key = voiceKeyOf(service)
    setVoiceLists((current) => ({ ...current, [key]: { kind: 'busy' } }))
    const result = await listVoices(service, { transport, credential: resolver.resolve })
    setVoiceLists((current) => ({
      ...current,
      [key]: result.ok
        ? { kind: 'ready', voices: result.voices }
        : {
            kind: 'error',
            message: result.failure.hint
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
        ? { locale, kind: 'done', ok: true, message: '音色可用' }
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

  /** 该服务缺哪几个 API KEY —— 逐语言显示，因为"能不能生成"是在这一级决定的 */
  const missingKeysOf = (service: ResolvedService): string[] => {
    if (!service.authShape) return []
    const needed = new Set<string>(AUTH_SHAPES[service.authShape].map((field) => field.key))
    return service.auth
      .filter((field) => needed.has(field.key))
      .map((field) => field.value)
      .filter((ref) => ref.trim() !== '' && !resolver.has(ref))
  }

  return (
    <div className="tts-form">
      <header className="tts-page-head">
        <div className="tts-page-head-inner">
          <span className="tts-page-name">配音方案 · {character}</span>
          <span className="tts-page-actions">
            <button
              type="button"
              className="tts-btn"
              onClick={onOpenCredentials}
              title="查看与增删本机保存的 API KEY"
            >
              编辑本地缓存
            </button>
            <button
              type="button"
              className="tts-btn is-ghost"
              onClick={onSwitchToRaw}
              title="切到原始 JSON（这里改的都已经写回文件）"
            >
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

        {!unreadable && locales.length === 0 && (
          <div className="tts-empty">还没有语言方案 —— 在下面选一个语言开始。</div>
        )}

        {locales.map((locale) => {
          const entry = plan.voices[locale] as VoicePlanEntry | undefined
          /*
           * 值不是对象时 `toVoicePlan` 会把这个键整个跳过。卡片仍然要画出来 ——
           * 否则用户面对的是一个"读不出来、也删不掉"的键，只能去改 JSON。
           */
          if (!entry) {
            return (
              <section className="tts-card" key={locale} aria-label={`语言 ${locale}`}>
                <div className="tts-card-head">
                  <span className="tts-page-name">{locale}</span>
                  <span className="tts-card-actions">
                    <button
                      type="button"
                      className="tts-btn is-ghost is-danger"
                      onClick={() => removeEntry(locale)}
                    >
                      删除
                    </button>
                  </span>
                </div>
                <div className="tts-card-body">
                  <RowNote tone="danger">条目必须是对象</RowNote>
                </div>
              </section>
            )
          }

          const service = services.get(entry.service) ?? null
          const protocol: ProtocolId | null = service?.protocol ?? null
          const range = protocol ? PROTOCOLS[protocol].speedRange : undefined
          const listable = protocol !== null && canListVoices(protocol)
          const listState = service ? voiceLists[voiceKeyOf(service)] : undefined
          const fetched = listState?.kind === 'ready' ? listState.voices : null
          const probing = probeState?.locale === locale && probeState.kind === 'busy'
          const probeDone =
            probeState?.locale === locale && probeState.kind === 'done' ? probeState : null
          const missingKeys = service ? missingKeysOf(service) : []
          const cardIssues = issuesAt(`voices.${locale}`)
          const serviceIssues = issuesAt(`voices.${locale}.service`)
          const voiceIssues = issuesAt(`voices.${locale}.voice`)
          const speedIssues = issuesAt(`voices.${locale}.speed`)

          const draft =
            speedEdit && speedEdit.locale === locale
              ? speedEdit.text
              : entry.speed !== undefined
                ? String(entry.speed)
                : ''
          const draftValue = parseSpeed(draft)
          const speedOutOfRange =
            range !== undefined &&
            typeof draftValue === 'number' &&
            (draftValue < range[0] || draftValue > range[1])
          /** 这条的语言在不在选项里 —— 不在就得自己补一个，否则下拉会显示成第一项 */
          const localeListed = localeGroups.some((group) =>
            group.items.some((entry) => entry.tag === locale),
          )

          return (
            <section className="tts-card" key={locale} aria-label={`语言 ${locale}`}>
              <div className="tts-card-head">
                <div className="tts-control">
                  {/* 语言表与编辑器的语言选择器**是同一张** —— 编辑器里选得到的，
                      这里就配得了。已经配过的语言在选项里禁用：一条语言只能有一份配置。 */}
                  <select
                    value={locale}
                    aria-label="语言"
                    onChange={(event) => renameEntry(locale, event.target.value)}
                  >
                    {!localeListed && <option value={locale}>{locale}</option>}
                    {localeGroups.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.items.map((entry) => {
                          const used = entry.tag !== locale && Boolean(plan.voices[entry.tag])
                          return (
                            <option key={entry.tag} value={entry.tag} disabled={used}>
                              {used
                                ? `${localeOptionLabel(entry)}（已配）`
                                : localeOptionLabel(entry)}
                            </option>
                          )
                        })}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <span className="tts-card-actions">
                  <button
                    type="button"
                    className="tts-btn is-ghost"
                    disabled={locales.length < 2}
                    onClick={() => applyToAll(locale)}
                    title="把这条的服务、音色、语速应用到其他每条语言"
                  >
                    应用到全部
                  </button>
                  <button
                    type="button"
                    className="tts-btn is-ghost is-danger"
                    onClick={() => removeEntry(locale)}
                  >
                    删除
                  </button>
                </span>
              </div>

              <div className="tts-card-body">
                {cardIssues.map((issue) => (
                  <RowNote key={issue.path} tone={issue.level === 'error' ? 'danger' : 'warn'}>
                    {issue.message}
                  </RowNote>
                ))}

                <div className="tts-row">
                  <span className="tts-row-label">服务</span>
                  <div className="tts-control">
                    <select
                      value={entry.service}
                      aria-label="服务"
                      onChange={(event) => {
                        patchEntry(locale, { service: event.target.value })
                        // 换服务了，上一个音色的验证结论不再成立
                        setProbeState(null)
                      }}
                    >
                      {!services.has(entry.service) && (
                        <option value={entry.service}>{entry.service || '（空）'}（不存在）</option>
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
                      className="tts-btn is-ghost"
                      onClick={() => {
                        const id = createService()
                        if (!id) return
                        // 先写进方案再提示去填 —— 这一刻活动文件还是方案，
                        // 顺序反了会把方案内容写进那个新服务里
                        patchEntry(locale, { service: id })
                        setCreatedService(id)
                        setProbeState(null)
                      }}
                    >
                      新建
                    </button>
                  </div>
                </div>

                {serviceIssues.length > 0 ? (
                  <RowNote tone={serviceIssues.some((i) => i.level === 'error') ? 'danger' : 'warn'}>
                    {serviceIssues.map((issue) => issue.message).join('；')}
                  </RowNote>
                ) : createdService && entry.service === createdService ? (
                  <RowNote tone="warn">
                    「{createdService}」还是默认设置
                    <button
                      type="button"
                      className="tts-form-link"
                      onClick={() => openService(createdService)}
                    >
                      服务设置
                    </button>
                  </RowNote>
                ) : service && !service.protocol ? (
                  <RowNote tone="danger">
                    服务没有可用的协议
                    <button
                      type="button"
                      className="tts-form-link"
                      onClick={() => openService(service.id)}
                    >
                      服务设置
                    </button>
                  </RowNote>
                ) : missingKeys.length > 0 ? (
                  <RowNote tone="warn">
                    缺少 API KEY <code>{missingKeys.join('、')}</code>
                    <button type="button" className="tts-form-link" onClick={onOpenCredentials}>
                      填写
                    </button>
                  </RowNote>
                ) : null}

                <div className="tts-row">
                  <span className="tts-row-label">音色</span>
                  <div className="tts-control">
                    <input
                      type="text"
                      value={entry.voice ?? ''}
                      placeholder={protocol === 'minimax' ? 'voice_id' : '音色 id'}
                      list={fetched ? `tts-voices-${locale}` : undefined}
                      aria-label="音色 id"
                      title="音色 id 到厂商控制台复制；「验证」会试合成两个字符确认它存在"
                      onChange={(event) => {
                        patchEntry(locale, { voice: event.target.value || undefined })
                        // 改过 id 之后上一次的验证结论不再成立
                        if (probeState?.locale === locale) setProbeState(null)
                      }}
                    />
                    {fetched && (
                      <datalist id={`tts-voices-${locale}`}>
                        {fetched.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name === item.id ? item.id : item.name}
                          </option>
                        ))}
                      </datalist>
                    )}
                    {listable && service && (
                      <button
                        type="button"
                        className="tts-btn is-ghost"
                        disabled={listState?.kind === 'busy'}
                        onClick={() => void fetchVoices(service)}
                        title={
                          listState?.kind === 'error'
                            ? `上次获取失败：${listState.message}`
                            : '从厂商账号里取音色列表'
                        }
                      >
                        {listState?.kind === 'busy' ? '获取中…' : '获取音色'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="tts-btn is-ghost"
                      disabled={probing || !service || !entry.voice?.trim()}
                      onClick={() => service && void probe(locale, entry, service)}
                      title={
                        protocol === 'minimax'
                          ? '试合成两个字符确认 id 存在（按合成计费）；MiniMax 的音色列表不全，id 到控制台复制'
                          : '试合成两个字符确认 id 存在'
                      }
                    >
                      {probing ? '验证中…' : '验证'}
                    </button>
                  </div>
                </div>

                {voiceIssues.length > 0 ? (
                  <RowNote tone={voiceIssues.some((i) => i.level === 'error') ? 'danger' : 'warn'}>
                    {voiceIssues.map((issue) => issue.message).join('；')}
                  </RowNote>
                ) : probeDone ? (
                  <RowNote tone={probeDone.ok ? 'ok' : 'danger'}>{probeDone.message}</RowNote>
                ) : listState?.kind === 'error' ? (
                  <RowNote tone="warn">获取音色失败：{listState.message}</RowNote>
                ) : null}

                <div className="tts-row">
                  <span className="tts-row-label">语速</span>
                  <div className="tts-control">
                    {/* text + inputMode：原生 number 会在小数点刚敲下时规范化回去，
                        1.05 这种就打不完（见文件头注释） */}
                    <input
                      className="is-number"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft}
                      placeholder="1.0"
                      aria-label="语速"
                      aria-invalid={draftValue === null || speedOutOfRange}
                      onChange={(event) => {
                        const next = event.target.value
                        setSpeedEdit({ locale, text: next })
                        const value = parseSpeed(next)
                        // 解析不出来（敲到一半）就先不写文件 —— 写进去只会得到 null 或 NaN
                        if (value !== null) patchEntry(locale, { speed: value })
                      }}
                      onBlur={() => {
                        if (!speedEdit || speedEdit.locale !== locale) return
                        const value = parseSpeed(speedEdit.text)
                        setSpeedEdit(null)
                        // 还原 / 钳制都是**字段上看得见的变化**，不再另发一条提示
                        if (value === null) return
                        if (
                          value !== undefined &&
                          range &&
                          (value < range[0] || value > range[1])
                        ) {
                          patchEntry(locale, {
                            speed: Math.min(range[1], Math.max(range[0], value)),
                          })
                        }
                      }}
                    />
                    <span className="tts-hint">
                      {range ? `${range[0]} – ${range[1]}，留空为 1.0` : '留空为 1.0'}
                    </span>
                  </div>
                </div>

                {draftValue === null ? (
                  <RowNote tone="danger">不是数字</RowNote>
                ) : speedOutOfRange && range ? (
                  <RowNote tone="warn">
                    超出 {range[0]} – {range[1]}，失焦时按边界取值
                  </RowNote>
                ) : speedIssues.length > 0 ? (
                  <RowNote tone="warn">
                    {speedIssues.map((issue) => issue.message).join('；')}
                  </RowNote>
                ) : null}
              </div>
            </section>
          )
        })}

        <section className="tts-card">
          <div className="tts-card-body">
            <div className="tts-row">
              <span className="tts-row-label">新增语言</span>
              <div className="tts-control">
                {/* 同样来自编辑器那张语言表；已经配过的不列出来 */}
                <select
                  value={newLocale}
                  aria-label="新增语言"
                  disabled={addableTags.size === 0}
                  onChange={(event) => setNewLocale(event.target.value)}
                >
                  <option value="">
                    {addableTags.size === 0 ? '无可选语言' : '选择语言'}
                  </option>
                  {localeGroups.map((group) => {
                    const items = group.items.filter((entry) => addableTags.has(entry.tag))
                    if (items.length === 0) return null
                    return (
                      <optgroup key={group.label} label={group.label}>
                        {items.map((entry) => (
                          <option key={entry.tag} value={entry.tag}>
                            {localeOptionLabel(entry)}
                          </option>
                        ))}
                      </optgroup>
                    )
                  })}
                </select>
                <button
                  type="button"
                  className="tts-btn is-primary"
                  disabled={!newLocale}
                  onClick={addEntry}
                >
                  添加
                </button>
              </div>
            </div>
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
