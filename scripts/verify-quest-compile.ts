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

const multi = {
  format: MULTI_QUEST_FORMAT,
  version: 1 as const,
  id: 'tree-1',
  entry: { id: 'entry', target: null, title: { text: 'entry.title' }, description: { text: 'entry.description' } },
  nodes: {},
}
const passthrough = await questCompiler.compile(
  file('b.quest', `${JSON.stringify(multi)}\n`),
  ctx,
)
assert.equal(passthrough.length, 1)
assert.equal(passthrough[0]!.path, 'quest/b.quest')
assert.equal(JSON.parse(String(passthrough[0]!.bytes)).format, MULTI_QUEST_FORMAT)
assert.equal(JSON.parse(String(passthrough[0]!.bytes)).extensions, undefined)

console.log('PASS: quest compile simple→multi with hanshuSimpleQuest; multi passthrough')
