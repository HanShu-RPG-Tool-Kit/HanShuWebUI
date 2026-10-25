import assert from 'node:assert/strict'
import { goalAliases, parseCompletionGraph, canConnectCompletion, completionIssues, evaluateCompletion, layoutCompletion, type CompletionGraph } from '../src/workspaces/quest/completionGraph'
import { createProgress, parseProgress, stringifyProgress, type ProgressGoal } from '../src/workspaces/quest/progressDoc'
import { progressDocumentEffects, applyProgressEffects } from '../src/workspaces/quest/progressOperations'
const goals: ProgressGoal[] = ['kill','collect','kill','talk','collect'].map((kind,i)=>({id:`goal-${i}`,kind,config:{}}))
assert.deepEqual([...goalAliases(goals).values()],['A1','B1','A2','C1','B2'])
assert.deepEqual([...goalAliases([goals[1],goals[0],goals[4]]) .values()],['A1','B1','A2'])
assert.equal([...goalAliases(Array.from({length:28},(_,i)=>({id:String(i),kind:String(i),config:{}}))).values()].at(-1),'AB1')
const graph: CompletionGraph={nodes:[{id:'g0',type:'goal',goalId:goals[0].id},{id:'g1',type:'goal',goalId:goals[1].id},{id:'logic',type:'logic',op:'and'},{id:'output',type:'output'}],links:[{id:'a',from:'g0',to:'logic'},{id:'b',from:'g1',to:'logic'},{id:'c',from:'logic',to:'output'}]}
assert.deepEqual(parseCompletionGraph(graph),graph)
assert.deepEqual(completionIssues(graph,goals),[])
for(const [op,expected] of [['and',false],['or',true],['xor',true]] as const){
 const changed=structuredClone(graph);changed.nodes[2]={id:'logic',type:'logic',op}
 assert.equal(evaluateCompletion(changed,goals,new Map([[goals[0].id,true],[goals[1].id,false]])),expected)
}
const unary=structuredClone(graph);unary.nodes[2]={id:'logic',type:'logic',op:'not'};unary.links=unary.links.filter(l=>l.id!=='b')
assert.equal(evaluateCompletion(unary,goals,new Map([[goals[0].id,true]])),false)
assert.equal(evaluateCompletion(unary,goals,new Map()),true)
assert.equal(canConnectCompletion(unary,'g1','logic'),false)
assert.equal(canConnectCompletion(graph,'g1','output'),false)
assert.equal(canConnectCompletion(graph,'output','g0'),false)
assert.equal(canConnectCompletion(graph,'g0','g1'),false)
assert.equal(canConnectCompletion({...graph,links:graph.links.filter(l=>l.id!=='c')},'logic','logic'),false)
const cycle: CompletionGraph={nodes:[{id:'output',type:'output'},{id:'l1',type:'logic',op:'and'},{id:'l2',type:'logic',op:'or'}],links:[{id:'e1',from:'l1',to:'l2'},{id:'e2',from:'l2',to:'l1'}]}
assert.throws(()=>parseCompletionGraph(cycle))
assert.throws(()=>parseCompletionGraph({...graph,nodes:[...graph.nodes,{id:'output',type:'output'}]}))
assert.throws(()=>parseCompletionGraph({...graph,layout:{x:1}}))
assert.throws(()=>parseCompletionGraph({...graph,nodes:graph.nodes.map(n=>({...n,position:{x:1,y:1}}))}))
const dangling={...graph,nodes:[...graph.nodes,{id:'loose',type:'goal' as const,goalId:'deleted'}]}
assert.equal(evaluateCompletion(dangling,goals,new Map()),false,'disconnected invalid references do not affect completion')
assert.equal(evaluateCompletion(graph,goals.slice(1),new Map()),null,'deleting a referenced goal keeps an invalid reference')
assert.ok(completionIssues({...graph,links:[]},goals).length)
const xor=structuredClone(graph);xor.nodes[2]={id:'logic',type:'logic',op:'xor'};xor.links=xor.links.filter(l=>l.id!=='b')
assert.equal(evaluateCompletion(xor,goals,new Map()),null)
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
console.log('PASS completion graph: aliases, all operators, arity, cycles, missing refs, disconnected drafts, layout, roundtrip and semantic effects')
