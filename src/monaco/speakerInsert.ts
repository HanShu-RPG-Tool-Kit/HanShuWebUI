import type { Monaco } from '@monaco-editor/react'
import { Selection, type editor } from 'monaco-editor'

const SPEAKER_SLOT_COUNT = 11

/** 角色名：字母/数字/下划线，且不能以数字开头 */
const SPEAKER_NAME = '[a-zA-Z_][a-zA-Z0-9_]*'

/** 单行：speaker:content// */
const SINGLE_RE = new RegExp(`^(${SPEAKER_NAME}):(.*)\\/\\/\\r?$`)
/** 多行：speaker:\\ncontent\\n//（兼容 CRLF） */
const MULTI_RE = new RegExp(
  `^(${SPEAKER_NAME}):\\r?\\n([\\s\\S]*?)\\r?\\n\\/\\/\\r?$`,
)

const EXTRACT_MULTI_RE = new RegExp(
  `^(${SPEAKER_NAME}):\\r?\\n([\\s\\S]*?)\\r?\\n\\/\\/`,
  'gm',
)
const EXTRACT_SINGLE_RE = new RegExp(
  `^(${SPEAKER_NAME}):(.*)\\/\\/\\r?$`,
  'gm',
)

export function createDefaultRoles(): string[] {
  const roles = Array.from({ length: SPEAKER_SLOT_COUNT }, () => '')
  roles[0] = 'narrator'
  return roles
}

export function numpadLabel(slotIndex: number): string {
  if (slotIndex < 10) return String(slotIndex)
  return '·'
}

export function numpadHint(slotIndex: number): string {
  if (slotIndex < 10) return `Ctrl+小键盘${slotIndex}`
  return '无快捷键'
}

function parseSpeakerBlock(text: string): { speaker: string; content: string; multi: boolean } | null {
  const multi = text.match(MULTI_RE)
  if (multi) {
    return { speaker: multi[1], content: multi[2], multi: true }
  }
  const single = text.match(SINGLE_RE)
  if (single) {
    return { speaker: single[1], content: single[2], multi: false }
  }
  return null
}

/** 从正文中按出现顺序提取合法 speaker:…// 角色名（不含选项行） */
export function extractSpeakersFromText(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()

  const add = (raw: string) => {
    const name = raw.trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    found.push(name)
  }

  for (const match of text.matchAll(EXTRACT_MULTI_RE)) {
    add(match[1])
  }
  for (const match of text.matchAll(EXTRACT_SINGLE_RE)) {
    add(match[1])
  }

  return found
}

/** 正文里有、备选里没有的角色，按顺序填入空位 */
export function fillRolesFromSpeakers(
  roles: string[],
  speakers: string[],
): string[] {
  const occupied = new Set(
    roles.map((role) => role.trim()).filter(Boolean),
  )
  const missing = speakers.filter((name) => !occupied.has(name))
  if (missing.length === 0) return roles

  const next = [...roles]
  let cursor = 0
  for (let i = 0; i < next.length && cursor < missing.length; i++) {
    if (!next[i].trim()) {
      next[i] = missing[cursor++]
    }
  }

  const unchanged = next.every((role, index) => role === roles[index])
  return unchanged ? roles : next
}

function buildBlock(
  speaker: string,
  content: string,
  multi: boolean,
): { text: string; cursorOffset: number } {
  if (multi) {
    const text = `${speaker}:\n${content}\n//`
    // 光标在结尾 // 之前（即最后一个 \n 之后、/ 之前）
    return { text, cursorOffset: text.length - 2 }
  }
  const text = `${speaker}:${content}//`
  return { text, cursorOffset: text.length - 2 }
}

function getTargetRange(ed: editor.IStandaloneCodeEditor, model: editor.ITextModel) {
  const selection = ed.getSelection()
  if (!selection) return null

  const hasSelection =
    selection.startLineNumber !== selection.endLineNumber ||
    selection.startColumn !== selection.endColumn

  if (hasSelection) {
    return {
      range: selection,
      text: model.getValueInRange(selection),
    }
  }

  // 无选区：整行（含空行）
  const lineNumber = selection.positionLineNumber
  return {
    range: {
      startLineNumber: lineNumber,
      startColumn: 1,
      endLineNumber: lineNumber,
      endColumn: model.getLineMaxColumn(lineNumber),
    },
    text: model.getLineContent(lineNumber),
  }
}

/** 用备选角色快速包一层 speaker:…//，或替换已有 speaker */
export function applySpeakerInsert(
  ed: editor.IStandaloneCodeEditor,
  speaker: string,
) {
  const name = speaker.trim()
  if (!name) return

  const model = ed.getModel()
  if (!model) return

  const target = getTargetRange(ed, model)
  if (!target) return

  const raw = target.text
  const existing = parseSpeakerBlock(raw)

  let next: { text: string; cursorOffset: number }

  if (existing) {
    next = buildBlock(name, existing.content, existing.multi)
  } else if (raw.length === 0) {
    next = buildBlock(name, '', false)
  } else if (raw.includes('\n')) {
    next = buildBlock(name, raw, true)
  } else {
    next = buildBlock(name, raw, false)
  }

  const startLine = target.range.startLineNumber
  const startColumn = target.range.startColumn

  ed.pushUndoStop()
  ed.executeEdits(
    'hanshu.speakerInsert',
    [
      {
        range: target.range,
        text: next.text,
        forceMoveMarkers: true,
      },
    ],
    [
      (() => {
        // 把线性 offset 换成行列（相对替换起点）
        const before = next.text.slice(0, next.cursorOffset)
        const lines = before.split('\n')
        const line = startLine + lines.length - 1
        const column =
          lines.length === 1
            ? startColumn + lines[0].length
            : lines[lines.length - 1].length + 1
        return new Selection(line, column, line, column)
      })(),
    ],
  )
  ed.pushUndoStop()
  ed.focus()
}

const NUMPAD_KEYS = [
  'Numpad0',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
] as const

export function bindSpeakerHotkeys(
  ed: editor.IStandaloneCodeEditor,
  monaco: Monaco,
  getRoles: () => string[],
) {
  NUMPAD_KEYS.forEach((keyName, slotIndex) => {
    const keyCode = monaco.KeyCode[keyName]
    ed.addCommand(monaco.KeyMod.CtrlCmd | keyCode, () => {
      const role = getRoles()[slotIndex]
      if (role) applySpeakerInsert(ed, role)
    })
  })
}

export { SPEAKER_SLOT_COUNT }
