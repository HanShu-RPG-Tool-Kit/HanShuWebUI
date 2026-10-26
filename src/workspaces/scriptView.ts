import { createViewFlags } from '../ui/viewFlags'

/** 剧本大栏的查看开关。别的工作区不要写这份，各自 createViewFlags。 */
export type ScriptViewFlags = {
  explorer: boolean
  agent: boolean
  roles: boolean
  /** 录音棚是编辑模式，不记住到下次打开。 */
  studio: boolean
  minimap: boolean
  wordWrap: boolean
  fontSize: number
}

const FONT_MIN = 12
const FONT_MAX = 32
const FONT_DEFAULT = 18

export const scriptViewFlags = createViewFlags<ScriptViewFlags>(
  'hanshu.view.script',
  {
    explorer: true,
    agent: true,
    roles: true,
    studio: false,
    minimap: false,
    wordWrap: true,
    fontSize: FONT_DEFAULT,
  },
  {
    ephemeral: ['studio'],
    sanitize: (value) => {
      const fontSize = Math.round(value.fontSize)
      return {
        ...value,
        fontSize: fontSize >= FONT_MIN && fontSize <= FONT_MAX ? fontSize : FONT_DEFAULT,
      }
    },
  },
)

export const SCRIPT_FONT_MIN = FONT_MIN
export const SCRIPT_FONT_MAX = FONT_MAX

const VIEW_MENU = {
  'explorer-panel': 'explorer',
  'agent-panel': 'agent',
  'roles-panel': 'roles',
  'voice-studio': 'studio',
  'show-minimap': 'minimap',
  'word-wrap': 'wordWrap',
} as const

/** Toggle a script view flag by menu id. Returns false when the id is not a view toggle. */
export function toggleScriptViewItem(item: string): boolean {
  const key = VIEW_MENU[item as keyof typeof VIEW_MENU]
  if (!key) return false
  scriptViewFlags.toggle(key)
  return true
}

/** 18px uses line height 28. Other sizes keep that ratio. */
export function scriptEditorAppearance(flags: Pick<ScriptViewFlags, 'fontSize' | 'minimap' | 'wordWrap'>) {
  return {
    fontSize: flags.fontSize,
    lineHeight: Math.round((flags.fontSize * 28) / 18),
    minimap: { enabled: flags.minimap },
    wordWrap: flags.wordWrap ? 'on' as const : 'off' as const,
  }
}
