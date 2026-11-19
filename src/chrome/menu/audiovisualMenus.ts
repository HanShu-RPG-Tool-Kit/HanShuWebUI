import type { MenuContribution, MenuCommand } from './types'

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
        cmd('agent-panel', 'Agent 面板', {
          checked: () => {
            try {
              return localStorage.getItem('hanshu.agentOpen.audiovisual') === 'true'
            } catch {
              return false
            }
          },
        }),
        cmd('editor-layout', '编辑器布局'),
      ],
    },
  ],
}
