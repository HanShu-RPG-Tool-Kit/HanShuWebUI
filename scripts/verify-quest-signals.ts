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
test('optional identifiers share a quest namespace; submission structure and required capability are validated',()=>{
 let {flow,goal}=backgroundGoal()
 const condition=C.createPredicateNode(flow,{x:0,y:400});flow=condition.flow
 flow.objectives![goal].identifier='collect_apples';flow.predicates![condition.id].identifier='has_apples'
 assert.deepEqual(M.parseFlow(JSON.stringify(flow)),flow)
 flow.objectives![goal].identifier=flow.progress[flow.start].identifier
 assert(M.validateFlow(flow).some(issue=>issue.severity==='error'&&issue.path===`objectives.${goal}.identifier`))
 flow.objectives![goal].identifier='collect_apples'
 flow.predicates![condition.id].identifier='progress_1'
 const next=C.createProgressNode(flow,{x:300,y:400});assert.equal(next.flow.progress[next.id].identifier,'progress_2')
 const definitions=[{kind:'collect',requiresDelivery:true}]
 assert(M.validateFlow(flow,definitions).some(issue=>issue.severity==='error'&&issue.path===`objectives.${goal}.submission`))
 flow.objectives![goal].submission={title:{text:'提交'},description:{text:''},buttonText:{text:'确认'}}
 assert.equal(M.validateFlow(flow,definitions).some(issue=>issue.severity==='error'),false)
 for(const submission of [null,{}, {title:{text:'标题'},description:{text:''},buttonText:'提交'}]){
  const bad=structuredClone(flow) as any;bad.objectives[goal].submission=submission;assert.throws(()=>M.parseFlow(JSON.stringify(bad)))
 }
 flow.objectives![goal].submission!.buttonText.text=''
 assert(M.validateFlow(flow,definitions).some(issue=>issue.severity==='error'&&issue.path.endsWith('buttonText')))
})
test('effective goals start atomically; drafts stay inactive and cannot settle; reset returns all inactive',()=>{
 let {flow,goal}=backgroundGoal();const draft=C.createObjectiveNode(flow,{x:0,y:400});flow=draft.flow
 const empty=S.createSimState(flow);assert.equal(S.objectiveState(empty,goal),'inactive');assert.equal(S.settleObjective(flow,empty,goal,'succeeded'),empty)
 const sim=S.initializeQuest(flow,empty,true);assert.equal(S.progressState(sim,flow.start),'running');assert.equal(S.objectiveState(sim,goal),'running');assert.equal(S.objectiveState(sim,draft.id),'inactive')
 assert.equal(S.settleObjective(flow,sim,draft.id,'succeeded'),sim)
 assert.equal(S.objectiveState(S.resetSimState(flow),goal),'inactive')
})
test('goal rejects external A, answers Q by lifecycle result, never settles twice; C closes either output',()=>{
 const {flow,goal}=backgroundGoal();let sim=S.initializeQuest(flow,S.createSimState(flow))
 sim=S.injectSignal(flow,sim,goal,'output',{kind:'activate'});assert.equal(sim.log.at(-1)!.accepted,false)
 for (const outcome of ['succeeded','failed'] as const) {
  const settled=S.settleObjective(flow,sim,goal,outcome);assert.equal(S.objectiveState(settled,goal),outcome)
  assert.equal(S.settleObjective(flow,settled,goal,outcome==='succeeded'?'failed':'succeeded'),settled)
  assert(settled.log.some(row=>row.to===goal&&row.signal.kind==='query'&&row.emitted?.[0]?.signal.kind==='activate'))
  assert(settled.log.some(row=>row.to===goal&&row.signal.kind==='query'&&row.emitted?.[0]?.signal.kind==='none'))
  const closed=S.injectSignal(flow,settled,goal,'output',{kind:'cancel'})
  assert.equal(S.objectiveState(closed,goal),'closed')
  assert.equal(S.settleObjective(flow,closed,goal,outcome),closed)
  const wire=flow.logic!.links.find(link=>link.from===goal)!
  const queried=S.propagateSignals(flow,closed,[{signal:{kind:'query'},to:goal,port:'output',from:wire.to,link:wire.id,round:999}])
  assert(queried.log.some(row=>row.to===goal&&row.round===999&&row.emitted?.[0]?.signal.kind==='none'))
 }
})
test('condition lifecycle gates broadcasts and queries; closure is node-wide and permanent',()=>{
 let {flow,predicate}=waitingGate()
 let sim=S.setPredicateTruth(flow,S.createSimState(flow),predicate,true)
 assert.equal(S.conditionState(sim,predicate),'inactive')
 sim=S.initializeQuest(flow,sim)
 assert.equal(S.conditionState(sim,predicate),'running')
 const closed=S.injectSignal(flow,sim,predicate,'output',{kind:'cancel'})
 assert.equal(S.conditionState(closed,predicate),'closed')
 assert.equal(S.setPredicateTruth(flow,closed,predicate,false),closed)
 const wire=flow.logic!.links.find(link=>link.from===predicate)!
 const queried=S.propagateSignals(flow,closed,[{signal:{kind:'query'},to:predicate,port:'output',from:wire.to,link:wire.id,round:555}])
 assert(queried.log.some(row=>row.to===predicate&&row.round===555&&row.emitted?.[0]?.signal.kind==='none'))
 assert.equal(S.conditionState(S.resetSimState(flow),predicate),'inactive')
 const beforeStart=S.injectSignal(flow,S.createSimState(flow),predicate,'output',{kind:'cancel'})
 assert.equal(S.conditionState(S.initializeQuest(flow,beforeStart),predicate),'closed','initialization never reopens closed nodes')
})
test('submission is an explicit instance outcome: satisfaction alone cannot succeed; failed attempts retry',()=>{
 const {flow,goal}=backgroundGoal()
 flow.objectives![goal].submission={title:{text:'交付'},description:{text:''},buttonText:{text:'提交'}}
 const sim=S.initializeQuest(flow,S.createSimState(flow))
 assert.equal(S.settleObjective(flow,sim,goal,'succeeded'),sim)
 const rejected=S.submitObjective(flow,sim,goal,false)
 assert.equal(S.objectiveState(rejected,goal),'running');assert.equal(rejected.queue.length,0)
 assert.equal(rejected.log.length,sim.log.length)
 const accepted=S.submitObjective(flow,rejected,goal,true,true)
 assert.equal(S.objectiveState(accepted,goal),'succeeded');assert(accepted.queue.every(row=>row.port==='input'))
 assert.equal(S.submitObjective(flow,S.drainSignals(flow,accepted),goal,true).pulse,accepted.pulse)
 const failed=S.settleObjective(flow,sim,goal,'failed');assert.equal(S.objectiveState(failed,goal),'failed')
 const closed=S.injectSignal(flow,sim,goal,'output2',{kind:'cancel'})
 assert.equal(S.submitObjective(flow,closed,goal,true),closed)
 const changed=structuredClone(flow);changed.objectives![goal].identifier='changed'
 const rollback=S.drainSignals(changed,accepted);assert.equal(rollback.fault?.code,'graph-changed');assert.equal(S.objectiveState(rollback,goal),'running')
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
test('background goals and conditions on AND inputs warn per link without blocking execution',()=>{
 let {flow,goal,gate,end}=backgroundGoal()
 const predicate=C.createPredicateNode(flow,{x:0,y:400});flow=predicate.flow
 flow.predicates![predicate.id].conditions=[{kind:'task',state:'succeeded',target:'other'}]
 flow=M.connectNodes(flow,predicate.id,gate,'input','output').flow
 flow=M.connectNodes(flow,predicate.id,gate,'input2','output').flow
 flow=M.connectNodes(flow,goal,gate,'input','output2').flow
 flow=M.connectNodes(flow,predicate.id,end,'input','output').flow
 const risk=()=>M.validateFlow(flow).filter(issue=>issue.message.includes('非建议用法'))
 const expected=flow.logic!.links.filter(link=>link.to===gate&&link.port==='input'&&[goal,predicate.id].includes(link.from))
 assert.equal(expected.length,3)
 assert.deepEqual(risk().map(issue=>issue.path).sort(),expected.map(link=>`logic.links.${link.id}`).sort())
 assert(risk().every(issue=>issue.severity==='warning'&&issue.message.includes('可能导致任务挂起')))
 assert.equal(M.validateFlow(flow).some(issue=>issue.severity==='error'),false)
 assert.equal(S.initializeQuest(flow,S.createSimState(flow)).fault,null,'advisory warnings never block simulation')
 for(const link of expected) flow=M.disconnectLink(flow,{kind:'logic-link',id:link.id})
 assert.equal(risk().length,0,'OR inputs, progress AND inputs and direct end connections do not receive this warning')
 const draftGoal=C.createObjectiveNode(flow,{x:900,y:600}),draftGate=C.createTransitionNode(draftGoal.flow,{x:1200,y:600})
 flow=M.connectNodes(draftGate.flow,draftGoal.id,draftGate.id,'input','output').flow
 assert.equal(risk().length,1,'structural authoring warning also covers draft links')
})
test('AND advisory follows nested OR/AND logic, deduplicates diamonds and stops at progress boundaries',()=>{
 for(const family of ['objective','predicate'] as const) {
  let flow=M.createFlow('nested-advisory')
  const origin=family==='objective'?C.createObjectiveNode(flow,{x:0,y:200}):C.createPredicateNode(flow,{x:0,y:200});flow=origin.flow
  const first=C.createTransitionNode(flow,{x:300,y:200});flow=first.flow
  const second=C.createTransitionNode(flow,{x:600,y:200});flow=second.flow
  const third=C.createTransitionNode(flow,{x:900,y:200});flow=third.flow
  flow=M.connectNodes(flow,origin.id,first.id,'input2').flow
  flow=M.connectNodes(flow,first.id,second.id,'input2').flow
  flow=M.connectNodes(flow,first.id,third.id,'input').flow
  flow=M.connectNodes(flow,second.id,third.id,'input').flow
  const warnings=(f:M.ProgressFlow)=>M.validateFlow(f).filter(issue=>issue.message.includes('非建议用法'))
  assert.equal(warnings(flow).length,2,'each nested AND link warns once, independent of OR nesting')
  const final=C.createTransitionNode(flow,{x:1200,y:200});flow=final.flow
  flow=M.connectNodes(flow,third.id,final.id,'input').flow
  assert.equal(warnings(flow).length,3,'diamond ancestry does not duplicate warnings')
  const progress=C.createProgressNode(flow,{x:900,y:400});flow=progress.flow
  flow=M.connectNodes(flow,first.id,progress.id,'input').flow
  flow=M.connectNodes(flow,progress.id,final.id,'input').flow
  assert.equal(warnings(flow).length,3,'ordinary progress cuts off background ancestry')
  const orOnly=structuredClone(flow);orOnly.logic!.links=orOnly.logic!.links.filter(link=>!M.getTransitionNode(orOnly,link.to)||link.port==='input2')
  assert.equal(warnings(orOnly).length,0,'pure OR paths do not warn')
 }
})
test('nested logic re-queries upstream after another progress finishes later',()=>{
 let flow=M.createFlow('nested-delayed')
 const p=C.createProgressNode(flow,{x:300,y:0});flow=p.flow
 const a=C.createTransitionNode(flow,{x:300,y:200});flow=a.flow
 const b=C.createTransitionNode(flow,{x:600,y:0});flow=b.flow
 const end=C.createEndNode(flow,{x:900,y:0});flow=end.flow
 for(const [from,to] of [[flow.start,p.id],[flow.start,a.id],[a.id,b.id],[p.id,b.id],[b.id,end.id]])flow=M.connectNodes(flow,from,to,'input','output').flow
 let sim=S.settleProgress(flow,S.initializeQuest(flow,S.createSimState(flow)),flow.start,'succeeded')
 assert.equal(sim.outcome,null);assert.equal(S.progressState(sim,p.id),'running')
 const pending=S.settleProgress(flow,sim,p.id,'succeeded',true),automatic=S.drainSignals(flow,pending)
 let stepped=pending;while(S.isBusy(stepped))stepped=S.stepSignal(flow,stepped)
 assert.deepEqual(stepped,automatic)
 assert.deepEqual(automatic.outcome,{endId:end.id,result:'success'})
 assert(automatic.log.some(row=>row.to===a.id&&row.signal.kind==='query'&&row.emitted?.some(item=>item.queryId!==undefined&&item.signal.kind==='query')))
 assert.deepEqual(automatic.queryRounds,{})
})

function nestedQueryFixture() {
 let flow=M.createFlow('query-isolation')
 const end=C.createEndNode(flow,{x:1200,y:0});flow=M.connectNodes(end.flow,flow.start,end.id,'input','output').flow
 const condition=C.createPredicateNode(flow,{x:0,y:200});flow=condition.flow
 const blocker=C.createPredicateNode(flow,{x:0,y:400});flow=blocker.flow
 const a=C.createTransitionNode(flow,{x:300,y:200});flow=a.flow
 const b=C.createTransitionNode(flow,{x:600,y:200});flow=b.flow
 const extra=C.createProgressNode(flow,{x:600,y:400});flow=extra.flow
 flow=M.connectNodes(flow,condition.id,a.id,'input2').flow
 flow=M.connectNodes(flow,a.id,b.id,'input').flow
 flow=M.connectNodes(flow,blocker.id,b.id,'input').flow
 flow=M.connectNodes(flow,b.id,end.id,'input').flow
 flow=M.connectNodes(flow,a.id,extra.id,'input').flow
 const wire=flow.logic!.links.find(link=>link.from===a.id&&link.to===b.id)!
 const leaf=flow.logic!.links.find(link=>link.from===condition.id&&link.to===a.id)!
 const sim=S.initializeQuest(flow,S.createSimState(flow))
 return {flow,sim,a:a.id,b:b.id,condition:condition.id,blocker:blocker.id,extra:extra.id,wire,leaf}
}

test('recursive Q is read-only, replies only to its caller, uses live truth and returns N for empty logic',()=>{
 const {flow,sim,a,b,condition,extra,wire}=nestedQueryFixture()
 sim.predicates[condition]=true
 const query:S.Delivery={signal:{kind:'query'},from:b,to:a,port:'output',link:wire.id,round:91}
 const result=S.propagateSignals(flow,sim,[query])
 assert.deepEqual(result.progress,sim.progress);assert.deepEqual(result.rounds,sim.rounds)
 assert.equal(S.progressState(result,extra),'inactive');assert.equal(result.log.some(row=>row.signal.kind==='cancel'),false)
 const answers=result.log.flatMap(row=>row.to===a?row.emitted??[]:[]).filter(row=>row.signal.kind==='activate')
 assert.equal(answers.length,1);assert.equal(answers[0].to,b);assert.equal(answers[0].round,91)
 const originalQ=result.log.find(row=>row.to===a&&row.signal.kind==='query')!
 const response=result.log.find(row=>row.to===b&&row.round===91)!
 assert(S.traceParents(response).includes(originalQ.traceId!),'delayed response retains original Q as a causal parent')
 const assessment=result.log.find(row=>row.to===a&&row.assessment?.mode==='query')!.assessment!
 for(const answer of assessment.answers)assert(response.causes!.includes(answer.traceId!),'recursive response retains all input answer evidence')
 const changed=structuredClone(result);changed.predicates[condition]=false
 const current=S.propagateSignals(flow,changed,[{...query,round:92}])
 assert(current.log.some(row=>row.to===b&&row.round===92&&row.signal.kind==='none'))
 const empty=structuredClone(flow);empty.logic!.links=empty.logic!.links.filter(link=>link.to!==a)
 const negative=S.propagateSignals(empty,S.syncSimState(sim,empty),[{...query,round:93}])
 assert(negative.log.some(row=>row.to===b&&row.round===93&&row.signal.kind==='none'))
 assert.deepEqual(negative.queryRounds,{})
})

test('concurrent recursive callers retain original rounds; cancellation does not strand their queries',()=>{
 const {flow,sim,a,b,condition,wire,leaf}=nestedQueryFixture();sim.predicates[condition]=true
 const request=(round:number):S.Delivery=>({signal:{kind:'query'},from:b,to:a,port:'output',link:wire.id,round})
 const pending=S.propagateSignals(flow,sim,[request(101),request(102),{signal:{kind:'cancel'},from:b,to:a,port:'output',link:wire.id}],true)
 const complete=S.drainSignals(flow,pending)
 const replies=complete.log.filter(row=>row.to===b&&[101,102].includes(row.round??-1)&&row.signal.kind==='activate')
 assert.deepEqual(replies.map(row=>row.round),[101,102]);assert.deepEqual(complete.queryRounds,{})
 const firstQ=complete.log.find(row=>row.to===a&&row.signal.kind==='query')!
 const stale=S.propagateSignals(flow,complete,[{signal:{kind:'activate'},from:condition,to:a,port:'input2',link:leaf.id,round:firstQ.traceId,queryId:firstQ.traceId}])
 assert.equal(stale.log.at(-1)!.accepted,false);assert.equal(stale.log.at(-1)!.reason,'过期递归查询应答')
 assert.equal(stale.rounds[a].id,complete.rounds[a].id,'late query A never opens an activation round')
})

test('recursive queries and activation rounds coexist without cross-delivering answers',()=>{
 const {flow,sim,a,b,condition,wire,leaf}=nestedQueryFixture();sim.predicates[condition]=true
 const result=S.propagateSignals(flow,sim,[
  {signal:{kind:'activate'},from:condition,to:a,port:'input2',link:leaf.id},
  {signal:{kind:'query'},from:b,to:a,port:'output',link:wire.id,round:201},
 ])
 assert.equal(result.fault,null);assert.equal(result.rounds[a].id,1)
 assert(result.log.some(row=>row.to===b&&row.round===201&&row.signal.kind==='activate'))
 assert.deepEqual(result.queryRounds,{})
})

test('recursive query contexts roll back on budget and graph-change faults',()=>{
 const {flow,sim,a,b,condition,wire}=nestedQueryFixture();sim.predicates[condition]=true
 let pending=S.propagateSignals(flow,sim,[{signal:{kind:'query'},from:b,to:a,port:'output',link:wire.id,round:301}],true)
 pending=S.stepSignal(flow,pending);assert(Object.keys(pending.queryRounds[a]).length)
 const changed=structuredClone(flow);changed.predicates![condition].conditions=[{kind:'expr',state:'true',target:'changed'}]
 const graphFault=S.drainSignals(changed,pending);assert.equal(graphFault.fault?.code,'graph-changed');assert.deepEqual(graphFault.queryRounds,sim.queryRounds)
 pending.execution!.budget=pending.execution!.processed
 const budgetFault=S.drainSignals(flow,pending);assert.equal(budgetFault.fault?.code,'budget-exceeded');assert.deepEqual(budgetFault.queryRounds,sim.queryRounds)
})
test('multi-layer mixed AND/OR queries handle diamonds, goal failure ports and link permutations',()=>{
 let {flow,sim,a,b,condition,blocker}=nestedQueryFixture()
 const goal=C.createObjectiveNode(flow,{x:0,y:600});flow=goal.flow
 const top=C.createTransitionNode(flow,{x:900,y:200});flow=top.flow
 const sink=C.createTransitionNode(flow,{x:1200,y:200});flow=sink.flow
 flow=M.connectNodes(flow,goal.id,b,'input2','output2').flow
 flow=M.connectNodes(flow,b,top.id,'input').flow
 flow=M.connectNodes(flow,a,top.id,'input2').flow
 flow=M.connectNodes(flow,top.id,sink.id,'input2').flow
 const wire=flow.logic!.links.find(link=>link.from===top.id&&link.to===sink.id)!
 sim=S.syncSimState(sim,flow);sim.predicates[condition]=true;sim.predicates[blocker]=true;sim.objectives[goal.id]='failed'
 const seeds:S.Delivery[]=[{signal:{kind:'query'},from:sink.id,to:top.id,port:'output',link:wire.id,round:401}]
 const positive=S.propagateSignals(flow,sim,seeds)
 assert(positive.log.some(row=>row.to===sink.id&&row.round===401&&row.signal.kind==='activate'))
 assert.deepEqual(positive.queryRounds,{});assert.equal(positive.fault,null)
 const reordered=structuredClone(flow);reordered.logic!.links.reverse()
 assert.deepEqual(S.propagateSignals(reordered,sim,seeds),positive)
 const changed=structuredClone(sim);changed.objectives[goal.id]='succeeded'
 const negative=S.propagateSignals(flow,changed,seeds)
 assert(negative.log.some(row=>row.to===sink.id&&row.round===401&&row.signal.kind==='none'))
 assert.equal(negative.log.some(row=>row.signal.kind==='cancel'),false)
})
test('logic release does not cancel producers while a downstream logic is still blocked',()=>{
 let flow=M.createFlow('no-premature-consumption')
 const a=C.createProgressNode(flow,{x:300,y:0});flow=a.flow
 const b=C.createProgressNode(flow,{x:300,y:200});flow=b.flow
 const choice=C.createTransitionNode(flow,{x:600,y:100});flow=choice.flow
 const gate=C.createTransitionNode(flow,{x:900,y:100});flow=gate.flow
 const condition=C.createPredicateNode(flow,{x:600,y:400});flow=condition.flow
 const next=C.createProgressNode(flow,{x:1200,y:100});flow=next.flow
 const end=C.createEndNode(flow,{x:1500,y:100});flow=end.flow
 for(const [from,to,port]of [[flow.start,a.id,'input'],[flow.start,b.id,'input'],[a.id,choice.id,'input2'],[b.id,choice.id,'input2'],[choice.id,gate.id,'input'],[condition.id,gate.id,'input'],[gate.id,next.id,'input'],[next.id,end.id,'input']] as const)flow=M.connectNodes(flow,from,to,port).flow
 let sim=S.settleProgress(flow,S.initializeQuest(flow,S.createSimState(flow)),flow.start,'succeeded')
 assert.equal(S.progressState(sim,b.id),'running')
 const before=sim.log.length
 sim=S.settleProgress(flow,sim,a.id,'succeeded')
 assert.equal(S.progressState(sim,b.id),'running','upstream OR must not cancel the other producer before a consumer activates')
 assert.equal(S.progressState(sim,next.id),'inactive')
 assert.equal(sim.log.slice(before).some(row=>row.signal.kind==='cancel'),false,'logic-to-logic release creates no C')
 sim=S.setPredicateTruth(flow,sim,condition.id,true)
 assert.equal(S.progressState(sim,next.id),'running');assert.equal(S.progressState(sim,b.id),'cancelled')
 const roots=sim.log.filter(row=>row.signal.kind!=='cancel'&&row.emitted?.some(child=>child.signal.kind==='cancel'))
 assert(roots.length>0)
 assert(roots.every(row=>M.getProgressNode(flow,row.to)&&row.signal.kind==='activate'&&row.changes?.some(change=>change.id===row.to&&change.text==='未激活 → 运行中')),'only newly activated progress generates original cancellation')
 for(const row of sim.log.filter(row=>M.getTransitionNode(flow,row.to)&&row.emitted?.some(child=>child.signal.kind==='cancel')))assert.equal(row.signal.kind,'cancel','logic only relays an incoming C')
 const count=sim.log.length
 sim=S.injectSignal(flow,sim,next.id,'input',{kind:'activate'})
 assert.equal(sim.log.slice(count).some(row=>row.emitted?.some(child=>child.signal.kind==='cancel')),false,'repeated activation of running progress creates no C')
})
test('logic ending a quest does not create consumption C either',()=>{
 let flow=M.createFlow('logic-end-only')
 const gate=C.createTransitionNode(flow,{x:300,y:0});flow=gate.flow
 const end=C.createEndNode(flow,{x:600,y:0});flow=end.flow
 flow=M.connectNodes(flow,flow.start,gate.id,'input').flow;flow=M.connectNodes(flow,gate.id,end.id,'input').flow
 const sim=S.settleProgress(flow,S.initializeQuest(flow,S.createSimState(flow)),flow.start,'succeeded')
 assert.equal(sim.outcome?.result,'success')
 assert.equal(sim.log.some(row=>row.signal.kind==='cancel'||row.emitted?.some(child=>child.signal.kind==='cancel')),false)
})
console.log(`${checks} quest signal checks passed`)
