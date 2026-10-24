import { useEffect, useRef } from 'react'
import Editor, { type EditorProps, type OnMount } from '@monaco-editor/react'
import { notify } from '../../activity/activityStore'
import { attachKitPython } from './kitPythonLanguage'
import { isControlConnected, subscribeControlHub } from '../../gameDevServer/controlHub'

/** Drop-in Monaco editor with real Pyright and the runtime's injected kit globals. */
export function KitPythonEditor({ onMount, ...props }: EditorProps) {
  const cleanup = useRef<() => void>(() => {})
  useEffect(() => () => cleanup.current(), [])
  const mount: OnMount = (editor, monaco) => {
    cleanup.current()
    let binding: { dispose(): void } | undefined
    const attach = () => {
      binding?.dispose()
      const model = editor.getModel()
      binding = model ? attachKitPython(monaco, model, error => {
        notify(`Python 补全：${error instanceof Error ? error.message : String(error)}`, { kind: 'warning' })
      }) : undefined
    }
    attach()
    const listener = editor.onDidChangeModel(attach)
    const stopControl = subscribeControlHub(() => {
      if (!isControlConnected()) {
        editor.trigger('kit-python', 'hideSuggestWidget', {})
        editor.trigger('kit-python', 'closeParameterHints', {})
      }
    })
    cleanup.current = () => { stopControl(); listener.dispose(); binding?.dispose() }
    onMount?.(editor, monaco)
  }
  return <Editor {...props} language="python" onMount={mount} />
}
