/** Monaco 菜单命令。剧本和其他编辑器都可以按菜单 id 调用。 */
export const EDITOR_MENU_ACTIONS: Record<string, string> = {
  undo: 'undo',
  redo: 'redo',
  cut: 'editor.action.clipboardCutAction',
  copy: 'editor.action.clipboardCopyAction',
  paste: 'editor.action.clipboardPasteAction',
  find: 'actions.find',
  replace: 'editor.action.startFindReplaceAction',
  'select-all': 'editor.action.selectAll',
  'expand-selection': 'editor.action.smartSelect.expand',
  'shrink-selection': 'editor.action.smartSelect.shrink',
  'copy-line-up': 'editor.action.copyLinesUpAction',
  'copy-line-down': 'editor.action.copyLinesDownAction',
  'go-to-line': 'editor.action.gotoLine',
  'prev-problem': 'editor.action.marker.prev',
  'next-problem': 'editor.action.marker.next',
}

export type MenuEditor = {
  focus: () => void
  trigger: (source: string, handlerId: string, payload: unknown) => void
}

export function editorMenuActionId(item: string): string | null {
  return EDITOR_MENU_ACTIONS[item] ?? null
}

/** 有编辑器且 id 有对应命令时执行并返回 true。没有编辑器时返回 false，由调用方提示。 */
export function runMonacoMenuAction(editor: MenuEditor | null, item: string): boolean {
  const action = editorMenuActionId(item)
  if (!editor || !action) return false
  editor.focus()
  editor.trigger('menu', action, null)
  return true
}
