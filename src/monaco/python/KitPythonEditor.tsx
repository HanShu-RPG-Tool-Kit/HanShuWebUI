import { useEffect, useRef } from 'react'
import Editor, { type EditorProps, type OnMount } from '@monaco-editor/react'
import { notify } from '../../activity/activityStore'
import { attachKitPython } from './kitPythonLanguage'

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
    cleanup.current = () => { listener.dispose(); binding?.dispose() }
    onMount?.(editor, monaco)
  }
  return <Editor {...props} language="python" onMount={mount} />
}
