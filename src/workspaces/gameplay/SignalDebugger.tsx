import { useState } from 'react'
import * as M from './model'
import * as S from './signals'

export function SignalDebugger({ flow, sim, playing, duration, disabled, onInitialize, onStep, onPlay, onReset, onDuration, onFocus, resolveText }: {
  flow: M.ProgressFlow; sim: S.FlowSimState; playing: boolean; duration: number; disabled: boolean
  onInitialize: () => void; onStep: () => void; onPlay: () => void; onReset: () => void; onDuration: (value: number) => void
  onFocus: (delivery: S.Delivery) => void; resolveText?: (key: string) => string | null
}) {
  const [tab, setTab] = useState<'queue' | 'history' | 'discarded'>('queue')
  const label = (id: string | null) => {
    if (!id) return '手动注入'
    const node = M.getProgressNode(flow,id) ?? M.getPredicateNode(flow,id) ?? M.getEndNode(flow,id)
    return node ? M.displayText(node.title, resolveText) || (id === flow.start ? '开始进度' : id) : M.getTransitionNode(flow,id) ? `变迁 ${id}` : id
  }
  const port = (delivery: S.Delivery) => M.getTransitionNode(flow,delivery.to) ? delivery.port === 'input' ? '合取' : delivery.port === 'input2' ? '析取' : '查询' : M.getEndNode(flow,delivery.to) ? delivery.port === 'input2' ? '失败入' : '成功入' : ({input:'激活',input2:'失败入',output:'成功 / 查询',output2:'失败 / 查询'})[delivery.port]
  const rows: (S.Delivery & { accepted?: boolean; reason?: string })[] = tab === 'queue' ? sim.queue : tab === 'history' ? [...sim.log].reverse() : sim.discarded
  const busy = S.isBusy(sim), last = sim.last
  return <section className="signal-debugger" aria-label="信号调试器">
    <header className="signal-debugger-controls">
      <span className={`signal-debugger-status${sim.outcome ? ` is-terminal is-${sim.outcome.result}` : ''}${sim.fault ? ' is-fault' : ''}`} role="status">{sim.fault ? '执行故障 · 已回退' : sim.outcome ? `任务${sim.outcome.result === 'success' ? '成功' : '失败'} · ${label(sim.outcome.endId)}` : !sim.initialized ? '未初始化' : busy ? `${playing ? '播放中' : '已暂停'} · 待投递 ${sim.queue.length}` : '等待事件'}</span>
      <button type="button" disabled={disabled || sim.initialized || !!sim.fault} onClick={onInitialize}>初始化任务</button>
      <button type="button" disabled={disabled || !busy} title="处理队首的一条信号" onClick={onStep}>单步</button>
      <button type="button" disabled={disabled || !busy} onClick={onPlay}>{playing ? '暂停' : '播放'}</button>
      <label className="signal-debugger-speed">速度<select aria-label="信号播放速度" value={duration} onChange={event=>onDuration(Number(event.target.value))}><option value={1200}>慢速</option><option value={600}>正常</option><option value={180}>快速</option><option value={0}>无动画</option></select></label>
      <button type="button" disabled={disabled} onClick={onReset}>重置模拟</button>
      <span className="signal-debugger-counter">事件 #{sim.pulse}{sim.execution ? ` · ${sim.execution.processed}/${sim.execution.budget}` : ''}</span>
    </header>
    <div className="signal-debugger-body">
      <div className="signal-debugger-queue">
        <nav aria-label="信号记录"><button type="button" className={tab==='queue'?'is-active':''} onClick={()=>setTab('queue')}>待投递 {sim.queue.length}</button><button type="button" className={tab==='history'?'is-active':''} onClick={()=>setTab('history')}>已处理 {sim.log.length}</button><button type="button" className={tab==='discarded'?'is-active':''} onClick={()=>setTab('discarded')}>已丢弃 {sim.discarded.length}</button></nav>
        <div className="signal-debugger-rows" role="list" aria-label={tab==='queue'?'待投递信号':tab==='history'?'已处理信号':'丢弃信号'}>
          {!rows.length && <p className="signal-debugger-empty">{tab==='queue' ? sim.outcome ? '任务已结束，队列已清空' : '队列为空 · Ctrl 点击运行中的进度可结算，点击谓词可改变真值' : '暂无记录'}</p>}
          {rows.slice(0,100).map((delivery,index)=><button type="button" role="listitem" key={`${tab}:${index}`} className={`signal-debugger-row${tab==='queue'&&index===0?' is-head':''}`} title={delivery.reason ?? '点击定位接收节点'} onClick={()=>onFocus(delivery)}>
            <span className="signal-debugger-index">{tab==='queue'&&index===0?'▶':index+1}</span><b className={`signal-kind is-${delivery.signal.kind}`}>{S.SIGNAL_LABELS[delivery.signal.kind]}</b><span className="signal-debugger-route">{label(delivery.from)} <i>→</i> {label(delivery.to)}</span><small>{port(delivery)}</small>{'round' in delivery && delivery.round !== undefined && <small>Q#{delivery.round}</small>}{'accepted' in delivery && <small>{delivery.accepted?'接收':'忽略'}</small>}{'reason' in delivery && delivery.reason && <small className="signal-debugger-reason">{delivery.reason}</small>}
          </button>)}
          {rows.length>100&&<p className="signal-debugger-empty">显示前 100 条，共 {rows.length} 条</p>}
        </div>
      </div>
      <aside className="signal-debugger-detail" aria-label="最近投递详情"><small>最近已处理</small>
        {sim.fault ? <><strong>{sim.fault.code}</strong><p>{sim.fault.message}</p><p>故障轨迹保留供检查。重置后才能继续。</p></> : last ? <><strong><b className={`signal-kind is-${last.delivery.signal.kind}`}>{S.SIGNAL_LABELS[last.delivery.signal.kind]}</b> {label(last.delivery.to)} · {last.accepted?'已接收':'已忽略'}</strong><p>{last.reason ?? (sim.outcome ? '锁存终局，停止传播并清空剩余队列' : `追加 ${last.emitted.length} 条信号到队尾`)}</p>{last.changes.map((change,index)=><p key={index}>{label(change.id)}：{change.text}</p>)}</> : <><strong>FIFO · 逐条投递</strong><p>事件先入队；单步完成一条投递。播放在线上展示投递过程。</p><p>模拟初始化后锁定图编辑，重置后恢复。</p></>}
      </aside>
    </div>
  </section>
}
