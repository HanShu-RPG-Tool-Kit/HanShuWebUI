import { UI_SCALES } from '../../displayPrefs'
import type { MenuCommand, MenuContribution, MenuEntry } from './types'

const always = () => true

function cmd(
  id: string,
  label: string,
  run: MenuCommand['run'],
  extra?: Pick<MenuCommand, 'enabled' | 'checked'>,
): MenuCommand {
  return { id, label, run, enabled: extra?.enabled ?? always, checked: extra?.checked }
}

/** App 级菜单贡献（工程会话、外观比例、帮助、退出等） */
export const globalMenuContribution: MenuContribution = {
  menus: [
    {
      id: 'file',
      label: '文件',
      items: [
        cmd('open-project', '打开工程…', 'workspace'),
        cmd('new-project', '新建工程…', 'workspace'),
        cmd('share-project', '分享工程…', 'app', {
          enabled: (ctx) => ctx.role === 'owner',
        }),
        cmd('connect-server', '连接其他服务器…', 'app'),
        cmd('close-project', '关闭工程', 'app', {
          enabled: (ctx) => ctx.projectBound,
        }),
        { type: 'separator' },
        cmd('project-history', '历史版本', 'app'),
        { type: 'separator' },
        cmd('quit', '退出', 'app'),
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        cmd('game-dev-server', '游戏开发服务器', 'app'),
      ],
    },
    {
      id: 'view',
      label: '查看',
      items: [
        cmd('collaboration-panel', '协作面板', 'app'),
        { type: 'separator' },
        ...UI_SCALES.map((scale): MenuEntry =>
          cmd(`ui-scale-${scale}`, `界面比例 ${scale}%`, 'app', {
            checked: (ctx) => ctx.uiScale === scale,
          }),
        ),
        cmd('ui-scale-reset', '恢复推荐大小（125%）', 'app'),
      ],
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        cmd('help-welcome', '欢迎', 'app'),
        cmd('help-docs', '文档', 'app'),
        { type: 'separator' },
        cmd('help-about', '关于汉书', 'app'),
      ],
    },
  ],
}
