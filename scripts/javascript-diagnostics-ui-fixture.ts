import '../src/monaco/setup'
import {createElement} from 'react'
import {createRoot, type Root} from 'react-dom/client'
import type * as Monaco from 'monaco-editor'
import {JavaScriptEditor} from '../src/monaco/javascript/JavaScriptEditor'
import {updateGameDevServerPrefs} from '../src/gameDevServer/controlHub'
export * as monaco from 'monaco-editor'
let root: Root | null = null
export const source = 'function count(value: number): number {\n    return "wrong";\n}\n'
export function mount() {
  updateGameDevServerPrefs({autoConnect:false,password:'diagnostic-private-password'})
  root=createRoot(document.getElementById('editor')!)
  return new Promise<Monaco.editor.IStandaloneCodeEditor>(resolve=>{
    root!.render(createElement(JavaScriptEditor,{height:'500px',path:'diagnostic-fixture.js',defaultValue:source,scriptType:'common',options:{readOnly:true,minimap:{enabled:false}},onMount:editor=>resolve(editor)}))
  })
}
export function unmount(){root?.unmount();root=null}
