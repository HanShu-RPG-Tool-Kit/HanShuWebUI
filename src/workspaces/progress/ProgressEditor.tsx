import { useId, useState, type ReactNode } from 'react'
import {
  PROGRESS_GROUP_LABELS,
  PROGRESS_REPEAT_LABELS,
  createProgressGoal,
  createProgressGroup,
  defaultConfigForKind,
  goalLabel,
  removeGoalAt,
  stringifyProgress,
  summarizeProgress,
  type ProgressCondition,
  type ProgressConfigField,
  type ProgressConfigValue,
  type ProgressDocument,
  type ProgressGoal,
  type ProgressGoalGroup,
  type ProgressGroupKind,
  type ProgressRepeatKind,
} from './progressDoc'
import type { GoalDefinition, GoalDefinitionCatalog } from './goalDefinitions'
import './ProgressEditor.css'
import './KitEditor.css'

const replaceAt = <T,>(list: T[], index: number, value: T) => list.map((item, i) => i === index ? value : item)
const removeAt = <T,>(list: T[], index: number) => list.filter((_, i) => i !== index)

function Panel({ title, subtitle, count, action, children }: {
  title: string
  subtitle?: string
  count?: number
  action?: ReactNode
  children: ReactNode
}) {
  return <section className="kit-panel">
    <header className="kit-panel-head">
      <h3>{title}</h3>
      {count !== undefined && <span className="kit-badge">{count}</span>}
      {subtitle && <span className="kit-panel-sub">{subtitle}</span>}
      <div className="kit-panel-actions">{action}</div>
    </header>
    {children}
  </section>
}

function TagField({ tags, disabled, onChange }: { tags: string[]; disabled?: boolean; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('')
  function add(raw: string) {
    const parts = raw.split(/[,，]/).map((item) => item.trim().normalize('NFC')).filter(Boolean)
    if (!parts.length) return
    const seen = new Set(tags.map((tag) => tag.toLocaleLowerCase()))
    const next = [...tags]
    for (const part of parts) {
      const key = part.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      next.push(part)
    }
    onChange(next)
    setDraft('')
  }
  return <div className="kit-tags-row">
    <span className="kit-tags-label" title="游戏标签，便于筛选与系统查询">标签</span>
    <div className={`kit-tag-picker${disabled ? ' is-disabled' : ''}`}>
      {tags.map((tag) => <span key={tag} className="kit-tag-chip">
        <span className="kit-tag-chip-label">{tag}</span>
        {!disabled && (
          <button type="button" className="kit-tag-chip-remove" aria-label={`移除 ${tag}`} onClick={() => onChange(tags.filter((item) => item !== tag))}>×</button>
        )}
      </span>)}
      {!disabled && <input
        className="kit-tag-input"
        value={draft}
        placeholder={tags.length ? '' : '如 daily、main'}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(draft) }
          if (event.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1))
        }}
        onBlur={() => { if (draft.trim()) add(draft) }}
      />}
    </div>
  </div>
}

function ConditionField({ label, hint, value, disabled, onChange }: {
  label: string
  hint: string
  value: ProgressCondition
  disabled?: boolean
  onChange: (value: ProgressCondition) => void
}) {
  const name = useId()
  return <div className="prog-cond">
    <div className="prog-cond-head">
      <strong>{label}</strong>
      <label className="prog-seg">
        <input type="radio" name={name} checked={value.mode === 'default'} disabled={disabled} onChange={() => onChange({ ...value, mode: 'default' })} />
        默认
      </label>
      <label className="prog-seg">
        <input type="radio" name={name} checked={value.mode === 'expr'} disabled={disabled} onChange={() => onChange({ ...value, mode: 'expr' })} />
        条件表达式
      </label>
    </div>
    <p className="prog-hint">{hint}</p>
    {value.mode === 'expr' && (
      <textarea
        className="prog-expr"
        spellCheck={false}
        disabled={disabled}
        rows={3}
        placeholder="例如 level >= 10 && flag.after_intro"
        value={value.expr}
        onChange={(event) => onChange({ ...value, expr: event.target.value })}
      />
    )}
  </div>
}

