import JSZip from 'jszip'
import {buildProjectPackZip} from '../src/export/projectPack'
import assert from 'node:assert/strict'
import {RESOURCE_TYPES,categoryExtensions} from '../src/resourceTypes'
import {assertCanonicalSourcePath,sourcePathOf,findScriptByName,createProject,createSourceFile} from '../src/workspace'
import {emptyOrganization,parseOrganization,serializeOrganization,organizationFromDocuments,documentPlacements,relocateOrganization} from '../src/project/explorerOrganization'
import {canMoveFlowEntry,moveFlowEntry,requireAvailableName,sectionFolderKey,packageAcceptsImportFile,withLibraryTables,isBuiltinScriptDocumentKey,scriptTypeInFolder,ensurePackageSections} from '../src/workspaces/gameplay/library'
import {withBuiltinScripts} from '../src/workspaces/gameplay/scriptResources'
import type {FlowWorkspaceState} from '../src/workspaces/gameplay/storage'
let checks=0
const test=(name:string,run:()=>void)=>{run();checks++;console.log('PASS',name)}
const state=():FlowWorkspaceState=>({documents:[{key:'a',name:'apple.item',package:'items',folderId:'f',source:'{}'}],folders:[{key:'f',name:'Food',parentId:null,package:'items'}],activeKey:null})
test('canonical paths are lossless and nested source paths fail explicitly',()=>{
 for(const type of RESOURCE_TYPES){const path=sourcePathOf({name:`test${type.ext}`});assert.doesNotThrow(()=>assertCanonicalSourcePath(path))}
 assert.throws(()=>assertCanonicalSourcePath('src/items/nested/apple.item'),/非规范资源路径/)
 assert.throws(()=>assertCanonicalSourcePath('src/script/unknown/a.py'),/非规范资源路径/)
})
test('category formats and import conversion are distinct',()=>{
 assert.deepEqual(categoryExtensions('items'),['.item']);assert(packageAcceptsImportFile('items','a.itemstack'));assert(!categoryExtensions('items').includes('.itemstack'))
 assert.equal(categoryExtensions('actor').length,0)
})
test('folder cannot retag incompatible children by crossing categories',()=>{
 assert.equal(canMoveFlowEntry(state(),{kind:'folder',key:'f'},'gift',null),false)
 assert.throws(()=>moveFlowEntry(state(),{kind:'folder',key:'f'},'gift',null))
})
test('real builtin and library views do not block empty or populated folder moves',()=>{
 const base=state()
 base.folders.push({key:'target',name:'Target',parentId:null,package:'items'},{key:'empty',name:'Empty',parentId:null,package:'items'})
 const s=withLibraryTables(withBuiltinScripts(base))
 assert(s.documents.some(doc=>isBuiltinScriptDocumentKey(doc.key)))
 for(const key of ['f','empty']){
  assert(canMoveFlowEntry(s,{kind:'folder',key},'items','target'))
  const moved=moveFlowEntry(s,{kind:'folder',key},'items','target')
  assert.equal(moved.folders.find(folder=>folder.key===key)?.parentId,'target')
  assert.deepEqual(moved.documents,s.documents)
 }
})

