import assert from 'node:assert/strict'
import JSZip from 'jszip'
import {SCRIPT_TYPES,BUILTIN_SCRIPTS,SCRIPT_TEMPLATES,scriptTemplate} from '../src/scriptResources'
import {sourcePathOf,srcKindFromDiskPath,type Workspace} from '../src/workspace'
import {sourcesToProgressDocuments,applyProgressDocumentsToWorkspace} from '../src/project/projectSession'
import {ensurePackageSections,sectionFolderKey,requireAvailableName,uniqueDocumentName,scriptTypeInFolder} from '../src/workspaces/gameplay/library'
import {withBuiltinScripts,stripBuiltinScripts} from '../src/workspaces/gameplay/scriptResources'
import {buildGoalDefinitionCatalog} from '../src/workspaces/gameplay/goalDefinitions'
import {buildCompileGraph} from '../src/export/compile'
import {exportPaks} from '../src/export/pack/exportPaks'
const scripts=SCRIPT_TYPES.map((type,i)=>({id:type,name:'shared.py',srcKind:type,content:`# ${type}`,updatedAt:i}))
for(const s of scripts){assert.equal(sourcePathOf(s),`src/script/${s.srcKind}/shared.py`);assert.equal(srcKindFromDiskPath(sourcePathOf(s)),s.srcKind);assert(scriptTemplate(s.srcKind as typeof SCRIPT_TYPES[number],'default.py','标题').startsWith('# 标题'))}
const workspace={packages:[{id:'p',name:'test',scripts,assets:[],assetFolders:[]}],activePackageId:'p',activeScriptId:null} as unknown as Workspace
const base=ensurePackageSections({documents:sourcesToProgressDocuments(scripts),folders:[],activeKey:null})
assert.deepEqual(applyProgressDocumentsToWorkspace(workspace,base.documents,base.folders).packages[0].scripts.map(s=>s.srcKind),[...SCRIPT_TYPES])
for(const type of SCRIPT_TYPES){const parent=sectionFolderKey('script',type==='goal'?'goal-def':type);assert.equal(scriptTypeInFolder(base,parent),type);assert.throws(()=>requireAvailableName(base,'shared.py','script',parent));assert.equal(uniqueDocumentName(base,'shared.py','script',parent),'shared (2).py')}
const builtin=BUILTIN_SCRIPTS.find(s=>s.type==='goal'&&s.name==='core_item_mc_type_hold.py')!
const replacement={id:'override',name:builtin.name,srcKind:'goal',content:'@goal("test:replacement")\n@config()\nclass Replacement(BaseGoalPy):\n    pass\n',updatedAt:1}
const sources=[...scripts,replacement]
const state=ensurePackageSections({documents:sourcesToProgressDocuments(sources),folders:[],activeKey:null})
const view=withBuiltinScripts(state);assert(!view.documents.some(d=>d.key.startsWith('builtin:')&&d.name===builtin.name));assert.equal(stripBuiltinScripts(view).documents.length,sources.length)
const catalog=buildGoalDefinitionCatalog(state);assert(catalog.byKind.has('test:replacement'));assert(!catalog.byKind.has('core:item_mc_type_hold'),'old definitions in overridden file must disappear')
workspace.packages[0].scripts=sources
const graph=await buildCompileGraph(workspace)
assert.equal(graph.artifacts.filter(a=>a.path===`script/goal/${builtin.name}`).length,1)
assert.equal(graph.artifacts.find(a=>a.path===`script/goal/${builtin.name}`)?.bytes,replacement.content)
assert.equal(graph.artifacts.filter(a=>a.path.startsWith('script/')).length,BUILTIN_SCRIPTS.length+scripts.length)
assert(!graph.artifacts.some(a=>a.path.startsWith('goal/')||a.path.includes('templates/')))
const exported=await exportPaks(workspace,{targets:['server','client']})
for(const pak of exported.packs){const zip=await JSZip.loadAsync(await pak.blob.arrayBuffer());for(const s of sources)assert.equal(!!zip.file(sourcePathOf(s).slice(4)),pak.target==='server');assert(!Object.keys(zip.files).some(p=>p.includes('templates/')))}
assert.equal(SCRIPT_TEMPLATES.length,SCRIPT_TYPES.length)
console.log('PASS script resources: seven types, path/session roundtrip, type-scoped names, whole-file builtin overlay, goal catalog replacement and server/client PAK contents')
