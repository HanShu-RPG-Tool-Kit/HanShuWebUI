import { createFlow, connectNodes, validateFlow } from '../src/workspaces/gameplay/model.ts'
import { createObjectiveNode, createPredicateNode, createTransitionNode } from '../src/workspaces/gameplay/canvas.ts'
/**
 * 单进度（hanshu.progress）→ 多进度外壳（hanshu.progress-tree + extensions.hanshuSimpleQuest）。
 * 覆盖 compileSimpleQuestDocument 与 questCompiler 入口。
 */
import assert from 'node:assert/strict'
import { createProgress, stringifyProgress } from '../src/workspaces/gameplay/progressDoc.ts'
import { MULTI_QUEST_FORMAT, SIMPLE_QUEST_FORMAT } from '../src/workspaces/gameplay/questKind.ts'
import { compileSimpleQuestDocument, questCompiler } from '../src/export/compile/compilers/quest.ts'
import type { CompileContext, CompileIndex } from '../src/export/compile/types.ts'
import { createProject, type SourceFile } from '../src/workspace.ts'

function file(name: string, content: string): SourceFile {
  return { id: name, name, content, updatedAt: 0 }
}

const doc = createProgress('驿站委托')
assert.equal(doc.format, SIMPLE_QUEST_FORMAT)

const compiled = compileSimpleQuestDocument(doc)
const tree = JSON.parse(compiled) as {
  format: string
  version: number
  id: string
  extensions?: { hanshuSimpleQuest?: typeof doc }
}
assert.equal(tree.format, MULTI_QUEST_FORMAT)
assert.equal(tree.version, 1)
assert.equal(tree.id, doc.id)
assert.ok(tree.extensions?.hanshuSimpleQuest, '须携带 extensions.hanshuSimpleQuest')
assert.equal(tree.extensions!.hanshuSimpleQuest!.format, SIMPLE_QUEST_FORMAT)
assert.deepEqual(tree.extensions!.hanshuSimpleQuest, doc)

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
assert.equal(arts[0]!.path, 'quest/a.quest')
assert.equal(arts[0]!.plane, 'shared')
const fromCompiler = JSON.parse(String(arts[0]!.bytes)) as typeof tree
assert.equal(fromCompiler.format, MULTI_QUEST_FORMAT)
assert.ok(fromCompiler.extensions?.hanshuSimpleQuest)

const multi = createObjectiveNode(createFlow('tree-1'),{x:300,y:0}).flow
const backgroundId=Object.keys(multi.objectives!)[0]
multi.objectives![backgroundId].goal={kind:'collect',params:{item:'minecraft:apple',count:3}}
const passthrough = await questCompiler.compile(
  file('b.quest', `${JSON.stringify(multi)}\n`),
  ctx,
)
assert.equal(passthrough.length, 1)
assert.equal(passthrough[0]!.path, 'quest/b.quest')
assert.equal(JSON.parse(String(passthrough[0]!.bytes)).format, MULTI_QUEST_FORMAT)
assert.equal(JSON.parse(String(passthrough[0]!.bytes)).extensions, undefined)
assert.deepEqual(JSON.parse(String(passthrough[0]!.bytes)).objectives,multi.objectives,'background goal type and parameters survive export without runtime state')

console.log('PASS: quest compile simple→multi with hanshuSimpleQuest; multi passthrough')

const invalid = structuredClone(multi)
invalid.logic = {links:[{id:'bad',from:multi.start,to:multi.start,port:'input',fromPort:'output'}]}
const rejected = await questCompiler.compile(file('invalid.quest',JSON.stringify(invalid)),ctx)
assert.equal(rejected.length,0)
assert(diagnostics.some(d=>d.code==='quest_graph'))
console.log('PASS: invalid multi graph is blocked before export')

const gate=createTransitionNode(multi,{x:600,y:0})
const condition=createPredicateNode(gate.flow,{x:300,y:200})
let advisory=connectNodes(condition.flow,backgroundId,gate.id,'input','output2').flow
advisory=connectNodes(advisory,condition.id,gate.id,'input','output').flow
assert.equal(validateFlow(advisory).filter(issue=>issue.message.includes('非建议用法')&&issue.severity==='warning').length,2)
const advisoryExport=await questCompiler.compile(file('advisory.quest',JSON.stringify(advisory)),ctx)
assert.equal(advisoryExport.length,1,'AND-input advisories must not block export')
console.log('PASS: background goal and condition AND-input warnings do not block export')
