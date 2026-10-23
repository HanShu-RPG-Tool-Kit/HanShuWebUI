import type { MenuContribution, MenuCommand } from './types'

const always = () => true

function cmd(
  id: string,
  label: string,
  extra?: Pick<MenuCommand, 'enabled'>,
): MenuCommand {
  return { id, label, run: 'workspace', enabled: extra?.enabled ?? always }
}

/** 剧本工作区菜单贡献 */
export const scriptMenuContribution: MenuContribution = {
  menus: [
    {
      id: 'file',
      label: '文件',
      items: [
        cmd('new-script', '新建剧本'),
        cmd('new-package', '新建包'),
        cmd('save', '保存'),
        cmd('save-as-project', '另存为工程…'),
        { type: 'separator' },
        cmd('export-pak', '导出PAK'),
        cmd('export-pak-planes', '导出PAK（分平面）'),
        cmd('auto-publish-pak', '自动发版（auto.pak）'),
        cmd('export-project-pack', '导出工程包'),
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        cmd('undo', '撤销'),
        cmd('redo', '重做'),
        { type: 'separator' },
        cmd('cut', '剪切'),
        cmd('copy', '复制'),
        cmd('paste', '粘贴'),
        { type: 'separator' },
        cmd('find', '查找'),
        cmd('replace', '替换'),
      ],
    },
    {
      id: 'select',
      label: '选择',
      items: [
        cmd('select-all', '全选'),
        cmd('expand-selection', '扩展选区'),
        cmd('shrink-selection', '缩小选区'),
        { type: 'separator' },
        cmd('copy-line-up', '向上复制行'),
        cmd('copy-line-down', '向下复制行'),
      ],
    },
    {
      id: 'view',
      label: '查看',
      items: [
        cmd('agent-panel', 'Agent 窗口'),
        cmd('voice-studio', '录音棚'),
        cmd('command-palette', '命令面板...'),
        cmd('appearance', '外观'),
        cmd('editor-layout', '编辑器布局'),
        { type: 'separator' },
        cmd('show-minimap', '显示小地图'),
        cmd('word-wrap', '自动换行'),
      ],
    },
    {
      id: 'go',
      label: '转到',
      items: [
        cmd('go-to-file', '转到文件...'),
        cmd('go-to-line', '转到行/列...'),
        { type: 'separator' },
        cmd('prev-problem', '上一个问题'),
        cmd('next-problem', '下一个问题'),
      ],
    },
  ],
}
