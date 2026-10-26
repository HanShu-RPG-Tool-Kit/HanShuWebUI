import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from 'react'
import { ProgressCompletionEditor } from './ProgressCompletionEditor'
import { createCompletionGraph, goalAliases } from './completionGraph'
import {
  createProgressGoal, duplicateProgressGoal, goalConfigSummary,
  moveProgressGoal, progressIssues, PROGRESS_REPEAT_LABELS, stringifyProgress,
  conditionStatesFor, createConditionRule,
  type ProgressConditionRule, type ProgressDocument, type ProgressGoal,
  type ProgressRepeatKind,
} from './progressDoc'
import { localizedGoalDefinitionLabel, type GoalDefinition, type GoalDefinitionCatalog } from './goalDefinitions'
import {
  GoalParameterField,
  pickGoalLocaleDescription,
} from './goalWidgets'
import {
  KIT_LINK_MIME,
  decodeKitLinkPayload,
  kitRefFromFileName,
  normalizeKitRef,
} from './kit'
import './ProgressEditor.css'

function displayGoalLabel(goal: ProgressGoal, definitions: readonly GoalDefinition[], locale: string) {
  const definition = definitions.find((item) => item.kind === goal.kind)
  if (!definition) return goal.kind || '未选择目标类型'
  return localizedGoalDefinitionLabel(definition, locale)
}

type KitOption = { ref: string; label: string; key?: string }

function isKitFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.kit')
}

function hasKitRewardDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types ?? [])
  if (types.includes(KIT_LINK_MIME)) return true
  return Array.from(dataTransfer.files ?? []).some((file) => isKitFileName(file.name))
}

function collectKitRewardRefs(transfer: DataTransfer): { refs: string[]; errors: string[] } {
  const refs: string[] = []
  const errors: string[] = []
  const mime = transfer.getData(KIT_LINK_MIME)
  if (mime) {
    const ref = decodeKitLinkPayload(mime)
    if (ref) refs.push(ref)
    else errors.push('礼包链接无效')
  }
  for (const file of Array.from(transfer.files ?? [])) {
    if (!isKitFileName(file.name)) continue
    const ref = kitRefFromFileName(file.name)
    if (ref) refs.push(ref)
    else errors.push(`${file.name}：无效文件名`)
  }
  return { refs, errors }
}

