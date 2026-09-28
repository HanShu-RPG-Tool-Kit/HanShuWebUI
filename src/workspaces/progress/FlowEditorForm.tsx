import { Field, IdField, JsonField, TextField } from './Fields'
import { branches, clone, connectEntry, descendants, disconnectLink, displayText, getGoalNode, getLogicNode, getTransitionNode, inputPorts, getNode, GOAL_NAMES, LOGIC_NAMES, moveNode, parseFlow, removeNode, renameNode, reorderBranch, text, type Data, type FlowBranch, type FlowInputPort, type FlowCondition, type FlowSelection, type FlowText, type ProgressFlow } from './model'
import { addNextCheckpoint, withCanvasPositions } from './canvas'

function AuthorText({ label, value, onChange, multiline = false, disabled }: {
  label: string; value: FlowText; onChange: (value: FlowText) => void; multiline?: boolean; disabled: boolean
}) {
  return <div>
    <TextField label={label} value={value.text} disabled={disabled} multiline={multiline} onChange={(content) => onChange({ ...value, text: content })} />
    <details className="flow-localization"><summary>{value.key ? `文本键：${value.key}` : `${label}的本地化`}</summary>
      <TextField label={`${label}文本键（可选）`} value={value.key ?? ''} disabled={disabled} placeholder="story.chapter.start.title" onChange={(key) => { const next = { ...value }; if (key) next.key = key; else delete next.key; onChange(next) }} />
      <p className="flow-hint">原文用于设计预览；文本键供后续本地化资源引用。</p>
    </details>
  </div>
}

