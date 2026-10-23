import type { AppWorkspaceId } from '../../workspaces/types'
import { globalMenuContribution } from './globalMenus'
import { progressMenuContribution } from './progressMenus'
import { scriptMenuContribution } from './scriptMenus'
import type { MenuCommand, MenuContribution, MenuDef, MenuEntry } from './types'

const MENU_ORDER = ['file', 'edit', 'select', 'view', 'go', 'help'] as const

const WORKSPACE_CONTRIBUTIONS: Partial<Record<AppWorkspaceId, MenuContribution>> = {
  script: scriptMenuContribution,
  'progress-flow': progressMenuContribution,
}

function itemsOf(contribution: MenuContribution, menuId: string): MenuEntry[] {
  return contribution.menus.find((menu) => menu.id === menuId)?.items ?? []
}

function labelOf(menuId: string): string {
  const fromGlobal = globalMenuContribution.menus.find((menu) => menu.id === menuId)
  if (fromGlobal) return fromGlobal.label
  for (const contribution of Object.values(WORKSPACE_CONTRIBUTIONS)) {
    const found = contribution?.menus.find((menu) => menu.id === menuId)
    if (found) return found.label
  }
  return menuId
}

function isCommand(entry: MenuEntry): entry is MenuCommand {
  return entry.type !== 'separator'
}

function commandsById(items: MenuEntry[], ids: string[]): MenuEntry[] {
  const map = new Map(
    items.filter(isCommand).map((entry) => [entry.id, entry] as const),
  )
  return ids.flatMap((id) => {
    const found = map.get(id)
    return found ? [found] : []
  })
}

function trimSeparators(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = []
  for (const entry of items) {
    if (entry.type === 'separator') {
      if (out.length === 0) continue
      if (out[out.length - 1]?.type === 'separator') continue
      out.push(entry)
      continue
    }
    out.push(entry)
  }
  while (out.length > 0 && out[out.length - 1]?.type === 'separator') out.pop()
  return out
}

/**
 * 合并全局菜单与当前工作区贡献。
 * 同 menu id：按约定交错全局项与工作区项。
 */
export function mergeMenus(workspaceId: AppWorkspaceId): MenuDef[] {
  const ws = WORKSPACE_CONTRIBUTIONS[workspaceId]
  const menus: MenuDef[] = []

  for (const menuId of MENU_ORDER) {
    const globalItems = itemsOf(globalMenuContribution, menuId)
    const wsItems = ws ? itemsOf(ws, menuId) : []
    if (globalItems.length === 0 && wsItems.length === 0) continue

    let items: MenuEntry[]
    if (menuId === 'file') {
      items = trimSeparators([
        ...commandsById(globalItems, [
          'open-project',
          'new-project',
          'share-project',
          'connect-server',
          'close-project',
        ]),
        { type: 'separator' },
        ...wsItems,
        { type: 'separator' },
        ...commandsById(globalItems, [
          'auto-publish-pak',
          'export-pak',
          'export-pak-planes',
          'export-project-pack',
        ]),
        { type: 'separator' },
        ...commandsById(globalItems, ['project-history']),
        { type: 'separator' },
        ...commandsById(globalItems, ['quit']),
      ])
    } else if (menuId === 'edit') {
      items = trimSeparators([...wsItems, { type: 'separator' }, ...globalItems])
    } else if (menuId === 'view') {
      items = trimSeparators([...wsItems, { type: 'separator' }, ...globalItems])
    } else {
      items = trimSeparators([...globalItems, { type: 'separator' }, ...wsItems])
    }

    if (items.length === 0) continue
    menus.push({ id: menuId, label: labelOf(menuId), items })
  }

  return menus
}
