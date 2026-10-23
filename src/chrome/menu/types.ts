import type { AppWorkspaceId } from '../../workspaces/types'
import type { UiScale } from '../../displayPrefs'

/** 稳定菜单项 id；显示文案用 label，分发与启用规则用 id */
export type MenuItemId = string

export type MenuActionRun = 'app' | 'workspace'

export type MenuContext = {
  workspaceId: AppWorkspaceId
  projectBound: boolean
  /** 当前工程角色；未绑定时为 null */
  role: string | null
  uiScale: UiScale
}

export type MenuSeparator = { type: 'separator' }

export type MenuCommand = {
  type?: 'command'
  id: MenuItemId
  label: string
  run: MenuActionRun
  /** 默认 true */
  enabled?: (ctx: MenuContext) => boolean
  /** 勾选项（如界面比例） */
  checked?: (ctx: MenuContext) => boolean
}

export type MenuEntry = MenuSeparator | MenuCommand

export type MenuDef = {
  id: string
  label: string
  items: MenuEntry[]
}

export type MenuContribution = {
  menus: MenuDef[]
}
