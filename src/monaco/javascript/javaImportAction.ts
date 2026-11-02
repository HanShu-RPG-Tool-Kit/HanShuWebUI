import type * as Monaco from 'monaco-editor'
import { getProjectSession } from '../../project/projectSession'
import { controlRequest, controlConnectionGeneration, isControlConnected } from '../../gameDevServer/controlHub'
import { notify } from '../../activity/activityStore'
import { planJavaImport, javaImportReferenceMatches, type JavaClassEntry } from './javaImportPlan'
import type { StubResponse } from './stubs'
import { refreshJavaScriptImports } from './javascriptLanguage'
import {libraryKey,readJavaLibrary,readLibraryClasses} from './javaLibrary'

export type ImportRequest = {
  editor: Monaco.editor.IStandaloneCodeEditor; model: Monaco.editor.ITextModel
  version: number; query: string; range?: Monaco.IRange
  project: unknown; connection: number; endpoint?:string
}
export type ClassSearch = { schemaVersion: 1; runtimeId: string; classes: JavaClassEntry[]; hasMore: boolean }
export function importRequestActive(request: ImportRequest, monaco: typeof Monaco) {
  return !request.model.isDisposed() && request.editor.getModel() === request.model && !request.editor.getOption(monaco.editor.EditorOption.readOnly) && request.model.getVersionId() === request.version && getProjectSession().binding?.handle.client === request.project && (!request.endpoint||request.endpoint===libraryKey()) && controlConnectionGeneration() === request.connection
}
export async function searchJavaClasses(query: string): Promise<ClassSearch> {
  const library=await readJavaLibrary().catch(()=>undefined)
  if(library){const q=query.trim().toLowerCase(),matches=q.length<2?[]:library.classes.filter(c=>c.name.toLowerCase().includes(q)).sort((a,b)=>Number(b.symbol.toLowerCase()===q)-Number(a.symbol.toLowerCase()===q)||a.name.localeCompare(b.name));return {schemaVersion:1,runtimeId:library.id,classes:matches.slice(0,30),hasMore:matches.length>30}}
  const response = await controlRequest('javascript.classes.search', { query, limit: 30 }) as ClassSearch
  if (!response || response.schemaVersion !== 1 || typeof response.runtimeId !== 'string' || typeof response.hasMore !== 'boolean' || !Array.isArray(response.classes) || response.classes.length > 50 || response.classes.some(c => !c || typeof c.name !== 'string' || typeof c.symbol !== 'string' || typeof c.packageName !== 'string' || typeof c.origin !== 'string')) throw new Error('不兼容的 Java 类搜索结果')
  return response
}
export async function applyJavaImport(request: ImportRequest, entry: JavaClassEntry, alias: string, runtimeId: string, monaco: typeof Monaco, isCancelled: () => boolean = () => false) {
  if (isCancelled() || !importRequestActive(request, monaco)) throw new Error('文档、权限或游戏连接已变化，请重新打开导入窗口')
  const library=await readJavaLibrary().catch(()=>undefined)
  const response = library?{runtimeId:library.id,classes:await readLibraryClasses(library,[entry.name])}:await controlRequest('javascript.stubs', { classes: [entry.name] }) as StubResponse
  if (response.runtimeId !== runtimeId || !response.classes?.some(c => c.name === entry.name)) throw new Error('当前游戏无法提供此类，请重新搜索')
  if (isCancelled() || !importRequestActive(request, monaco)) throw new Error('文档、权限或游戏连接已变化，请重新打开导入窗口')
  const source = request.model.getValue()
  const plan = planJavaImport(source, entry, alias)
  const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = []
  const changes: { start: number; end: number; length: number }[] = []
  const caret = request.editor.getPosition()
  const caretOffset = caret ? request.model.getOffsetAt(caret) : 0
  if (plan.text) {
    const p = request.model.getPositionAt(plan.insertAt)
    const end = request.model.getPositionAt(plan.replaceEnd)
    edits.push({ range: new monaco.Range(p.lineNumber, p.column, end.lineNumber, end.column), text: plan.text, forceMoveMarkers: true })
    changes.push({ start: plan.insertAt, end: plan.replaceEnd, length: plan.text.length })
  }
  if (request.range) {
    const start = request.model.getOffsetAt({ lineNumber: request.range.startLineNumber, column: request.range.startColumn })
    const end = request.model.getOffsetAt({ lineNumber: request.range.endLineNumber, column: request.range.endColumn })
    if (start >= plan.replaceEnd && source.slice(start, end) !== plan.binding && javaImportReferenceMatches(source, start, end, entry)) {
      edits.push({ range: request.range, text: plan.binding }); changes.push({ start, end, length: plan.binding.length })
    }
  }
  if (edits.length) {
    request.editor.pushUndoStop()
    let translated = caretOffset, shift = 0
    for (const change of changes.sort((a, b) => a.start - b.start)) {
      if (caretOffset < change.start) break
      if (caretOffset < change.end) { translated = change.start + shift + change.length; break }
      shift += change.length - (change.end - change.start)
      translated = caretOffset + shift
    }
    request.editor.executeEdits('hanshu-java-import', edits, () => {
      const next = request.model.getPositionAt(translated)
      return [new monaco.Selection(next.lineNumber, next.column, next.lineNumber, next.column)]
    })
    request.editor.pushUndoStop()
  }
  await refreshJavaScriptImports(request.model).catch(error => notify(`Java 类已导入，补全加载失败：${String(error)}`, { kind: 'warning' }))
  if (!request.model.isDisposed() && request.editor.getModel() === request.model) request.editor.focus()
}
export function registerJavaImportAction(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco, open: (request: ImportRequest) => void) {
  return editor.addAction({
    id: 'hanshu.javascript.importJava', label: '导入 Java 类…',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyJ],
    contextMenuGroupId: 'navigation', contextMenuOrder: 3,
    precondition: '!editorReadonly && editorLangId == hanshu-javascript', keybindingContext: 'editorTextFocus',
    run: async () => {
      const model = editor.getModel(), position = editor.getPosition(), selection = editor.getSelection()
      if (!model || !position) return
      if (!isControlConnected()&&!await readJavaLibrary().catch(()=>undefined)) { notify('请先连接游戏或同步本地类型库', { kind: 'warning' }); return }
      let query = selection ? model.getValueInRange(selection) : '', range: Monaco.IRange | undefined
      if (/^[A-Za-z_$][\w.$]*$/.test(query)) range = selection!
      else { const word = model.getWordAtPosition(position); query = word?.word ?? ''; if (word) range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) }
      if(model.isDisposed()||editor.getModel()!==model)return
      open({ editor, model, query, range, version: model.getVersionId(), project: getProjectSession().binding?.handle.client, connection: controlConnectionGeneration(),endpoint:libraryKey() })
    },
  })
}
