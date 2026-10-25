import {BUILTIN_SCRIPTS,effectiveBuiltinScripts,SCRIPT_TYPES,scriptSection} from '../../scriptResources'
import {builtinScriptFolderKey,builtinScriptDocumentKey,isBuiltinScriptDocumentKey,isBuiltinScriptFolder,ensurePackageSections,sectionFolderKey,scriptTypeInFolder} from './library'
import {stampDocument,type FlowWorkspaceState} from './storage'
export function withBuiltinScripts(state:FlowWorkspaceState):FlowWorkspaceState{
 const base=stripBuiltinScripts(ensurePackageSections(state))
 const project=base.documents.filter(d=>d.package==='script').map(d=>({name:d.name,srcKind:scriptTypeInFolder(base,d.folderId??null)}))
 const effective=effectiveBuiltinScripts(project)
 return {...base,folders:[...base.folders,...SCRIPT_TYPES.filter(type=>BUILTIN_SCRIPTS.some(s=>s.type===type)).map(type=>({key:builtinScriptFolderKey(type),name:'内置',parentId:sectionFolderKey('script',scriptSection(type)),package:'script' as const}))],documents:[...base.documents,...effective.map(s=>stampDocument({key:builtinScriptDocumentKey(s.type,s.name),name:s.name,source:s.source,package:'script',folderId:builtinScriptFolderKey(s.type)}))]}
}
export function stripBuiltinScripts(state:FlowWorkspaceState):FlowWorkspaceState{return {...state,documents:state.documents.filter(d=>!isBuiltinScriptDocumentKey(d.key)),folders:state.folders.filter(f=>!isBuiltinScriptFolder(f.key))}}
