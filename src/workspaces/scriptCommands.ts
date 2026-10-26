import { openCommandPalette, type DialogChoice } from '../ui/dialogs'
import { scriptViewFlags } from './scriptView'

/** 剧本命令面板的条目。勾选状态现读查看开关，别的工作区不要用这份。 */
export function scriptPaletteChoices(): DialogChoice[] {
  const view = scriptViewFlags.get()
  const shown = (on: boolean) => (on ? '已显示' : '已隐藏')
  return [
    { id: 'save', label: '保存' },
    { id: 'new-script', label: '新建剧本' },
    { id: 'save-as-project', label: '另存为工程' },
    { id: 'undo', label: '撤销' },
    { id: 'redo', label: '重做' },
    { id: 'cut', label: '剪切' },
    { id: 'copy', label: '复制' },
    { id: 'paste', label: '粘贴' },
    { id: 'find', label: '查找' },
    { id: 'replace', label: '替换' },
    { id: 'select-all', label: '全选' },
    { id: 'go-to-file', label: '转到文件' },
    { id: 'go-to-line', label: '转到行' },
    { id: 'prev-problem', label: '上一个问题' },
    { id: 'next-problem', label: '下一个问题' },
    { id: 'explorer-panel', label: '资源管理器', detail: shown(view.explorer) },
    { id: 'agent-panel', label: 'Agent 窗口', detail: shown(view.agent) },
    { id: 'roles-panel', label: '备选角色', detail: shown(view.roles) },
    { id: 'voice-studio', label: '录音棚', detail: shown(view.studio) },
    { id: 'show-minimap', label: '显示小地图', detail: view.minimap ? '开' : '关' },
    { id: 'word-wrap', label: '自动换行', detail: view.wordWrap ? '开' : '关' },
    { id: 'appearance', label: '外观', detail: view.fontSize + 'px' },
    { id: 'editor-layout', label: '恢复默认布局' },
  ]
}

/** Open the script command palette and run the chosen id. Cancel does nothing. */
export async function runScriptCommandPalette(run: (id: string) => void): Promise<void> {
  const id = await openCommandPalette(scriptPaletteChoices())
  if (id) run(id)
}
