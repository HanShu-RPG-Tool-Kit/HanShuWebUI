import assert from 'node:assert/strict'
import * as M from '../src/workspaces/gameplay/model'
import * as C from '../src/workspaces/gameplay/canvas'
import * as S from '../src/workspaces/gameplay/signals'
import { progressEdges } from '../src/workspaces/gameplay/graphAdapter'
import { compileQuestFlow, compileSimpleQuest, parseQuestCompiled } from '../src/workspaces/gameplay/questCompiled'
import { createProgress, stringifyProgress } from '../src/workspaces/gameplay/progressDoc'
import { buildCompileGraph } from '../src/export/compile'
import { exportPaks } from '../src/export/pack/exportPaks'
import JSZip from 'jszip'
import { createProject } from '../src/workspace'

let flow=M.createFlow('editor-only-id')
const p=C.createProgressNode(flow,{x:600,y:10});flow=p.flow
const q=C.createProgressNode(flow,{x:600,y:200});flow=q.flow
const a=C.createPredicateNode(flow,{x:0,y:50});flow=a.flow
const b=C.createObjectiveNode(flow,{x:0,y:250});flow=b.flow
flow.objectives![b.id].goal={kind:'collect',params:{count:3}}
const g=C.createTransitionNode(flow,{x:300,y:0});flow=g.flow
const e=C.createEndNode(flow,{x:900,y:0});flow=e.flow
for(const [from,to,port]of [[flow.start,g.id,'input'],[a.id,g.id,'input2'],[b.id,g.id,'input2'],[g.id,p.id,'input'],[g.id,q.id,'input'],[p.id,e.id,'input'],[q.id,e.id,'input']] as const)flow=M.connectNodes(flow,from,to,port).flow
const draft=C.createObjectiveNode(flow,{x:0,y:800});flow=draft.flow
draft.flow.objectives![draft.id].submission={submit_type:'dialogue_injection',param:'not_exported'}
const note=C.createCanvasNote(flow,{x:0,y:1000});flow=note.flow
flow.extensions={editorHint:'must not ship'}
const original=compileQuestFlow(flow),before=JSON.stringify(flow)
assert.equal(Object.hasOwn(original,'id'),false)
assert.deepEqual(Object.keys(original).sort(),['format','version','metadata','start','nodes'].sort())
assert.equal(original.nodes[a.id].type,'condition');assert.equal(original.nodes[b.id].type,'objective')
assert.equal(Object.hasOwn(original.nodes,draft.id),false);assert.equal(Object.hasOwn(original.nodes,note.id),false)
assert.equal(JSON.stringify(original).includes('must not ship'),false)
assert.equal(JSON.stringify(original).includes('"links"'),false,'runtime graph owns no edge table')
assert.deepEqual(parseQuestCompiled(JSON.stringify(original)),original)
assert.equal(JSON.stringify(flow),before,'compilation never modifies the authoring graph')
console.log('PASS questc prunes drafts by undirected connectivity, preserves background sources and strips editor identity/layout/extensions')

