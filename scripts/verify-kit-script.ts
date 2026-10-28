import assert from 'node:assert/strict'
import {createKit,parseKit,stringifyKit} from '../src/workspaces/gameplay/kit'
import {buildCompileGraph} from '../src/export/compile'
import type {Workspace} from '../src/workspace'
const kit=createKit('test');kit.script=[{ref:'reward.py'}]
assert.deepEqual(parseKit(stringifyKit(kit)).script,[{ref:'reward.py'}],'ID may itself end in .py')
for(const ref of ['../x','a/b','a:b'])assert.throws(()=>parseKit(JSON.stringify({...kit,script:{ref}})))
const legacy=parseKit(JSON.stringify({...kit,script:'player.addTag("old")'}));assert.equal(legacy.script,'player.addTag("old")')
const workspace={packages:[{id:'p',name:'test',scripts:[{id:'k',name:'test.kit',content:stringifyKit(kit),updatedAt:0},{id:'s',name:'reward.py.py',srcKind:'kit',content:'# script',updatedAt:0}],assets:[],assetFolders:[]}],activePackageId:'p',activeScriptId:'k'} as unknown as Workspace
let graph=await buildCompileGraph(workspace);assert(!graph.diagnostics.some(d=>d.code==='kit_script_missing'))
workspace.packages[0].scripts[1].srcKind='common';graph=await buildCompileGraph(workspace);assert(graph.diagnostics.some(d=>d.code==='kit_script_missing'))
workspace.packages[0].scripts[0].content=stringifyKit(legacy);graph=await buildCompileGraph(workspace);assert(graph.diagnostics.some(d=>d.code==='kit_inline_script'))

const multi=createKit('multi');multi.script=[{ref:'first'},{ref:'second'}]
assert.deepEqual(parseKit(stringifyKit(multi)).script,multi.script)
assert.throws(()=>parseKit(JSON.stringify({...multi,script:[{ref:'first'},{ref:'first'}]})))
assert.deepEqual(parseKit(JSON.stringify({...multi,script:{ref:'single'}})).script,[{ref:'single'}])

for(const fields of [{extends:"base"},{extends:""},{includes:[]},{includes:["extra"]}]) assert.throws(()=>parseKit(JSON.stringify({...kit,...fields})),/extends\/includes/)

for (const fields of [{ extends: 'base' }, { includes: [] }]) {
  workspace.packages[0].scripts[0].content = JSON.stringify({ ...kit, ...fields })
  graph = await buildCompileGraph(workspace)
  assert(graph.diagnostics.some(d => d.severity === 'error' && d.message.includes('extends/includes')))
  assert(!graph.artifacts.some(a => a.path === 'gift/test.kit'))
}

console.log('PASS kit script references: explicit legacy discrimination, flat IDs, independent definitions, type-scoped export validation')
