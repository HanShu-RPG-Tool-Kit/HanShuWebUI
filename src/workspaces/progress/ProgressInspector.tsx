import { Field, JsonField, TextField } from './Fields'
import { addNode, branches, clone, descendants, displayText, getNode, moveNode, parseFlow, removeNode, renameNode, reorderBranch, text, type Data, type FlowBranch, type FlowCondition, type FlowSelection, type FlowText, type ProgressFlow } from './model'

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

export function ProgressInspector({ flow, selection, onChange, onSelect, onPending, onNotice, locked }: {
  flow: ProgressFlow; selection: FlowSelection; onChange: (flow: ProgressFlow) => void; onSelect: (selection: FlowSelection) => void
  onPending: (label: string, value: boolean) => void; onNotice: (notice: string) => void; locked: boolean
}) {
  function edit(mutate: (next: ProgressFlow) => void) {
    const next = clone(flow); mutate(next)
    onChange(parseFlow(JSON.stringify(next)))
  }
  function attempt(action: () => void) { try { action() } catch (error) { onNotice(String(error)) } }
  const authorText = (label: string, value: FlowText, update: (next: ProgressFlow, value: FlowText) => void, multiline = false) => <AuthorText label={label} value={value} multiline={multiline} disabled={locked} onChange={(value) => edit((next) => update(next, value))} />

  if (selection.kind === 'flow') return <div className="flow-inspector-content">
    <h3>进度流程</h3>
    {authorText('流程名称', flow.title, (next, value) => { next.title = value })}
    {authorText('流程说明', flow.description, (next, value) => { next.description = value }, true)}
    <Field label="内容类别"><select disabled={locked} value={flow.kind} onChange={(event) => edit((next) => { next.kind = event.target.value as ProgressFlow['kind'] })}>
      <option value="task">任务</option><option value="chapter">章节推进</option><option value="exploration">探索解锁</option><option value="custom">自定义</option>
    </select></Field>
    <TextField label="文档 ID" value={flow.id} disabled={locked} onChange={(id) => edit((next) => { next.id = id })} />
    <p className="flow-hint">一个流程是一棵有起点的树。节点描述阶段，后续分支描述推进方式与条件；动作和奖励以资源引用保存。</p>
    <button type="button" disabled={locked || !getNode(flow, flow.root)} onClick={() => onSelect({ kind: 'node', id: flow.root })}>编辑起点</button>
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
    return <div className="flow-inspector-content">
      <h3>阶段 {id === flow.root && <span className="flow-badge">起点</span>}</h3>
      {authorText('阶段名称', node.title, (next, value) => { next.nodes[id].title = value })}
      {authorText('阶段说明', node.description, (next, value) => { next.nodes[id].description = value }, true)}
      <Field label="节点 ID"><input key={id} defaultValue={id} disabled={locked} onBlur={(event) => {
        const value = event.target.value.trim()
        if (value === id) return
        attempt(() => { onChange(renameNode(flow, id, value)); onSelect({ kind: 'node', id: value }) })
        event.target.value = id
      }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></Field>
      <Field label="后续分支方式"><select disabled={locked} value={node.branching} onChange={(event) => edit((next) => { next.nodes[id].branching = event.target.value as typeof node.branching })}>
        <option value="parallel">各分支分别推进</option><option value="choice">选择其中一条</option><option value="priority">按分支顺序选择</option>
      </select></Field>
      <label className="flow-check"><input type="checkbox" checked={node.completion === 'finish'} disabled={locked || (node.completion !== 'finish' && node.children.length > 0)} onChange={(event) => edit((next) => { next.nodes[id].completion = event.target.checked ? 'finish' : 'continue' })} />到达此节点后结束流程</label>
      {id !== flow.root && <Field label="所在父节点"><select value={parent ?? ''} disabled={locked || !parent} onChange={(event) => attempt(() => onChange(moveNode(flow, id, event.target.value)))}>
        {Object.entries(flow.nodes).filter(([key, n]) => !subtree.has(key) && n.completion !== 'finish').map(([key, n]) => <option key={key} value={key}>{displayText(n.title) || key} · {key}</option>)}
      </select></Field>}
      <div className="flow-section-heading"><h4>后续阶段 · {node.children.length}</h4><button type="button" disabled={locked || node.completion === 'finish'} onClick={() => attempt(() => {
        const result = addNode(flow, id); onChange(result.flow); onSelect({ kind: 'node', id: result.id })
      })}>＋ 阶段</button></div>
      <div className="flow-children">{node.children.map((b, index) => <div className="flow-child" key={b.id}>
        <button type="button" disabled={locked} onClick={() => onSelect({ kind: 'branch', parent: id, id: b.id })}><strong>{displayText(b.title) || b.id}</strong><small>→ {displayText(getNode(flow, b.target)?.title ?? text(b.target))}</small></button>
        <button type="button" disabled={locked || index === 0} aria-label={`上移分支 ${b.id}`} onClick={() => onChange(reorderBranch(flow, id, b.id, -1))}>↑</button>
        <button type="button" disabled={locked || index === node.children.length - 1} aria-label={`下移分支 ${b.id}`} onClick={() => onChange(reorderBranch(flow, id, b.id, 1))}>↓</button>
      </div>)}</div>
      {!node.children.length && <p className="flow-hint">可以添加后续阶段，也可以将当前节点标记为流程终点。</p>}
      {resourceFields('进入阶段的动作', 'onEnter')}
      {resourceFields('结束时的动作', 'onFinish')}
      {resourceFields('奖励引用', 'rewards')}
      <div className="flow-inline-actions"><button type="button" className="flow-danger" disabled={locked || id === flow.root} onClick={() => {
        if (window.confirm(`删除「${displayText(node.title) || id}」及全部后续阶段？`)) attempt(() => { onChange(removeNode(flow, id)); onSelect({ kind: 'node', id: parent ?? flow.root }) })
      }}>删除此分支</button></div>
    </div>
  }

  const { parent, id } = selection, node = getNode(flow, parent), branch = node?.children.find((b) => b.id === id)
  if (!node || !branch) return <p className="flow-hint">分支已移除，请重新选择。</p>
  const update = (mutate: (b: FlowBranch) => void) => edit((next) => mutate(next.nodes[parent].children.find((b) => b.id === id)!))
  const updateCondition = (index: number, patch: Partial<FlowCondition>) => update((b) => { Object.assign(b.conditions.items[index], patch) })
  const kinds: [FlowCondition['kind'], string][] = [['manual', '人工标记'], ['counter', '累计事件'], ['signal', '等待信号'], ['nodes', '等待其他阶段'], ['external', '外部条件引用']]
  return <div className="flow-inspector-content">
    <h3>推进分支</h3>
    <p className="flow-route">{displayText(node.title) || parent} <span>→</span> {displayText(getNode(flow, branch.target)?.title ?? text(branch.target))}</p>
    <AuthorText label="分支名称" value={branch.title} disabled={locked} onChange={(title) => update((b) => { b.title = title })} />
    <Field label="分支 ID"><input key={id} defaultValue={id} disabled={locked} onBlur={(event) => {
      const value = event.target.value.trim()
      if (value === id) return
      if (!value || branches(flow).some(({ branch: b }) => b.id === value)) { onNotice('分支 ID 不能为空或重复。'); event.target.value = id; return }
      update((b) => { b.id = value }); onSelect({ kind: 'branch', parent, id: value })
    }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /></Field>
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
    <p className="flow-hint">条件描述推进意图，当前编辑器不执行或模拟游戏逻辑。</p>
    <button type="button" disabled={locked || !getNode(flow, branch.target)} onClick={() => onSelect({ kind: 'node', id: branch.target })}>编辑后续阶段</button>
  </div>
}