assert.deepEqual(original.nodes[g.id].outputs.output!.map(pointer=>pointer.node),[p.id,q.id])
assert.deepEqual(original.nodes[g.id].inputs.input2!.map(pointer=>pointer.node),[a.id,b.id])
flow.layout!.positions[q.id].y=-10
const reordered=compileQuestFlow(flow)
assert.deepEqual(reordered.nodes[g.id].outputs.output!.map(pointer=>pointer.node),[q.id,p.id])
assert.deepEqual(reordered.nodes[g.id].inputs.input2,original.nodes[g.id].inputs.input2)
flow.layout!.positions[b.id].y=-100
assert.deepEqual(compileQuestFlow(flow).nodes[g.id].inputs.input2!.map(pointer=>pointer.node),[b.id,a.id])
const shuffled=structuredClone(flow);shuffled.logic!.links.reverse()
assert.deepEqual(compileQuestFlow(shuffled),compileQuestFlow(flow))
assert.equal(JSON.stringify(flow).includes('reverseOrder'),false);assert.equal(before.includes('"order"'),false)
const legacy=JSON.parse(JSON.stringify(flow));legacy.logic.links.forEach((link:any)=>Object.assign(link,{order:123,reverseOrder:456}))
assert.deepEqual(compileQuestFlow(M.parseFlow(JSON.stringify(legacy))),compileQuestFlow(flow))
const compiled=compileQuestFlow(flow)
for(const [id,node] of Object.entries(compiled.nodes)) {
 for(const [port,pointers]of Object.entries(node.outputs))assert.deepEqual(pointers,M.orderedLinks(flow).filter(link=>link.from===id&&M.linkSourcePort(flow,id,link.fromPort)===port).map(link=>({node:link.to,port:link.port})))
 for(const [port,pointers]of Object.entries(node.inputs))assert.deepEqual(pointers,M.orderedLinks(flow,true).filter(link=>link.to===id&&link.port===port).map(link=>({node:link.from,port:M.linkSourcePort(flow,link.from,link.fromPort)})))
}
const edges=progressEdges(flow)
const sourceLinks=M.orderedLinks(flow).filter(link=>link.from===g.id)
assert.equal(edges.find(edge=>edge.id===`logic:${sourceLinks[0].id}`)!.sourceBadge,0)
const inputLinks=M.orderedLinks(flow,true).filter(link=>link.to===g.id&&link.port==='input2')
assert.equal(edges.find(edge=>edge.id===`logic:${inputLinks[0].id}`)!.targetBadge,0)
console.log('PASS live source order, visible badges and independent compiled input/output arrays agree in both directions')

// A changed reverse order must invalidate an in-flight pulse, even if all forward orders stay unchanged.
const initial=S.initializeQuest(flow,S.createSimState(flow))
const pending=S.settleProgress(flow,initial,flow.start,'succeeded',true)
const moved=structuredClone(flow);moved.layout!.positions[b.id].y=300
assert.deepEqual(M.orderedLinks(moved).map(link=>link.id),M.orderedLinks(flow).map(link=>link.id))
const fault=S.drainSignals(moved,pending)
assert.equal(fault.fault?.code,'graph-changed');assert.deepEqual(fault.progress,initial.progress)
console.log('PASS a reverse-only layout reorder cannot change execution halfway through an event')

const custom=structuredClone(flow)
custom.progress[p.id].goals=[{id:'goal_a',kind:'collect',params:{}}]
custom.progress[p.id].completion='custom'
custom.progress[p.id].completionGraph={nodes:[{id:'leaf',type:'goal',goalId:'goal_a'},{id:'not',type:'logic',op:'not'},{id:'out',type:'output'},{id:'unused',type:'goal',goalId:'missing_draft'}],links:[{id:'l1',from:'leaf',to:'not'},{id:'l2',from:'not',to:'out'}]}
const customCompiled=compileQuestFlow(custom)
assert.deepEqual((customCompiled.nodes[p.id] as any).completionExpression,{type:'logic',op:'not',inputs:[{type:'goal',goalId:'goal_a'}]})
assert.equal(Object.hasOwn(customCompiled.nodes[p.id],'completionGraph'),false)
assert.equal(JSON.stringify(customCompiled).includes('missing_draft'),false)
const incomplete=structuredClone(custom);incomplete.progress[p.id].completionGraph!.links=[]
assert.throws(()=>compileQuestFlow(incomplete),/请连接完成输出/)
console.log('PASS custom completion lowers to an expression without edge tables, positions or disconnected completion drafts')

