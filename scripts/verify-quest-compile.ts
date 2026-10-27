import { createFlow, connectNodes, validateFlow } from '../src/workspaces/gameplay/model.ts'
import { createObjectiveNode, createPredicateNode, createTransitionNode, createEndNode } from '../src/workspaces/gameplay/canvas.ts'
/**
 * 单进度、多进度均编译为节点自带有序连接指针的 questc。
 * 覆盖 compileSimpleQuestDocument 与 questCompiler 入口。
 */
import assert from 'node:assert/strict'
import { createProgress, stringifyProgress } from '../src/workspaces/gameplay/progressDoc.ts'
import { SIMPLE_QUEST_FORMAT } from '../src/workspaces/gameplay/questKind.ts'
import { parseQuestCompiled, QUEST_COMPILED_FORMAT } from '../src/workspaces/gameplay/questCompiled.ts'
import { compileSimpleQuestDocument, questCompiler } from '../src/export/compile/compilers/quest.ts'
import { linkArtifacts } from '../src/export/compile/link.ts'
import type { CompileContext, CompileIndex } from '../src/export/compile/types.ts'
import { createProject, type SourceFile } from '../src/workspace.ts'

function file(name: string, content: string): SourceFile {
  return { id: name, name, content, updatedAt: 0 }
}

const doc = createProgress('驿站委托')
assert.equal(doc.format, SIMPLE_QUEST_FORMAT)

const compiled = compileSimpleQuestDocument(doc)
const tree = parseQuestCompiled(compiled)
assert.equal(tree.format, QUEST_COMPILED_FORMAT)
assert.equal(tree.version, 1)
assert.equal(Object.hasOwn(tree,'id'),false)
assert.equal(Object.hasOwn(tree,'extensions'),false)
assert.deepEqual(tree.nodes[tree.start].outputs.output,[{node:'end_success',port:'input'}])
assert.deepEqual(tree.nodes[tree.start].outputs.output2,[{node:'end_failure',port:'input2'}])

const pkg = createProject('quest-compile')
const index: CompileIndex = {
  workspace: { packages: [pkg], activeScriptId: null, activeAssetId: null },
  package: pkg,
  scriptsByPath: new Map(),
  assetsByPath: new Map(),
}
const diagnostics: { severity: string; code?: string }[] = []
const ctx: CompileContext = {
  index,
  report(d) {
    diagnostics.push(d)
  },
}

const source = stringifyProgress(doc)
assert.equal(questCompiler.match(file('a.quest', source), index), true)
assert.equal(questCompiler.match(file('legacy.progress', source), index), false)

const arts = await questCompiler.compile(file('a.quest', source), ctx)
assert.equal(diagnostics.filter((d) => d.severity === 'error').length, 0)
assert.equal(arts.length, 1)
assert.equal(arts[0]!.path, 'quest/a.questc')
assert.equal(arts[0]!.plane, 'shared')
const fromCompiler = JSON.parse(String(arts[0]!.bytes)) as typeof tree
assert.equal(fromCompiler.format, QUEST_COMPILED_FORMAT)
assert.deepEqual(fromCompiler,tree)

let multi = createObjectiveNode(createFlow('tree-1'),{x:300,y:0}).flow
const backgroundId=Object.keys(multi.objectives!)[0]
multi.objectives![backgroundId].goal={kind:'collect',params:{item:'minecraft:apple',count:3}}
const terminal=createEndNode(multi,{x:900,y:0});multi=terminal.flow
multi=connectNodes(multi,multi.start,terminal.id,'input').flow
multi=connectNodes(multi,backgroundId,terminal.id,'input').flow
const passthrough = await questCompiler.compile(
  file('b.quest', `${JSON.stringify(multi)}\n`),
  ctx,
)
assert.equal(passthrough.length, 1)
assert.equal(passthrough[0]!.path, 'quest/b.questc')
assert.equal(JSON.parse(String(passthrough[0]!.bytes)).format, QUEST_COMPILED_FORMAT)
assert.equal(JSON.parse(String(passthrough[0]!.bytes)).extensions, undefined)
assert.deepEqual(JSON.parse(String(passthrough[0]!.bytes)).nodes[backgroundId].goal,multi.objectives![backgroundId].goal,'background goal type and parameters survive export without runtime state')

console.log('PASS: both quest authoring formats compile to the same questc pointer graph')

const invalid = structuredClone(multi)
invalid.logic = {links:[{id:'bad',from:multi.start,to:multi.start,port:'input',fromPort:'output'}]}
const rejected = await questCompiler.compile(file('invalid.quest',JSON.stringify(invalid)),ctx)
assert.equal(rejected.length,0)
assert(diagnostics.some(d=>d.code==='quest_graph'))
console.log('PASS: invalid multi graph is blocked before export')

