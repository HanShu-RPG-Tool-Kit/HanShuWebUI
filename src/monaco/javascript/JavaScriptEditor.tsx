import {getProjectSession,subscribeProjectSession} from '../../project/projectSession'
import type {ScriptType} from '../../scriptResources/types'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Editor, { type EditorProps, type OnMount } from '@monaco-editor/react'
import { notify } from '../../activity/activityStore'
import { attachJavaScript } from './javascriptLanguage'
import { registerJavaImportAction, type ImportRequest } from './javaImportAction'
import { JavaImportDialog } from './JavaImportDialog'
import { isControlConnected, subscribeControlHub } from '../../gameDevServer/controlHub'

/** Shared JavaScript editor; host globals and services belong to its project/type profile. */
export function JavaScriptEditor({ onMount, scriptType='common', ...props }: EditorProps & {scriptType?:ScriptType}) {
  const [javaImport, setJavaImport] = useState<{ request: ImportRequest; monaco: typeof import('monaco-editor') } | null>(null)
  const project=useSyncExternalStore(subscribeProjectSession,getProjectSession).binding?.handle.client
  const rebind=useRef<()=>void>(()=>{})
  useEffect(()=>{rebind.current()},[scriptType,project])
  const latest=useRef(scriptType);latest.current=scriptType
  const cleanup = useRef<() => void>(() => {})
  useEffect(() => () => cleanup.current(), [])
  const mount: OnMount = (editor, monaco) => {
    cleanup.current()
    let binding: { dispose(): void } | undefined
    const attach = () => {
      binding?.dispose()
      const model = editor.getModel()
      binding = model ? attachJavaScript(monaco, model, error => {
        notify(`JavaScript 补全：${error instanceof Error ? error.message : String(error)}`, { kind: 'warning' })
      },latest.current) : undefined
    }
    rebind.current=attach
    attach()
    const importAction = registerJavaImportAction(editor, monaco, request => setJavaImport({ request, monaco }))
    const listener = editor.onDidChangeModel(attach)
    const stopControl = subscribeControlHub(() => {
      if (!isControlConnected()) {
        editor.trigger('hanshu-javascript', 'hideSuggestWidget', {})
        editor.trigger('hanshu-javascript', 'closeParameterHints', {})
      }
    })
    cleanup.current = () => { rebind.current=()=>{};stopControl(); importAction.dispose(); listener.dispose(); binding?.dispose() }
    onMount?.(editor, monaco)
  }
  return <><Editor {...props} language="javascript" onMount={mount} />{javaImport && <JavaImportDialog request={javaImport.request} monaco={javaImport.monaco} close={() => setJavaImport(null)} />}</>
}
