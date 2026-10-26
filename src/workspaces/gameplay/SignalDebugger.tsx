import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import * as M from './model'
import * as S from './signals'
import type { SignalBreakpoints } from './signalDebugging'
type TraceRow = S.Delivery & Partial<Pick<S.SimDelivery,'accepted' | 'reason' | 'emitted' | 'changes' | 'rolledBack' | 'assessment'>>

export function SignalDebugger({ flow, sim, playing, duration, disabled, onInitialize, onStep, onPlay, onReset, onDuration, onFocus, resolveText, breakpoints, stopReason, onClearBreakpoints, viewTools, expanded = true, onToggleExpanded }: {
  viewTools?: ReactNode; expanded?: boolean; onToggleExpanded?: () => void
  breakpoints: SignalBreakpoints; stopReason: string; onClearBreakpoints: () => void
  flow: M.ProgressFlow; sim: S.FlowSimState; playing: boolean; duration: number; disabled: boolean
  onInitialize: () => void; onStep: () => void; onPlay: () => void; onReset: () => void; onDuration: (value: number) => void
  onFocus: (delivery: S.Delivery) => void; resolveText?: (key: string) => string | null
}) {
  const [inspected, setInspected] = useState<number | null>(null)
  const detailsId=useId()
  const [kind, setKind] = useState('all')
  const [search, setSearch] = useState('')
  const [scroll, setScroll] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<'queue' | 'history' | 'discarded'>('queue')
  const resetScroll=()=>{setScroll(0);if(scroller.current)scroller.current.scrollTop=0}
  const chooseTab=(value: typeof tab)=>{resetScroll();setTab(value)}
  const label = (id: string | null) => {
    if (!id) return '手动注入'
    return M.flowNodeLabel(flow, id, resolveText)
  }
  const port = (delivery: S.Delivery) => M.getTransitionNode(flow,delivery.to) ? delivery.port === 'input' ? '并且' : delivery.port === 'input2' ? '或者' : '查询' : M.getEndNode(flow,delivery.to) ? delivery.port === 'input2' ? '失败入' : '成功入' : ({input:'激活',input2:'失败入',output:'成功 / 查询',output2:'失败 / 查询'})[delivery.port]
  const allRows: TraceRow[] = tab === 'queue' ? sim.queue : tab === 'history' ? [...sim.log].reverse() : sim.discarded
  const rows = allRows.filter(delivery=>(kind==='all'||kind==='ignored'&&delivery.accepted===false||delivery.signal.kind===kind)&&(!search||`${label(delivery.from)} ${label(delivery.to)} ${delivery.from} ${delivery.to} #${delivery.traceId}`.toLowerCase().includes(search.toLowerCase())))
  const index = useMemo(()=>S.traceIndex(sim),[sim])
  const selected = (inspected === null ? sim.last?.delivery.traceId === undefined ? undefined : index.get(sim.last.delivery.traceId) : index.get(inspected)) as TraceRow | undefined
  const parents = selected ? S.traceParents(selected) : []
  const ancestors: number[] = [], visited = new Set<number>()
  const pending = [...parents]
  for(let cursor=0;cursor<pending.length&&ancestors.length<32;cursor++){
    const id=pending[cursor];if(visited.has(id))continue
    visited.add(id);ancestors.push(id)
    const entry=index.get(id);if(entry)pending.push(...S.traceParents(entry))
  }
  const event = sim.events.find(event=>event.id===selected?.eventId)
  const inspect = (delivery: S.Delivery) => {setInspected(delivery.traceId ?? null);onFocus(delivery)}
  const inspectId = (id: number) => {setInspected(id);const row=index.get(id);if(row)onFocus(row)}
  const busy = S.isBusy(sim)
  const autoFailure = sim.outcome?.endId === null ? S.AUTO_FAILURE_REASONS[sim.outcome.reason] : null
  const rowHeight = 28, firstRow = Math.max(0,Math.min(Math.floor(scroll/rowHeight)-3,rows.length-1)), shown = rows.slice(firstRow,firstRow+18)
  return <section className={`signal-debugger quest-graph-tools${expanded ? ' is-expanded' : ''}`} aria-label="信号调试器">
    <header className="quest-tools-bar" aria-label="Quest 图工具栏">
      <div className="quest-view-tools" role="group" aria-label="画布视图工具">{viewTools}</div>
      <div className="quest-sim-tools" role="group" aria-label="模拟控制">
      <button type="button" disabled={disabled || sim.initialized || !!sim.fault} title="初始化任务，开始模拟" onClick={onInitialize}>初始化任务</button>
      <button type="button" className="quest-play" disabled={disabled || !busy} title={playing ? '暂停信号播放' : '播放待投递信号'} onClick={onPlay}><span aria-hidden="true">{playing ? 'Ⅱ' : '▷'}</span>{playing ? '暂停' : '播放'}</button>
      <button type="button" disabled={disabled || !busy} title="处理队首的一条信号" onClick={onStep}>单步</button>
      <button type="button" disabled={disabled} title="清空本地模拟状态，恢复图编辑" onClick={onReset}>重置模拟</button>
      </div>
      <span className={`signal-debugger-status${sim.outcome ? ` is-terminal is-${sim.outcome.result}` : ''}${sim.fault ? ' is-fault' : ''}`} role="status" title={autoFailure ?? undefined}>{sim.fault ? '执行故障 · 已回退' : autoFailure ? `任务自动失败 · ${autoFailure}` : sim.outcome ? `任务${sim.outcome.result === 'success' ? '成功' : '失败'} · ${label(sim.outcome.endId)}` : !sim.initialized ? '未初始化' : busy ? `${playing ? '播放中' : '已暂停'} · 待投递 ${sim.queue.length}` : '等待事件'}</span>
      {onToggleExpanded && <button type="button" className="quest-tools-toggle" aria-expanded={expanded} aria-controls={detailsId} title={expanded ? '收起调试详情，扩大画布' : '展开速度、断点与信号记录'} onClick={onToggleExpanded}><span aria-hidden="true" className="quest-tools-chevron">⌃</span>{expanded ? '收起' : '调试'}{!!sim.queue.length && <span className="quest-tools-badge">{sim.queue.length}</span>}</button>}
    </header>
    {stopReason&&<div className="signal-debugger-stop" role="status">● {stopReason}</div>}
    <div id={detailsId} className="quest-tools-details" hidden={!expanded}>
    <div className="signal-debugger-controls">
      <span className="quest-tools-section-label">模拟设置</span>
      <label className="signal-debugger-speed">速度<select aria-label="信号播放速度" value={duration} onChange={event=>onDuration(Number(event.target.value))}><option value={1200}>慢速</option><option value={600}>正常</option><option value={180}>快速</option><option value={0}>无动画</option></select></label>
      <button type="button" disabled={!breakpoints.nodes.length&&!breakpoints.links.length} title="清除所有本地断点" onClick={onClearBreakpoints}>断点 {breakpoints.nodes.length+breakpoints.links.length} ×</button>
      <span className="signal-debugger-counter">事件 #{sim.pulse}{sim.execution ? ` · ${sim.execution.processed}/${sim.execution.budget}` : ''}</span>
    </div>
    <div className="signal-debugger-body">
      <div className="signal-debugger-queue">
        <nav aria-label="信号记录"><button type="button" className={tab==='queue'?'is-active':''} onClick={()=>chooseTab('queue')}>待投递 {sim.queue.length}</button><button type="button" className={tab==='history'?'is-active':''} onClick={()=>chooseTab('history')}>已处理 {sim.log.length}</button><button type="button" className={tab==='discarded'?'is-active':''} onClick={()=>chooseTab('discarded')}>已丢弃 {sim.discarded.length}</button></nav>
        <div className="signal-debugger-filters"><input aria-label="筛选信号节点" placeholder="节点名称或 #投递编号" value={search} onChange={event=>{resetScroll();setSearch(event.target.value)}}/><select aria-label="筛选信号类型" value={kind} onChange={event=>{resetScroll();setKind(event.target.value)}}><option value="all">全部信号</option><option value="activate">A 激活</option><option value="query">Q 查询</option><option value="cancel">C 取消</option><option value="none">N 否定应答</option><option value="ignored">仅忽略</option></select><small>{rows.length} 条</small></div>
        <div ref={scroller} onScroll={event=>setScroll(event.currentTarget.scrollTop)} className="signal-debugger-rows" role="list" aria-label={tab==='queue'?'待投递信号':tab==='history'?'已处理信号':'丢弃信号'}>
          {!rows.length && <p className="signal-debugger-empty">{tab==='queue' ? sim.outcome ? '任务已结束，队列已清空' : '队列为空 · Ctrl 点击运行中的进度可结算，点击条件可改变真值' : '暂无记录'}</p>}
          <div style={{height:rows.length*rowHeight,position:'relative'}}>{shown.map((delivery,offset)=>{const index=firstRow+offset;return <button type="button" role="listitem" key={delivery.traceId ?? `${tab}:${index}`} data-trace-id={delivery.traceId} aria-posinset={index+1} aria-setsize={rows.length} style={{position:'absolute',top:index*rowHeight,height:rowHeight}} className={`signal-debugger-row${tab==='queue'&&index===0?' is-head':''}${inspected===delivery.traceId?' is-inspected':''}`} title={delivery.reason ?? '点击定位接收节点'} onClick={()=>inspect(delivery)}>
            <span className="signal-debugger-index">{tab==='queue'&&index===0?'▶':`#${delivery.traceId ?? index+1}`}</span><b className={`signal-kind is-${delivery.signal.kind}`}>{S.SIGNAL_LABELS[delivery.signal.kind]}</b><span className="signal-debugger-route">{label(delivery.from)} <i>→</i> {label(delivery.to)}</span><small>{port(delivery)}</small>{'round' in delivery && delivery.round !== undefined && <small>Q#{delivery.round}</small>}{delivery.rolledBack&&<small>已回退</small>}{'accepted' in delivery && <small>{delivery.accepted?'接收':'忽略'}</small>}{'reason' in delivery && delivery.reason && <small className="signal-debugger-reason">{delivery.reason}</small>}
          </button>})}</div>
        </div>
      </div>
      <aside className="signal-debugger-detail" aria-label="投递检查器">
        <small>{inspected===null?'最近已处理':'正在检查历史 / 队列'}</small>
        {sim.fault&&<p className="signal-debugger-fault">{sim.fault.message}</p>}
        {autoFailure&&<p className="signal-debugger-fault">任务自动失败：{autoFailure}。未触发结束节点奖励。</p>}
        {selected ? <>
          <strong><b className={`signal-kind is-${selected.signal.kind}`}>{S.SIGNAL_LABELS[selected.signal.kind]}</b> #{selected.traceId} · {label(selected.to)}</strong>
          <p>{selected.rolledBack?'本次事件已回退 · 以下变化不生效':selected.accepted===undefined ? '尚未投递' : selected.accepted?'已接收':'已忽略'}{selected.round===undefined?'':` · 查询轮次 #${selected.round}`}</p>
          <p>{selected.reason ?? (selected.emitted ? `产生 ${selected.emitted.length} 条新投递` : '仍在 FIFO 队列中')}</p>
          <p className="signal-debugger-event">事件 #{selected.eventId} · {event?.label ?? '事件说明已裁剪'} {event?.nodeId?label(event.nodeId):''}</p>
          {selected.changes?.map((change,index)=><p key={index}>{label(change.id)}：{change.text}</p>)}
          {selected.assessment&&<div className="signal-debugger-causes"><small>逻辑查询 #{selected.assessment.round} · {selected.assessment.conjunction&&selected.assessment.disjunction?'通过':'未通过'}</small><p>并且{selected.assessment.conjunction?'满足':'不满足'} · 或者{selected.assessment.disjunction?'满足':'不满足'}</p>{selected.assessment.answers.map(answer=>{const link=flow.logic?.links.find(link=>link.id===answer.link);return <button type="button" key={answer.link} disabled={answer.traceId===undefined} onClick={()=>inspectId(answer.traceId!)}>#{answer.traceId??'—'} {S.SIGNAL_LABELS[answer.signal]} · {link?label(link.from):answer.link}</button>})}</div>}
          <div className="signal-debugger-causes"><small>因果来源{parents.length>1?'（含逻辑的全部应答）':''}</small>
            {!parents.length&&<p>外部事件直接产生</p>}
            {ancestors.map(id=>{const ancestor=index.get(id);return <button type="button" key={id} aria-label={`检查来源 #${id}`} onClick={()=>inspectId(id)}>#{id} {ancestor?`${S.SIGNAL_LABELS[ancestor.signal.kind]} → ${label(ancestor.to)}`:'历史已裁剪'}{parents.includes(id)?' · 直接来源':''}</button>})}
            {ancestors.length===32&&<small>显示前 32 个祖先；点击可继续追溯</small>}
          </div>
          {!!selected.emitted?.length&&<div className="signal-debugger-causes"><small>产生的投递</small>{selected.emitted.map(child=><button type="button" key={child.traceId} aria-label={`检查子投递 #${child.traceId}`} onClick={()=>inspectId(child.traceId!)}>#{child.traceId} {S.SIGNAL_LABELS[child.signal.kind]} → {label(child.to)}</button>)}</div>}
        </> : inspected!==null ? <><strong>#{inspected} 不在当前保留的轨迹中</strong><p>该历史已裁剪，不会用当前状态冒充当时状态。</p></> : <><strong>FIFO · 因果追踪</strong><p>点击任意投递检查当时的变化、父信号与新增投递。</p><p>右键节点或连线添加断点，或运行到选中节点。断点在投递前暂停；单步可越过当前断点。</p></>}
        {inspected!==null&&<button type="button" className="signal-debugger-follow" onClick={()=>setInspected(null)}>跟随最新投递</button>}
      </aside>
    </div>
    </div>
  </section>
}