for(const identifier of [undefined,'','   ']) {
 const unnamed=structuredClone(multi) as any
 if(identifier===undefined) delete unnamed.objectives[backgroundId].identifier
 else unnamed.objectives[backgroundId].identifier=identifier
 assert.equal((await questCompiler.compile(file('unnamed.quest',JSON.stringify(unnamed)),ctx)).length,0,'unnamed objectives cannot be exported, even when drafts')
}
console.log('PASS: absent, blank and whitespace-only objective identifiers block export')

const gate=createTransitionNode(multi,{x:600,y:0})
const condition=createPredicateNode(gate.flow,{x:300,y:200})
let advisory=connectNodes(condition.flow,backgroundId,gate.id,'input','output2').flow
advisory=connectNodes(advisory,condition.id,gate.id,'input','output').flow
assert.equal(validateFlow(advisory).filter(issue=>issue.message.includes('非建议用法')&&issue.severity==='warning').length,2)
const advisoryExport=await questCompiler.compile(file('advisory.quest',JSON.stringify(advisory)),ctx)
assert.equal(advisoryExport.length,1,'AND-input advisories must not block export')
console.log('PASS: background goal and condition AND-input warnings do not block export')

multi.objectives![backgroundId].goal.kind='core:item_mc_type_submit'
assert.equal((await questCompiler.compile(file('submit.quest',JSON.stringify(multi)),ctx)).length,0,'builtin delivery goal requires explicit submission')
multi.objectives![backgroundId].identifier='collect_apples'
multi.objectives![backgroundId].submission={submit_type:'ui',param:null}
const submissionExport=await questCompiler.compile(file('submit.quest',JSON.stringify(multi)),ctx)
assert.equal(submissionExport.length,1)
assert.deepEqual(JSON.parse(String(submissionExport[0].bytes)).nodes[backgroundId].submission,multi.objectives![backgroundId].submission)
const override={...file('core_item_mc_type_submit.py','@goal("core:item_mc_type_submit")\nclass Replacement(BaseGoalPy):\n    requires_delivery = False\n'),srcKind:'goal' as const}
pkg.scripts.push(override)
delete multi.objectives![backgroundId].submission
assert.equal((await questCompiler.compile(file('override.quest',JSON.stringify(multi)),ctx)).length,1,'effective project file overrides builtin capability too')
override.content='@goal("core:item_mc_type_submit")\nclass Replacement(BaseGoalPy):\n    def deliver(self, instance, context):\n        return True\n'
assert.equal((await questCompiler.compile(file('undeclared.quest',JSON.stringify(multi)),ctx)).length,0,'undeclared delivery hook is a configuration error')
console.log('PASS: delivery declarations, submission requirements, effective overrides and descriptor roundtrip')

override.content='@goal("core:item_mc_type_submit")\nclass Replacement(BaseGoalPy):\n    requires_delivery = True\n'
multi.objectives![backgroundId].submission={submit_type:'dialogue_injection',param:'submit_goal'}
multi.progress[multi.start].goals=[{id:'one',kind:'core:item_mc_type_submit',params:{}},{id:'two',kind:'core:item_mc_type_submit',params:{}}]
assert.equal((await questCompiler.compile(file('missing-progress-submit.quest',JSON.stringify(multi)),ctx)).length,0)
multi.progress[multi.start].submission={submit_type:'dialogue_injection',param:'submit_progress'}
const entries=await questCompiler.compile(file('entries.quest',JSON.stringify(multi)),ctx)
assert.equal(entries.length,1)
const exported=JSON.parse(String(entries[0].bytes))
assert.deepEqual(exported.nodes[multi.start].submission,{submit_type:'dialogue_injection',param:'submit_progress'})
assert(exported.nodes[multi.start].goals.every((goal:object)=>!Object.hasOwn(goal,'submission')))
assert.deepEqual(entries[0].requires?.map(ref=>ref.id).sort(),['submit_goal','submit_progress'])
assert.equal(linkArtifacts(entries).filter(issue=>issue.severity==='error'&&issue.code==='missing_require').length,2)
const linked=linkArtifacts([...entries,{path:'hanshu/submit.hsc',bytes:'',plane:'client',packageName:pkg.name,provides:[{kind:'hsInject',id:'SUBMIT_PROGRESS'},{kind:'hsInject',id:'submit_goal'}]}])
assert.equal(linked.some(issue=>issue.severity==='error'),false,'submission points resolve using the existing case-insensitive hsInject linker')
console.log('PASS: shared progress/objective submission schema and real dialogue-injection dependencies')

await import('./verify-quest-runtime.ts')
