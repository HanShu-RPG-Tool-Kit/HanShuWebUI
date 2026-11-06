import {getProjectSession,subscribeProjectSession} from '../../project/projectSession'
import type {ScriptType} from '../../scriptResources/types'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Editor, { type EditorProps, type OnMount } from '@monaco-editor/react'
import { notify } from '../../activity/activityStore'
import { attachJavaScript, captureJavaScriptDiagnostics, JAVASCRIPT_LANGUAGE_ID, registerJavaScriptLanguage } from './javascriptLanguage'
import { registerJavaImportAction, type ImportRequest } from './javaImportAction'
import { JavaImportDialog } from './JavaImportDialog'
import { registerHookInsertAction, type HookInsertRequest } from './hookInsertAction'
import { HookInsertDialog } from './HookInsertDialog'
import { getControlHubSnapshot, isControlConnected, subscribeControlHub } from '../../gameDevServer/controlHub'
import {LanguageDiagnosticsDialog, type LanguageDiagnosticsRequest} from './LanguageDiagnosticsDialog'
import {recordLanguageDiagnostic} from './diagnostics'

/** Shared JavaScript editor; host globals and services belong to its project/type profile. */
export function JavaScriptEditor({ onMount, beforeMount, scriptType='common', ...props }: EditorProps & {scriptType?:ScriptType}) {
  const [javaImport, setJavaImport] = useState<{ request: ImportRequest; monaco: typeof import('monaco-editor') } | null>(null)
  const [hookInsert, setHookInsert] = useState<{ request: HookInsertRequest; monaco: typeof import('monaco-editor') } | null>(null)
  const [diagnostics, setDiagnostics] = useState<LanguageDiagnosticsRequest | null>(null)
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
      try {
        binding = model ? attachJavaScript(monaco, model, error => {
          notify(`JavaScript 补全：${error instanceof Error ? error.message : String(error)}`, { kind: 'warning' })
        },latest.current) : undefined
      } catch (error) {
        recordLanguageDiagnostic('editor', 'attach-error', error)
        notify(`JavaScript 语言服务启动失败：${String(error)}`, {kind:'warning'})
      }
    }
    rebind.current=attach
    attach()
    const importAction = registerJavaImportAction(editor, monaco, request => setJavaImport({ request, monaco }))
    const hookAction = registerHookInsertAction(editor, monaco, request => setHookInsert({ request, monaco }))
    const completionAction = editor.addAction({
      id:'hanshu.javascript.triggerSuggest',label:'显示脚本补全',
      keybindings:[monaco.KeyMod.Alt | monaco.KeyCode.Slash],
      precondition:'editorTextFocus && !editorReadonly && editorLangId == hanshu-javascript',
      run:()=>editor.trigger('hanshu-javascript','editor.action.triggerSuggest',{}),
    })
    const openDiagnostics = () => {
      const model=editor.getModel();if(!model||model.isDisposed())return
      setDiagnostics({name:model.uri.path.split('/').at(-1)??'script.js',report:captureJavaScriptDiagnostics(model,editor.getPosition(),editor.getSelection()),password:getControlHubSnapshot().prefs.password})
    }
    const diagnosticAction = editor.addAction({
      id:'hanshu.javascript.exportDiagnostics',label:'导出语言服务诊断…',
      contextMenuGroupId:'navigation',contextMenuOrder:4,
      precondition:'editorLangId == hanshu-javascript',
      run:openDiagnostics,
    })
    const diagnosticButton=document.createElement('button')
    diagnosticButton.type='button';diagnosticButton.className='javascript-diagnostics-button';diagnosticButton.textContent='诊断'
    diagnosticButton.title='导出语言服务诊断';diagnosticButton.setAttribute('aria-label','导出语言服务诊断')
    diagnosticButton.onmousedown=event=>event.stopPropagation();diagnosticButton.onclick=openDiagnostics
    const diagnosticWidget={getId:()=> 'hanshu.javascript.diagnostics',getDomNode:()=>diagnosticButton,getPosition:()=>({preference:monaco.editor.OverlayWidgetPositionPreference.TOP_RIGHT_CORNER})}
    editor.addOverlayWidget(diagnosticWidget)
    const listener = editor.onDidChangeModel(attach)
    // 只在「已连接 → 断开」时收起补全；自动重连轮询会反复 bump 且长期未连接，
    // 若每次都 hideSuggestWidget，离线 Alt+/ 弹层会被秒关。
    let controlConnected = isControlConnected()
    const stopControl = subscribeControlHub(() => {
      const next = isControlConnected()
      if (controlConnected && !next) {
        editor.trigger('hanshu-javascript', 'hideSuggestWidget', {})
        editor.trigger('hanshu-javascript', 'closeParameterHints', {})
      }
      controlConnected = next
    })
    cleanup.current = () => { rebind.current=()=>{};stopControl(); editor.removeOverlayWidget(diagnosticWidget); diagnosticButton.onclick=null; diagnosticAction.dispose(); completionAction.dispose(); hookAction.dispose(); importAction.dispose(); listener.dispose(); binding?.dispose() }
    onMount?.(editor, monaco)
  }
  return <><Editor {...props} language={JAVASCRIPT_LANGUAGE_ID} beforeMount={monaco=>{registerJavaScriptLanguage(monaco);beforeMount?.(monaco)}} onMount={mount} />{javaImport && <JavaImportDialog request={javaImport.request} monaco={javaImport.monaco} close={() => setJavaImport(null)} />}{hookInsert && <HookInsertDialog request={hookInsert.request} monaco={hookInsert.monaco} close={() => setHookInsert(null)} />}{diagnostics && <LanguageDiagnosticsDialog request={diagnostics} close={() => setDiagnostics(null)} />}</>
}