export function FlowEditorForm({ flow, selection, onChange, onSelect, onPending, onNotice, locked }: {
  flow: ProgressFlow; selection: FlowSelection; onChange: (flow: ProgressFlow) => void; onSelect: (selection: FlowSelection) => void
  onPending: (label: string, value: boolean) => void; onNotice: (notice: string) => void; locked: boolean
}) {
  function edit(mutate: (next: ProgressFlow) => void) {
    const next = clone(flow); mutate(next)
    onChange(parseFlow(JSON.stringify(next)))
  }
  function attempt(action: () => void) { try { action() } catch (error) { onNotice(String(error)) } }
  const authorText = (label: string, value: FlowText, update: (next: ProgressFlow, value: FlowText) => void, multiline = false) => <AuthorText label={label} value={value} multiline={multiline} disabled={locked} onChange={(value) => edit((next) => update(next, value))} />

  if (selection.kind === 'entry' || selection.kind === 'entry-link') return <div className="flow-editor-fields">
    <p className="flow-hint">起点只表示流程入口，不承载阶段内容、条件或奖励。它可以自由移动，始终保留在画布中。</p>
    <Field label="起始节点"><select disabled={locked} value={flow.entry.target ?? ''} onChange={(event) => attempt(() => onChange(connectEntry(withCanvasPositions(flow), event.target.value || null)))}>
      <option value="">暂不连接</option>
      {Object.entries(flow.nodes).map(([id, node]) => <option key={id} value={id}>{displayText(node.title) || id}</option>)}
      {Object.entries(flow.logic?.nodes ?? {}).map(([id, node]) => <option key={id} value={id}>{LOGIC_NAMES[node.operator]} · {displayText(node.title) || id}</option>)}
      {Object.entries(flow.goals ?? {}).map(([id, node]) => <option key={id} value={id}>Goal · {displayText(node.title) || id}</option>)}
      {Object.entries(flow.transitions ?? {}).map(([id, node]) => <option key={id} value={id}>转移 · {displayText(node.title) || id}</option>)}
    </select></Field>
    {flow.entry.target && inputPorts(flow, flow.entry.target).length > 1 && <Field label="连接的输入端口"><select disabled={locked} value={flow.entry.port ?? 'input'} onChange={event => attempt(() => onChange(connectEntry(withCanvasPositions(flow), flow.entry.target, event.target.value as FlowInputPort)))}><option value="input">输入 1</option><option value="input2">输入 2</option></select></Field>}
    <button type="button" disabled={locked || flow.entry.target !== null} onClick={() => attempt(() => {
      const result = addNextCheckpoint(flow, flow.entry.id); onChange(result.flow); onSelect({ kind: 'node', id: result.id })
    })}>＋ 新建并连接 checkpoint</button>
  </div>

  if (selection.kind === 'flow') return <div className="flow-editor-fields">
    {authorText('流程名称', flow.title, (next, value) => { next.title = value })}
    {authorText('流程说明', flow.description, (next, value) => { next.description = value }, true)}
    <Field label="内容类别"><select disabled={locked} value={flow.kind} onChange={(event) => edit((next) => { next.kind = event.target.value as ProgressFlow['kind'] })}>
      <option value="task">任务</option><option value="chapter">章节推进</option><option value="exploration">探索解锁</option><option value="custom">自定义</option>
    </select></Field>
    <details><summary>高级设置</summary><TextField label="文档 ID" value={flow.id} disabled={locked} onChange={(id) => edit((next) => { next.id = id })} /></details>
  </div>

  if (selection.kind === 'node') {
    const { id } = selection, node = getNode(flow, id)
    if (!node) return <p className="flow-hint">节点已移除，请重新选择。</p>
    const parent = branches(flow).find(({ branch }) => branch.target === id)?.parent
    const subtree = descendants(flow, id)
    const resourceFields = (label: string, key: 'onEnter' | 'onFinish' | 'rewards') => <details><summary>{label} · {node[key].length}</summary>
      <JsonField label={label} shape="array" value={node[key]} onPending={onPending} onApply={(value) => edit((next) => { next.nodes[id][key] = value as typeof node[typeof key] })} />
      <p className="flow-hint">资源引用格式：{`{"id":"...","reference":"...","params":{}}`}。这里记录设计意图，由后续引擎解释。</p>
    </details>
    return <div className="flow-editor-fields">
      {authorText('阶段名称', node.title, (next, value) => { next.nodes[id].title = value })}
      {authorText('阶段说明', node.description, (next, value) => { next.nodes[id].description = value }, true)}
      <label className="flow-check"><input type="checkbox" checked={node.completion === 'finish'} disabled={locked || (node.completion !== 'finish' && (node.children.length > 0 || !!flow.logic?.links.some(link => link.from === id)))} onChange={(event) => edit((next) => { next.nodes[id].completion = event.target.checked ? 'finish' : 'continue' })} />到达此节点后结束流程</label>
      {node.children.length > 0 && <p className="flow-hint">已有 {node.children.length} 个后续阶段。推进条件可双击画布上的分支编辑。</p>}
      {resourceFields('进入阶段的动作', 'onEnter')}
      {resourceFields('结束时的动作', 'onFinish')}
      {resourceFields('奖励引用', 'rewards')}
      <details><summary>结构与高级设置</summary>
      <IdField key={id} label="节点 ID" value={id} disabled={locked} onPending={onPending} onApply={(value) => { onChange(renameNode(flow, id, value)); onSelect({ kind: 'node', id: value }) }} />
      <Field label="后续分支方式"><select disabled={locked} value={node.branching} onChange={(event) => edit((next) => { next.nodes[id].branching = event.target.value as typeof node.branching })}>
        <option value="parallel">各分支分别推进</option><option value="choice">选择其中一条</option><option value="priority">按分支顺序选择</option>
      </select></Field>
      <Field label="所在父节点"><select value={parent ?? ''} disabled={locked || !parent} onChange={(event) => attempt(() => onChange(moveNode(withCanvasPositions(flow), id, event.target.value)))}>
        {!parent && <option value="">{flow.entry.target === id ? '起点入口' : '独立节点'}</option>}
        {Object.entries(flow.nodes).filter(([key, n]) => !subtree.has(key) && n.completion !== 'finish').map(([key, n]) => <option key={key} value={key}>{displayText(n.title) || key} · {key}</option>)}
      </select></Field>
      <div className="flow-section-heading"><h4>后续阶段 · {node.children.length}</h4><button type="button" disabled={locked || node.completion === 'finish'} onClick={() => attempt(() => {
        const result = addNextCheckpoint(flow, id); onChange(result.flow); onSelect({ kind: 'node', id: result.id })
      })}>＋ 阶段</button></div>
      <div className="flow-children">{node.children.map((b, index) => <div className="flow-child" key={b.id}>
        <button type="button" disabled={locked} onClick={() => onSelect({ kind: 'branch', parent: id, id: b.id })}><strong>{displayText(b.title) || b.id}</strong><small>→ {displayText(getNode(flow, b.target)?.title ?? text(b.target))}</small></button>
        <button type="button" disabled={locked || index === 0} aria-label={`上移分支 ${b.id}`} onClick={() => onChange(reorderBranch(flow, id, b.id, -1))}>↑</button>
        <button type="button" disabled={locked || index === node.children.length - 1} aria-label={`下移分支 ${b.id}`} onClick={() => onChange(reorderBranch(flow, id, b.id, 1))}>↓</button>
      </div>)}</div>
      {!node.children.length && <p className="flow-hint">可以添加后续阶段，也可以将当前节点标记为流程终点。</p>}
      <div className="flow-inline-actions"><button type="button" className="flow-danger" disabled={locked} onClick={() => {
        attempt(() => { onChange(removeNode(withCanvasPositions(flow), id)); onSelect({ kind: 'flow' }) })
      }}>删除当前节点</button></div><p className="flow-hint">只删除当前节点及相关连接，其他节点保留。完成后可撤销。</p>
      </details>
    </div>
  }

  if (selection.kind === 'goal') {
    const { id } = selection, goal = getGoalNode(flow, id)
    if (!goal) return <p className="flow-hint">目标已移除，请重新选择。</p>
    const update = (patch: Partial<typeof goal>) => edit(next => { Object.assign(next.goals![id], patch) })
    return <div className="flow-editor-fields">
      {authorText('目标名称', goal.title, (next, value) => { next.goals![id].title = value })}
      {authorText('目标说明', goal.description, (next, value) => { next.goals![id].description = value }, true)}
      <Field label="条件类型"><select disabled={locked} value={goal.kind} onChange={event => {
        const kind = event.target.value as FlowCondition['kind']
        update({ kind, nodeRefs: [], params: kind === 'counter' ? { event: '', target: 1 } : kind === 'signal' ? { event: '' } : kind === 'external' ? { reference: '', args: {} } : {} })
      }}>{Object.entries(GOAL_NAMES).map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}</select></Field>
      {['counter', 'signal'].includes(goal.kind) && <TextField label="事件或信号引用" disabled={locked} value={String(goal.params.event ?? '')} onChange={event => update({ params: { ...goal.params, event } })} />}
      {goal.kind === 'counter' && <Field label="累计目标值"><input type="number" min="1" disabled={locked} value={Number(goal.params.target ?? 1)} onChange={event => update({ params: { ...goal.params, target: Number(event.target.value) } })} /></Field>}
      {goal.kind === 'nodes' && <div className="flow-node-refs">{Object.entries(flow.nodes).map(([ref, node]) => <label className="flow-check" key={ref}><input type="checkbox" disabled={locked} checked={goal.nodeRefs.includes(ref)} onChange={event => update({ nodeRefs: event.target.checked ? [...goal.nodeRefs, ref] : goal.nodeRefs.filter(value => value !== ref) })} />{displayText(node.title) || ref}</label>)}</div>}
      {goal.kind === 'external' && <>
        <TextField label="条件资源引用" disabled={locked} value={String(goal.params.reference ?? '')} onChange={reference => update({ params: { ...goal.params, reference } })} />
        <JsonField label="条件参数" value={goal.params.args ?? {}} onPending={onPending} onApply={args => update({ params: { ...goal.params, args: args as Data } })} />
      </>}
      <button type="button" className="flow-danger" disabled={locked} onClick={() => { onChange(removeNode(withCanvasPositions(flow), id)); onSelect({ kind: 'flow' }) }}>删除当前节点</button>
    </div>
  }

  if (selection.kind === 'transition') {
    const node = getTransitionNode(flow, selection.id)
    if (!node) return <p className="flow-hint">节点已移除，请重新选择。</p>
    return <div className="flow-editor-fields">
      {authorText('节点名称', node.title, (next, value) => { next.transitions![selection.id].title = value })}
      {authorText('节点说明', node.description, (next, value) => { next.transitions![selection.id].description = value }, true)}
      <button type="button" className="flow-danger" disabled={locked} onClick={() => { onChange(removeNode(withCanvasPositions(flow), selection.id)); onSelect({ kind: 'flow' }) }}>删除当前节点</button>
    </div>
  }

  if (selection.kind === 'logic') {
    const node = getLogicNode(flow, selection.id)
    if (!node) return <p className="flow-hint">节点已移除，请重新选择。</p>
    return <div className="flow-editor-fields">
      <p className="flow-hint">{LOGIC_NAMES[node.operator]}节点 · 当前仅编辑结构，不计算真值。</p>
      {authorText('节点名称', node.title, (next, value) => { next.logic!.nodes[selection.id].title = value })}
      {authorText('节点说明', node.description, (next, value) => { next.logic!.nodes[selection.id].description = value }, true)}
      <button type="button" className="flow-danger" disabled={locked} onClick={() => { onChange(removeNode(withCanvasPositions(flow), selection.id)); onSelect({ kind: 'flow' }) }}>删除当前节点</button>
    </div>
  }

  if (selection.kind === 'logic-link') {
    const link = flow.logic?.links.find(link => link.id === selection.id)
    if (!link) return <p className="flow-hint">连接已移除，请重新选择。</p>
    const name = (id: string) => displayText((getNode(flow, id) ?? getLogicNode(flow, id) ?? getGoalNode(flow, id) ?? getTransitionNode(flow, id))?.title ?? text(id))
    return <div className="flow-editor-fields">
      <p className="flow-route">{name(link.from)} → {name(link.to)}</p>
      <p className="flow-hint">输出连接到输入端口。</p>
      <button type="button" className="flow-danger" disabled={locked} onClick={() => { onChange(disconnectLink(withCanvasPositions(flow), selection)); onSelect({ kind: 'flow' }) }}>断开连接</button>
    </div>
  }

  if (selection.kind !== 'branch') return null
  const { parent, id } = selection, node = getNode(flow, parent), branch = node?.children.find((b) => b.id === id)
  if (!node || !branch) return <p className="flow-hint">分支已移除，请重新选择。</p>
  const update = (mutate: (b: FlowBranch) => void) => edit((next) => mutate(next.nodes[parent].children.find((b) => b.id === id)!))
  const updateCondition = (index: number, patch: Partial<FlowCondition>) => update((b) => { Object.assign(b.conditions.items[index], patch) })
  const kinds: [FlowCondition['kind'], string][] = [['manual', '人工标记'], ['counter', '累计事件'], ['signal', '等待信号'], ['nodes', '等待其他阶段'], ['external', '外部条件引用']]
  return <div className="flow-editor-fields">
    <p className="flow-route">{displayText(node.title) || parent} <span>→</span> {displayText(getNode(flow, branch.target)?.title ?? text(branch.target))}</p>
    <AuthorText label="分支名称" value={branch.title} disabled={locked} onChange={(title) => update((b) => { b.title = title })} />
    <Field label="推进方式"><select value={branch.trigger} disabled={locked} onChange={(event) => update((b) => { b.trigger = event.target.value as typeof branch.trigger })}><option value="automatic">条件满足后继续</option><option value="confirm">条件满足后等待确认</option></select></Field>
    <Field label="条件组合"><select value={branch.conditions.mode} disabled={locked} onChange={(event) => update((b) => { b.conditions.mode = event.target.value as 'all' | 'any' })}><option value="all">全部满足</option><option value="any">任一满足</option></select></Field>
    <div className="flow-section-heading"><h4>推进条件 · {branch.conditions.items.length}</h4><button type="button" disabled={locked} onClick={() => {
      let n = 1; while (branch.conditions.items.some((c) => c.id === `condition_${n}`)) n++
      update((b) => { b.conditions.items.push({ id: `condition_${n}`, kind: 'manual', title: text('新的条件'), params: {}, nodeRefs: [] }) })
    }}>＋ 条件</button></div>
    {branch.conditions.items.map((condition, index) => <div className="flow-goal" key={condition.id}>
      <div className="flow-section-heading"><strong>条件 {index + 1}</strong><button type="button" disabled={locked} className="flow-danger" onClick={() => update((b) => { b.conditions.items.splice(index, 1) })}>移除</button></div>
      <AuthorText label={`条件 ${index + 1} 名称`} value={condition.title} disabled={locked} onChange={(title) => updateCondition(index, { title })} />
      <Field label={`条件 ${index + 1} 类型`}><select value={condition.kind} disabled={locked} onChange={(event) => {
        const kind = event.target.value as FlowCondition['kind']
        updateCondition(index, { kind, nodeRefs: [], params: kind === 'counter' ? { event: '', target: 1 } : kind === 'signal' ? { event: '' } : kind === 'external' ? { reference: '', args: {} } : {} })
      }}>{kinds.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></Field>
      {['counter', 'signal'].includes(condition.kind) && <TextField label="事件或信号引用" value={String(condition.params.event ?? '')} disabled={locked} placeholder="story.guard_defeated" onChange={(event) => updateCondition(index, { params: { ...condition.params, event } })} />}
      {condition.kind === 'counter' && <Field label="累计目标值"><input type="number" min="1" disabled={locked} value={typeof condition.params.target === 'number' ? condition.params.target : ''} onChange={(event) => updateCondition(index, { params: { ...condition.params, target: Number(event.target.value) } })} /></Field>}
      {condition.kind === 'nodes' && <div className="flow-node-refs"><span className="flow-hint">等待这些阶段到达：</span>{Object.entries(flow.nodes).map(([key, n]) => <label className="flow-check" key={key}><input type="checkbox" disabled={locked} checked={condition.nodeRefs.includes(key)} onChange={(event) => updateCondition(index, { nodeRefs: event.target.checked ? [...condition.nodeRefs, key] : condition.nodeRefs.filter((ref) => ref !== key) })} />{displayText(n.title) || key}</label>)}</div>}
      {condition.kind === 'external' && <>
        <TextField label="条件资源引用" value={String(condition.params.reference ?? '')} disabled={locked} placeholder="conditions.protect_traveler" onChange={(reference) => updateCondition(index, { params: { ...condition.params, reference } })} />
        <JsonField label={`条件 ${index + 1} 参数`} value={condition.params.args ?? {}} onPending={onPending} onApply={(args) => updateCondition(index, { params: { ...condition.params, args: args as Data } })} />
      </>}
    </div>)}
    {!branch.conditions.items.length && <p className="flow-hint">没有附加条件，此分支可以直接继续；也可以设置为等待确认。</p>}
    <details><summary>高级设置</summary><IdField key={id} label="分支 ID" value={id} disabled={locked} onPending={onPending} onApply={(value) => {
      if (value === id) return
      if (!value || branches(flow).some(({ branch: b }) => b.id === value)) throw new Error('分支 ID 不能为空或重复。')
      update((b) => { b.id = value }); onSelect({ kind: 'branch', parent, id: value })
    }} /></details>
  </div>
}
