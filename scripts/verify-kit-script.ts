import assert from 'node:assert/strict'
import {createKit,parseKit,stringifyKit,flattenKit} from '../src/workspaces/quest/kit'
import {buildCompileGraph} from '../src/export/compile'
import type {Workspace} from '../src/workspace'
const kit=createKit('test');kit.script=[{ref:'reward.py'}]
assert.deepEqual(parseKit(stringifyKit(kit)).script,[{ref:'reward.py'}],'ID may itself end in .py')
const child=createKit('child');child.extends='base';assert.deepEqual(flattenKit(child,'child',new Map([['base',kit]])).kit.script,kit.script)
for(const ref of ['../x','a/b','a:b'])assert.throws(()=>parseKit(JSON.stringify({...kit,script:{ref}})))
const legacy=parseKit(JSON.stringify({...kit,script:'player.addTag("old")'}));assert.equal(legacy.script,'player.addTag("old")')
const workspace={packages:[{id:'p',name:'test',scripts:[{id:'k',name:'test.kit',content:stringifyKit(kit),updatedAt:0},{id:'s',name:'reward.py.py',srcKind:'kit',content:'# script',updatedAt:0}],assets:[],assetFolders:[]}],activePackageId:'p',activeScriptId:'k'} as unknown as Workspace
let graph=await buildCompileGraph(workspace);assert(!graph.diagnostics.some(d=>d.code==='kit_script_missing'))
workspace.packages[0].scripts[1].srcKind='common';graph=await buildCompileGraph(workspace);assert(graph.diagnostics.some(d=>d.code==='kit_script_missing'))
workspace.packages[0].scripts[0].content=stringifyKit(legacy);graph=await buildCompileGraph(workspace);assert(graph.diagnostics.some(d=>d.code==='kit_inline_script'))
console.log('PASS kit script references: explicit legacy discrimination, flat IDs, inheritance, type-scoped export validation')

const multi=createKit('multi');multi.script=[{ref:'first'},{ref:'second'}]
assert.deepEqual(parseKit(stringifyKit(multi)).script,multi.script)
assert.throws(()=>parseKit(JSON.stringify({...multi,script:[{ref:'first'},{ref:'first'}]})))
assert.deepEqual(parseKit(JSON.stringify({...multi,script:{ref:'single'}})).script,[{ref:'single'}])
