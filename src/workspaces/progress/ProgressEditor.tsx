import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import {
  createProgressGoal, duplicateProgressGoal, goalConfigSummary,
  goalLabel, moveProgressGoal, progressIssues, PROGRESS_REPEAT_LABELS, stringifyProgress,
  TASK_VISIBILITY_STATES, DIALOGUE_VISIBILITY_STATES,
  type ProgressConditionRule, type ProgressConfigValue, type ProgressDocument, type ProgressGoal,
  type ProgressRepeatKind,
} from './progressDoc'
import type { GoalConfigField, GoalDefinition, GoalDefinitionCatalog } from './goalDefinitions'
import './ProgressEditor.css'

type KitOption = { ref: string; label: string }

function NumberInput({ value, onChange, label, integer = false, min, allowUnset = false }: {
  value: number | undefined; onChange: (value: number | undefined) => void; label: string; integer?: boolean; min?: number; allowUnset?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => { setDraft(null); setError(false) }, [value])
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

function Parameter({ field, value, onChange }: {
  field: GoalConfigField; value: ProgressConfigValue | undefined; onChange: (value: ProgressConfigValue | undefined) => void
}) {
  const name = field.label || field.key
  const current = value ?? field.default
  const options = field.type === 'string' && field.hint?.startsWith('enum:') ? field.hint.slice(5).split('|').filter(Boolean) : null
  const inherited = value === undefined
  return <div className={`progress-parameter${inherited ? ' is-default' : ' is-explicit'}`}>
    <span className="progress-parameter-name">{name}{field.required && <sup>*</sup>}</span>
    <div className="progress-parameter-control">
      <div className="progress-parameter-input">
        {field.type === 'bool' ? <label className="progress-bool"><input type="checkbox" role="switch" aria-label={name} checked={Boolean(current)} onChange={event => onChange(event.target.checked)} /><span>{current ? '开启' : '关闭'}</span></label>
          : field.type === 'int' || field.type === 'float'
            ? <NumberInput label={name} value={typeof current === 'number' ? current : undefined} integer={field.type === 'int'} allowUnset onChange={onChange} />
            : options ? <select aria-label={name} value={String(current ?? '')} onChange={event => onChange(event.target.value)}><option value="" disabled>请选择</option>{current !== undefined && !options.includes(String(current)) && current !== '' && <option value={String(current)}>{String(current)}（无效）</option>}{options.map(option => <option key={option} value={option}>{option}</option>)}</select>
              : <input aria-label={name} value={String(current ?? '')} placeholder="请输入" onChange={event => onChange(event.target.value)} />}
      </div>
      <span className="progress-value-origin">{inherited ? (field.default === undefined ? '未填写' : '默认') : '已填写'}</span>
      <button type="button" className="progress-reset-value" disabled={inherited} aria-label={`${name}：${field.default === undefined ? '清除填写' : '恢复默认值'}`} title={field.default === undefined ? '清除填写' : `恢复默认值：${String(field.default)}`} onClick={() => onChange(undefined)}>↶</button>
    </div>
  </div>
}

function GoalPicker({ definitions, current, onChoose, onClose }: {
  definitions: readonly GoalDefinition[]; current?: string; onChoose: (kind: string) => void; onClose: () => void
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
  const choices = definitions.filter(item => `${item.label} ${item.kind} ${item.sourceName}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <dialog ref={ref} className="progress-picker" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}>
    <header><div><small>目标目录</small><h2 id={titleId}>{current ? '更换目标类型' : '添加一个目标'}</h2></div><button type="button" aria-label="关闭目标选择器" onClick={onClose}>×</button></header>
    <input className="progress-search" placeholder="搜索名称、类型或来源…" aria-label="搜索目标类型" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="progress-picker-list">
      {choices.map(item => <button key={item.kind} type="button" className={selected === item.kind ? 'is-selected' : ''} aria-pressed={selected === item.kind}
        onClick={() => current ? setSelected(item.kind) : onChoose(item.kind)}>
        <span className="progress-type-mark">◇</span><span><strong>{item.label}</strong><small>{item.fields.length} 个参数</small></span><span className="progress-picker-arrow">{current === item.kind ? '当前' : '＋'}</span>
      </button>)}
      {!choices.length && <p className="progress-empty">{definitions.length ? '没有匹配的目标类型。' : '目标目录为空，请先在「脚本 → 目标定义」中添加定义。'}</p>}
    </div>
    {current && <footer><p>更换类型会替换当前参数。切换回原类型可恢复本次编辑中的参数，也可以撤销。</p><button className="progress-primary" type="button" disabled={!selected || selected === current} onClick={() => onChoose(selected)}>替换类型与参数</button></footer>}
  </dialog>
}

export function ProgressEditor({ doc, goalCatalog, kitOptions = [], disabled, onChange }: {
  doc: ProgressDocument; goalCatalog: GoalDefinitionCatalog; kitOptions?: KitOption[]; disabled?: boolean; onChange: (source: string, discrete?: boolean) => void
}) {
  const definitions = goalCatalog.definitions
  const [collapsed, setCollapsed] = useState(() => new Set<string>())
  const openGoal = (id: string) => setCollapsed(previous => { const next = new Set(previous); next.delete(id); return next })
  const toggleGoal = (id: string) => setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const [picker, setPicker] = useState<{ goalId?: string } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<number | null>(null)
  const pointerDrag = useRef<{ id: string; startY: number; active: boolean; index: number } | null>(null)
  const [notice, setNotice] = useState('')
  const typeDrafts = useRef(new Map<string, ProgressGoal['config']>())
  const update = (patch: Partial<ProgressDocument>) => {
    const identity = (goals: ProgressGoal[]) => goals.map(goal => [goal.id, goal.kind])
    const discrete = patch.completion !== undefined || (!!patch.goals && JSON.stringify(identity(patch.goals)) !== JSON.stringify(identity(doc.goals)))
    if (!disabled) onChange(stringifyProgress({ ...doc, ...patch }), discrete)
  }
  const changeGoal = (goal: ProgressGoal) => update({ goals: doc.goals.map(item => item.id === goal.id ? goal : item) })
  const issues = progressIssues(doc, definitions)
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
    if (disabled) return
    onChange(stringifyProgress(moveProgressGoal(doc, goal.id, index)), true)
    setNotice('已调整目标顺序。')
  }
  const cancelDrag = () => { pointerDrag.current = null; setDragging(null); setDropKey(null) }
  const dragProps = (goal: ProgressGoal, index: number) => ({
    onPointerDown: (event: PointerEvent<HTMLSpanElement>) => {
      if (disabled || event.button !== 0) return
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
  return <div className="progress-editor" onClick={event => {
    if (event.target instanceof Element && event.target.closest('button')) event.target.closest('.progress-menu')?.removeAttribute('open')
  }}>
    <fieldset disabled={disabled} className="progress-page">
      <header className="progress-document-head">
        <section className="progress-info-card progress-main-info" aria-label="标题与描述">
        <label className="progress-document-field"><span className="progress-document-field-label">标题</span>
          <input className="progress-title" aria-label="进度标题" placeholder="为这项进度命名…" value={doc.name} onChange={event => update({ name: event.target.value })} />
        </label>
        <label className="progress-document-field"><span className="progress-document-field-label">描述 <span>向玩家展示</span></span>
          <textarea className="progress-description" aria-label="进度描述" rows={3} placeholder="填写这项进度的故事与要求…" value={doc.description} onChange={event => update({ description: event.target.value })} />
        </label>
        </section>
        <section className="progress-info-card progress-extra-info" aria-label="文档信息">
            <label className="progress-field"><span>文档 ID</span><input aria-label="文档 ID" className="progress-document-id" readOnly value={doc.id} /></label>
            <label className="progress-field"><span>标签</span><input aria-label="标签" placeholder="用逗号分隔" key={doc.tags.join(',')} defaultValue={doc.tags.join(', ')} onBlur={event => update({ tags: [...new Set(event.target.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))] })} /></label>
            <label className="progress-field"><span>作者备注 <small>不向玩家展示</small></span><textarea rows={2} value={doc.authorNotes} onChange={event => update({ authorNotes: event.target.value })} /></label>
        </section>
      </header>

      <div className="progress-summary-grid">
        <section className="progress-card progress-reward-section" aria-label="完成奖励">
          <header className="progress-card-head"><h2>完成奖励</h2><span className="progress-card-count">{doc.rewardKits.length}</span></header>
          <div className="progress-card-body">
            {doc.rewardKits.map(ref => <div className="progress-reward-row" key={ref}><span>{kitOptions.find(item => item.ref === ref)?.label || `${ref}（未找到）`}</span><button type="button" className="progress-remove" aria-label={`移除礼包 ${ref}`} onClick={() => update({ rewardKits: doc.rewardKits.filter(item => item !== ref) })}>×</button></div>)}
            <select aria-label="添加奖励礼包" value="" disabled={!availableKits.length} onChange={event => { if (event.target.value) update({ rewardKits: [...doc.rewardKits, event.target.value] }) }}><option value="">{availableKits.length ? '＋ 添加礼包' : kitOptions.length ? '所有礼包已添加' : '暂无可用礼包'}</option>{availableKits.map(item => <option key={item.ref} value={item.ref}>{item.label}</option>)}</select>
          </div>
        </section>
        <section className="progress-card" aria-label="周期"><header className="progress-card-head"><h2>周期</h2></header>
          <div className="progress-card-body progress-lifecycle"><label className="progress-field"><span>重复方式</span><select aria-label="重复方式" value={doc.repeat.kind} onChange={event => update({ repeat: { ...doc.repeat, kind: event.target.value as ProgressRepeatKind } })}>{Object.entries(PROGRESS_REPEAT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              {doc.repeat.kind === 'duration' && <label className="progress-field"><span>间隔（小时）</span><NumberInput label="重复间隔小时" min={0.01} value={doc.repeat.hours} onChange={hours => { if (hours !== undefined) update({ repeat: { ...doc.repeat, hours } }) }} /></label>}
              <label className="progress-abandon-switch"><span>可放弃</span><input type="checkbox" role="switch" aria-label="可放弃" checked={doc.abandonable} onChange={event => update({ abandonable: event.target.checked })} /></label>
          </div>
        </section>
      </div>

      <section className="progress-card progress-objectives" aria-label="目标要求">
        <div className="progress-section-head progress-card-head"><div><h2>目标 <span>{count}</span></h2></div>
          <div className="progress-completion-switch" role="group" aria-label="目标完成规则">
            <button type="button" aria-pressed={doc.completion === 'all'} onClick={() => update({ completion: 'all' })}>完成全部</button>
            <button type="button" aria-pressed={doc.completion === 'any'} onClick={() => update({ completion: 'any' })}>完成任一</button>
          </div>
        </div>
        <div className="progress-goals">
            {doc.goals.map((goal, index) => {
              const definition = definitions.find(item => item.kind === goal.kind)
              const fields = definition?.fields ?? []
              const open = !collapsed.has(goal.id)
              return <article key={goal.id} aria-label={`目标 ${goalLabel(goal, definitions)}`} className={`progress-goal${open ? ' is-expanded' : ''}${dragging === goal.id ? ' is-dragging' : ''}${dropKey === index ? ' is-drop' : ''}`}>
                <div className="progress-goal-row">
                  <span className="progress-drag" title="上下拖动排序；也可使用右侧菜单" aria-hidden="true" {...dragProps(goal, index)}>⠿</span>
                  <button type="button" className="progress-goal-open" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}目标 ${goalLabel(goal, definitions)}`} onClick={() => toggleGoal(goal.id)}><span className="progress-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span><strong>{goalLabel(goal, definitions)}</strong><span className="progress-node-kind">GOAL</span></button>
                  <details className="progress-menu"><summary aria-label={`${goalLabel(goal, definitions)}操作`}>⋯</summary><div>
                    <button type="button" disabled={index === 0} onClick={() => move(goal, index - 1)}>上移</button>
                    <button type="button" disabled={index === doc.goals.length - 1} onClick={() => move(goal, index + 2)}>下移</button>
                    <button type="button" onClick={() => { const copy = duplicateProgressGoal(goal); const goals = [...doc.goals]; goals.splice(index + 1, 0, copy); update({ goals }); openGoal(copy.id) }}>复制目标</button>
                    <button type="button" onClick={() => setPicker({ goalId: goal.id })}>更换类型</button>
                    <button type="button" className="progress-danger" onClick={() => { update({ goals: doc.goals.filter(item => item.id !== goal.id) }); setNotice('已删除目标，可用 Ctrl / ⌘ + Z 撤销。') }}>删除目标</button>
                  </div></details>
                </div>
                {open && <div className="progress-goal-body">
                  {!definition && <p className="progress-inline-warning">请在「脚本 → 目标定义」中恢复此类型的定义脚本，或更换类型。原参数已保留。</p>}
                  {definition && Object.keys(goal.config).some(key => !fields.some(field => field.key === key)) && <p className="progress-inline-warning">已保留脚本中不再声明的旧参数；可编辑字段仅来自定义脚本。</p>}
                  <div className="progress-parameters">{fields.map(field => <Parameter key={`${goal.kind}:${field.key}`} field={field} value={goal.config[field.key]} onChange={value => {
                    const config = { ...goal.config }
                    if (value === undefined) delete config[field.key]
                    else config[field.key] = value
                    changeGoal({ ...goal, config })
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
      </section>

      {([['visibility', '可见性条件'], ['acceptance', '可承接条件']] as const).map(([field, title]) => <section key={field} className="progress-card progress-rules" aria-label={title}><header className="progress-card-head"><h2>{title}</h2><span className="progress-card-count">{doc[field].length}</span><small className="progress-card-note">全部满足</small></header>
        <div className="progress-card-body">
          {doc[field].map((rule, index) => <div className="progress-visibility-row" key={index}>
            <select aria-label={`${title} ${index + 1} 对象类型`} value={rule.kind} onChange={event => update({ [field]: doc[field].map((item, i) => i !== index ? item : event.target.value === 'task' ? { kind: 'task', state: 'succeeded', target: '' } : { kind: 'dialogue', state: 'after', target: '' }) })}><option value="task">任务</option><option value="dialogue">对话</option></select>
            <select aria-label={`${title} ${index + 1} 状态`} value={rule.state} onChange={event => update({ [field]: doc[field].map((item, i) => i !== index ? item : { ...rule, state: event.target.value } as ProgressConditionRule) })}>{Object.entries(rule.kind === 'task' ? TASK_VISIBILITY_STATES : DIALOGUE_VISIBILITY_STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <input aria-label={`${title} ${index + 1} 对象`} placeholder={rule.kind === 'task' ? '任务对象' : '对话对象'} value={rule.target} onChange={event => update({ [field]: doc[field].map((item, i) => i !== index ? item : { ...rule, target: event.target.value }) })} />
            <button type="button" className="progress-remove" aria-label={`删除${title} ${index + 1}`} onClick={() => update({ [field]: doc[field].filter((_, i) => i !== index) })}>×</button>
          </div>)}
          {!doc[field].length && <p className="progress-card-empty">没有条件，直接满足。</p>}
          <button type="button" className="progress-card-add" aria-label={`添加${title}`} onClick={() => update({ [field]: [...doc[field], { kind: 'task', state: 'succeeded', target: '' }] })}>＋ 添加条件</button>
        </div>
      </section>)}

      {(issues.length > 0 || goalCatalog.errors.length > 0) && <section className="progress-card progress-validation"><header className="progress-card-head"><h2>{issues.length + goalCatalog.errors.length} 项待完善</h2></header><ul>{issues.map((issue, index) => <li key={index}>{issue}</li>)}{goalCatalog.errors.map((issue, index) => <li key={`catalog-${index}`}>{issue.sourceName}：{issue.message}</li>)}</ul></section>}
      <p className="progress-notice" role="status">{notice || '拖动手柄排序，更多操作在行末菜单'}</p>
      {picker && <GoalPicker definitions={definitions} current={pickerGoal?.kind} onChoose={choose} onClose={() => setPicker(null)} />}
    </fieldset>
  </div>
}
