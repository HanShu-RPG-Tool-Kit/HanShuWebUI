import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {SCRIPT_TYPES,BUILTIN_SCRIPTS,SCRIPT_TEMPLATES,scriptTemplate} from '../src/scriptResources'
import {sourcePathOf,srcKindFromDiskPath,type Workspace} from '../src/workspace'
import {sourcesToProgressDocuments,applyProgressDocumentsToWorkspace} from '../src/project/projectSession'
import {ensurePackageSections,sectionFolderKey,requireAvailableName,uniqueDocumentName,scriptTypeInFolder} from '../src/workspaces/gameplay/library'
import {withBuiltinScripts,stripBuiltinScripts} from '../src/workspaces/gameplay/scriptResources'
import {buildGoalDefinitionCatalog} from '../src/workspaces/gameplay/goalDefinitions'
import {buildCompileGraph} from '../src/export/compile'
import {pakScriptMetadata,transformDialect} from '../src/monaco/javascript/dialect'
import {exportPaks} from '../src/export/pack/exportPaks'
const scripts=SCRIPT_TYPES.map((type,i)=>({id:type,name:'shared.js',srcKind:type,content:type==='goal'?'import Tick from "test.Tick"\n@goal("test:shared")\n@config()\n@state()\n@subscribe(Tick)\nfunction on_tick(instance: GoalInstance,event: Tick): void {}\nfunction update_state(instance: GoalInstance): void {}':`// ${type}`,updatedAt:i}))
for(const s of scripts){assert.equal(sourcePathOf(s),`src/script/${s.srcKind}/shared.js`);assert.equal(srcKindFromDiskPath(sourcePathOf(s)),s.srcKind);assert(scriptTemplate(s.srcKind as typeof SCRIPT_TYPES[number],'default.js','标题').startsWith('// 标题'))}
const workspace={packages:[{id:'p',name:'test',scripts,assets:[],assetFolders:[]}],activePackageId:'p',activeScriptId:null} as unknown as Workspace
const base=ensurePackageSections({documents:sourcesToProgressDocuments(scripts),folders:[],activeKey:null})
assert.deepEqual(applyProgressDocumentsToWorkspace(workspace,base.documents,base.folders).packages[0].scripts.map(s=>s.srcKind),[...SCRIPT_TYPES])
for(const type of SCRIPT_TYPES){const parent=sectionFolderKey('script',type==='goal'?'goal-def':type);assert.equal(scriptTypeInFolder(base,parent),type);assert.throws(()=>requireAvailableName(base,'shared.js','script',parent));assert.equal(uniqueDocumentName(base,'shared.js','script',parent),'shared (2).js')}
const builtin=BUILTIN_SCRIPTS.find(s=>s.type==='goal'&&s.name==='core_item_mc_type_hold.js')!
const replacement={id:'override',name:builtin.name,srcKind:'goal',content:'import Tick from "test.Tick"\n@goal("test:replacement")\n@config()\n@state()\n@subscribe(Tick)\nfunction on_tick(instance: GoalInstance,event: Tick): void {}\nfunction update_state(instance: GoalInstance): void {}\n',updatedAt:1}
const sources=[...scripts,replacement]
const state=ensurePackageSections({documents:sourcesToProgressDocuments(sources),folders:[],activeKey:null})
const view=withBuiltinScripts(state);assert(!view.documents.some(d=>d.key.startsWith('builtin:')&&d.name===builtin.name));assert.equal(stripBuiltinScripts(view).documents.length,sources.length)
const catalog=buildGoalDefinitionCatalog(state);assert(catalog.byKind.has('test:replacement'));assert(!catalog.byKind.has('core:item_mc_type_hold'),'old definitions in overridden file must disappear')
workspace.packages[0].scripts=sources
const graph=await buildCompileGraph(workspace)
assert.equal(graph.artifacts.filter(a=>a.path===`goal_scripts/${builtin.name}`).length,1)
assert.equal(graph.artifacts.find(a=>a.path===`goal_scripts/${builtin.name}`)?.bytes,transformDialect(replacement.content).source)
const goalTable=JSON.parse(String(graph.artifacts.find(a=>a.path===`goal_scripts/${builtin.name.slice(0,-3)}.hooks.json`)?.bytes))
assert.equal(goalTable.version,2);assert.equal(goalTable.goal.id,'test:replacement');assert.equal(goalTable.goal.handlers[0].event,'test.Tick')
assert.deepEqual(goalTable.hooks,[])
const commonTable=JSON.parse(String(graph.artifacts.find(a=>a.path==='script/common/shared.hooks.json')?.bytes))
assert.deepEqual(commonTable,{version:2,hooks:[],goal:null})
const hooked=transformDialect('@hook("tick")\nfunction tick(event: any, board: any): void {}\n')
assert.deepEqual(pakScriptMetadata(hooked.hooks,hooked.goal).hooks[0],{hook:'tick',function:'tick',line:1,cancellable:null,priority:'NORMAL',receiveCancelled:false})
assert(!('functionLine' in pakScriptMetadata(hooked.hooks,hooked.goal).hooks[0]))
assert(!('eventType' in pakScriptMetadata(hooked.hooks,hooked.goal).hooks[0]))
assert.equal(transformDialect(replacement.content).source.split('\n').length,replacement.content.split('\n').length,'export must retain every author line')
assert.equal(graph.artifacts.filter(a=>(a.path.startsWith('script/')||a.path.startsWith('goal_scripts/'))&&a.path.endsWith('.js')).length,BUILTIN_SCRIPTS.length+scripts.length)
assert(!graph.artifacts.some(a=>a.path.startsWith('goal/')||a.path.includes('templates/')))
const exported=await exportPaks(workspace,{targets:['server','client']})
for(const pak of exported.packs){const zip=await JSZip.loadAsync(await pak.blob.arrayBuffer());for(const s of sources)assert.equal(!!zip.file(s.srcKind==='goal'?`goal_scripts/${s.name}`:sourcePathOf(s).slice(4)),pak.target==='server');assert(!Object.keys(zip.files).some(p=>p.includes('templates/')))}
assert.equal(SCRIPT_TEMPLATES.length,SCRIPT_TYPES.length)
console.log('PASS script resources: six types, path/session roundtrip, type-scoped names, whole-file builtin overlay, goal catalog replacement and server/client PAK contents')