const rejects=(mutate:(value:any)=>void)=>{const bad=structuredClone(original);mutate(bad);assert.throws(()=>parseQuestCompiled(JSON.stringify(bad)),/questc/)}
rejects(value=>{value.id='not-a-resource-id'})
rejects(value=>{value.edges=[]})
rejects(value=>{value.nodes[g.id].outputs.output[0].node='missing'})
rejects(value=>{value.nodes[g.id].inputs.input=[]})
rejects(value=>{value.nodes[g.id].outputs.output.push({...value.nodes[g.id].outputs.output[0]})})
rejects(value=>{value.nodes[g.id].inputs.wrong=[]})
rejects(value=>{value.nodes[b.id].layout={}})
rejects(value=>{value.nodes[flow.start].goals=[{id:'bad',kind:'collect',params:{nested:[]}}]})
rejects(value=>{value.nodes[flow.start].completion='custom';value.nodes[flow.start].completionExpression={type:'goal',goalId:'missing'}})
rejects(value=>{value.nodes[e.id].outputs.output=[]})
rejects(value=>{value.nodes[g.id].outputs.output.push({node:g.id,port:'input'});value.nodes[g.id].inputs.input.push({node:g.id,port:'output'})})
rejects(value=>{value.nodes.extra={type:'logic',inputs:{input:[],input2:[]},outputs:{output:[]}}})
console.log('PASS compiled loader rejects invalid schema, dangling/nonreciprocal/duplicate pointers, wrong ports, cycles and leaked drafts')

const doc=createProgress('驿站')
doc.rewardKits=['starter'];doc.authorNotes='private editor notes';doc.tags=['story'];doc.visibility=[{kind:'task',state:'succeeded',target:'prologue'}];doc.autoStartWhenAcceptable=true
const simple=compileSimpleQuest(doc)
assert.deepEqual(simple.metadata.visibility,doc.visibility);assert.equal(simple.metadata.autoStartWhenAcceptable,true)
assert.deepEqual(simple.metadata.tags,['story']);assert.equal(simple.metadata.title,'name')
if(simple.nodes.end_success.type==='end')assert.deepEqual(simple.nodes.end_success.rewardKits,['starter'])
if(simple.nodes.end_failure.type==='end')assert.deepEqual(simple.nodes.end_failure.rewardKits,[])
assert.equal(JSON.stringify(simple).includes('private editor notes'),false)
assert.deepEqual(compileSimpleQuest({...doc,id:'different-editor-identity'}),simple)
const pkg=createProject('locale-quest')
pkg.scripts=[{id:'quest',name:'localized.quest',content:stringifyProgress(doc),updatedAt:0}]
const blob=new Blob([JSON.stringify({name:'驿站',description:'委托'})])
pkg.assets=[{id:'lang',path:'assets/zh_cn/lang_quest/localized.lang',mime:'application/json',size:blob.size,updatedAt:0}]
// The pass reads the browser asset cache, not a Blob stored on AssetFile metadata.
const priorIndexedDB=globalThis.indexedDB
globalThis.indexedDB={open:()=>{
 const request:any={}
 queueMicrotask(()=>{
  request.result={close:()=>{},transaction:()=>({objectStore:()=>({get:()=>{
   const read:any={};queueMicrotask(()=>{read.result=blob;read.onsuccess()});return read
  }})})}
  request.onsuccess()
 });return request
}} as unknown as IDBFactory
let graph:Awaited<ReturnType<typeof buildCompileGraph>>
try{
 const workspace={packages:[pkg],activeScriptId:null,activeAssetId:null}
 graph=await buildCompileGraph(workspace)
 const result=await exportPaks(workspace,{targets:['combined','client','server']})
 for(const pack of result.packs){
  const zip=await JSZip.loadAsync(await pack.blob.arrayBuffer())
  assert(zip.file('quest/localized.questc'),`shared questc missing from ${pack.target}`)
  assert(zip.file('assets/zh_cn/lang_quest/localized.lang'),`quest locale missing from ${pack.target}`)
  assert.equal(zip.file('quest/localized.quest'),null)
  parseQuestCompiled(await zip.file('quest/localized.questc')!.async('string'))
 }
}finally{globalThis.indexedDB=priorIndexedDB}
assert(graph.artifacts.some(artifact=>artifact.path==='quest/localized.questc'))
assert(graph.artifacts.some(artifact=>artifact.path==='assets/zh_cn/lang_quest/localized.lang'))
assert(!graph.artifacts.some(artifact=>artifact.path==='quest/localized.quest'))
assert(!graph.diagnostics.some(issue=>issue.severity==='error'))
console.log('PASS simple task policy, localized keys and quest-owned language assets survive actual combined/client/server PAK export')