test('script subtree moves with builtin views check nested destination name collisions',()=>{
 const s=withLibraryTables(withBuiltinScripts({documents:[{key:'a',name:'same.py',package:'script',folderId:'nested',source:''},{key:'b',name:'same.py',package:'script',folderId:sectionFolderKey('script','kit'),source:''}],folders:[{key:'f',name:'Folder',parentId:sectionFolderKey('script','common'),package:'script'},{key:'nested',name:'Nested',parentId:'f',package:'script'}],activeKey:null}))
 assert.throws(()=>moveFlowEntry(s,{kind:'folder',key:'f'},'script',sectionFolderKey('script','kit')),/同名/)
 assert.doesNotThrow(()=>requireAvailableName(s,'same.py','script',sectionFolderKey('script','entity')))
 const moved=moveFlowEntry(s,{kind:'folder',key:'f'},'script',sectionFolderKey('script','entity'))
 assert.equal(scriptTypeInFolder(moved,moved.documents.find(doc=>doc.key==='a')!.folderId??null),'entity')
 assert.equal(scriptTypeInFolder(moved,moved.documents.find(doc=>doc.key==='b')!.folderId??null),'kit')
})
test('shared placements are canonical paths, not window-local IDs',()=>{
 const s=state(),org=organizationFromDocuments(s.documents,s.folders)
 assert.equal(org.placements['src/items/apple.item'],'f')
 assert.equal(documentPlacements([{...createSourceFile('apple.item'),id:'another-client'}],org)['another-client'],'f')
 assert.equal(serializeOrganization(parseOrganization(serializeOrganization(org))),serializeOrganization(org))
})
test('map sections round-trip without leaking default document placements',()=>{
 const projected=ensurePackageSections({documents:[
  {key:'level',name:'hub.level',package:'level',folderId:sectionFolderKey('level','templates'),source:'{}'},
  {key:'nav',name:'camp.nav',package:'level',folderId:sectionFolderKey('level','dynamic-nav'),source:'{}'},
 ],folders:[],activeKey:'level'})
 assert.deepEqual(organizationFromDocuments(projected.documents,projected.folders),emptyOrganization())
 projected.folders.push(
  {key:'maps',name:'Maps',package:'level',parentId:sectionFolderKey('level','templates')},
  {key:'routes',name:'Routes',package:'level',parentId:sectionFolderKey('level','dynamic-nav')},
  {key:'nested',name:'Nested',package:'level',parentId:'routes'},
 )
 projected.documents[0].folderId='maps';projected.documents[1].folderId='nested'
 const org=organizationFromDocuments(projected.documents,projected.folders)
 assert.deepEqual(org.placements,{'src/level/hub.level':'maps','src/navigator/camp.nav':'nested'})
 assert.equal(org.folders.length,3)
 assert.equal(serializeOrganization(parseOrganization(serializeOrganization(org))),serializeOrganization(org))
 for(const parentId of ['section:level:static-nav','section:level:missing','section:script:kit'])
  assert.throws(()=>parseOrganization(JSON.stringify({...org,folders:[{key:'bad',name:'Bad',package:'level',parentId}],placements:{}})))
})

test('cycles, invalid parents, category/type mismatch and sibling duplicates rejected',()=>{
 const org=organizationFromDocuments(state().documents,state().folders)
 for(const candidate of [
 {...org,folders:[{...org.folders[0],parentId:'f'}]},
 {...org,folders:[{...org.folders[0],parentId:'missing'}]},
 {...org,placements:{'src/gift/a.kit':'f'}},
 {...org,folders:[...org.folders,{...org.folders[0],key:'g',name:'food'}]},
 {...org,placements:{'src/items/nested/apple.item':'f'}},
 ])assert.throws(()=>parseOrganization(JSON.stringify(candidate)))
})
test('rename/delete relocate placements without changing virtual folders',()=>{
 const org=organizationFromDocuments(state().documents,state().folders)
 const moved=relocateOrganization(org,[{path:'src/items/apple.item',destination:'src/items/pear.item'}])
 assert.equal(moved.placements['src/items/pear.item'],'f');assert(!moved.placements['src/items/apple.item'])
 assert.deepEqual(relocateOrganization(moved,[{path:'src/items/pear.item',destination:null}]).placements,{})
 assert.deepEqual(moved.folders,org.folders)
})
test('ambiguous bare names fail while canonical lookup remains exact',()=>{
 const files=[createSourceFile('same.py','','common'),createSourceFile('same.py','','kit')]
 const w={packages:[createProject('test',files)],activeScriptId:null,activeAssetId:null}
 assert.throws(()=>findScriptByName(w,'same.py'),/不唯一/)
 assert.equal(findScriptByName(w,'src/script/kit/same.py')?.script.srcKind,'kit')
 assert.deepEqual(parseOrganization(null),emptyOrganization())
})
console.log(`${checks} resource organization checks passed`)

const org=organizationFromDocuments(state().documents,state().folders)
const project={...createProject('exported'),explorer:org}
const pack=await buildProjectPackZip({packages:[project],activeScriptId:null,activeAssetId:null})
const zip=await JSZip.loadAsync(await pack.blob.arrayBuffer())
assert.deepEqual(JSON.parse(await zip.file('exported/meta/explorer.json')!.async('string')),JSON.parse(serializeOrganization(org)))
console.log('PASS engineering export preserves shared organization metadata')
