import { chooseDialog, type DialogChoice } from './dialogs'

/** 可筛选的命令面板。传入命令，返回选中的 id；取消返回 null。 */
export function openCommandPalette(commands: readonly DialogChoice[]): Promise<string | null> {
  return chooseDialog({
    title: '命令面板',
    message: '输入以筛选，回车执行。',
    options: commands,
    filterable: true,
    placeholder: '筛选命令',
  })
}
