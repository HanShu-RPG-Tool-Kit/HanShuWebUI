import type { Monaco } from '@monaco-editor/react'
import { Selection, type editor } from 'monaco-editor'

const CHOICE_DEPTH = /^(-+)(?:[\s\S]*)$/

function choiceDepth(line: string): number {
  const m = line.match(CHOICE_DEPTH)
  return m ? m[1].length : 0
}

/** 当前行或上方最近一行选项的层级；没有则为 0 */
function resolveRefDepth(
  model: editor.ITextModel,
  lineNumber: number,
): number {
  const here = choiceDepth(model.getLineContent(lineNumber))
  if (here > 0) return here
  for (let i = lineNumber - 1; i >= 1; i--) {
    const d = choiceDepth(model.getLineContent(i))
    if (d > 0) return d
  }
  return 0
}

/**
 * 插入对话选项行。
 * - same：同级（无上下文时为 `-`）
 * - deeper：下一级（相对同级 +1）
 * 光标落在 `-…` 与 `://` 之间，方便直接敲文案。
 */
export function insertChoiceLine(
  ed: editor.IStandaloneCodeEditor,
  deeper: boolean,
) {
  const model = ed.getModel()
  const selection = ed.getSelection()
  if (!model || !selection) return

  const lineNumber = selection.positionLineNumber
  const line = model.getLineContent(lineNumber)
  const ref = resolveRefDepth(model, lineNumber)
  const sameDepth = ref > 0 ? ref : 1
  const depth = deeper ? sameDepth + 1 : sameDepth
  const marks = '-'.repeat(depth)
  const text = `${marks}://`
  const cursorCol = marks.length + 1

  ed.pushUndoStop()

  if (/^\s*$/.test(line)) {
    // 选项必须行首无空格；空行直接写成顶格选项
    ed.executeEdits(
      'hanshu.choiceInsert',
      [
        {
          range: {
            startLineNumber: lineNumber,
            startColumn: 1,
            endLineNumber: lineNumber,
            endColumn: line.length + 1,
          },
          text,
          forceMoveMarkers: true,
        },
      ],
      [new Selection(lineNumber, cursorCol, lineNumber, cursorCol)],
    )
  } else {
    const endCol = line.length + 1
    ed.executeEdits(
      'hanshu.choiceInsert',
      [
        {
          range: {
            startLineNumber: lineNumber,
            startColumn: endCol,
            endLineNumber: lineNumber,
            endColumn: endCol,
          },
          text: `\n${text}`,
          forceMoveMarkers: true,
        },
      ],
      [
        new Selection(
          lineNumber + 1,
          cursorCol,
          lineNumber + 1,
          cursorCol,
        ),
      ],
    )
  }

  ed.pushUndoStop()
  ed.focus()
}

/** Ctrl+[ 同级选项；Ctrl+] 下一级选项 */
export function bindChoiceInsertHotkeys(
  ed: editor.IStandaloneCodeEditor,
  monaco: Monaco,
) {
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.BracketLeft, () => {
    insertChoiceLine(ed, false)
  })
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.BracketRight, () => {
    insertChoiceLine(ed, true)
  })
}
