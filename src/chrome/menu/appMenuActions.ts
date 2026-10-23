import type { HelpTopicId } from '../../help/topics'
import type { UiScale } from '../../displayPrefs'
import { UI_SCALES } from '../../displayPrefs'
import type { ProjectUiAction } from '../../project/projectUi'
import { runProjectExportAction } from '../../project/exportActions'

const HELP_BY_ID: Record<string, HelpTopicId> = {
  'help-welcome': 'welcome',
  'help-docs': 'docs',
  'help-about': 'about',
}

export type AppMenuHandlers = {
  openProjectUi: (kind: ProjectUiAction) => void
  openHistory: () => void
  openGameDev: () => void
  openHelp: (topic: HelpTopicId) => void
  changeUiScale: (scale: UiScale) => void
  quit: () => void
}

/** 处理 run:'app' 的菜单项；返回 true 表示已消费 */
export function runAppMenuAction(id: string, handlers: AppMenuHandlers): boolean {
  switch (id) {
    case 'open-project':
      handlers.openProjectUi('open')
      return true
    case 'new-project':
      handlers.openProjectUi('create')
      return true
    case 'share-project':
      handlers.openProjectUi('share')
      return true
    case 'connect-server':
      handlers.openProjectUi('connect')
      return true
    case 'close-project':
      handlers.openProjectUi('close')
      return true
    case 'collaboration-panel':
      handlers.openProjectUi('collaboration')
      return true
    case 'project-history':
      handlers.openHistory()
      return true
    case 'game-dev-server':
      handlers.openGameDev()
      return true
    case 'ui-scale-reset':
      handlers.changeUiScale(125)
      return true
    case 'quit':
      handlers.quit()
      return true
    default:
      break
  }

  if (runProjectExportAction(id)) return true

  const help = HELP_BY_ID[id]
  if (help) {
    handlers.openHelp(help)
    return true
  }

  const scaleMatch = /^ui-scale-(\d+)$/.exec(id)
  if (scaleMatch) {
    const scale = Number.parseInt(scaleMatch[1], 10) as UiScale
    if (UI_SCALES.includes(scale)) {
      handlers.changeUiScale(scale)
      return true
    }
  }

  return false
}
