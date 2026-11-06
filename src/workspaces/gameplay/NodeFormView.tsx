import { useRef, useState } from 'react'
import { useViewport } from '@xyflow/react'
import { TextField } from './Fields'
import { EditorExpansion } from './EditorExpansion'
import { ConditionRulesEditor } from './ConditionRulesEditor'
import { createCompletionGraph, goalAliases } from './completionGraph'
import { localizedGoalDefinitionLabel, type GoalDefinition } from './goalDefinitions'
import { GoalParameterField } from './goalWidgets'
import { GoalPicker } from './ProgressEditor'
import { ProgressCompletionEditor } from './ProgressCompletionEditor'
import { SubmissionField } from './SubmissionField'
import { PROGRESS_REPEAT_LABELS, type ProgressRepeatKind } from './progressDoc'
import { flowNodeLabel, progressIdentifierIssue, nodeIdentifierIssue, objectiveIdentifierIssue, getEndNode, getPredicateNode, getObjectiveNode, getProgressNode, isStartNode, type FlowText, type ProgressFlow } from './model'

export type NodeFormKind = 'progress' | 'predicate' | 'objective' | 'end'

export function NodeFormView({ flow, nodeId, kind, active = false, disabled = false, resolveText, setText, definitions, kitOptions, onChange, onClose, onActivate, onResize }: {
  flow: ProgressFlow
  nodeId: string
  kind: NodeFormKind
  active?: boolean
  disabled?: boolean
  resolveText?: (key: string) => string | null
  setText?: (key: string, value: string) => void
  definitions: readonly GoalDefinition[]
  kitOptions: readonly { ref: string; label: string }[]
  onChange: (flow: ProgressFlow) => void
  onClose: () => void
  onActivate?: () => void
  onResize: (size: { width: number; height: number }, reveal?: boolean) => void
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const viewport = useViewport()
  const resize = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const [picker, setPicker] = useState<{ goalId?: string } | null>(null)
  const [collapsed, setCollapsed] = useState(new Set<string>())
  const typeDrafts = useRef(new Map<string, ProgressFlow['progress'][string]['goals'][number]['params']>())
  const [kitDraft, setKitDraft] = useState('')
  const update = (mutate: (next: ProgressFlow) => void) => {
    const next = structuredClone(flow)
    mutate(next)
    onChange(next)
  }
  const read = (field: FlowText) => resolveText ? resolveText(field.text) ?? '' : field.text
  const authorText = (label: string, value: FlowText, bind: (next: ProgressFlow, field: FlowText) => void, multiline = false) => {
    const field = <TextField label={label} value={read(value)} disabled={disabled} multiline={multiline} onChange={content => {
      if (setText) setText(value.text, content)
      else update(next => bind(next, { text: content }))
    }} />
    return multiline ? <EditorExpansion title={label} kind="text">{({ expanded, expand }) => <div className="node-form-text">
      {!expanded && <button type="button" className="node-form-field-expand" aria-label={`放大${label}`} onClick={expand}>放大 ↗</button>}{field}
    </div>}</EditorExpansion> : field
  }
  const optionalIdentifier = (collection: 'predicates', identifier = '') => <>
    <TextField label="标识符（可选，留空为匿名）" value={identifier} disabled={disabled} onChange={value => update(next => {
      const node = next[collection]![nodeId]
      if (value) node.identifier = value
      else delete node.identifier
    })} />
    {nodeIdentifierIssue(flow, nodeId, identifier) && <p className="progress-inline-warning" role="alert">{nodeIdentifierIssue(flow, nodeId, identifier)}</p>}
  </>

  let title = '节点'
  let body = null
  if (kind === 'progress') {
    const node = getProgressNode(flow, nodeId)
    if (!node) return null
    const start = isStartNode(flow, nodeId)
    title = start ? '开始进度' : '进度'
    const goals = node.goals.map(goal => ({ id: goal.id, kind: goal.kind, config: goal.params as Record<string, string | number | boolean> }))
    const aliases = goalAliases(goals)
    body = <div className="node-form-progress-layout">
      <section className="node-form-info"><h2>进度信息</h2>
      {start && authorText('任务标题', node.questTitle ?? { text: '' }, (next, field) => { next.progress[nodeId].questTitle = field })}
      {start && authorText('任务说明', node.description ?? { text: '' }, (next, field) => { next.progress[nodeId].description = field }, true)}
      <TextField label="进度标识符" value={node.identifier} disabled={disabled} onChange={identifier => update(next => { next.progress[nodeId].identifier = identifier })} />
      {progressIdentifierIssue(flow, nodeId, node.identifier) && <p className="progress-inline-warning" role="alert">{progressIdentifierIssue(flow, nodeId, node.identifier)}</p>}
      {authorText('进行时日志', node.runningLog, (next, field) => { next.progress[nodeId].runningLog = field }, true)}
      {authorText('完成时日志', node.completedLog, (next, field) => { next.progress[nodeId].completedLog = field }, true)}
      <SubmissionField value={node.submission} progress disabled={disabled} onChange={submission => update(next => {
        if (submission) next.progress[nodeId].submission = submission
        else delete next.progress[nodeId].submission
      })} />
      {start && <>
        <h2>周期与策略</h2>
        <label className="flow-field"><span>重复方式</span><select aria-label="重复方式" disabled={disabled} value={node.repeat?.kind ?? 'once'} onChange={event => update(next => { next.progress[nodeId].repeat = { kind: event.target.value as ProgressRepeatKind, hours: next.progress[nodeId].repeat?.hours ?? 24 } })}>{Object.entries(PROGRESS_REPEAT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {(node.repeat?.kind ?? 'once') === 'duration' && <label className="flow-field"><span>间隔（小时）</span><input type="number" aria-label="重复间隔小时" min={0.01} step="any" disabled={disabled} value={node.repeat?.hours ?? 24} onChange={event => update(next => { next.progress[nodeId].repeat = { kind: 'duration', hours: Number(event.target.value) || 24 } })} /></label>}
        <label className="progress-abandon-switch"><span>可承接时自动开始</span><input type="checkbox" role="switch" aria-label="可承接时自动开始" disabled={disabled} checked={node.autoStartWhenAcceptable ?? false} onChange={event => update(next => { next.progress[nodeId].autoStartWhenAcceptable = event.target.checked })} /></label>
        <label className="progress-abandon-switch"><span>可放弃</span><input type="checkbox" role="switch" aria-label="可放弃" disabled={disabled} checked={node.abandonable ?? true} onChange={event => update(next => { next.progress[nodeId].abandonable = event.target.checked })} /></label>
        <label className="progress-abandon-switch"><span>周期不满足时不可见</span><input type="checkbox" role="switch" aria-label="周期不满足时不可见" disabled={disabled} checked={node.hideWhenRepeatUnsatisfied ?? false} onChange={event => update(next => { next.progress[nodeId].hideWhenRepeatUnsatisfied = event.target.checked })} /></label>
        <label className="flow-field"><span>标签（逗号分隔）</span><input aria-label="任务标签" disabled={disabled} value={(node.tags ?? []).join(', ')} onChange={event => update(next => { next.progress[nodeId].tags = event.target.value.split(',').map(tag => tag.trim()).filter(Boolean) })} /></label>
      </>}
      </section>
      {start && ([['visibility', '可见性条件'], ['acceptance', '可承接条件']] as const).map(([field, title]) => {
        const rules = node[field] ?? []
        return <section key={field} className="node-form-rules" aria-label={title}>
          <header className="progress-section-head progress-card-head"><h2>{title} <span>{rules.length}</span></h2></header>
          <ConditionRulesEditor
            title={title}
            rules={rules}
            disabled={disabled}
            emptyHint="没有条件，直接满足。"
            onChange={nextRules => update(next => { next.progress[nodeId][field] = nextRules })}
          />
        </section>
      })}
      <section className="node-form-goals-section">
        <header className="progress-section-head progress-card-head"><h2>目标 <span>{node.goals.length}</span></h2></header>
        <div className="progress-completion-switch" role="group" aria-label="目标完成规则">
        {([['all', '完成全部'], ['any', '完成任一'], ['custom', '自定义完成']] as const).map(([completion, label]) => <button key={completion} type="button" disabled={disabled} aria-pressed={node.completion === completion} onClick={() => {
          update(next => {
            const target = next.progress[nodeId]
            target.completion = completion
            if (completion === 'custom' && !target.completionGraph) target.completionGraph = createCompletionGraph()
            if (completion !== 'custom') delete target.completionGraph
          })
        }}>{label}</button>)}
        </div>
        <div className="node-form-goals">
        {node.goals.map((goal, index) => {
          const definition = definitions.find(item => item.kind === goal.kind)
          const title = definition ? localizedGoalDefinitionLabel(definition, 'zh_cn') : goal.kind || '未选择目标'
          const open = !collapsed.has(goal.id)
          return <article className={`progress-goal${open ? ' is-expanded' : ''}`} key={goal.id}>
            <div className="progress-goal-row">
              <button type="button" className="progress-goal-open" aria-expanded={open} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (open) next.add(goal.id); else next.delete(goal.id); return next })}><span className="progress-goal-alias">{aliases.get(goal.id)}</span><span className="progress-chevron">{open ? '▾' : '▸'}</span><strong>{title}</strong><span className="progress-node-kind">GOAL</span></button>
              <details className="progress-menu"><summary aria-label={`${title}操作`}>⋯</summary><div>
                <button type="button" disabled={disabled} onClick={() => setPicker({ goalId: goal.id })}>更换类型</button>
                <button type="button" className="progress-danger" disabled={disabled} onClick={() => update(next => { next.progress[nodeId].goals.splice(index, 1) })}>删除目标</button>
              </div></details>
            </div>
            {open && <div className="progress-goal-body">
              {!definition && <p className="progress-inline-warning">未找到定义脚本。原参数已保留，可在菜单中更换类型。</p>}
              <div className="progress-parameters">{definition?.fields.map(field => <GoalParameterField key={`${goal.kind}:${field.key}`} field={field} value={['string', 'number', 'boolean'].includes(typeof goal.params[field.key]) ? goal.params[field.key] as string | number | boolean : undefined} disabled={disabled} locale="zh_cn" onChange={value => update(next => {
                const params = next.progress[nodeId].goals[index].params
                if (value === undefined) delete params[field.key]
                else Object.defineProperty(params, field.key, { value, writable: true, enumerable: true, configurable: true })
              })} />)}</div>
              {definition && !definition.fields.length && <p className="progress-node-empty">此目标无需配置参数</p>}
            </div>}
          </article>
        })}
        </div>
        <div className="progress-add-row"><button type="button" disabled={disabled} onClick={() => setPicker({})}>＋ 添加目标</button>{!node.goals.length && <span>先选择一种目标，再填写参数</span>}</div>
      </section>
      {node.completion === 'custom' && node.completionGraph && <EditorExpansion title="自定义完成图" kind="graph">{({ expanded, expand }) => <section className="node-form-section node-form-graph">
        <div className="node-form-graph-heading"><span>完成逻辑</span>{!expanded && <button type="button" aria-label="放大自定义完成图" onClick={expand}>放大 ↗</button>}</div>
        <ProgressCompletionEditor graph={node.completionGraph!} goals={goals} definitions={definitions} disabled={disabled} active onChange={graph => update(next => { next.progress[nodeId].completionGraph = graph })} />
      </section>}</EditorExpansion>}
      {picker && <GoalPicker definitions={definitions} current={node.goals.find(goal => goal.id === picker.goalId)?.kind} locale="zh_cn" onClose={() => setPicker(null)} onChoose={kind => {
        update(next => {
          const goal = next.progress[nodeId].goals.find(goal => goal.id === picker.goalId)
          if (goal) { typeDrafts.current.set(`${goal.id}:${goal.kind}`, { ...goal.params }); goal.kind = kind; goal.params = typeDrafts.current.get(`${goal.id}:${kind}`) ?? {} }
          else next.progress[nodeId].goals.push({ id: `goal_${Math.random().toString(36).slice(2, 10)}`, kind, params: {} })
        }); setPicker(null)
      }} />}
    </div>
  } else if (kind === 'objective') {
    const node = getObjectiveNode(flow,nodeId)
    if (!node) return null
    title = '目标'
    const definition = definitions.find(item=>item.kind === node.goal.kind)
    body = <section className="node-form-section">
      <TextField label="目标标识符" value={node.identifier} disabled={disabled} onChange={identifier => update(next => { next.objectives![nodeId].identifier = identifier })} />
      {objectiveIdentifierIssue(flow, nodeId, node.identifier) && <p className="progress-inline-warning" role="alert">{objectiveIdentifierIssue(flow, nodeId, node.identifier)}</p>}
      <header className="progress-section-head"><h2>{definition ? localizedGoalDefinitionLabel(definition,'zh_cn') : node.goal.kind || '未选择目标'}</h2>
        <button type="button" disabled={disabled} onClick={()=>setPicker({})}>{node.goal.kind ? '更换类型' : '选择目标类型'}</button>
      </header>
      <p className="flow-hint">随任务启动的后台目标，不进入任务 UI 跟踪；不维持任务存活。</p>
      {node.goal.kind && !definition && <p className="progress-inline-warning">未找到定义脚本，原参数已保留。</p>}
      <div className="progress-parameters">{definition?.fields.map(field=><GoalParameterField key={`${node.goal.kind}:${field.key}`} field={field} value={['string','number','boolean'].includes(typeof node.goal.params[field.key]) ? node.goal.params[field.key] as string|number|boolean : undefined} disabled={disabled} locale="zh_cn" onChange={value=>update(next=>{
        const params=next.objectives![nodeId].goal.params
        if(value===undefined) delete params[field.key]
        else Object.defineProperty(params,field.key,{value,writable:true,enumerable:true,configurable:true})
      })} />)}</div>
      {definition && !definition.fields.length && <p className="progress-node-empty">此目标无需配置参数</p>}
      {definition?.error && <p className="progress-inline-warning" role="alert">{definition.error}</p>}
      <SubmissionField value={node.submission} disabled={disabled} onChange={submission => update(next => {
        if (submission) next.objectives![nodeId].submission = submission
        else delete next.objectives![nodeId].submission
      })} />
      {picker && <GoalPicker definitions={definitions} current={node.goal.kind} locale="zh_cn" onClose={()=>setPicker(null)} onChoose={kind=>{
        if (disabled) return
        update(next=>{
          typeDrafts.current.set(`objective:${node.goal.kind}`,{...node.goal.params})
          next.objectives![nodeId].goal={kind,params:typeDrafts.current.get(`objective:${kind}`) ?? {}}
        });setPicker(null)
      }} />}
    </section>
  } else if (kind === 'predicate') {
    const node = getPredicateNode(flow, nodeId)
    if (!node) return null
    title = '条件'
    body = <>
      {optionalIdentifier('predicates', node.identifier)}
      <section className="node-form-section node-form-rules">
        <header><h2>条件 <span>{node.conditions.length}</span></h2></header>
        <ConditionRulesEditor
          title="条件"
          rules={node.conditions}
          disabled={disabled}
          emptyHint="未配置判断规则时，此节点恒真（与 Mod 空串语义一致）。"
          onChange={rules => update(next => { next.predicates![nodeId].conditions = rules })}
        />
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

  return <EditorExpansion title={`${title}表单`} kind="form">{({ expanded, expand, restore }) => <div className={`node-form-view progress-editor${active ? ' is-active' : ''}${disabled ? ' is-readonly' : ''}`} onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    <header className="node-form-header nowheel" title="拖动移动表单 · 双击关闭表单" onDoubleClick={event => {
      event.stopPropagation()
      if ((event.target as Element).closest('button')) return
      onClose()
    }}>
      <span className="node-form-kind">{title}</span>
      <strong>{flowNodeLabel(flow, nodeId, resolveText)}</strong>
      {!expanded && <button type="button" className="node-form-enlarge nodrag nopan" onClick={expand}>放大表单 ↗</button>}
      <button type="button" className="node-form-expand nodrag nopan" onClick={event => { const wide = event.currentTarget.parentElement!.parentElement!.getBoundingClientRect().width / viewport.zoom >= 1000; onResize({ width: wide ? 760 : 1180, height: 540 }, true); if (scroll.current) scroll.current.scrollTop = 0 }} title="切换横向展开">横向展开</button>
      <button type="button" className="node-form-close nodrag nopan" aria-label={expanded ? '还原表单' : '关闭表单'} title={expanded ? '还原表单' : '关闭表单'} onClick={expanded ? restore : onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
    </header>
    <div className="node-form-body nodrag nopan nowheel" ref={scroll} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>{body}</div>
    <button type="button" className="node-form-resize nodrag nopan nowheel" aria-label="调整表单大小" title="拖动调整宽高；方向键微调" onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault(); event.stopPropagation()
      const rect = event.currentTarget.parentElement!.getBoundingClientRect()
      resize.current = { x: event.clientX, y: event.clientY, width: rect.width / viewport.zoom, height: rect.height / viewport.zoom }
      event.currentTarget.setPointerCapture(event.pointerId)
    }} onPointerMove={event => { const start = resize.current; if (start) onResize({ width: Math.max(420, start.width + (event.clientX - start.x) / viewport.zoom), height: Math.max(320, start.height + (event.clientY - start.y) / viewport.zoom) }) }} onPointerUp={event => { resize.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={() => { resize.current = null }} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const rect = event.currentTarget.parentElement!.getBoundingClientRect()
      onResize({ width: Math.max(420, rect.width / viewport.zoom + (event.key === 'ArrowRight' ? 40 : event.key === 'ArrowLeft' ? -40 : 0)), height: Math.max(320, rect.height / viewport.zoom + (event.key === 'ArrowDown' ? 40 : event.key === 'ArrowUp' ? -40 : 0)) })
    }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 13 8-8m-3 8 3-3" /></svg></button>
  </div>}</EditorExpansion>
}
