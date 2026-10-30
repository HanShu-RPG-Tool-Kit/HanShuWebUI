import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { PythonEditor } from '../src/monaco/python/PythonEditor'
import type { OnMount } from '@monaco-editor/react'

export function mountPythonTools(element: HTMLElement, source: string, onMount: OnMount) {
  const root = createRoot(element)
  root.render(createElement(PythonEditor, { defaultValue: source, scriptType: 'common', theme: 'vs-dark', options: { minimap: { enabled: false }, automaticLayout: true }, onMount }))
  return root
}
