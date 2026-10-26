import assert from 'node:assert/strict'
import * as M from '../src/workspaces/gameplay/model'
import * as C from '../src/workspaces/gameplay/canvas'
import * as S from '../src/workspaces/gameplay/signals'
let checks=0
const test=(name:string,run:()=>void)=>{run();console.log(`PASS ${name}`);checks++}
function fork(){
 let f=M.createFlow('signals'),a=C.createProgressNode(f,{x:400,y:0});f=a.flow
 const b=C.createProgressNode(f,{x:400,y:220});f=b.flow
 f=M.connectNodes(f,f.start,a.id,'input','output').flow;f=M.connectNodes(f,f.start,b.id,'input','output').flow
 const end=C.createEndNode(f,{x:800,y:400});f=M.connectNodes(end.flow,b.id,end.id,'input','output').flow
 return {flow:f,a:a.id,b:b.id}
}
test('one delivery is atomic; FIFO appends generated cancellation after pending activation',()=>{
 const {flow,a,b}=fork();const base=S.initializeQuest(flow,S.createSimState(flow))
 const pending=S.settleProgress(flow,base,flow.start,'succeeded',true)
 assert.equal(pending.queue.length,2);assert.equal(S.progressState(pending,a),'inactive')
 const first=S.stepSignal(flow,pending)
 assert.equal(S.progressState(first,a),'running');assert.equal(S.progressState(first,b),'inactive')
 assert.equal(first.queue[0].to,b);assert.equal(first.queue[1].signal.kind,'cancel')
 assert.equal(S.progressState(pending,a),'inactive','input snapshots are immutable')
 assert.equal(S.settleProgress(flow,first,a,'succeeded',true),first,'events cannot interleave a pulse')
 assert.deepEqual(S.injectSignal(flow,first,b,'input',{kind:'activate'}),first)
})
test('first end latches quest, drops queued arrivals, terminates running siblings without cancellation',()=>{
 let {flow,a,b}=fork();let sim=S.drainSignals(flow,S.settleProgress(flow,S.initializeQuest(flow,S.createSimState(flow)),flow.start,'succeeded',true))
 const end=C.createEndNode(flow,{x:800,y:0});flow=end.flow
 flow=M.connectNodes(flow,a,end.id,'input','output').flow;flow=M.connectNodes(flow,a,end.id,'input2','output').flow
 const other=C.createEndNode(flow,{x:800,y:200});flow=other.flow;flow=M.connectNodes(flow,a,other.id,'input2','output').flow
 sim=S.syncSimState(sim,flow);sim=S.settleProgress(flow,sim,a,'succeeded',true)
 const terminal=S.stepSignal(flow,sim)
 assert.deepEqual(terminal.outcome,{endId:end.id,result:'success'});assert.equal(terminal.queue.length,0)
 assert.equal(terminal.discarded.length,2);assert.equal(terminal.ends[other.id],null)
 assert.equal(S.progressState(terminal,b),'terminated');assert.equal(S.progressState(terminal,a),'succeeded')
 assert.equal(terminal.log.length,sim.log.length+1)
 assert.equal(S.settleProgress(flow,terminal,b,'failed'),terminal)
 assert.equal(S.injectSignal(flow,terminal,end.id,'input2',{kind:'activate'}),terminal)
})
test('failure may win first too; never success-biased',()=>{
 let f=M.createFlow();const e=C.createEndNode(f,{x:400,y:0});f=e.flow
 f=M.connectNodes(f,f.start,e.id,'input2','output').flow;f=M.connectNodes(f,f.start,e.id,'input','output').flow
 const sim=S.settleProgress(f,S.initializeQuest(f,S.createSimState(f)),f.start,'succeeded')
 assert.equal(sim.outcome?.result,'failure');assert.equal(sim.discarded.length,1)
})
test('links array permutation does not change order or full runtime result',()=>{
 const {flow}=fork(),reordered=structuredClone(flow);reordered.logic!.links.reverse()
 const run=(f:M.ProgressFlow)=>S.settleProgress(f,S.initializeQuest(f,S.createSimState(f)),f.start,'succeeded')
 assert.deepEqual(run(flow),run(reordered))
})
test('movement persists local fanout order; ties use fixed ID comparison; reverse order is independent',()=>{
 const {flow,a,b}=fork();const moved=C.moveCanvasNodes(flow,{[b]:{x:400,y:-100}})
 assert.equal(M.orderedLinks(moved)[0].to,b)
 assert.equal(M.orderedLinks(flow)[0].to,a)
 const roundtrip=M.parseFlow(JSON.stringify(moved));delete roundtrip.layout
 assert.equal(M.orderedLinks(roundtrip)[0].to,b,'engine needs no layout')
})
test('old missing-order graph normalizes deterministically rather than using array order',()=>{
 const {flow}=fork();for(const link of flow.logic!.links){delete link.order;delete link.reverseOrder}
 const reversed=structuredClone(flow);reversed.logic!.links.reverse()
 assert.deepEqual(M.orderedLinks(flow).map(l=>l.id),M.orderedLinks(reversed).map(l=>l.id))
 assert(M.parseFlow(JSON.stringify(flow)).logic!.links.every(l=>l.order!==undefined&&l.reverseOrder!==undefined))
})
test('stepped, automatic and resumed execution produce identical states and trace',()=>{
 const {flow}=fork(),base=S.initializeQuest(flow,S.createSimState(flow))
 const pending=S.settleProgress(flow,base,flow.start,'succeeded',true)
 let stepped=pending;while(stepped.queue.length)stepped=S.stepSignal(flow,stepped)
 assert.deepEqual(stepped,S.drainSignals(flow,pending))
 assert.deepEqual(stepped,S.settleProgress(flow,base,flow.start,'succeeded'))
})
test('budget exhaustion rolls back the entire external event and retains diagnostic trace',()=>{
 const {flow,a}=fork(),base=S.initializeQuest(flow,S.createSimState(flow))
 const pending=S.settleProgress(flow,base,flow.start,'succeeded',true);pending.execution!.budget=1
 const failed=S.stepSignal(flow,pending)
 assert.equal(failed.fault?.code,'budget-exceeded');assert.deepEqual(failed.progress,base.progress)
 assert.equal(failed.queue.length,0);assert(failed.log.length);assert(failed.discarded.length)
 assert.equal(S.settleProgress(flow,failed,a,'succeeded'),failed)
 assert.equal(S.resetSimState(flow).fault,null)
})
test('changing executable graph mid-pulse faults and restores checkpoint',()=>{
 const {flow,a}=fork(),base=S.initializeQuest(flow,S.createSimState(flow)),pending=S.settleProgress(flow,base,flow.start,'succeeded',true)
 const changed=C.moveCanvasNodes(flow,{[a]:{x:500,y:500}})
 const failed=S.stepSignal(changed,pending)
 assert.equal(failed.fault?.code,'graph-changed');assert.deepEqual(failed.progress,base.progress)
})
test('draft predicate can be preset but never broadcasts after initialization',()=>{
 let f=M.createFlow();const p=C.createPredicateNode(f,{x:0,y:400});f=p.flow
 const n=C.createProgressNode(f,{x:400,y:400});f=n.flow;f=M.connectNodes(f,p.id,n.id,'input').flow
 const end=C.createEndNode(f,{x:800,y:0});f=M.connectNodes(end.flow,f.start,end.id,'input','output').flow
 const init=S.initializeQuest(f,S.createSimState(f)),changed=S.setPredicateTruth(f,init,p.id,true,true)
 assert.equal(changed.predicates[p.id],true);assert.equal(changed.queue.length,0);assert.equal(changed.pulse,init.pulse)
 assert.equal(S.progressState(changed,n.id),'inactive')
})
test('illegal cycles, duplicate links, fanout and graph size prevent simulation',()=>{
 const {flow,a}=fork(),duplicate=structuredClone(flow);duplicate.logic!.links.push({...duplicate.logic!.links[0],id:'duplicate'})
 assert(M.validateFlow(duplicate).some(i=>i.severity==='error'))
 const invalid=structuredClone(flow);invalid.logic!.links.push({id:'cycle',from:a,to:flow.start,port:'input',fromPort:'output'})
 assert.equal(S.initializeQuest(invalid,S.createSimState(invalid)).fault?.code,'invalid-graph')
 const large=structuredClone(flow);for(let i=0;i<M.FLOW_LIMITS.nodes;i++)large.progress[`extra${i}`]=structuredClone(large.progress[large.start])
 assert.equal(S.initializeQuest(large,S.createSimState(large)).fault?.code,'invalid-graph')
})
test('per-port fanout limit is enforced independently of graph node count',()=>{
 const {flow,a}=fork()
 for(let i=0;i<130;i++){
   const id=`fan${i}`;flow.progress[id]=structuredClone(flow.progress[a])
   flow.logic!.links.push({id:`fanlink${i}`,from:flow.start,to:id,fromPort:'output',port:'input'})
 }
 assert(M.validateFlow(flow).some(i=>i.severity==='error'&&i.message.includes('端口最多')))
 assert.equal(S.initializeQuest(flow,S.createSimState(flow)).fault?.code,'invalid-graph')
})
test('inverse diamond cancellation does not repeatedly expand the same inactive state',()=>{
 let f=M.createFlow();const u=C.createProgressNode(f,{x:200,y:0});f=u.flow
 const a=C.createProgressNode(f,{x:400,y:0});f=a.flow;const b=C.createProgressNode(f,{x:400,y:200});f=b.flow
 const join=C.createProgressNode(f,{x:600,y:0});f=join.flow
 for(const [from,to] of [[f.start,u.id],[u.id,a.id],[u.id,b.id],[a.id,join.id],[b.id,join.id]])f=M.connectNodes(f,from,to,'input','output').flow
 const end=C.createEndNode(f,{x:900,y:0});f=M.connectNodes(end.flow,join.id,end.id,'input','output').flow
 const sim=S.injectSignal(f,S.initializeQuest(f,S.createSimState(f)),join.id,'output',{kind:'cancel'})
 assert.equal(sim.fault,null)
 assert(sim.log.some(row=>row.reason?.includes('相同状态的取消')))
 assert.equal(sim.log.filter(row=>row.to===f.start).length,1)
})
test('no end is valid syntax but initialization fails immediately, including deferred empty pulses',()=>{
 const flow=M.createFlow('no-end'),before=S.createSimState(flow)
 assert.equal(M.validateFlow(flow).filter(issue=>issue.severity==='error').length,0)
 for(const deferred of [false,true]){
   const sim=S.initializeQuest(flow,before,deferred)
   assert.deepEqual(sim.outcome,{endId:null,result:'failure',reason:'no-reachable-end'})
   assert.equal(sim.progress[flow.start],'terminated');assert.equal(sim.fault,null)
   assert.equal(sim.execution,null);assert.equal(sim.queue.length,0);assert.deepEqual(sim.ends,{})
   assert.equal(S.settleProgress(flow,sim,flow.start,'succeeded'),sim)
 }
 assert.equal(before.initialized,false);assert.equal(before.outcome,null)
 assert.equal(S.resetSimState(flow).outcome,null)
})
test('both end ports and both progress outputs count structurally; unused settlement port fails without deliveries',()=>{
 let flow=M.createFlow('failure-only');const end=C.createEndNode(flow,{x:-900,y:-700});flow=end.flow
 flow=M.connectNodes(flow,flow.start,end.id,'input2','output2').flow
 const base=S.initializeQuest(flow,S.createSimState(flow));assert.equal(base.outcome,null)
 const failure=S.settleProgress(flow,base,flow.start,'failed')
 assert.deepEqual(failure.outcome,{endId:end.id,result:'failure'})
 const noOutput=S.settleProgress(flow,base,flow.start,'succeeded',true)
 assert.deepEqual(noOutput.outcome,{endId:null,result:'failure',reason:'no-running-progress'})
 assert.equal(noOutput.ends[end.id],null)
})
test('leaf progress may run and settle beside a live main line; stranded leaves cannot keep quest alive',()=>{
 const {flow,a,b}=fork();let sim=S.settleProgress(flow,S.initializeQuest(flow,S.createSimState(flow)),flow.start,'succeeded')
 assert.equal(sim.outcome,null);assert.equal(sim.progress[a],'running');assert.equal(sim.progress[b],'running')
 const leafDone=S.settleProgress(flow,sim,a,'succeeded',true)
 assert.equal(leafDone.queue.length,0);assert.equal(leafDone.outcome,null);assert.equal(leafDone.progress[b],'running')
 sim=S.settleProgress(flow,sim,b,'failed',true)
 assert.deepEqual(sim.outcome,{endId:null,result:'failure',reason:'no-reachable-end'})
 assert.equal(sim.progress[a],'terminated');assert.equal(sim.progress[b],'failed')
 assert(Object.values(sim.ends).every(value=>value===null),'automatic failure does not trigger an end or its reward')
})
function waitingGate(){
 let flow=M.createFlow('waiting-gate');const predicate=C.createPredicateNode(flow,{x:0,y:200});flow=predicate.flow
 const gate=C.createTransitionNode(flow,{x:300,y:0});flow=gate.flow
 const end=C.createEndNode(flow,{x:600,y:0});flow=end.flow
 flow=M.connectNodes(flow,flow.start,gate.id,'input','output').flow
 flow=M.connectNodes(flow,predicate.id,gate.id,'input2','output').flow
 flow=M.connectNodes(flow,gate.id,end.id,'input','output').flow
 return {flow,predicate:predicate.id,end:end.id}
}
test('pending Q/N deliveries and debugger pauses postpone automatic failure until the final signal',()=>{
 const {flow,predicate}=waitingGate(),base=S.initializeQuest(flow,S.createSimState(flow))
 let sim=S.settleProgress(flow,base,flow.start,'succeeded',true)
 assert.equal(sim.outcome,null);assert(!Object.values(sim.progress).includes('running'))
 const expected=S.drainSignals(flow,sim)
 while(sim.queue.length){assert.equal(sim.outcome,null);sim=S.stepSignal(flow,sim)}
 assert.deepEqual(sim,expected)
 assert.deepEqual(sim.outcome,{endId:null,result:'failure',reason:'no-running-progress'})
 assert.equal(S.setPredicateTruth(flow,sim,predicate,true),sim,'future predicate truth cannot rescue a failed quest')
 assert.equal(S.injectSignal(flow,sim,flow.start,'output',{kind:'activate'}),sim)
})
test('preset predicate signals may reach an explicit end in this pulse; explicit terminal wins',()=>{
 const {flow,predicate,end}=waitingGate()
 const preset=S.setPredicateTruth(flow,S.createSimState(flow),predicate,true)
 const base=S.initializeQuest(flow,preset)
 assert.equal(base.outcome,null)
 const sim=S.settleProgress(flow,base,flow.start,'succeeded')
 assert.deepEqual(sim.outcome,{endId:end,result:'success'})
})
test('weak connectivity and a future predicate path do not substitute for forward reachability',()=>{
 let flow=M.createFlow('reverse-only');const leaf=C.createProgressNode(flow,{x:300,y:0});flow=leaf.flow
 const predicate=C.createPredicateNode(flow,{x:0,y:200});flow=predicate.flow
 const end=C.createEndNode(flow,{x:600,y:200});flow=end.flow
 flow=M.connectNodes(flow,flow.start,leaf.id,'input','output').flow
 flow=M.connectNodes(flow,predicate.id,leaf.id,'input','output').flow
 flow=M.connectNodes(flow,predicate.id,end.id,'input','output').flow
 assert(M.connectedToStart(flow).has(end.id))
 const sim=S.initializeQuest(flow,S.createSimState(flow))
 assert.equal(sim.outcome?.endId,null);assert.equal(sim.outcome?.result,'failure')
 assert.equal(S.setPredicateTruth(flow,sim,predicate.id,true),sim)
 // The same preset truth can end this quest during initialization: its queued A
 // must settle before structural failure is considered.
 const preset=S.setPredicateTruth(flow,S.createSimState(flow),predicate.id,true)
 const explicit=S.initializeQuest(flow,preset,true);assert.equal(explicit.outcome,null);assert(explicit.queue.length)
 assert.deepEqual(S.drainSignals(flow,explicit).outcome,{endId:end.id,result:'success'})
})
function backgroundGoal() {
 let flow=M.createFlow('background-goal')
 const end=C.createEndNode(flow,{x:600,y:0});flow=M.connectNodes(end.flow,flow.start,end.id,'input','output').flow
 const goal=C.createObjectiveNode(flow,{x:0,y:200});flow=goal.flow
 const gate=C.createTransitionNode(flow,{x:300,y:200});flow=gate.flow
 flow=M.connectNodes(flow,goal.id,gate.id,'input','output').flow
 flow=M.connectNodes(flow,goal.id,gate.id,'input2','output2').flow
 flow=M.connectNodes(flow,gate.id,end.id,'input','output').flow
 flow.objectives![goal.id].goal={kind:'collect',params:{count:3}}
 return {flow,goal:goal.id,gate:gate.id,end:end.id}
}
test('background goal roundtrip, two distinct outputs, no inputs; delete cleans links and layout',()=>{
 const {flow,goal}=backgroundGoal()
 const parsed=M.parseFlow(JSON.stringify(flow));assert.deepEqual(parsed,flow)
 assert.deepEqual(M.inputPorts(flow,goal),[]);assert.deepEqual(M.outputPorts(flow,goal),['output','output2'])
 assert.equal(M.canConnectNodes(flow,flow.start,goal,'input','output'),false)
 assert.equal(M.validateFlow(flow).some(issue=>issue.severity==='error'),false)
 assert.equal(C.socketOffset(flow,goal,'output2').y,104)
 const removed=M.removeNode(flow,goal);assert(!removed.objectives![goal]);assert(!removed.logic!.links.some(link=>link.from===goal));assert(!removed.layout!.positions[goal])
 for (const replacement of [{goal:{kind:'collect',params:{bad:[]}}},{goal:{kind:7,params:{}}}]) {
  const invalid=structuredClone(flow) as any;invalid.objectives[goal]=replacement;assert.throws(()=>M.parseFlow(JSON.stringify(invalid)))
 }
 const duplicate=structuredClone(flow) as any;duplicate.predicates={[goal]:{conditions:[]}};assert.throws(()=>M.parseFlow(JSON.stringify(duplicate)))
})
test('effective goals start atomically; drafts stay inactive and cannot settle; reset returns all inactive',()=>{
 let {flow,goal}=backgroundGoal();const draft=C.createObjectiveNode(flow,{x:0,y:400});flow=draft.flow
 const empty=S.createSimState(flow);assert.equal(S.objectiveState(empty,goal),'inactive');assert.equal(S.settleObjective(flow,empty,goal,'succeeded'),empty)
 const sim=S.initializeQuest(flow,empty,true);assert.equal(S.progressState(sim,flow.start),'running');assert.equal(S.objectiveState(sim,goal),'running');assert.equal(S.objectiveState(sim,draft.id),'inactive')
 assert.equal(S.settleObjective(flow,sim,draft.id,'succeeded'),sim)
 assert.equal(S.objectiveState(S.resetSimState(flow),goal),'inactive')
})
test('goal ignores C, rejects external A, answers Q by settled port, and never settles twice',()=>{
 const {flow,goal}=backgroundGoal();let sim=S.initializeQuest(flow,S.createSimState(flow))
 sim=S.injectSignal(flow,sim,goal,'output',{kind:'cancel'});assert.equal(S.objectiveState(sim,goal),'running')
 sim=S.injectSignal(flow,sim,goal,'output',{kind:'activate'});assert.equal(sim.log.at(-1)!.accepted,false)
 for (const outcome of ['succeeded','failed'] as const) {
  const settled=S.settleObjective(flow,sim,goal,outcome);assert.equal(S.objectiveState(settled,goal),outcome)
  assert.equal(S.settleObjective(flow,settled,goal,outcome==='succeeded'?'failed':'succeeded'),settled)
  assert(settled.log.some(row=>row.to===goal&&row.signal.kind==='query'&&row.emitted?.[0]?.signal.kind==='activate'))
  assert(settled.log.some(row=>row.to===goal&&row.signal.kind==='query'&&row.emitted?.[0]?.signal.kind==='none'))
  assert.equal(S.objectiveState(S.injectSignal(flow,settled,goal,'output',{kind:'cancel'}),goal),outcome)
 }
})
test('goal success and failure broadcast only their own outputs; quest terminal blocks late instance reports',()=>{
 for (const outcome of ['succeeded','failed'] as const) {
  let {flow,goal,end}=backgroundGoal();flow.logic!.links=flow.logic!.links.filter(link=>link.from!==goal)
  flow=M.connectNodes(flow,goal,end,'input','output').flow;flow=M.connectNodes(flow,goal,end,'input2','output2').flow
  const pending=S.settleObjective(flow,S.initializeQuest(flow,S.createSimState(flow)),goal,outcome,true)
  assert.equal(pending.queue.length,1);assert.equal(pending.queue[0].port,outcome==='succeeded'?'input':'input2')
  const terminal=S.drainSignals(flow,pending);assert.equal(terminal.outcome?.result,outcome==='succeeded'?'success':'failure')
  assert.equal(S.settleObjective(flow,terminal,goal,'failed'),terminal)
 }
})
test('running background goals do not sustain quest, even with their own path to an end',()=>{
 let {flow,goal}=backgroundGoal();let sim=S.initializeQuest(flow,S.createSimState(flow))
 sim=S.settleProgress(flow,sim,flow.start,'failed');assert.equal(sim.outcome?.endId,null);assert.equal(S.objectiveState(sim,goal),'running')
 assert.equal(S.settleObjective(flow,sim,goal,'succeeded'),sim,'auto-failure cannot be revived')
 const orphan=M.createFlow();const e=C.createEndNode(orphan,{x:600,y:0}),g=C.createObjectiveNode(e.flow,{x:0,y:200})
 let stranded=M.connectNodes(g.flow,g.id,e.id,'input','output').flow
 stranded=M.connectNodes(stranded,stranded.start,e.id,'input2','output2').flow
 // The start has a structural end path, so it survives until cancelled; the goal still cannot sustain it.
 const initialized=S.initializeQuest(stranded,S.createSimState(stranded))
 const cancelled=S.injectSignal(stranded,initialized,stranded.start,'output',{kind:'cancel'})
 assert.equal(cancelled.outcome?.endId,null);assert.equal(S.objectiveState(cancelled,g.id),'running')
})
test('goal instance outcomes obey pulse rollback, signature guards and event serialization',()=>{
 const {flow,goal}=backgroundGoal();const initial=S.initializeQuest(flow,S.createSimState(flow))
 const pending=S.settleObjective(flow,initial,goal,'succeeded',true)
 assert.equal(S.settleObjective(flow,pending,goal,'failed'),pending)
 const changed=structuredClone(flow);changed.objectives![goal].goal.params.count=5
 const rolledBack=S.drainSignals(changed,pending);assert.equal(rolledBack.fault?.code,'graph-changed');assert.equal(S.objectiveState(rolledBack,goal),'running')
 assert.equal(S.objectiveState(initial,goal),'running','original snapshots remain immutable')
})
test('background goal with end reachability cannot rescue a stranded running progress',()=>{
 let {flow,goal}=backgroundGoal();const leaf=C.createProgressNode(flow,{x:300,y:500});flow=leaf.flow
 flow=M.connectNodes(flow,flow.start,leaf.id,'input','output2').flow
 const sim=S.settleProgress(flow,S.initializeQuest(flow,S.createSimState(flow)),flow.start,'failed')
 assert.equal(sim.outcome?.endId,null);assert(sim.outcome&&'reason' in sim.outcome&&sim.outcome.reason==='no-reachable-end')
 assert.equal(S.objectiveState(sim,goal),'running');assert.equal(S.progressState(sim,leaf.id),'terminated')
})
test('background goals count toward shared execution limits',()=>{
 const {flow}=backgroundGoal()
 flow.objectives=Object.fromEntries(Array.from({length:M.FLOW_LIMITS.nodes},(_,index)=>[`goal_${index}`,{goal:{kind:'collect',params:{}}}]))
 assert(M.validateFlow(flow).some(issue=>issue.severity==='error'&&issue.path==='graph'))
 assert.equal(S.initializeQuest(flow,S.createSimState(flow)).fault?.code,'invalid-graph')
})
console.log(`${checks} quest signal checks passed`)
