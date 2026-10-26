import assert from 'node:assert/strict'
import * as M from '../src/workspaces/gameplay/model'
import * as C from '../src/workspaces/gameplay/canvas'
import * as S from '../src/workspaces/gameplay/signals'
import { signalStop } from '../src/workspaces/gameplay/signalDebugging'
let checks=0
const test=(name:string,run:()=>void)=>{run();console.log(`PASS ${name}`);checks++}
function gate(){
 let flow=M.createFlow('debugging');const predicate=C.createPredicateNode(flow,{x:0,y:240});flow=predicate.flow
 const t=C.createTransitionNode(flow,{x:300,y:0});flow=t.flow
 const next=C.createProgressNode(flow,{x:600,y:0});flow=next.flow
 flow=M.connectNodes(flow,flow.start,t.id,'input','output').flow
 flow=M.connectNodes(flow,predicate.id,t.id,'input2','output').flow
 flow=M.connectNodes(flow,t.id,next.id,'input','output').flow
 let sim=S.initializeQuest(flow,S.createSimState(flow));sim=S.settleProgress(flow,sim,flow.start,'succeeded')
 sim=S.setPredicateTruth(flow,sim,predicate.id,true,true)
 return {flow,sim,t:t.id,next:next.id,predicate:predicate.id}
}
test('each queued and handled signal has unique deterministic identity and an external event',()=>{
 const {flow,sim}=gate();const complete=S.drainSignals(flow,sim)
 const ids=complete.log.map(row=>row.traceId)
 assert.equal(ids.length,new Set(ids).size);assert(ids.every(id=>Number.isSafeInteger(id)))
 assert(complete.log.every(row=>complete.events.some(event=>event.id===row.eventId)))
 assert.deepEqual(S.drainSignals(flow,sim),complete)
})
test('query replies point to Q; gate release retains all response evidence, not only the last reply',()=>{
 const {flow,sim,t,next}=gate(),complete=S.drainSignals(flow,sim),index=S.traceIndex(complete)
 const activation=complete.log.find(row=>row.to===next&&row.signal.kind==='activate')!
 assert(activation);assert((activation.causes?.length??0)>=2)
 for(const id of activation.causes!){const answer=index.get(id)!;assert.equal(answer.to,t);assert(answer.traceId!<activation.traceId!)}
 const reply=complete.log.find(row=>row.round!==undefined&&row.to===t&&row.signal.kind==='activate'&&row.parentId!==null)!
 assert.equal(index.get(reply.parentId!)!.signal.kind,'query')
 assert.equal(index.get(reply.parentId!)!.round,reply.round)
})
test('history stores immutable local changes and emitted IDs; later state cannot rewrite the record',()=>{
 const {flow,sim,next}=gate(),complete=S.drainSignals(flow,sim),activation=complete.log.find(row=>row.to===next&&row.signal.kind==='activate')!
 assert(activation.changes?.some(change=>change.id===next&&change.text.includes('未激活 → 运行中')))
 assert(activation.emitted?.every(child=>child.parentId===activation.traceId))
 const after=S.settleProgress(flow,complete,next,'succeeded')
 assert.deepEqual(after.log.find(row=>row.traceId===activation.traceId),activation)
})
test('node, wire and run-to observe the queue head before any business state changes',()=>{
 const {flow,sim,t}=gate(),frozen=structuredClone(sim),head=sim.queue[0]
 assert.equal(signalStop(sim,{nodes:[t],links:[]})?.reason,'node')
 assert.equal(signalStop(sim,{nodes:[],links:[head.link!]})?.reason,'link')
 assert.equal(signalStop(sim,{nodes:[],links:[]},t)?.reason,'target')
 assert.equal(signalStop(sim,{nodes:['absent'],links:[]}),null)
 assert.deepEqual(sim,frozen)
 const expected=S.drainSignals(flow,sim);let stepped=sim
 while(stepped.queue.length){signalStop(stepped,{nodes:[t],links:[head.link!]});stepped=S.stepSignal(flow,stepped)}
 assert.deepEqual(stepped,expected)
})
test('trace identity spans events, fault histories are marked rolled back and IDs never get reused',()=>{
 const {flow,sim}=gate();sim.execution!.budget=1
 const failed=S.stepSignal(flow,sim)
 assert(failed.fault);assert(failed.log.filter(row=>row.eventId===failed.pulse).every(row=>row.rolledBack))
 assert(failed.log.filter(row=>row.eventId!==failed.pulse).every(row=>!row.rolledBack))
 const ids=[...failed.log,...failed.discarded].map(row=>row.traceId)
 assert.equal(ids.length,new Set(ids).size)
 assert(failed.nextTraceId>Math.max(...ids as number[]))
})
test('trimmed parent IDs remain explicit rather than silently referring to another delivery',()=>{
 const {flow,sim}=gate(),complete=S.drainSignals(flow,sim),row=complete.log.find(row=>row.parentId!=null)!
 const parents=S.traceParents(row);assert(parents.length)
 complete.log=complete.log.filter(entry=>!parents.includes(entry.traceId!))
 for(const id of parents)assert.equal(S.traceIndex(complete).get(id),undefined)
 assert.deepEqual(S.traceParents(row),parents)
})
test('gate assessment explains both failed and successful rounds using recorded answers',()=>{
 const {flow,sim,t}=gate(),complete=S.drainSignals(flow,sim)
 const rounds=complete.log.filter(row=>row.to===t&&row.assessment)
 assert(rounds.some(row=>!row.assessment!.disjunction))
 assert(rounds.some(row=>row.assessment!.conjunction&&row.assessment!.disjunction))
 for(const row of rounds)for(const answer of row.assessment!.answers){
   const delivery=S.traceIndex(complete).get(answer.traceId!)!
   assert.equal(delivery.signal.kind,answer.signal)
 }
})
console.log(`${checks} quest debugger checks passed`)