function KitRewardDropZone({
  disabled,
  empty,
  onAdd,
  children,
}: {
  disabled?: boolean
  empty?: boolean
  onAdd: (refs: string[]) => { added: number; skipped: number }
  children: ReactNode
}) {
  const [over, setOver] = useState(false)
  const [notice, setNotice] = useState('')

  function onDragOver(event: DragEvent) {
    if (disabled || !hasKitRewardDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }

  function flash(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice((current) => (current === message ? '' : current)), 3200)
  }

  return (
    <div
      className={`progress-reward-drop${over ? ' is-over' : ''}`}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(event) => {
        setOver(false)
        if (disabled) return
        event.preventDefault()
        event.stopPropagation()
        if (!hasKitRewardDrag(event.dataTransfer)) return
        const { refs, errors } = collectKitRewardRefs(event.dataTransfer)
        if (!refs.length && !errors.length) {
          flash('请拖入 .kit，或从礼包分类拖入链接')
          return
        }
        const unique = [...new Set(refs.map((ref) => normalizeKitRef(ref)).filter(Boolean))]
        const { added, skipped } = unique.length ? onAdd(unique) : { added: 0, skipped: 0 }
        const parts = [
          added ? `已添加 ${added} 个礼包` : '',
          skipped ? `${skipped} 个已在列表中` : '',
          ...errors,
        ].filter(Boolean)
        if (parts.length) flash(parts.join('；'))
      }}
    >
      {children}
      {(over || empty) && (
        <p className={`progress-reward-drop-hint${over ? ' is-over' : ''}`}>
          {over ? '松开以添加 .kit' : '可从左侧礼包拖入 .kit，或点下方添加'}
        </p>
      )}
      {notice && (
        <p className="progress-reward-drop-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}

function NumberInput({ value, onChange, label, integer = false, min, allowUnset = false }: {
  value: number | undefined; onChange: (value: number | undefined) => void; label: string; integer?: boolean; min?: number; allowUnset?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const valid = (text: string) => text.trim() !== '' && Number.isFinite(Number(text)) && (!integer || Number.isInteger(Number(text))) && (min === undefined || Number(text) >= min)
  function commit() {
    if (draft === null) return
    if (error) return
    if (draft === '' && allowUnset) { onChange(undefined); setDraft(null); setError(false); return }
    if (!valid(draft)) { setError(true); return }
    onChange(Number(draft)); setDraft(null); setError(false)
  }
  return <span className="progress-number">
    <input type="number" step={integer ? 1 : 'any'} min={min} inputMode={integer ? 'numeric' : 'decimal'} aria-label={label} aria-invalid={error}
      value={draft ?? (value === undefined ? '' : String(value))} onChange={event => { setDraft(event.target.value); setError(event.target.validity.badInput) }}
      onBlur={commit} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commit() }
        if (event.key === 'Escape') { setDraft(null); setError(false) }
      }} />
    {error && <small role="alert">请输入{min !== undefined ? ` ≥ ${min} 的` : ''}{integer ? '整数' : '数值'}；尚未保存，Esc 撤销</small>}
  </span>
}

export function GoalPicker({ definitions, current, onChoose, onClose, locale }: {
  definitions: readonly GoalDefinition[]; current?: string; onChoose: (kind: string) => void; onClose: () => void; locale: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const dialog = ref.current!; dialog.showModal()
    dialog.querySelector<HTMLInputElement>('input')?.focus()
    return () => { dialog.close(); previous?.focus() }
  }, [])
  const choices = definitions.filter((item) => {
    const label = localizedGoalDefinitionLabel(item, locale)
    const description = pickGoalLocaleDescription(item.labels, locale) ?? ''
    return `${label} ${description} ${item.kind} ${item.sourceName}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  })
  return <dialog ref={ref} className="progress-picker" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}>
    <header><div><small>目标目录</small><h2 id={titleId}>{current ? '更换目标类型' : '添加一个目标'}</h2></div><button type="button" aria-label="关闭目标选择器" onClick={onClose}>×</button></header>
    <input className="progress-search" placeholder="搜索名称、类型或来源…" aria-label="搜索目标类型" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="progress-picker-list">
      {choices.map(item => {
        const label = localizedGoalDefinitionLabel(item, locale)
        const description = pickGoalLocaleDescription(item.labels, locale)
        return <button key={item.kind} type="button" className={selected === item.kind ? 'is-selected' : ''} aria-pressed={selected === item.kind}
          title={description || undefined}
          onClick={() => current ? setSelected(item.kind) : onChoose(item.kind)}>
          <span className="progress-type-mark">◇</span><span><strong>{label}</strong><small>{item.kind} · {item.fields.length} 个参数</small></span><span className="progress-picker-arrow">{current === item.kind ? '当前' : '＋'}</span>
        </button>
      })}
      {!choices.length && <p className="progress-empty">{definitions.length ? '没有匹配的目标类型。' : '目标目录为空，请先在「脚本 → 目标定义」中添加定义。'}</p>}
    </div>
    {current && <footer><p>更换类型会替换当前参数。切换回原类型可恢复本次编辑中的参数，也可以撤销。</p><button className="progress-primary" type="button" disabled={!selected || selected === current} onClick={() => onChoose(selected)}>替换类型与参数</button></footer>}
  </dialog>
}

export function ProgressEditor({ doc, goalCatalog, kitOptions = [], disabled, onChange, resolveText, setText, onFlush, onComposition, onOpenKit, locale = 'zh_cn' }: {
  doc: ProgressDocument; goalCatalog: GoalDefinitionCatalog; kitOptions?: KitOption[]; disabled?: boolean
  onChange: (source: string, discrete?: boolean) => void
  onFlush?: () => void
  onComposition?: (active: boolean) => void
  /** 当前语言下解析语义键；缺省时回退显示键名/明文 */
  resolveText?: (key: string) => string
  /** 写入当前语言译文（不改文档里的键） */
  setText?: (key: string, value: string) => void
  /** 打开工程内已找到的奖励礼包文档 */
  onOpenKit?: (documentKey: string) => void
  /** Goal 文件头 labels / localize 预览语言（与进度正文 locale 对齐） */
  locale?: string
}) {
  const definitions = goalCatalog.definitions
  const [goalView, setGoalView] = useState<'compact' | 'list'>(() => {
    try { return localStorage.getItem('hanshu.progress.goalView') === 'list' ? 'list' : 'compact' } catch { return 'compact' }
  })
  const goalsElement = useRef<HTMLDivElement>(null)
  const goalIds = doc.goals.map(goal => goal.id).join('|')
  // Keep the same keyed DOM tree in both views, including uncommitted NumberInput drafts.
  // One-pixel grid tracks let each card occupy its measured height without equal-height rows.
  useLayoutEffect(() => {
    const element = goalsElement.current
    if (!element || goalView !== 'compact') return
    let frame = 0
    const cards = [...element.querySelectorAll<HTMLElement>('.progress-goal, .progress-add-row')]
    const measure = () => {
      frame = 0
      const sizes = cards.map(card => Math.ceil(card.getBoundingClientRect().height) + 12)
      cards.forEach((card, index) => { const span = `span ${sizes[index]}`; if (card.style.gridRowEnd !== span) card.style.gridRowEnd = span })
    }
    const observer = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(measure) })
    cards.forEach(card => observer.observe(card))
    measure()
    return () => { observer.disconnect(); cancelAnimationFrame(frame); cards.forEach(card => card.style.removeProperty('grid-row-end')) }
  }, [goalView, goalIds])
  const [collapsed, setCollapsed] = useState(() => new Set<string>())
  const openGoal = (id: string) => setCollapsed(previous => { const next = new Set(previous); next.delete(id); return next })
  const toggleGoal = (id: string) => setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const [picker, setPicker] = useState<{ goalId?: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<number | null>(null)
  const pointerDrag = useRef<{ id: string; startY: number; active: boolean; index: number } | null>(null)
  const [notice, setNotice] = useState('')
  const typeDrafts = useRef(new Map<string, ProgressGoal['config']>())
  const readText = (key: string) => resolveText?.(key) ?? key
  const writeText = (key: string, value: string) => {
    if (disabled) return
    if (setText) setText(key, value)
    else if (key === 'name' || key === doc.name) onChange(stringifyProgress({ ...doc, name: value }), false)
    else if (key === 'description' || key === doc.description) onChange(stringifyProgress({ ...doc, description: value }), false)
  }
  const update = (patch: Partial<ProgressDocument>, immediate = true) => {
    if (!disabled) onChange(stringifyProgress({ ...doc, ...patch }), immediate)
  }
  const changeGoal = (goal: ProgressGoal, immediate = true) => update({ goals: doc.goals.map(item => item.id === goal.id ? goal : item) }, immediate)
  const issues = progressIssues(doc, definitions, resolveText ? (key) => resolveText(key) : null)
  const aliases = goalAliases(doc.goals)
  const count = doc.goals.length
  const pickerGoal = doc.goals.find(goal => goal.id === picker?.goalId)
  const availableKits = kitOptions.filter(item => !doc.rewardKits.includes(item.ref))
  function choose(kind: string) {
    if (!picker || disabled || !goalCatalog.byKind.has(kind)) return
    if (pickerGoal) {
      typeDrafts.current.set(`${pickerGoal.id}:${pickerGoal.kind}`, { ...pickerGoal.config })
      changeGoal({ ...pickerGoal, kind, config: typeDrafts.current.get(`${pickerGoal.id}:${kind}`) ?? {} })
      openGoal(pickerGoal.id)
    } else {
      const goal = createProgressGoal(kind, definitions)
      update({ goals: [...doc.goals, goal] }); openGoal(goal.id)
    }
    setPicker(null)
  }
  function move(goal: ProgressGoal, index: number) {
    if (disabled || goalView !== 'list') return
    onChange(stringifyProgress(moveProgressGoal(doc, goal.id, index)), true)
    setNotice('已调整目标顺序。')
  }
  const cancelDrag = () => { pointerDrag.current = null; setDragging(null); setDropKey(null) }
  const dragProps = (goal: ProgressGoal, index: number) => ({
    onPointerDown: (event: PointerEvent<HTMLSpanElement>) => {
      if (disabled || goalView !== 'list' || event.button !== 0) return
      event.preventDefault()
      pointerDrag.current = { id: goal.id, startY: event.clientY, active: false, index }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event: PointerEvent<HTMLSpanElement>) => {
      const drag = pointerDrag.current
      if (!drag || (!drag.active && Math.abs(event.clientY - drag.startY) < 5)) return
      drag.active = true
      setDragging(drag.id)
      const items = event.currentTarget.closest('.progress-goals')?.querySelectorAll('.progress-goal')
      if (!items) return
      const next = Array.from(items).findIndex(item => { const rect = item.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2 })
      drag.index = next < 0 ? doc.goals.length : next
      setDropKey(drag.index)
    },
    onPointerUp: (event: PointerEvent<HTMLSpanElement>) => {
      const drag = pointerDrag.current
      if (drag?.active) move(goal, drag.index)
      cancelDrag()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    onPointerCancel: cancelDrag,
    onLostPointerCapture: cancelDrag,
  })
  return <div className="progress-editor" onBlurCapture={event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) queueMicrotask(() => onFlush?.())
  }} onCompositionStartCapture={() => onComposition?.(true)} onCompositionEndCapture={() => queueMicrotask(() => onComposition?.(false))} onClick={event => {
    if (event.target instanceof Element && event.target.closest('button')) event.target.closest('.progress-menu')?.removeAttribute('open')
  }}>
    <div className="progress-form-scroll">
    <fieldset disabled={disabled} className="progress-page">
      <header className="progress-document-head">
        <section className="progress-info-card progress-main-info" aria-label="标题与描述">
        <label className="progress-document-field"><span className="progress-document-field-label">标题</span>
          <input className="progress-title" aria-label="进度标题" placeholder="为这项进度命名…" value={readText(doc.name)} onChange={event => writeText(doc.name, event.target.value)} />
        </label>
        <label className="progress-document-field"><span className="progress-document-field-label">描述 <span>向玩家展示</span></span>
          <textarea className="progress-description" aria-label="进度描述" rows={3} placeholder="填写这项进度的故事与要求…" value={readText(doc.description)} onChange={event => writeText(doc.description, event.target.value)} />
        </label>
        </section>
        <section className="progress-info-card progress-extra-info" aria-label="文档信息">
            <label className="progress-field"><span>文档 ID</span><input aria-label="文档 ID" className="progress-document-id" readOnly value={doc.id} /></label>
            <label className="progress-field"><span>标签</span><input aria-label="标签" placeholder="用逗号分隔" key={doc.tags.join(',')} defaultValue={doc.tags.join(', ')} onBlur={event => update({ tags: [...new Set(event.target.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))] })} /></label>
            <label className="progress-field"><span>作者备注 <small>不向玩家展示</small></span><textarea rows={2} value={doc.authorNotes} onChange={event => update({ authorNotes: event.target.value }, false)} /></label>
        </section>
      </header>

      <div className="progress-summary-grid">
        <section className="progress-card progress-reward-section" aria-label="完成奖励">
          <header className="progress-card-head"><h2>完成奖励</h2><span className="progress-card-count">{doc.rewardKits.length}</span></header>
          <KitRewardDropZone
            disabled={disabled}
            empty={!doc.rewardKits.length}
            onAdd={(refs) => {
              const next = [...doc.rewardKits]
              let added = 0
              let skipped = 0
              for (const ref of refs) {
                if (next.includes(ref)) {
                  skipped += 1
                  continue
                }
                next.push(ref)
                added += 1
              }
              if (added) update({ rewardKits: next })
              return { added, skipped }
            }}
          >
            <div className="progress-card-body">
              {doc.rewardKits.map((ref) => {
                const option = kitOptions.find((item) => item.ref === ref)
                return (
                  <div className="progress-reward-row" key={ref}>
                    <span>{option?.label || `${ref}（未找到）`}</span>
                    {option?.key && onOpenKit ? (
                      <a
                        className="progress-open"
                        href="#open-kit"
                        role="button"
                        aria-label={`打开礼包 ${ref}`}
                        title="打开礼包"
                        onClick={(event) => {
                          event.preventDefault()
                          onOpenKit(option.key!)
                        }}
                      >
                        ↗
                      </a>
                    ) : null}
                    <button type="button" className="progress-remove" aria-label={`移除礼包 ${ref}`} onClick={() => update({ rewardKits: doc.rewardKits.filter((item) => item !== ref) })}>×</button>
                  </div>
                )
              })}
              <select aria-label="添加奖励礼包" value="" disabled={!availableKits.length} onChange={event => { if (event.target.value) update({ rewardKits: [...doc.rewardKits, event.target.value] }) }}><option value="">{availableKits.length ? '＋ 添加礼包' : kitOptions.length ? '所有礼包已添加' : '暂无可用礼包'}</option>{availableKits.map(item => <option key={item.ref} value={item.ref}>{item.label}</option>)}</select>
            </div>
          </KitRewardDropZone>
        </section>
        <section className="progress-card" aria-label="周期"><header className="progress-card-head"><h2>周期</h2></header>
          <div className="progress-card-body progress-lifecycle"><label className="progress-field"><span>重复方式</span><select aria-label="重复方式" value={doc.repeat.kind} onChange={event => update({ repeat: { ...doc.repeat, kind: event.target.value as ProgressRepeatKind } })}>{Object.entries(PROGRESS_REPEAT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              {doc.repeat.kind === 'duration' && <label className="progress-field"><span>间隔（小时）</span><NumberInput label="重复间隔小时" min={0.01} value={doc.repeat.hours} onChange={hours => { if (hours !== undefined) update({ repeat: { ...doc.repeat, hours } }) }} /></label>}
              <div className="progress-lifecycle-switches">
                <label className="progress-abandon-switch"><span>可承接时自动开始</span><input type="checkbox" role="switch" aria-label="可承接时自动开始" checked={doc.autoStartWhenAcceptable} onChange={event => update({ autoStartWhenAcceptable: event.target.checked })} /></label>
                <label className="progress-abandon-switch"><span>可放弃</span><input type="checkbox" role="switch" aria-label="可放弃" checked={doc.abandonable} onChange={event => update({ abandonable: event.target.checked })} /></label>
              </div>
          </div>
        </section>
      </div>

      <section className="progress-card progress-objectives" aria-label="目标要求">
        <div className="progress-section-head progress-card-head"><div><h2>目标 <span>{count}</span></h2></div>
          <div className="progress-completion-switch" role="group" aria-label="目标完成规则">
            <button type="button" aria-pressed={doc.completion === 'all'} onClick={() => update({ completion: 'all' })}>完成全部</button>
            <button type="button" aria-pressed={doc.completion === 'any'} onClick={() => update({ completion: 'any' })}>完成任一</button>
            <button type="button" aria-pressed={doc.completion === 'custom'} onClick={() => update({ completion: 'custom', completionGraph: doc.completionGraph ?? createCompletionGraph() })}>自定义完成</button>
          </div>
        </div>
        <div className="progress-goal-viewbar">
          <div className="progress-view-switch" role="group" aria-label="目标视图">
            {([['compact', '紧凑'], ['list', '列表']] as const).map(([view, label]) => <button key={view} type="button" aria-pressed={goalView === view} onClick={() => {
              cancelDrag(); setGoalView(view)
              try { localStorage.setItem('hanshu.progress.goalView', view) } catch { /* View still changes when browser storage is unavailable. */ }
            }}>{label}</button>)}
          </div>
          <small>{goalView === 'compact' ? '自动紧凑排版 · 切到列表可拖拽排序' : '按列表顺序排列 · 拖动手柄排序'}</small>
        </div>
        <div ref={goalsElement} className={`progress-goals is-${goalView}`}>

            {doc.goals.map((goal, index) => {
              const definition = definitions.find(item => item.kind === goal.kind)
              const fields = definition?.fields ?? []
              const open = !collapsed.has(goal.id)
              const title = displayGoalLabel(goal, definitions, locale)
              const goalDescription = definition ? pickGoalLocaleDescription(definition.labels, locale) : undefined
              return <article key={goal.id} aria-label={`目标 ${title}`} className={`progress-goal${open ? ' is-expanded' : ''}${dragging === goal.id ? ' is-dragging' : ''}${dropKey === index ? ' is-drop' : ''}`}>
                <div className="progress-goal-row">
                  {goalView === 'list' && <span className="progress-drag" title="上下拖动排序；也可使用右侧菜单" aria-hidden="true" {...dragProps(goal, index)}>⠿</span>}
                  <button type="button" className="progress-goal-open" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}目标 ${title}`} title={goalDescription || undefined} onClick={() => toggleGoal(goal.id)}><span className="progress-goal-alias">{aliases.get(goal.id)}</span><span className="progress-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span><strong>{title}</strong><span className="progress-node-kind">GOAL</span></button>
                  <details className="progress-menu"><summary aria-label={`${title}操作`}>⋯</summary><div>
                    {goalView === 'list' && <><button type="button" disabled={index === 0} onClick={() => move(goal, index - 1)}>上移</button>
                    <button type="button" disabled={index === doc.goals.length - 1} onClick={() => move(goal, index + 2)}>下移</button></>}
                    <button type="button" onClick={() => { const copy = duplicateProgressGoal(goal); const goals = [...doc.goals]; goals.splice(index + 1, 0, copy); update({ goals }); openGoal(copy.id) }}>复制目标</button>
                    <button type="button" onClick={() => setPicker({ goalId: goal.id })}>更换类型</button>
                    <button type="button" className="progress-danger" onClick={() => { update({ goals: doc.goals.filter(item => item.id !== goal.id) }); setNotice('已删除目标，可用 Ctrl / ⌘ + Z 撤销。') }}>删除目标</button>
                  </div></details>
                </div>
                {open && <div className="progress-goal-body">
                  {!definition && <p className="progress-inline-warning">请在「脚本 → 目标定义」中恢复此类型的定义脚本，或更换类型。原参数已保留。</p>}
                  {definition && Object.keys(goal.config).some(key => !fields.some(field => field.key === key)) && <p className="progress-inline-warning">已保留脚本中不再声明的旧参数；可编辑字段仅来自定义脚本。</p>}
                  <div className="progress-parameters">{fields.map(field => <GoalParameterField key={`${goal.kind}:${field.key}`} field={field} value={goal.config[field.key]} disabled={disabled} locale={locale} onChange={(value, immediate) => {
                    const config = { ...goal.config }
                    if (value === undefined) delete config[field.key]
                    else Object.defineProperty(config, field.key, { value, writable: true, enumerable: true, configurable: true })
                    changeGoal({ ...goal, config }, !!immediate)
                  }} />)}</div>
                  {definition && !fields.length && <p className="progress-node-empty">此目标无需配置参数</p>}
                </div>}
                {!open && <p className="progress-node-summary">{goalConfigSummary(goal, definitions) || (definition ? (fields.length ? '填写目标参数' : '无需配置参数') : '未找到定义脚本')}</p>}
              </article>
            })}
            <div className={`progress-add-row${dropKey === doc.goals.length ? ' is-drop' : ''}`}>
              <button type="button" onClick={() => setPicker({})}>＋ 添加目标</button>{doc.goals.length === 0 && <span>先选择一种目标，再填写参数</span>}
            </div>
          </div>
        {doc.completionGraph && <ProgressCompletionEditor key={doc.id} graph={doc.completionGraph} goals={doc.goals} definitions={definitions} disabled={disabled} active={doc.completion === 'custom'} onChange={completionGraph => update({ completionGraph })} />}
      </section>

      {([['visibility', '可见性条件', true], ['acceptance', '可承接条件', false]] as const).map(([field, title, allowRepeat]) => <section key={field} className="progress-card progress-rules" aria-label={title}><header className="progress-card-head"><h2>{title}</h2><span className="progress-card-count">{doc[field].length}</span><small className="progress-card-note">{field === 'acceptance' ? '全部满足（含周期投影）' : '全部满足'}</small></header>
        <div className="progress-card-body">
          {field === 'acceptance' && <div className="progress-visibility-row is-projected" aria-label="重复周期投影"><span className="progress-condition-kind">重复周期</span><span className="progress-condition-state">已满足</span><span className="progress-condition-target">由周期策略投影，不写入条件</span></div>}
          {doc[field].map((rule, index) => <div className="progress-visibility-row" key={index}>
            <select aria-label={`${title} ${index + 1} 对象类型`} value={rule.kind} onChange={event => update({ [field]: doc[field].map((item, i) => i !== index ? item : createConditionRule(event.target.value as ProgressConditionRule['kind'])) })}><option value="task">任务</option><option value="dialogue">对话</option><option value="expr">求值</option>{allowRepeat && <option value="repeat">重复周期</option>}</select>
            <select aria-label={`${title} ${index + 1} 状态`} value={rule.state} onChange={event => update({ [field]: doc[field].map((item, i) => i !== index ? item : { ...rule, state: event.target.value } as ProgressConditionRule) })}>{Object.entries(conditionStatesFor(rule.kind)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            {rule.kind === 'repeat'
              ? <span className="progress-condition-target">本进度周期</span>
              : <input aria-label={`${title} ${index + 1} 对象`} placeholder={rule.kind === 'task' ? '任务对象' : rule.kind === 'dialogue' ? '对话对象' : '条件表达式'} value={rule.target} onChange={event => update({ [field]: doc[field].map((item, i) => i !== index ? item : { ...rule, target: event.target.value }) }, false)} />}
            <button type="button" className="progress-remove" aria-label={`删除${title} ${index + 1}`} onClick={() => update({ [field]: doc[field].filter((_, i) => i !== index) })}>×</button>
          </div>)}
          {!doc[field].length && field === 'visibility' && <p className="progress-card-empty">没有条件，直接满足。</p>}
          {!doc[field].length && field === 'acceptance' && <p className="progress-card-empty">除周期投影外没有条件。</p>}
          <button type="button" className="progress-card-add" aria-label={`添加${title}`} onClick={() => update({ [field]: [...doc[field], createConditionRule('task')] })}>＋ 添加条件</button>
        </div>
      </section>)}

      {(issues.length > 0 || goalCatalog.errors.length > 0) && <section className="progress-card progress-validation"><header className="progress-card-head"><h2>{issues.length + goalCatalog.errors.length} 项待完善</h2></header><ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}{goalCatalog.errors.map((issue, index) => <li key={`catalog-${index}`}>{issue.sourceName}：{issue.message}</li>)}</ul></section>}
      <p className="progress-notice" role="status">{notice || (goalView === 'list' ? '拖动手柄排序，更多操作在行末菜单' : '切换列表视图可调整目标顺序')}</p>
      {picker && <GoalPicker definitions={definitions} current={pickerGoal?.kind} locale={locale} onChoose={choose} onClose={() => setPicker(null)} />}
    </fieldset>
    </div>
  </div>
}