function ConfigFieldCard({ field, value, disabled, onChange }: {
  field: ProgressConfigField
  value: ProgressConfigValue | undefined
  disabled?: boolean
  onChange: (value: ProgressConfigValue) => void
}) {
  const current = value ?? field.default ?? (field.type === 'bool' ? false : field.type === 'string' ? '' : 0)
  return <label className={`prog-config-card${field.required ? ' is-required' : ''}`}>
    <span className="prog-config-label">
      {field.label || field.key}
      {field.required && <i>*</i>}
      {field.hint && <em>{field.hint}</em>}
    </span>
    {field.type === 'bool' ? (
      <input type="checkbox" disabled={disabled} checked={Boolean(current)} onChange={(event) => onChange(event.target.checked)} />
    ) : field.type === 'int' || field.type === 'float' ? (
      <input
        type="number"
        step={field.type === 'int' ? 1 : 'any'}
        disabled={disabled}
        value={typeof current === 'number' ? current : Number(current) || 0}
        onChange={(event) => {
          const next = field.type === 'int' ? Math.floor(Number(event.target.value) || 0) : Number(event.target.value)
          onChange(Number.isFinite(next) ? next : 0)
        }}
      />
    ) : (
      <input
        type="text"
        disabled={disabled}
        value={String(current ?? '')}
        placeholder={field.hint || field.key}
        onChange={(event) => onChange(event.target.value)}
      />
    )}
  </label>
}

function GoalCard({ index, goal, definitions, disabled, onChange, onRemove }: {
  index: number
  goal: ProgressGoal
  definitions: readonly GoalDefinition[]
  disabled?: boolean
  onChange: (goal: ProgressGoal) => void
  onRemove: () => void
}) {
  const schema = definitions.find((item) => item.kind === goal.kind)
  const known = Boolean(schema)
  const fields = schema?.fields ?? []
  const extraKeys = Object.keys(goal.config).filter((key) => !fields.some((field) => field.key === key))

  function setKind(kind: string) {
    onChange({ kind, config: defaultConfigForKind(kind, definitions) })
  }

  function setConfig(key: string, value: ProgressConfigValue) {
    onChange({ ...goal, config: { ...goal.config, [key]: value } })
  }

  return <article className="prog-goal-card">
    <header className="prog-goal-card-head">
      <span className="prog-goal-index" title="目标下标">#{index}</span>
      <select
        disabled={disabled || definitions.length === 0}
        value={known ? goal.kind : goal.kind || ''}
        aria-label={`目标 ${index} 种类`}
        onChange={(event) => setKind(event.target.value)}
      >
        {!known && <option value={goal.kind || ''}>{goal.kind ? `${goal.kind}（未在目标定义中找到）` : '请选择种类'}</option>}
        {definitions.map((item) => <option key={item.kind} value={item.kind}>{item.label} · {item.kind}</option>)}
      </select>
      <code className="prog-goal-kind">{goal.kind || '—'}</code>
      <button type="button" className="prog-icon-btn" disabled={disabled} aria-label={`移除目标 ${index}`} onClick={onRemove}>×</button>
    </header>
    {fields.length > 0 ? (
      <div className="prog-config-grid">
        {fields.map((field) => (
          <ConfigFieldCard
            key={field.key}
            field={field}
            value={goal.config[field.key]}
            disabled={disabled}
            onChange={(value) => setConfig(field.key, value)}
          />
        ))}
      </div>
    ) : known ? (
      <p className="prog-hint">此种类无需 config。</p>
    ) : (
      <p className="prog-hint">种类不在「脚本 → 目标定义」中；请先添加带 @goal 的 py，或改选已有种类。</p>
    )}
    {extraKeys.length > 0 && (
      <div className="prog-config-grid">
        {extraKeys.map((key) => (
          <ConfigFieldCard
            key={key}
            field={{ key, type: typeof goal.config[key] === 'boolean' ? 'bool' : typeof goal.config[key] === 'number' ? 'float' : 'string', required: false, label: key }}
            value={goal.config[key]}
            disabled={disabled}
            onChange={(value) => setConfig(key, value)}
          />
        ))}
      </div>
    )}
  </article>
}

