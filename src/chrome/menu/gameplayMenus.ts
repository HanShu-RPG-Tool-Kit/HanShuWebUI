import type { MenuContribution, MenuCommand } from './types'
import { isAutoItemSnapshotRefreshEnabled } from '../../workspaces/gameplay/itemSnapshotCache'

const always = () => true

function cmd(
  id: string,
  label: string,
  extra?: Pick<MenuCommand, 'enabled' | 'checked'>,
): MenuCommand {
  return {
    id,
    label,
    run: 'workspace',
    enabled: extra?.enabled ?? always,
    checked: extra?.checked,
  }
}

/** 进度工作区菜单贡献 */
export const gameplayMenuContribution: MenuContribution = {
  menus: [
    {
      id: 'file',
      label: '文件',
      items: [
        cmd('save', '保存'),
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        cmd('undo', '撤销'),
        cmd('redo', '重做'),
        { type: 'separator' },
        cmd('toggle-auto-item-snapshot-refresh', '自动刷新物品快照', {
          checked: () => isAutoItemSnapshotRefreshEnabled(),
        }),
        cmd('refresh-item-snapshot', '刷新物品快照'),
        cmd('refresh-all-item-snapshots', '刷新全部物品快照'),
      ],
    },
    {
      id: 'view',
      label: '查看',
      items: [
        cmd('editor-layout', '编辑器布局'),
      ],
    },
  ],
}
