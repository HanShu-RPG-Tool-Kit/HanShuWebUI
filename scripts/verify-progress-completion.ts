import assert from 'node:assert/strict'
import { goalAliases, parseCompletionGraph, canConnectCompletion, completionIssues, completionWarnings, evaluateCompletion, layoutCompletion, compileCompletionExpression, compileBuiltinCompletion, type CompletionGraph } from '../src/workspaces/gameplay/completionGraph'
import { createProgress, parseProgress, stringifyProgress, type ProgressGoal } from '../src/workspaces/gameplay/progressDoc'
import { progressDocumentEffects, applyProgressEffects } from '../src/workspaces/gameplay/progressOperations'
const goals: ProgressGoal[] = ['kill','collect','kill','talk','collect'].map((kind,i)=>({id:`goal-${i}`,kind,config:{}}))
assert.deepEqual([...goalAliases(goals).values()],['A1','B1','A2','C1','B2'])
assert.deepEqual([...goalAliases([goals[1],goals[0],goals[4]]) .values()],['A1','B1','A2'])
assert.equal([...goalAliases(Array.from({length:28},(_,i)=>({id:String(i),kind:String(i),config:{}}))).values()].at(-1),'AB1')
const graph: CompletionGraph={
  nodes:[{id:'g0',type:'goal',goalId:goals[0].id},{id:'g1',type:'goal',goalId:goals[1].id},{id:'logic',type:'logic',op:'and'},{id:'output',type:'output'}],
  links:[
    {id:'a',from:'g0',fromPort:'output',to:'logic',toPort:'input'},
    {id:'b',from:'g1',fromPort:'output',to:'logic',toPort:'input'},
    {id:'c',from:'logic',fromPort:'output',to:'output',toPort:'input'},
  ],
}
assert.deepEqual(parseCompletionGraph(graph),graph)
assert.deepEqual(completionIssues(graph,goals),[])
assert.deepEqual(completionWarnings(graph),[])
for(const [op,expected] of [['and',null],['or','deliverable'],['xor','deliverable']] as const){
 const changed=structuredClone(graph);changed.nodes[2]={id:'logic',type:'logic',op}
 assert.equal(evaluateCompletion(changed,goals,new Map([[goals[0].id,'success'],[goals[1].id,'failure']])),expected)
}
const unary=structuredClone(graph);unary.nodes[2]={id:'logic',type:'logic',op:'not'};unary.links=unary.links.filter(l=>l.id!=='b')
assert.equal(evaluateCompletion(unary,goals,new Map([[goals[0].id,'success']])),null)
assert.equal(evaluateCompletion(unary,goals,new Map()),'deliverable')
assert.equal(canConnectCompletion(unary,'g1','output','logic','input'),false)
assert.equal(canConnectCompletion(graph,'g1','output','output','input'),false)
assert.equal(canConnectCompletion(graph,'output','input','g0','output'),false)
assert.equal(canConnectCompletion(graph,'g0','output','g1','input'),false)
assert.equal(canConnectCompletion({...graph,links:graph.links.filter(l=>l.id!=='c')},'logic','output','logic','input'),false)
const cycle: CompletionGraph={nodes:[{id:'output',type:'output'},{id:'l1',type:'logic',op:'and'},{id:'l2',type:'logic',op:'or'}],links:[{id:'e1',from:'l1',fromPort:'output',to:'l2',toPort:'input'},{id:'e2',from:'l2',fromPort:'output',to:'l1',toPort:'input'}]}
assert.throws(()=>parseCompletionGraph(cycle))
assert.deepEqual(parseCompletionGraph({...graph,nodes:[...graph.nodes,{id:'output-b',type:'output'}]}).nodes.filter(n=>n.type==='output').map(n=>n.id),['output','output-b'])
assert.throws(()=>parseCompletionGraph({...graph,layout:{x:1}}))
assert.throws(()=>parseCompletionGraph({...graph,nodes:graph.nodes.map(n=>({...n,position:{x:1,y:1}}))}))
assert.throws(()=>parseCompletionGraph({...graph,links:[{id:'legacy',from:'g0',to:'output'} as any]}))
const dangling={...graph,nodes:[...graph.nodes,{id:'loose',type:'goal' as const,goalId:'deleted'}]}
assert.equal(evaluateCompletion(dangling,goals,new Map([[goals[0].id,'success'],[goals[1].id,'success']])),'deliverable','disconnected invalid references do not affect completion')
assert.equal(evaluateCompletion(graph,goals.slice(1),new Map()),null,'deleting a referenced goal keeps an invalid reference')
assert.ok(completionIssues({...graph,links:[]},goals).length)
const xor=structuredClone(graph);xor.nodes[2]={id:'logic',type:'logic',op:'xor'};xor.links=xor.links.filter(l=>l.id!=='b')
assert.equal(evaluateCompletion(xor,goals,new Map()),null)
const dual: CompletionGraph={
  nodes:[{id:'g0',type:'goal',goalId:goals[0].id},{id:'out',type:'output'}],
  links:[
    {id:'ok',from:'g0',fromPort:'output',to:'out',toPort:'input'},
    {id:'bad',from:'g0',fromPort:'output2',to:'out',toPort:'input2'},
  ],
}
assert.deepEqual(completionWarnings(dual),['成功与失败完成输出可同时触发，运行时 first-wins、无稳定优先级'])
assert.equal(evaluateCompletion(dual,goals,new Map([[goals[0].id,'success']])),'deliverable')
assert.equal(evaluateCompletion(dual,goals,new Map([[goals[0].id,'failure']])),'failed')
assert.deepEqual(compileCompletionExpression(dual,goals),{outputs:[{success:`goal.success(${JSON.stringify(goals[0].id)})`,failure:`goal.failure(${JSON.stringify(goals[0].id)})`}]})
assert.deepEqual(compileBuiltinCompletion('all',goals.slice(0,2)),{outputs:[{success:`goal.success(${JSON.stringify(goals[0].id)}) && goal.success(${JSON.stringify(goals[1].id)})`,failure:`goal.failure(${JSON.stringify(goals[0].id)}) || goal.failure(${JSON.stringify(goals[1].id)})`}]})
assert.deepEqual(compileBuiltinCompletion('any',goals.slice(0,2)),{outputs:[{success:`goal.success(${JSON.stringify(goals[0].id)}) || goal.success(${JSON.stringify(goals[1].id)})`,failure:`goal.failure(${JSON.stringify(goals[0].id)}) && goal.failure(${JSON.stringify(goals[1].id)})`}]})
const layout=layoutCompletion(dangling)
assert(layout.g0.x<layout.logic.x && layout.logic.x<layout.output.x)
assert(layout.loose.y>layout.output.y)
assert.deepEqual(layoutCompletion(dangling),layout)
const before=createProgress();before.goals=goals
const after={...before,completion:'custom' as const,completionGraph:graph}
assert.deepEqual(parseProgress(stringifyProgress(after)),after)
assert(!stringifyProgress(after).includes('position'))
const changes=progressDocumentEffects(stringifyProgress(before),stringifyProgress(after))
assert.deepEqual(changes.map(e=>e.target),[{kind:'field',field:'completion'},{kind:'field',field:'completionGraph'}])
assert.deepEqual(parseProgress(applyProgressEffects({source:stringifyProgress(before),languages:{}},changes).source),after)
const switched={...after,completion:'all' as const}
assert.deepEqual(parseProgress(stringifyProgress(switched)).completionGraph,graph)
assert.throws(()=>parseProgress(stringifyProgress({...before,completion:'custom'})))
console.log('PASS completion graph: dual-rail ports, multi-output, warnings, aliases, operators, cycles, missing refs, layout, roundtrip')
