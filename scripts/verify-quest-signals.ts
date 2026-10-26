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
 const sim=S.injectSignal(f,S.initializeQuest(f,S.createSimState(f)),join.id,'output',{kind:'cancel'})
 assert.equal(sim.fault,null)
 assert(sim.log.some(row=>row.reason?.includes('相同状态的取消')))
 assert.equal(sim.log.filter(row=>row.to===f.start).length,1)
})
console.log(`${checks} quest signal checks passed`)
