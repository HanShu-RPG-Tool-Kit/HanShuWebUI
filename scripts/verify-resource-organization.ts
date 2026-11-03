import JSZip from 'jszip'
import {buildProjectPackZip} from '../src/export/projectPack'
import assert from 'node:assert/strict'
import {RESOURCE_TYPES,categoryExtensions} from '../src/resourceTypes'
import {assertCanonicalSourcePath,sourcePathOf,findScriptByName,createProject,createSourceFile} from '../src/workspace'
import {emptyOrganization,parseOrganization,serializeOrganization,organizationFromDocuments,documentPlacements,relocateOrganization,projectDomainOrganization,domainFolders} from '../src/project/explorerOrganization'
import {AUDIOVISUAL_DOMAIN,DEFAULT_ORGANIZATION_REGISTRY,GAMEPLAY_DOMAIN,STAGEPLAY_DOMAIN,categoryAllowsFolders,organizationRegistry} from '../src/project/organizationDomains'
import {addVirtualFolder,moveVirtualFolder,placeSource,removeVirtualFolder,renameVirtualFolder} from '../src/explorerShell/virtualFolders'
import {gameplayFolders,canMoveFlowEntry,moveFlowEntry,requireAvailableName,sectionFolderKey,packageAcceptsImportFile,withLibraryTables,isBuiltinScriptDocumentKey,scriptTypeInFolder,ensurePackageSections} from '../src/workspaces/gameplay/library'
import {withBuiltinScripts} from '../src/workspaces/gameplay/scriptResources'
import type {FlowWorkspaceState} from '../src/workspaces/gameplay/storage'
let checks=0
const test=(name:string,run:()=>void)=>{run();checks++;console.log('PASS',name)}
const state=():FlowWorkspaceState=>({documents:[{key:'a',name:'apple.item',package:'items',folderId:'f',source:'{}'}],folders:[{key:'f',name:'Food',parentId:null,category:'items'}],activeKey:null})
test('canonical paths are lossless and nested source paths fail explicitly',()=>{
 for(const type of RESOURCE_TYPES){const path=sourcePathOf({name:`test${type.ext}`});assert.doesNotThrow(()=>assertCanonicalSourcePath(path))}
 assert.throws(()=>assertCanonicalSourcePath('src/items/nested/apple.item'),/非规范资源路径/)
 assert.throws(()=>assertCanonicalSourcePath('src/script/unknown/a.js'),/非规范资源路径/)
})
test('category formats and import conversion are distinct',()=>{
 assert.deepEqual(categoryExtensions('items'),['.item']);assert(packageAcceptsImportFile('items','a.itemstack'));assert(!categoryExtensions('items').includes('.itemstack'))
 assert.deepEqual(categoryExtensions('actor'),['.actor'])
})
test('folder cannot retag incompatible children by crossing categories',()=>{
 assert.equal(canMoveFlowEntry(state(),{kind:'folder',key:'f'},'gift',null),false)
 assert.throws(()=>moveFlowEntry(state(),{kind:'folder',key:'f'},'gift',null))
})
test('real builtin and library views do not block empty or populated folder moves',()=>{
 const base=state()
 base.folders.push({key:'target',name:'Target',parentId:null,category:'items'},{key:'empty',name:'Empty',parentId:null,category:'items'})
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
 const s=withLibraryTables(withBuiltinScripts({documents:[{key:'a',name:'same.js',package:'script',folderId:'nested',source:''},{key:'b',name:'same.js',package:'script',folderId:sectionFolderKey('script','kit'),source:''}],folders:[{key:'f',name:'Folder',parentId:sectionFolderKey('script','common'),category:'script'},{key:'nested',name:'Nested',parentId:'f',category:'script'}],activeKey:null}))
 assert.throws(()=>moveFlowEntry(s,{kind:'folder',key:'f'},'script',sectionFolderKey('script','kit')),/同名/)
 assert.doesNotThrow(()=>requireAvailableName(s,'same.js','script',sectionFolderKey('script','actor')))
 const moved=moveFlowEntry(s,{kind:'folder',key:'f'},'script',sectionFolderKey('script','actor'))
 assert.equal(scriptTypeInFolder(moved,moved.documents.find(doc=>doc.key==='a')!.folderId??null),'actor')
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
  {key:'maps',name:'Maps',category:'level',parentId:sectionFolderKey('level','templates')},
  {key:'routes',name:'Routes',category:'level',parentId:sectionFolderKey('level','dynamic-nav')},
  {key:'nested',name:'Nested',category:'level',parentId:'routes'},
 )
 projected.documents[0].folderId='maps';projected.documents[1].folderId='nested'
 const org=organizationFromDocuments(projected.documents,projected.folders)
 assert.deepEqual(org.placements,{'src/level/hub.level':'maps','src/navigator/camp.nav':'nested'})
 assert.equal(org.folders.length,3)
 assert.equal(serializeOrganization(parseOrganization(serializeOrganization(org))),serializeOrganization(org))
 for(const parentId of ['section:level:static-nav','section:level:missing','section:script:kit'])
  assert.throws(()=>parseOrganization(JSON.stringify({...org,folders:[{key:'bad',name:'Bad',category:'level',parentId}],placements:{}})))
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
 const files=[createSourceFile('same.js','','common'),createSourceFile('same.js','','kit')]
 const w={packages:[createProject('test',files)],activeScriptId:null,activeAssetId:null}
 assert.throws(()=>findScriptByName(w,'same.js'),/不唯一/)
 assert.equal(findScriptByName(w,'src/script/kit/same.js')?.script.srcKind,'kit')
 assert.deepEqual(parseOrganization(null),emptyOrganization())
})
test('legacy v1 package field is read and rewritten as v2 category',()=>{
 const legacy={version:1,folders:[{key:'f',name:'Food',package:'items',parentId:null}],placements:{'src/items/apple.item':'f'}}
 const parsed=parseOrganization(JSON.stringify(legacy))
 assert.deepEqual(parsed.folders,[{key:'f',name:'Food',parentId:null,category:'items'}])
 const written=JSON.parse(serializeOrganization(parsed))
 assert.equal(written.version,2);assert.equal(written.folders[0].category,'items');assert(!('package' in written.folders[0]))
 assert.throws(()=>parseOrganization(JSON.stringify({...legacy,version:2})),/虚拟文件夹无效/)
 assert.throws(()=>parseOrganization(JSON.stringify({...legacy,version:3})),/格式无效/)
})
test('audiovisual categories validate against their own table',()=>{
 const av={version:2,folders:[{key:'bars',name:'首领',category:'bossbar',parentId:null}],placements:{'src/bossbars/dragon.bossbar':'bars'}}
 assert.deepEqual(parseOrganization(JSON.stringify(av)).placements,{'src/bossbars/dragon.bossbar':'bars'})
 for(const candidate of [
  {...av,folders:[{key:'ui',name:'界面',category:'ui',parentId:null}],placements:{}},
  {...av,folders:[{key:'bars',name:'首领',category:'bossbar',parentId:'section:script:kit'}]},
  {...av,placements:{'src/items/apple.item':'bars'}},
  {...av,placements:{'src/hanshu/a.hs':'bars'}},
  {...av,folders:[...av.folders,{key:'h',name:'剧本',category:'hanshu',parentId:'bars'}],placements:{}},
  {...av,folders:[...av.folders,{key:'q',name:'Quest',category:'quest',parentId:'bars'}],placements:{}},
 ])assert.throws(()=>parseOrganization(JSON.stringify(candidate)))
 assert.throws(()=>organizationRegistry([GAMEPLAY_DOMAIN,{...AUDIOVISUAL_DOMAIN,categories:{quest:{name:'x',types:[]}}}]),/分类 ID 重复/)
 assert.throws(()=>organizationRegistry([GAMEPLAY_DOMAIN,{...AUDIOVISUAL_DOMAIN,categories:{other:{name:'x',types:['item']}}}]),/多个分类/)
})
test('stageplay categories allow shared virtual folders without changing disk paths',()=>{
 for(const category of Object.keys(STAGEPLAY_DOMAIN.categories))assert(categoryAllowsFolders(DEFAULT_ORGANIZATION_REGISTRY,category),`${category} should allow folders`)
 let org=emptyOrganization()
 const chapter=addVirtualFolder(org,'hanshu',null,'第一章');org=chapter.organization
 const cast=addVirtualFolder(org,'character',null,'主角');org=cast.organization
 const notes=addVirtualFolder(org,'meta',null,'设定');org=notes.organization
 org=placeSource(org,sourcePathOf({name:'序章.hs'}),chapter.folder.key)
 org=placeSource(org,sourcePathOf({name:'林砚.char'}),cast.folder.key)
 org=placeSource(org,sourcePathOf({name:'世界观.md'}),notes.folder.key)
 org=placeSource(org,sourcePathOf({name:'林砚.tts'}),notes.folder.key)
 assert.deepEqual(Object.keys(org.placements).sort(),['meta/docs/世界观.md','meta/voice/林砚.tts','src/character/林砚.char','src/hanshu/序章.hs'])
 assert.throws(()=>placeSource(org,'src/character/林砚.char',chapter.folder.key))
 assert.throws(()=>addVirtualFolder(org,'character',chapter.folder.key,'错分类'),/不在当前分类/)
 const parsed=JSON.parse(serializeOrganization(org))
 assert.equal(parsed.version,2);assert.deepEqual(parsed.folders.map((folder:{category:string})=>folder.category).sort(),['character','hanshu','meta'])
 const renamed=relocateOrganization(org,[{path:'src/hanshu/序章.hs',destination:'src/hanshu/楔子.hs'}])
 assert.equal(renamed.placements['src/hanshu/楔子.hs'],chapter.folder.key)
 assert(!relocateOrganization(org,[{path:'src/hanshu/序章.hs',destination:null}]).placements['src/hanshu/序章.hs'])
})
test('stageplay, audiovisual and gameplay projections never erase each other',()=>{
 const s=state()
 const av={version:2 as const,folders:[{key:'bars',name:'首领',category:'bossbar',parentId:null}],placements:{'src/bossbars/dragon.bossbar':'bars'}}
 const stage={version:2 as const,folders:[{key:'ch1',name:'第一章',category:'hanshu',parentId:null}],placements:{'src/hanshu/序章.hs':'ch1'}}
 const merged=organizationFromDocuments(s.documents,s.folders,{organization:{version:2,folders:[...av.folders,...stage.folders],placements:{...av.placements,...stage.placements}},sourcePaths:[]})
 assert.deepEqual(merged.folders.map(folder=>folder.key).sort(),['bars','ch1','f'])
 assert.deepEqual(domainFolders(merged,STAGEPLAY_DOMAIN).map(folder=>folder.key),['ch1'])
 const avOnly=projectDomainOrganization(AUDIOVISUAL_DOMAIN,[],{},{organization:merged,sourcePaths:['src/bossbars/dragon.bossbar']})
 assert.deepEqual(avOnly.folders.map(folder=>folder.key).sort(),['ch1','f'])
 assert.equal(avOnly.placements['src/hanshu/序章.hs'],'ch1')
 const stageOnly=projectDomainOrganization(STAGEPLAY_DOMAIN,[],{},{organization:merged,sourcePaths:['src/hanshu/序章.hs']})
 assert.deepEqual(stageOnly.folders.map(folder=>folder.key).sort(),['bars','f'])
 assert.deepEqual(stageOnly.placements,{'src/bossbars/dragon.bossbar':'bars','src/items/apple.item':'f'})
 const gameplayOnly=organizationFromDocuments([],[],{organization:merged,sourcePaths:['src/items/apple.item']})
 assert.deepEqual(gameplayOnly.folders.map(folder=>folder.key).sort(),['bars','ch1'])
 assert.equal(gameplayOnly.placements['src/hanshu/序章.hs'],'ch1')
})
test('each domain replaces only its own folders and projected placements',()=>{
 const av={version:2 as const,folders:[{key:'bars',name:'首领',category:'bossbar',parentId:null}],placements:{'src/bossbars/dragon.bossbar':'bars'}}
 const s=state()
 const merged=organizationFromDocuments(s.documents,s.folders,{organization:av,sourcePaths:[]})
 assert.deepEqual(merged.placements,{'src/bossbars/dragon.bossbar':'bars','src/items/apple.item':'f'})
 assert.deepEqual(merged.folders.map(folder=>folder.key).sort(),['bars','f'])
 assert.deepEqual(organizationFromDocuments([],[],{organization:merged,sourcePaths:['src/items/apple.item']}),av)
 const avOnly=projectDomainOrganization(AUDIOVISUAL_DOMAIN,[],{},{organization:merged,sourcePaths:['src/bossbars/dragon.bossbar']})
 assert.deepEqual(avOnly.folders.map(folder=>folder.key),['f']);assert.deepEqual(avOnly.placements,{'src/items/apple.item':'f'})
 assert.deepEqual(gameplayFolders(merged).map(folder=>folder.key),['f'])
 assert.deepEqual(domainFolders(merged,AUDIOVISUAL_DOMAIN).map(folder=>folder.key),['bars'])
})
test('virtual folder operations stay inside a category and never delete sources',()=>{
 let org=emptyOrganization()
 const added=addVirtualFolder(org,'bossbar',null,'首领');org=added.organization
 const child=addVirtualFolder(org,'bossbar',added.folder.key,'龙');org=child.organization
 assert.throws(()=>addVirtualFolder(org,'bossbar',null,'首领'),/同名/)
 assert.throws(()=>addVirtualFolder(org,'ui',null,'界面'),/不支持文件夹/)
 assert.throws(()=>addVirtualFolder(org,'items',added.folder.key,'错分类'),/不在当前分类/)
 org=placeSource(org,'src/bossbars/dragon.bossbar',child.folder.key)
 assert.throws(()=>placeSource(org,'src/items/apple.item',child.folder.key))
 assert.throws(()=>moveVirtualFolder(org,added.folder.key,child.folder.key),/子文件夹/)
 org=renameVirtualFolder(org,child.folder.key,'巨龙')
 org=moveVirtualFolder(org,child.folder.key,null)
 assert.equal(org.folders.find(folder=>folder.key===child.folder.key)?.parentId,null)
 org=moveVirtualFolder(org,child.folder.key,added.folder.key)
 org=removeVirtualFolder(org,added.folder.key)
 assert.deepEqual(org,emptyOrganization())
 const gameplay=addVirtualFolder(emptyOrganization(),'script',sectionFolderKey('script','kit'),'工具')
 assert.doesNotThrow(()=>placeSource(gameplay.organization,'src/script/kit/a.js',gameplay.folder.key))
 assert.throws(()=>placeSource(gameplay.organization,'src/script/common/a.js',gameplay.folder.key),/脚本类型/)
})
console.log(`${checks} resource organization checks passed`)

const org=organizationFromDocuments(state().documents,state().folders)
const project={...createProject('exported'),explorer:org}
const pack=await buildProjectPackZip({packages:[project],activeScriptId:null,activeAssetId:null})
const zip=await JSZip.loadAsync(await pack.blob.arrayBuffer())
assert.deepEqual(JSON.parse(await zip.file('exported/meta/explorer.json')!.async('string')),JSON.parse(serializeOrganization(org)))
console.log('PASS engineering export preserves shared organization metadata')
