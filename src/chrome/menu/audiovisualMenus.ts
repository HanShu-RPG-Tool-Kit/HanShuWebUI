import { audiovisualViewFlags } from '../../workspaces/audiovisual/viewFlags'
import type { MenuContribution, MenuCommand } from './types'

const always = () => true

function cmd(
  id: string,
  label: string,
  extra?: Pick<MenuCommand, 'checked'>,
): MenuCommand {
  return { id, label, run: 'workspace', enabled: always, checked: extra?.checked }
}

/** 视听效果工作区菜单贡献 */
export const audiovisualMenuContribution: MenuContribution = {
  menus: [
    {
      id: 'file',
      label: '文件',
      items: [cmd('save', '保存')],
    },
    {
      id: 'view',
      label: '查看',
      items: [
        cmd('asset-manager-panel', '资产管理器', {
          checked: () => audiovisualViewFlags.get().assetManager,
        }),
        cmd('editor-layout', '编辑器布局'),
      ],
    },
  ],
}