function GroupCard({ group, goals, definitions, disabled, onChange, onRemove }: {
  group: ProgressGoalGroup
  goals: ProgressGoal[]
  definitions: readonly GoalDefinition[]
  disabled?: boolean
  onChange: (group: ProgressGoalGroup) => void
  onRemove: () => void
}) {
  function toggleGoal(index: number) {
    const has = group.goals.includes(index)
    onChange({
      ...group,
      goals: has ? group.goals.filter((item) => item !== index) : [...group.goals, index].sort((a, b) => a - b),
    })
  }
  return <div className="prog-group">
    <div className="prog-group-head">
      <input disabled={disabled} value={group.title} placeholder="组名称" onChange={(event) => onChange({ ...group, title: event.target.value })} />
      <select disabled={disabled} value={group.kind} onChange={(event) => onChange({ ...group, kind: event.target.value as ProgressGroupKind })}>
        {(Object.keys(PROGRESS_GROUP_LABELS) as ProgressGroupKind[]).map((kind) => (
          <option key={kind} value={kind}>{PROGRESS_GROUP_LABELS[kind]}</option>
        ))}
      </select>
      {group.kind === 'choose_n' && (
        <label className="prog-inline">
          n
          <input type="number" min={1} disabled={disabled} value={group.count} onChange={(event) => onChange({ ...group, count: Math.max(1, Math.floor(Number(event.target.value) || 1)) })} />
        </label>
      )}
      <button type="button" className="prog-icon-btn" disabled={disabled} aria-label="移除组" onClick={onRemove}>×</button>
    </div>
    <div className="prog-group-goals">
      {goals.length === 0 && <span className="prog-hint">先在上方添加目标</span>}
      {goals.map((goal, index) => (
        <label key={index} className="prog-check">
          <input type="checkbox" disabled={disabled} checked={group.goals.includes(index)} onChange={() => toggleGoal(index)} />
          <span>{goalLabel(goal, index, definitions)}</span>
        </label>
      ))}
    </div>
  </div>
}

