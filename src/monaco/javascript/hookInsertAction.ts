import type * as Monaco from 'monaco-editor'
import { notify } from '../../activity/activityStore'
import { refreshJavaScriptImports, peekJavaScriptHooks } from './javascriptLanguage'
import { planHookHandler, type HookCatalogEntry } from './hookInsert'

export type HookInsertRequest = {
  editor: Monaco.editor.IStandaloneCodeEditor
  model: Monaco.editor.ITextModel
  version: number
  caretOffset: number
  hooks: HookCatalogEntry[]
}

export function hookInsertRequestActive(request: HookInsertRequest, monaco: typeof Monaco) {
  return !request.model.isDisposed()
    && request.editor.getModel() === request.model
    && !request.editor.getOption(monaco.editor.EditorOption.readOnly)
    && request.model.getVersionId() === request.version
}

export function applyHookHandler(
  request: HookInsertRequest,
  hook: HookCatalogEntry,
  monaco: typeof Monaco,
): void {
  if (!hookInsertRequestActive(request, monaco)) throw new Error('文档或权限已变化，请重新插入')
  const plan = planHookHandler(request.model.getValue(), hook, request.caretOffset)
  const ops: Monaco.editor.IIdentifiedSingleEditOperation[] = []
  if (plan.importText) {
    const start = request.model.getPositionAt(plan.importAt)
    const end = request.model.getPositionAt(plan.importEnd)
    ops.push({
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      text: plan.importText,
      forceMoveMarkers: true,
    })
  }
  // 同一批 edits 的 range 都基于改前文本；光标再按 import 净增量平移
  const bodyPosition = request.model.getPositionAt(Math.min(plan.bodyAt, request.model.getValueLength()))
  ops.push({
    range: new monaco.Range(bodyPosition.lineNumber, bodyPosition.column, bodyPosition.lineNumber, bodyPosition.column),
    text: plan.body,
    forceMoveMarkers: true,
  })
  const importDelta = plan.importText && plan.bodyAt >= plan.importEnd
    ? plan.importText.length - (plan.importEnd - plan.importAt)
    : 0
  const caretAbs = plan.bodyAt + importDelta + plan.caretInBody
  request.editor.pushUndoStop()
  request.editor.executeEdits('hanshu-hook-insert', ops, () => {
    const next = request.model.getPositionAt(Math.min(caretAbs, request.model.getValueLength()))
    return [new monaco.Selection(next.lineNumber, next.column, next.lineNumber, next.column)]
  })
  request.editor.pushUndoStop()
  void refreshJavaScriptImports(request.model).catch(error =>
    notify(`钩子已插入，补全加载失败：${String(error)}`, { kind: 'warning' }),
  )
  if (!request.model.isDisposed() && request.editor.getModel() === request.model) request.editor.focus()
}

export function registerHookInsertAction(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  open: (request: HookInsertRequest) => void,
) {
  return editor.addAction({
    id: 'hanshu.javascript.insertHook',
    label: '插入钩子函数…',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyH],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 3.5,
    precondition: '!editorReadonly && editorLangId == hanshu-javascript',
    keybindingContext: 'editorTextFocus',
    run: () => {
      const model = editor.getModel(), position = editor.getPosition()
      if (!model || !position) return
      const hooks = peekJavaScriptHooks(model)
      if (!hooks.length) {
        notify('当前脚本没有可用的宿主钩子（需 player／actor，并已连接游戏或同步类型库）', { kind: 'warning' })
        return
      }
      open({
        editor,
        model,
        version: model.getVersionId(),
        caretOffset: model.getOffsetAt(position),
        hooks: [...hooks].sort((a, b) => a.id.localeCompare(b.id)),
      })
    },
  })
}
