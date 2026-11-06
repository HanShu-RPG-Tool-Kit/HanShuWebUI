import {
  CONDITION_KIND_LABELS,
  CMP_OPS,
  QUEST_OPS,
  createConditionRule,
  type ConditionKind,
  type ProgressConditionRule,
} from './conditions'

type Props = {
  title: string
  rules: ProgressConditionRule[]
  disabled?: boolean
  emptyHint?: string
  onChange: (rules: ProgressConditionRule[]) => void
}

function replaceAt(rules: ProgressConditionRule[], index: number, rule: ProgressConditionRule) {
  return rules.map((item, i) => (i === index ? rule : item))
}

export function ConditionRulesEditor({ title, rules, disabled, emptyHint, onChange }: Props) {
  return (
    <div className="progress-card-body">
      {rules.map((rule, index) => (
        <div className="progress-visibility-row" key={index}>
          <select
            aria-label={`${title} ${index + 1} 类型`}
            disabled={disabled}
            value={rule.kind}
            onChange={event => onChange(replaceAt(rules, index, createConditionRule(event.target.value as ConditionKind)))}
          >
            {Object.entries(CONDITION_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          {(rule.kind === 'quest' || rule.kind === 'progress') && (
            <select
              aria-label={`${title} ${index + 1} 状态`}
              disabled={disabled}
              value={rule.op}
              onChange={event => onChange(replaceAt(rules, index, { ...rule, op: event.target.value as typeof rule.op }))}
            >
              {Object.entries(QUEST_OPS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          )}
          {(rule.kind === 'level' || rule.kind === 'reputation') && (
            <select
              aria-label={`${title} ${index + 1} 比较`}
              disabled={disabled}
              value={rule.cmp}
              onChange={event => onChange(replaceAt(rules, index, { ...rule, cmp: event.target.value as typeof rule.cmp }))}
            >
              {Object.keys(CMP_OPS).map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          )}
          {rule.kind === 'expr' && (
            <input
              aria-label={`${title} ${index + 1} 表达式`}
              disabled={disabled}
              placeholder="布尔表达式"
              value={rule.source}
              onChange={event => onChange(replaceAt(rules, index, { ...rule, source: event.target.value }))}
            />
          )}
          {rule.kind === 'quest' && (
            <input
              aria-label={`${title} ${index + 1} 任务 ID`}
              disabled={disabled}
              placeholder="任务 ID"
              value={rule.questId}
              onChange={event => onChange(replaceAt(rules, index, { ...rule, questId: event.target.value }))}
            />
          )}
          {rule.kind === 'progress' && (
            <>
              <input
                aria-label={`${title} ${index + 1} 任务 ID`}
                disabled={disabled}
                placeholder="任务 ID"
                value={rule.questId}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, questId: event.target.value }))}
              />
              <input
                aria-label={`${title} ${index + 1} 进度 ID`}
                disabled={disabled}
                placeholder="进度 identifier"
                value={rule.progressId}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, progressId: event.target.value }))}
              />
            </>
          )}
          {(rule.kind === 'talk_read' || rule.kind === 'talk_unread') && (
            <input
              aria-label={`${title} ${index + 1} 注入点`}
              disabled={disabled}
              placeholder="对话注入点"
              value={rule.injectId}
              onChange={event => onChange(replaceAt(rules, index, { ...rule, injectId: event.target.value }))}
            />
          )}
          {rule.kind === 'level' && (
            <input
              type="number"
              aria-label={`${title} ${index + 1} 等级`}
              disabled={disabled}
              value={rule.n}
              onChange={event => onChange(replaceAt(rules, index, { ...rule, n: Number(event.target.value) }))}
            />
          )}
          {rule.kind === 'reputation' && (
            <>
              <input
                aria-label={`${title} ${index + 1} 阵营`}
                disabled={disabled}
                placeholder="阵营 ID"
                value={rule.factionId}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, factionId: event.target.value }))}
              />
              <input
                type="number"
                aria-label={`${title} ${index + 1} 点数`}
                disabled={disabled}
                value={rule.n}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, n: Number(event.target.value) }))}
              />
            </>
          )}
          {(rule.kind === 'day' || rule.kind === 'night') && (
            <span className="progress-condition-target">{rule.kind === 'day' ? '当前维为白天' : '当前维为黑夜'}</span>
          )}
          <button
            type="button"
            className="progress-remove"
            disabled={disabled}
            aria-label={`删除${title} ${index + 1}`}
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
          >×</button>
        </div>
      ))}
      {!rules.length && emptyHint && <p className="progress-card-empty">{emptyHint}</p>}
      <button
        type="button"
        className="progress-card-add"
        disabled={disabled}
        aria-label={`添加${title}`}
        onClick={() => onChange([...rules, createConditionRule('quest')])}
      >＋ 添加条件</button>
    </div>
  )
}
