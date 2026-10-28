import { useEffect, useRef } from "react"
import Editor, { type OnMount } from "@monaco-editor/react"
import { AssetPreview } from "../../AssetPreview"
import { CHAR_THEME_ID, registerCharLanguage } from "../../monaco/charLanguage"
import { HANSHU_THEME_ID, registerHanshuLanguage } from "../../monaco/hanshuLanguage"
import { PythonEditor } from "../../monaco/python/PythonEditor"
import { useProjectSession } from "../../project/projectSession"
import { scriptType } from "../../scriptResources/types"
import { useViewFlags } from "../../ui/viewFlags"
import { editorLanguageForFile, findAsset, findScript, isCharFile, type Workspace } from "../../workspace"
import { scriptEditorAppearance, scriptViewFlags } from "../scriptView"
import type { EditorPage } from "./EditorTabs"

/**
 * 非活动分栏的普通编辑页。
 * 脚本改动只走调用方传入的 writeScriptContent，不另开保存通道。资源页只读。
 */
export function SecondaryDockPage({
  page,
  workspace,
  readOnly = false,
  onChangeScript,
}: {
  page: EditorPage
  workspace: Workspace
  readOnly?: boolean
  onChangeScript: (scriptId: string, text: string) => void
}) {
  if (page.kind === "asset") {
    const hit = findAsset(workspace, page.id)
    if (!hit) return <div className="editor-closed" role="status">未打开文件</div>
    return <AssetPreview packageId={hit.pkg.id} asset={hit.asset} />
  }
  const hit = findScript(workspace, page.id)
  if (!hit) return <div className="editor-closed" role="status">未打开文件</div>
  return (
    <SecondaryScriptEditor
      scriptId={hit.script.id}
      name={hit.script.name}
      srcKind={hit.script.srcKind}
      content={hit.script.content}
      readOnly={readOnly}
      onChange={onChangeScript}
    />
  )
}

function SecondaryScriptEditor({
  scriptId,
  name,
  srcKind,
  content,
  readOnly,
  onChange,
}: {
  scriptId: string
  name: string
  srcKind?: string | null
  content: string
  readOnly: boolean
  onChange: (scriptId: string, text: string) => void
}) {
  const view = useViewFlags(scriptViewFlags)
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const python = editorLanguageForFile(name) === "python"
  const SourceEditor = python ? PythonEditor : Editor
  const projectId = useProjectSession().binding?.handle.client.snapshot.projectId ?? "unbound"
  useEffect(() => {
    editorRef.current?.updateOptions({ ...scriptEditorAppearance(view), readOnly })
  }, [view, readOnly])
  return (
    <main className="editor-shell">
      <div className="editor-pane">
        <SourceEditor
          key={scriptId}
          {...(python ? { scriptType: scriptType(srcKind), path: `python-source://${projectId}/${scriptId}/${name}` } : {})}
          height="100%"
          language={editorLanguageForFile(name)}
          theme={isCharFile(name) ? CHAR_THEME_ID : HANSHU_THEME_ID}
          value={content}
          beforeMount={(monaco) => {
            registerHanshuLanguage(monaco)
            registerCharLanguage(monaco)
          }}
          onMount={(editor) => {
            editorRef.current = editor
            editor.updateOptions({ ...scriptEditorAppearance(scriptViewFlags.get()), readOnly })
          }}
          onChange={(next) => onChange(scriptId, next ?? "")}
          options={{
            ...scriptEditorAppearance(view),
            readOnly,
            domReadOnly: readOnly,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 14, bottom: 14 },
            renderLineHighlight: "all",
            cursorBlinking: "smooth",
            overviewRulerBorder: false,
            stickyScroll: { enabled: false },
            dropIntoEditor: { enabled: false },
            scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 14 },
          }}
        />
      </div>
    </main>
  )
}
