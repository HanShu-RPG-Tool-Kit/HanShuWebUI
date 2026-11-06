import {
  CONDITION_KIND_LABELS,
  CMP_OPS,
  QUEST_OPS,
  TALK_OPS,
  TIME_OPS,
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
    <div className="progress-card-body condition-rules">
      {rules.map((rule, index) => (
        <div className="progress-visibility-row" data-kind={rule.kind} key={index}>
          <select
            className="condition-field-kind"
            aria-label={`${title} ${index + 1} 类型`}
            disabled={disabled}
            value={rule.kind}
            onChange={event => onChange(replaceAt(rules, index, createConditionRule(event.target.value as ConditionKind)))}
          >
            {Object.entries(CONDITION_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>

          <div className="condition-params">
            {(rule.kind === 'quest' || rule.kind === 'progress') && (
              <select
                className="condition-field-op"
                aria-label={`${title} ${index + 1} 状态`}
                disabled={disabled}
                value={rule.op}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, op: event.target.value as typeof rule.op }))}
              >
                {Object.entries(QUEST_OPS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            )}
            {rule.kind === 'talk' && (
              <select
                className="condition-field-op is-compact"
                aria-label={`${title} ${index + 1} 读态`}
                disabled={disabled}
                value={rule.op}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, op: event.target.value as typeof rule.op }))}
              >
                {Object.entries(TALK_OPS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            )}
            {(rule.kind === 'level' || rule.kind === 'reputation') && (
              <select
                className="condition-field-op is-compact"
                aria-label={`${title} ${index + 1} 比较`}
                disabled={disabled}
                value={rule.cmp}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, cmp: event.target.value as typeof rule.cmp }))}
              >
                {Object.entries(CMP_OPS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            )}
            {rule.kind === 'time' && (
              <>
                <span className="condition-field-glue">处于</span>
                <select
                  className="condition-field-op is-compact"
                  aria-label={`${title} ${index + 1} 昼夜`}
                  disabled={disabled}
                  value={rule.op}
                  onChange={event => onChange(replaceAt(rules, index, { ...rule, op: event.target.value as typeof rule.op }))}
                >
                  {Object.entries(TIME_OPS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </>
            )}
            {rule.kind === 'expr' && (
              <input
                className="condition-field-expr"
                aria-label={`${title} ${index + 1} 表达式`}
                disabled={disabled}
                placeholder="满足 exp"
                spellCheck={false}
                value={rule.source}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, source: event.target.value }))}
              />
            )}
            {rule.kind === 'quest' && (
              <input
                className="condition-field-id"
                aria-label={`${title} ${index + 1} 任务标识符`}
                disabled={disabled}
                placeholder="任务标识符"
                spellCheck={false}
                value={rule.questId}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, questId: event.target.value }))}
              />
            )}
            {rule.kind === 'progress' && (
              <>
                <input
                  className="condition-field-id"
                  aria-label={`${title} ${index + 1} 任务标识符`}
                  disabled={disabled}
                  placeholder="任务标识符"
                  spellCheck={false}
                  value={rule.questId}
                  onChange={event => onChange(replaceAt(rules, index, { ...rule, questId: event.target.value }))}
                />
                <input
                  className="condition-field-id"
                  aria-label={`${title} ${index + 1} 进度标识符`}
                  disabled={disabled}
                  placeholder="进度标识符"
                  spellCheck={false}
                  value={rule.progressId}
                  onChange={event => onChange(replaceAt(rules, index, { ...rule, progressId: event.target.value }))}
                />
              </>
            )}
            {rule.kind === 'talk' && (
              <input
                className="condition-field-id"
                aria-label={`${title} ${index + 1} 对话注入点`}
                disabled={disabled}
                placeholder="对话注入点"
                spellCheck={false}
                value={rule.injectId}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, injectId: event.target.value }))}
              />
            )}
            {rule.kind === 'level' && (
              <input
                className="condition-field-num"
                type="number"
                aria-label={`${title} ${index + 1} 等级`}
                disabled={disabled}
                placeholder="等级"
                value={rule.n}
                onChange={event => onChange(replaceAt(rules, index, { ...rule, n: Number(event.target.value) }))}
              />
            )}
            {rule.kind === 'reputation' && (
              <>
                <input
                  className="condition-field-id"
                  aria-label={`${title} ${index + 1} 声誉主体`}
                  disabled={disabled}
                  placeholder="声誉主体（阵营）标识符"
                  spellCheck={false}
                  value={rule.factionId}
                  onChange={event => onChange(replaceAt(rules, index, { ...rule, factionId: event.target.value }))}
                />
                <input
                  className="condition-field-num"
                  type="number"
                  aria-label={`${title} ${index + 1} 数值`}
                  disabled={disabled}
                  placeholder="数值"
                  value={rule.n}
                  onChange={event => onChange(replaceAt(rules, index, { ...rule, n: Number(event.target.value) }))}
                />
              </>
            )}
          </div>

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
