import type { Monaco } from '@monaco-editor/react'
import { Selection, type editor } from 'monaco-editor'

type Tag = '#【场景】' | '#【动作】'

const TAG_PREFIXES: Tag[] = ['#【场景】', '#【动作】']

function splitIndent(line: string) {
  const indent = line.match(/^\s*/)?.[0] ?? ''
  return { indent, body: line.slice(indent.length) }
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 去掉行首注释：优先整段去掉 #【场景】/#【动作】，否则去掉普通 # */
function stripCommentPrefix(body: string): string | null {
  for (const tag of TAG_PREFIXES) {
    const re = new RegExp(`^${escapeRegExp(tag)}\\s?`)
    if (re.test(body)) return body.replace(re, '')
  }
  if (/^#\s?/.test(body)) return body.replace(/^#\s?/, '')
  return null
}

function replaceLine(
  ed: editor.IStandaloneCodeEditor,
  model: editor.ITextModel,
  lineNumber: number,
  nextLine: string,
) {
  ed.executeEdits('hanshu.comment', [
    {
      range: {
        startLineNumber: lineNumber,
        startColumn: 1,
        endLineNumber: lineNumber,
        endColumn: model.getLineMaxColumn(lineNumber),
      },
      text: nextLine,
      forceMoveMarkers: true,
    },
  ])
}

/** Ctrl+, / Ctrl+.：只加不删（单行），光标随插入前缀右移 */
export function addTaggedLineComment(
  ed: editor.IStandaloneCodeEditor,
  tag: Tag,
) {
  const model = ed.getModel()
  const selection = ed.getSelection()
  if (!model || !selection) return

  const lineNumber = selection.positionLineNumber
  const { indent, body } = splitIndent(model.getLineContent(lineNumber))

  // 已有任何 # 注释则不再加
  if (body.startsWith('#')) {
    ed.focus()
    return
  }

  // 在缩进之后插入，避免整行替换导致光标不跟
  const insertColumn = indent.length + 1
  const oldColumn = selection.positionColumn
  const newColumn =
    oldColumn >= insertColumn ? oldColumn + tag.length : oldColumn

  ed.pushUndoStop()
  ed.executeEdits(
    'hanshu.taggedComment',
    [
      {
        range: {
          startLineNumber: lineNumber,
          startColumn: insertColumn,
          endLineNumber: lineNumber,
          endColumn: insertColumn,
        },
        text: tag,
        forceMoveMarkers: true,
      },
    ],
    [new Selection(lineNumber, newColumn, lineNumber, newColumn)],
  )
  ed.pushUndoStop()
  ed.focus()
}

/**
 * Ctrl+/：切换注释。
 * 取消时会把 #【场景】/#【动作】整段去掉，不只剥掉一个 #。
 */
export function toggleLineComment(ed: editor.IStandaloneCodeEditor) {
  const model = ed.getModel()
  const selection = ed.getSelection()
  if (!model || !selection) return

  const startLine = Math.min(
    selection.startLineNumber,
    selection.endLineNumber,
  )
  const endLine = Math.max(selection.startLineNumber, selection.endLineNumber)

  const lines = []
  for (let n = startLine; n <= endLine; n++) {
    lines.push(splitIndent(model.getLineContent(n)))
  }

  // 选区内任意一行带注释 → 全部取消；否则全部加上普通 #
  const shouldUncomment = lines.some(
    ({ body }) => stripCommentPrefix(body) !== null,
  )

  ed.pushUndoStop()
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = startLine + i
    const { indent, body } = lines[i]
    const nextBody = shouldUncomment
      ? (stripCommentPrefix(body) ?? body)
      : body.length > 0
        ? `# ${body}`
        : '#'
    replaceLine(ed, model, lineNumber, `${indent}${nextBody}`)
  }
  ed.pushUndoStop()
  ed.focus()
}

export function bindTaggedCommentHotkeys(
  ed: editor.IStandaloneCodeEditor,
  monaco: Monaco,
) {
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Comma, () => {
    addTaggedLineComment(ed, '#【场景】')
  })

  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period, () => {
    addTaggedLineComment(ed, '#【动作】')
  })

  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash, () => {
    toggleLineComment(ed)
  })
}
