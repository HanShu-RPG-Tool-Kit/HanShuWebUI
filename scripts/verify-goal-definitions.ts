import assert from 'node:assert/strict'
import {
  BUILTIN_GOAL_DEFINITION_SCRIPTS,
  buildGoalDefinitionCatalog,
  isBuiltinScriptDocumentKey,
  parseGoalDefinitionsFromSource,
  withBuiltinScripts,
} from '../src/workspaces/gameplay/goalDefinitions.ts'
import { ensurePackageSections, sectionFolderKey } from '../src/workspaces/gameplay/library.ts'

let passed = 0
function test(name: string, check: () => void) { check(); passed++; console.log(`[OK] ${name}`) }

test('parses kill_mc_type config and file header', () => {
  const source = BUILTIN_GOAL_DEFINITION_SCRIPTS.find((item) => item.name.includes('kill_mc_type'))!.source
  const defs = parseGoalDefinitionsFromSource(source, { sourceKey: 'x', sourceName: 'core_kill_mc_type.js' })
  assert.equal(defs.length, 1)
  assert.equal(defs[0]!.kind, 'core:kill_mc_type')
  assert.deepEqual(defs[0]!.fields.map((field) => field.key), ['count', 'target'])
  assert.equal(defs[0]!.fields[0]!.type, 'int')
  assert.equal(defs[0]!.fields[0]!.default, 1)
  assert.equal(defs[0]!.labels?.zh_cn?.name, '击杀实体类型')
  assert.equal(defs[0]!.fields.find((field) => field.key === 'target')?.widget?.editor, 'suggest')
  assert.ok(defs[0]!.localize?.zh_cn?.includes('{target}'))
})

test('empty @config() does not swallow @state bag fields', () => {
  const source = BUILTIN_GOAL_DEFINITION_SCRIPTS.find((item) => item.name.includes('instant_complete'))!.source
  const defs = parseGoalDefinitionsFromSource(source, { sourceKey: 'y', sourceName: 'core_instant_complete.js' })
  assert.equal(defs[0]!.kind, 'core:instant_complete')
  assert.deepEqual(defs[0]!.fields, [])
  assert.ok(source.includes('field("done"'), 'fixture still has bag field done')
})

test('parses manual_complete required string', () => {
  const source = BUILTIN_GOAL_DEFINITION_SCRIPTS.find((item) => item.name.includes('manual_complete'))!.source
  const defs = parseGoalDefinitionsFromSource(source, { sourceKey: 'z', sourceName: 'core_manual_complete.js' })
  assert.equal(defs[0]!.kind, 'core:manual_complete')
  const token = defs[0]!.fields.find((field) => field.key === 'token')
  assert.equal(token?.type, 'string')
  assert.equal(token?.required, true)
})

const declaration=(id:string,config='',state='',options='',business='function update_state(instance: GoalInstance): void {}')=>`import Tick from "test.Tick"\n@goal("${id}"${options?`, ${options}`:''})\n@config(${config})\n@state(${state})\n@subscribe(Tick)\nfunction on_tick(instance: GoalInstance,event: Tick): void {}\n${business}`
test('literal configuration types', () => {
 const d=parseGoalDefinitionsFromSource(declaration('test:double','field("rate","double",1.5)'),{sourceKey:'d',sourceName:'d.js'})[0]!
 assert.equal(d.fields[0].type,'float');assert.equal(d.fields[0].default,1.5)
})
test('empty workspace exposes all builtin declarations without mutating source state', () => {
 const state=ensurePackageSections({documents:[],folders:[],activeKey:null}),catalog=buildGoalDefinitionCatalog(state)
 assert.ok(catalog.byKind.has('core:kill_mc_type'));assert.ok(catalog.byKind.has('core:dialog'))
 assert.ok(catalog.definitions.every(d=>d.sourceKey&&isBuiltinScriptDocumentKey(d.sourceKey)))
 assert.ok(withBuiltinScripts(state).documents.length>=28);assert.equal(state.documents.length,0);assert.deepEqual(catalog.errors,[])
})
test('whole-file override removes prior builtin declaration; custom files append', () => {
 const state=ensurePackageSections({documents:[],folders:[],activeKey:null})
 const folderId=sectionFolderKey('script','goal-def')
 state.documents.push({key:'script',name:'core_kill_mc_type.js',source:declaration('core:kill_mc_type','field("note","string","x")'),package:'script',folderId})
 state.documents.push({key:'custom',name:'only.js',source:declaration('custom:only','field("value","int",7)'),package:'script',folderId})
 state.documents.push({key:'ordinary',name:'outside.js',source:declaration('custom:outside'),package:'script',folderId:null})
 const catalog=buildGoalDefinitionCatalog(state)
 assert.equal(catalog.byKind.get('core:kill_mc_type')!.sourceKey,'script');assert.equal(catalog.byKind.get('core:kill_mc_type')!.fields[0].key,'note')
 assert.equal(catalog.byKind.get('custom:only')!.fields[0].default,7);assert(!catalog.byKind.has('custom:outside'));assert.deepEqual(catalog.errors,[])
})
test('config and state metadata remain independent', () => {
 const d=parseGoalDefinitionsFromSource(declaration('test:bags','field("count","int",3)','field("count","int",99)'),{sourceKey:'bags',sourceName:'bags.js'})[0]
 assert.equal(d.fields.length,1);assert.equal(d.fields[0].default,3)
})
test('optional deliver, required/default fields and nonexecuting parser', () => {
 const parse=(options='',business?:string)=>parseGoalDefinitionsFromSource(declaration('test:delivery','','',options,business),{sourceKey:'x',sourceName:'x.js'})[0]!
 const delivery='function update_state(i: GoalInstance): void {}\nfunction deliver(i: GoalInstance,c: GoalDeliverContext): boolean {return true;}'
 assert.equal(parse('',delivery).error,undefined)
 assert.throws(()=>parse('{requires_delivery:true}',delivery),/@goal|Invalid @goal|invalid @goal/i)
 const required=parseGoalDefinitionsFromSource(declaration('test:fields','field("must","string"),field("withDefault","int",2,{required:true})'),{sourceKey:'r',sourceName:'r.js'})[0].fields
 assert.equal(required[0].required,true);assert.equal(required[0].default,undefined);assert.equal(required[1].default,2);assert.equal(required[1].required,true)
 assert.equal(parseGoalDefinitionsFromSource('// @goal("fake")\nvar x="@goal(another)";',{sourceKey:null,sourceName:'x.js'}).length,0)
 const catalog=buildGoalDefinitionCatalog(ensurePackageSections({documents:[],folders:[],activeKey:null}))
 for(const suffix of ['mc_type_submit','mc_type_hold','rpgtk_type_submit','rpgtk_type_hold'])assert.ok(catalog.byKind.has(`core:item_${suffix}`))
})
console.log(`${passed} goal-definition checks passed.`)
