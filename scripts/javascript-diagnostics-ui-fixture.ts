import '../src/monaco/setup'
import {createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import type * as Monaco from 'monaco-editor'
import {JavaScriptEditor} from '../src/monaco/javascript/JavaScriptEditor'
import {JavaLibraryDialog} from '../src/monaco/javascript/JavaLibraryDialog'
import {updateGameDevServerPrefs} from '../src/gameDevServer/controlHub'
import type {ScriptType} from '../src/scriptResources/types'
export * as monaco from 'monaco-editor'
let root: Root | null = null
export const source = 'function count(value: number): number {\n    return "wrong";\n}\n'
export function mount(options:{source?:string;scriptType?:ScriptType;readOnly?:boolean}={}) {
  updateGameDevServerPrefs({autoConnect:false,password:'diagnostic-private-password'})
  root=createRoot(document.getElementById('editor')!)
  return new Promise<Monaco.editor.IStandaloneCodeEditor>(resolve=>{
    root!.render(createElement(JavaScriptEditor,{height:'500px',path:'diagnostic-fixture.js',defaultValue:options.source??source,scriptType:options.scriptType??'common',options:{readOnly:options.readOnly??true,minimap:{enabled:false}},onMount:editor=>resolve(editor)}))
  })
}
export function unmount(){root?.unmount();root=null}
export function mountLibraryDialog(){const dialogRoot=createRoot(document.getElementById('dialog')!);dialogRoot.render(createElement(JavaLibraryDialog,{close:()=>dialogRoot.unmount()}))}