export function ProgressEditor({ doc, error, goalCatalog, disabled, onChange }: {
  doc: ProgressDocument
  error?: string
  goalCatalog: GoalDefinitionCatalog
  disabled?: boolean
  onChange: (source: string) => void
}) {
  const definitions = goalCatalog.definitions
  const update = (patch: Partial<ProgressDocument>) => onChange(stringifyProgress({ ...doc, ...patch }))
  const summary = summarizeProgress(doc, definitions)

  return <div className="kit-editor prog-editor">
    <div className="kit-page">
      {error && <p className="kit-banner" role="alert">无法完整解析进度草稿，已显示可编辑兜底。{error}</p>}
      {goalCatalog.errors.length > 0 && (
        <p className="kit-banner" role="status">
          目标定义解析有提示：{goalCatalog.errors.map((item) => `${item.sourceName}：${item.message}`).join('；')}
        </p>
      )}
      {definitions.length === 0 && (
        <p className="kit-banner" role="status">
          还没有可用的 goal 种类。请在「脚本 → 目标定义」中添加带 @goal / @config 的 py。
        </p>
      )}

      <header className="kit-header">
        <input
          className="kit-title"
          disabled={disabled}
          value={doc.name}
          placeholder="委托名称"
          aria-label="委托名称"
          onChange={(event) => update({ name: event.target.value })}
        />
      </header>

      <TagField tags={doc.tags} disabled={disabled} onChange={(tags) => update({ tags })} />

      <textarea
        className="prog-desc"
        disabled={disabled}
        rows={2}
        placeholder="简介（给玩家或作者看）"
        value={doc.description}
        onChange={(event) => update({ description: event.target.value })}
      />

      <Panel
        title="目标"
        subtitle="种类唯一来源：脚本 → 目标定义"
        count={doc.goals.length}
        action={!disabled && <button type="button" disabled={definitions.length === 0} onClick={() => update({ goals: [...doc.goals, createProgressGoal(definitions[0]?.kind ?? '', definitions)] })}>添加目标</button>}
      >
        {doc.goals.length === 0 && <p className="prog-hint">还没有目标。</p>}
        <div className="prog-goal-list">
          {doc.goals.map((goal, index) => (
            <GoalCard
              key={index}
              index={index}
              goal={goal}
              definitions={definitions}
              disabled={disabled}
              onChange={(next) => update({ goals: replaceAt(doc.goals, index, next) })}
              onRemove={() => onChange(stringifyProgress(removeGoalAt(doc, index)))}
            />
          ))}
        </div>
      </Panel>

      <Panel
        title="目标组"
        subtitle="必修 / 选必修 / 多完成方式 / 选修"
        count={doc.groups.length}
        action={!disabled && <button type="button" onClick={() => update({ groups: [...doc.groups, createProgressGroup(`组 ${doc.groups.length + 1}`)] })}>添加组</button>}
      >
        <div className="prog-group-list">
          {doc.groups.map((group, index) => (
            <GroupCard
              key={group.id}
              group={group}
              goals={doc.goals}
              definitions={definitions}
              disabled={disabled}
              onChange={(next) => update({ groups: replaceAt(doc.groups, index, next) })}
              onRemove={() => update({ groups: removeAt(doc.groups, index) })}
            />
          ))}
        </div>
      </Panel>

      <Panel title="条件" subtitle="留空默认；特例写 Aviator 表达式">
        <ConditionField
          label="可接取"
          hint="默认：冷却结束等引擎约定门槛。"
          value={doc.accept}
          disabled={disabled}
          onChange={(accept) => update({ accept })}
        />
        <ConditionField
          label="可交付"
          hint="默认：非选修目标组均已满足。"
          value={doc.deliver}
          disabled={disabled}
          onChange={(deliver) => update({ deliver })}
        />
        <ConditionField
          label="失败"
          hint="默认：无自动失败。填写表达式则满足时失败。"
          value={doc.fail}
          disabled={disabled}
          onChange={(fail) => update({ fail })}
        />
        <label className="prog-check prog-abandon">
          <input type="checkbox" disabled={disabled} checked={doc.abandonable} onChange={(event) => update({ abandonable: event.target.checked })} />
          允许玩家放弃
        </label>
      </Panel>

      <Panel title="重复与冷却">
        <div className="prog-repeat">
          <select
            disabled={disabled}
            value={doc.repeat.kind}
            onChange={(event) => update({ repeat: { ...doc.repeat, kind: event.target.value as ProgressRepeatKind } })}
          >
            {(Object.keys(PROGRESS_REPEAT_LABELS) as ProgressRepeatKind[]).map((kind) => (
              <option key={kind} value={kind}>{PROGRESS_REPEAT_LABELS[kind]}</option>
            ))}
          </select>
          {doc.repeat.kind === 'duration' && (
            <label className="prog-inline">
              间隔（小时）
              <input
                type="number"
                min={1}
                disabled={disabled}
                value={doc.repeat.hours}
                onChange={(event) => update({ repeat: { ...doc.repeat, hours: Math.max(1, Number(event.target.value) || 1) } })}
              />
            </label>
          )}
        </div>
      </Panel>

      <Panel title="奖励" subtitle="引用礼包，不在此内联掉落">
        <label className="prog-inline prog-reward">
          礼包引用
          <input
            disabled={disabled}
            value={doc.rewardKit}
            placeholder="文件名去掉 .kit，如 daily_guard"
            onChange={(event) => update({ rewardKit: event.target.value })}
          />
        </label>
      </Panel>

      <Panel title="摘要" subtitle="只读，对照当前配置">
        <ul className="prog-summary">
          {summary.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </Panel>
    </div>
  </div>
}
