import { useRef, useState } from 'react'
import { TextField } from './Fields'
import { conditionStatesFor, createConditionRule, type ProgressConditionRule } from './conditions'
import { createCompletionGraph } from './completionGraph'
import { defaultConfigFromFields, type GoalDefinition, type GoalConfigField } from './goalDefinitions'
import { ProgressCompletionEditor } from './ProgressCompletionEditor'
import { getEndNode, getPredicateNode, getProgressNode, isStartNode, type FlowProgressNode, type FlowText, type ProgressFlow } from './model'

export type NodeFormKind = 'progress' | 'predicate' | 'end'

export function NodeFormView({ flow, nodeId, kind, disabled = false, resolveText, setText, definitions, kitOptions, onChange, onClose }: {
  flow: ProgressFlow
  nodeId: string
  kind: NodeFormKind
  disabled?: boolean
  resolveText?: (key: string) => string | null
  setText?: (key: string, value: string) => void
  definitions: readonly GoalDefinition[]
  kitOptions: readonly { ref: string; label: string }[]
  onChange: (flow: ProgressFlow) => void
  onClose: () => void
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const [kitDraft, setKitDraft] = useState('')
  const update = (mutate: (next: ProgressFlow) => void) => {
    const next = structuredClone(flow)
    mutate(next)
    onChange(next)
  }
  const read = (field: FlowText) => resolveText ? resolveText(field.text) ?? '' : field.text
  const authorText = (label: string, value: FlowText, bind: (next: ProgressFlow, field: FlowText) => void, multiline = false) => (
    <TextField label={label} value={read(value)} disabled={disabled} multiline={multiline} onChange={content => {
      if (setText) setText(value.text, content)
      else update(next => bind(next, { text: content }))
    }} />
  )

  let title = '节点'
  let body = null
  if (kind === 'progress') {
    const node = getProgressNode(flow, nodeId)
    if (!node) return null
    const start = isStartNode(flow, nodeId)
    title = start ? '开始进度' : '进度'
    const goals = node.goals.map(goal => ({ id: goal.id, kind: goal.kind, config: goal.params as Record<string, string | number | boolean> }))
    body = <>
      {start && authorText('任务标题', node.questTitle ?? { text: '' }, (next, field) => { next.progress[nodeId].questTitle = field })}
      {start && authorText('任务说明', node.description ?? { text: '' }, (next, field) => { next.progress[nodeId].description = field }, true)}
      {authorText('进度标题', node.title, (next, field) => { next.progress[nodeId].title = field })}
      {authorText('进行时日志', node.runningLog, (next, field) => { next.progress[nodeId].runningLog = field }, true)}
      {authorText('完成时日志', node.completedLog, (next, field) => { next.progress[nodeId].completedLog = field }, true)}
      <label className="flow-field">
        <span>完成判定</span>
        <select disabled={disabled} value={node.completion} onChange={event => {
          const completion = event.target.value as FlowProgressNode['completion']
          update(next => {
            const target = next.progress[nodeId]
            target.completion = completion
            if (completion === 'custom' && !target.completionGraph) target.completionGraph = createCompletionGraph()
            if (completion !== 'custom') delete target.completionGraph
          })
        }}>
          <option value="all">全部目标达成</option>
          <option value="any">任一目标达成</option>
          <option value="custom">自定义完成图</option>
        </select>
      </label>
      <section className="node-form-section">
        <header>目标<button type="button" disabled={disabled} onClick={() => update(next => {
          const target = next.progress[nodeId]
          target.goals.push({ id: `goal_${Math.random().toString(36).slice(2, 10)}`, kind: '', params: {} })
        })}>＋ 添加</button></header>
        {node.goals.length === 0 && <p className="flow-hint">还没有目标。目标会在进度运行中订阅，全部达成由上面的完成判定决定。</p>}
        {node.goals.map((goal, index) => {
          const definition = definitions.find(item => item.kind === goal.kind)
          return <div className="node-form-goal" key={goal.id}>
            <div className="node-form-goal-head">
              <select disabled={disabled} value={goal.kind} onChange={event => update(next => {
                const target = next.progress[nodeId].goals[index]
                const picked = definitions.find(item => item.kind === event.target.value)
                target.kind = event.target.value
                target.params = picked ? defaultConfigFromFields(picked.fields) : {}
              })}>
                <option value="">（未选择目标类型）</option>
                {definitions.map(item => <option key={item.kind} value={item.kind}>{item.label}</option>)}
              </select>
              <button type="button" disabled={disabled} onClick={() => update(next => { next.progress[nodeId].goals.splice(index, 1) })}>删除</button>
            </div>
            {definition?.fields.map((field: GoalConfigField) => <label className="node-form-param" key={field.key}>
              <span>{field.label ?? field.key}</span>
              {field.type === 'bool'
                ? <input type="checkbox" disabled={disabled} checked={goal.params[field.key] === true} onChange={event => update(next => { next.progress[nodeId].goals[index].params[field.key] = event.target.checked })} />
                : <input type={field.type === 'string' ? 'text' : 'number'} step={field.type === 'int' ? 1 : undefined} disabled={disabled} value={String(goal.params[field.key] ?? '')} onChange={event => update(next => {
                  const raw = event.target.value
                  next.progress[nodeId].goals[index].params[field.key] = field.type === 'string' ? raw : raw === '' ? '' : Number(raw)
                })} />}
            </label>)}
            {!definition && <p className="flow-hint">选择目标类型后可填写参数。</p>}
          </div>
        })}
      </section>
      {node.completion === 'custom' && node.completionGraph && <section className="node-form-section node-form-graph">
        <header>自定义完成图</header>
        <ProgressCompletionEditor graph={node.completionGraph} goals={goals} definitions={definitions} disabled={disabled} active onChange={graph => update(next => { next.progress[nodeId].completionGraph = graph })} />
      </section>}
    </>
  } else if (kind === 'predicate') {
    const node = getPredicateNode(flow, nodeId)
    if (!node) return null
    title = '谓词'
    body = <>
      {authorText('谓词标题', node.title, (next, field) => { next.predicates![nodeId].title = field })}
      <section className="node-form-section">
        <header>条件<button type="button" disabled={disabled} onClick={() => update(next => { next.predicates![nodeId].conditions.push(createConditionRule('task')) })}>＋ 添加</button></header>
        {node.conditions.length === 0 && <p className="flow-hint">没有条件时谓词恒假（不会发出 A）。</p>}
        {node.conditions.map((rule, index) => <div className="node-form-condition" key={index}>
          <select aria-label={`条件 ${index + 1} 类型`} disabled={disabled} value={rule.kind} onChange={event => update(next => {
            next.predicates![nodeId].conditions[index] = createConditionRule(event.target.value as ProgressConditionRule['kind'])
          })}>
            <option value="task">任务</option>
            <option value="dialogue">对话</option>
            <option value="expr">求值</option>
            <option value="repeat">重复周期</option>
          </select>
          <select aria-label={`条件 ${index + 1} 状态`} disabled={disabled} value={rule.state} onChange={event => update(next => {
            next.predicates![nodeId].conditions[index] = { ...rule, state: event.target.value } as ProgressConditionRule
          })}>
            {Object.entries(conditionStatesFor(rule.kind)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          {rule.kind === 'repeat'
            ? <span className="flow-hint">本任务周期</span>
            : <input aria-label={`条件 ${index + 1} 对象`} disabled={disabled} placeholder="任务 / 对话 / 表达式" value={rule.target} onChange={event => update(next => {
              next.predicates![nodeId].conditions[index] = { ...rule, target: event.target.value } as ProgressConditionRule
            })} />}
          <button type="button" disabled={disabled} onClick={() => update(next => { next.predicates![nodeId].conditions.splice(index, 1) })}>删除</button>
        </div>)}
      </section>
    </>
  } else {
    const node = getEndNode(flow, nodeId)
    if (!node) return null
    title = '结束'
    body = <>
      {authorText('结局标题', node.title, (next, field) => { next.ends![nodeId].title = field })}
      <section className="node-form-section">
        <header>奖励礼包</header>
        {node.rewardKits.length === 0 && <p className="flow-hint">还没有奖励。</p>}
        <div className="node-form-chips">
          {node.rewardKits.map(ref => <span className="node-form-chip" key={ref}>{kitOptions.find(option => option.ref === ref)?.label ?? ref}
            <button type="button" aria-label={`移除 ${ref}`} disabled={disabled} onClick={() => update(next => { next.ends![nodeId].rewardKits = next.ends![nodeId].rewardKits.filter(item => item !== ref) })}>×</button>
          </span>)}
        </div>
        <div className="node-form-kit-add">
          <input list={`kits-${nodeId}`} disabled={disabled} placeholder="礼包引用，如 starter" value={kitDraft} onChange={event => setKitDraft(event.target.value)} />
          <datalist id={`kits-${nodeId}`}>{kitOptions.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}</datalist>
          <button type="button" disabled={disabled || !kitDraft.trim()} onClick={() => {
            const ref = kitDraft.trim()
            setKitDraft('')
            update(next => { if (!next.ends![nodeId].rewardKits.includes(ref)) next.ends![nodeId].rewardKits.push(ref) })
          }}>添加</button>
        </div>
      </section>
    </>
  }

  return <div className={`node-form-view${disabled ? ' is-readonly' : ''}`}>
    <header className="node-form-header">
      <span className="node-form-kind">{title}</span>
      <strong>{read((kind === 'progress' ? getProgressNode(flow, nodeId)?.title : kind === 'predicate' ? getPredicateNode(flow, nodeId)?.title : getEndNode(flow, nodeId)?.title) ?? { text: '' })}</strong>
      <button type="button" className="node-form-close" aria-label="关闭表单" onClick={onClose}>×</button>
    </header>
    <div className="node-form-body" ref={scroll}>{body}</div>
  </div>
}
