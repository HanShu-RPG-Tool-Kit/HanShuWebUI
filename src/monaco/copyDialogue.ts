import type { Monaco } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

const SPEAKER_LINE = /^([a-zA-Z_][a-zA-Z0-9_]*):(.*)$/
const CHOICE_LINE = /^(-+)([\s\S]*?)\/\/\s*$/

export type DialogueBlock = {
  speaker: string
  content: string
}

/** 选项拆分：文案归「选项」；答复归最近 speaker */
export type ChoicePart = {
  kind: 'label' | 'reply'
  content: string
  /** 仅 reply：选项树前最近的角色名 */
  speaker?: string
}

function unescapeHs(text: string): string {
  return text
    .replace(/\\>>/g, '>>')
    .replace(/\\<</g, '<<')
    .replace(/\\-/g, '-')
}

function countEmbedDelimiters(line: string): number {
  let n = 0
  let i = 0
  while (i < line.length) {
    if (line.startsWith("''''", i)) {
      n++
      i += 4
    } else {
      i++
    }
  }
  return n
}

/** 第一个未转义的 `:` */
function findChoiceColon(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      i++
      continue
    }
    if (body[i] === ':') return i
  }
  return -1
}

function trimText(raw: string): string {
  return unescapeHs(raw).replace(/^\s+|\s+$/g, '')
}

/** 从文本中按出现顺序提取对白块（跳过注释 / 选项 / @ / @@ / ''''） */
export function extractDialogueBlocks(text: string): DialogueBlock[] {
  const lines = text.split(/\r?\n/)
  const blocks: DialogueBlock[] = []
  let inPython = false
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const toggles = countEmbedDelimiters(line)

    if (inPython) {
      if (toggles % 2 === 1) inPython = false
      i++
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      i++
      continue
    }

    if (
      line.startsWith('#') ||
      line.startsWith('@') ||
      /^-/.test(line)
    ) {
      i++
      continue
    }

    const m = line.match(SPEAKER_LINE)
    if (!m) {
      i++
      continue
    }

    const speaker = m[1]
    const rest = m[2]

    if (/\/\/\s*$/.test(rest)) {
      const content = unescapeHs(rest.replace(/\/\/\s*$/, ''))
      if (content.trim()) blocks.push({ speaker, content })
      i++
      continue
    }

    if (rest === '') {
      i++
      const buf: string[] = []
      while (i < lines.length && !/^\/\/\s*$/.test(lines[i])) {
        const L = lines[i]
        const t = countEmbedDelimiters(L)
        if (t % 2 === 1) inPython = !inPython
        if (!inPython && !L.startsWith('#') && !L.startsWith('@')) {
          buf.push(L)
        }
        i++
      }
      if (i < lines.length && /^\/\/\s*$/.test(lines[i])) i++
      const content = unescapeHs(buf.join('\n').replace(/\s+$/, ''))
      if (content.trim()) blocks.push({ speaker, content })
      continue
    }

    i++
  }

  return blocks
}

/**
 * 选项行拆分：
 * - label：玩家选项文案
 * - reply：普通答复 / `:<<` 正文；归属「该选项树前最近的 speaker」
 * - 跳过 `:>>func` / `:>jump`
 */
export function extractChoiceParts(text: string): ChoicePart[] {
  const lines = text.split(/\r?\n/)
  const parts: ChoicePart[] = []
  let inPython = false
  let inSpeaker = false
  let lastSpeaker = ''
  let i = 0

  const pushLabel = (raw: string) => {
    const s = trimText(raw)
    if (s) parts.push({ kind: 'label', content: s })
  }
  const pushReply = (raw: string) => {
    const s = trimText(raw)
    if (!s) return
    parts.push({
      kind: 'reply',
      content: s,
      speaker: lastSpeaker || undefined,
    })
  }

  while (i < lines.length) {
    const line = lines[i]
    const toggles = countEmbedDelimiters(line)

    if (inPython) {
      if (toggles % 2 === 1) inPython = false
      i++
      continue
    }
    if (toggles % 2 === 1) {
      inPython = true
      i++
      continue
    }

    if (line.startsWith('#') || line.startsWith('@')) {
      i++
      continue
    }

    if (inSpeaker) {
      if (/^\/\/\s*$/.test(line)) inSpeaker = false
      i++
      continue
    }

    const speaker = line.match(SPEAKER_LINE)
    if (speaker) {
      lastSpeaker = speaker[1]
      const rest = speaker[2]
      if (/\/\/\s*$/.test(rest)) {
        i++
        continue
      }
      if (rest === '') inSpeaker = true
      i++
      continue
    }

    const choice = line.match(CHOICE_LINE)
    if (!choice) {
      i++
      continue
    }

    const body = choice[2]
    const colon = findChoiceColon(body)
    if (colon < 0) {
      pushLabel(body)
    } else {
      pushLabel(body.slice(0, colon))
      const reply = body.slice(colon + 1)
      if (/^\s*>>/.test(reply)) {
        // 函数调用
      } else if (/^\s*>[a-zA-Z_][a-zA-Z0-9_]*\s*$/.test(reply)) {
        // 跳到注入点
      } else if (/^\s*<</.test(reply)) {
        pushReply(reply.replace(/^\s*<</, ''))
      } else {
        pushReply(reply)
      }
    }
    i++
  }

  return parts
}

/** 给 .lines：选项文案 + 答复扁平列表（顺序与出现一致） */
export function extractChoiceSources(text: string): string[] {
  return extractChoiceParts(text).map((p) => p.content)
}

/**
 * 纯文本导出：
 * - 角色对白 + 选项答复 → 按 speaker 分组
 * - 选项文案单独「选项」组
 */
export function formatDialoguePlainText(
  blocks: DialogueBlock[],
  choiceParts: ChoicePart[] = [],
): string {
  const order: string[] = []
  const groups = new Map<string, string[]>()

  const add = (speaker: string, content: string) => {
    const body = content.replace(/^\s+|\s+$/g, '')
    if (!body) return
    if (!groups.has(speaker)) {
      order.push(speaker)
      groups.set(speaker, [])
    }
    groups.get(speaker)!.push(body)
  }

  for (const { speaker, content } of blocks) add(speaker, content)

  const labelSeen = new Set<string>()
  const labels: string[] = []
  for (const part of choiceParts) {
    if (part.kind === 'label') {
      if (labelSeen.has(part.content)) continue
      labelSeen.add(part.content)
      labels.push(part.content)
      continue
    }
    // reply → 归角色；未知 speaker 时仍放「选项」以免丢文
    if (part.speaker) {
      add(part.speaker, part.content)
    } else {
      if (labelSeen.has(part.content)) continue
      labelSeen.add(part.content)
      labels.push(part.content)
    }
  }

  if (labels.length > 0) {
    labels.sort((a, b) => a.localeCompare(b, 'zh-CN'))
    if (!groups.has('选项')) order.push('选项')
    groups.set('选项', labels)
  }

  if (order.length === 0) return ''

  for (const name of order) {
    if (name === '选项') continue
    const list = groups.get(name)!
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const item of list) {
      if (seen.has(item)) continue
      seen.add(item)
      deduped.push(item)
    }
    deduped.sort((a, b) => a.localeCompare(b, 'zh-CN'))
    groups.set(name, deduped)
  }

  const speakers = order.filter((n) => n !== '选项')
  const hasOptions = order.includes('选项')

  if (speakers.length === 0 && hasOptions) {
    return groups.get('选项')!.join('\n\n')
  }

  if (speakers.length === 1 && !hasOptions) {
    return groups.get(speakers[0])!.join('\n\n')
  }

  if (speakers.length === 1 && hasOptions) {
    const body = groups.get(speakers[0])!.join('\n\n')
    const opt = groups.get('选项')!.join('\n\n')
    return `${speakers[0]}\n${body}\n\n选项\n${opt}`
  }

  return order
    .map((name) => `${name}\n${groups.get(name)!.join('\n\n')}`)
    .join('\n\n')
}

function getCopySource(ed: editor.IStandaloneCodeEditor): string {
  const model = ed.getModel()
  const selection = ed.getSelection()
  if (!model || !selection) return ''

  const hasSelection =
    selection.startLineNumber !== selection.endLineNumber ||
    selection.startColumn !== selection.endColumn

  if (hasSelection) {
    return model.getValueInRange(selection)
  }
  return model.getValue()
}

export async function copyDialoguePlainText(
  ed: editor.IStandaloneCodeEditor,
): Promise<boolean> {
  const source = getCopySource(ed)
  const text = formatDialoguePlainText(
    extractDialogueBlocks(source),
    extractChoiceParts(source),
  )
  if (!text) return false

  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
}

export function bindCopyDialogueHotkey(
  ed: editor.IStandaloneCodeEditor,
  monaco: Monaco,
) {
  ed.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC,
    () => {
      void copyDialoguePlainText(ed)
    },
  )
}
