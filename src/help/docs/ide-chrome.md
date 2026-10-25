# IDE 壳：菜单栏与状态栏

标题栏、**唯一**菜单栏、工作区页签与**唯一**状态栏由 App 壳统一提供。工作区只贡献菜单项与状态栏左右槽，**禁止**再画第二条底栏或第二套顶栏菜单。

「可配置」指开发期声明式贡献（TypeScript），不是用户设置面板或热插拔插件。

## 布局

```
┌ 标题栏：字标 · 工作区页签 │ 当前工作区菜单 ·（桌面窗控）┐
├ 工程连接条 ────────────────────────────────────┤
├ 工作区内容（仅一份 active）─────────────────────┤
└ 状态栏：左槽 | 右槽 | 活动铃铛 ─────────────────┘
```

相关实现：`src/chrome/`（`MenuBar`、`AppStatusBar`、`StatusBarSlots`、菜单贡献表）。

工作区页签固定在菜单左侧，分隔线随页签组定位。菜单宽度由当前命令入口自然撑开，不预留固定空位；切换工作区时菜单可以增减，页签和分隔线位置保持不变。

## 菜单栏

- **全局贡献**（`src/chrome/menu/globalMenus.ts`）：打开/新建/分享/连接/关闭工程、导出 PAK / 工程包 / 自动发版、历史、界面比例、帮助、退出、游戏开发服务器、协作面板等。
- **工作区贡献**：剧本 `scriptMenus.ts`、进度 `questMenus.ts`；按当前工作区与全局合并（`mergeMenus`）。
- 每项有稳定 **`id`**（分发与启用规则）和显示用 **`label`**。
- `run: 'app'` 由 `runAppMenuAction` 处理（工程会话经 `openProjectUi`，导出/发版经 `project/exportActions`）；`run: 'workspace'` 交给当前工作区 `handleMenuAction(id)`。
- 导出前用 `flushProjectEditors` 冲各工作区编辑缓冲进 `projectSession`；工作区通过 `registerProjectEditorFlush` 登记。
- **启用规则**写在贡献项的 `enabled(ctx)` 上（`ctx` 含 `workspaceId`、`projectBound`、`role`、`uiScale`），不要在 App 里按工作区硬编码一长串 disabled。

新增菜单项：改对应贡献表 → 若需逻辑则在 `appMenuActions` / `exportActions` 或工作区 `handleMenuAction` 按 **id** 分支。

## 状态栏

- 壳组件：`AppStatusBar`（唯一一条）。背景 `--bg-status` 与标题栏 `--bg-title` 同色。
- 工作区用 `<StatusBarSlots active left right />` 把内容 **portal** 进左右槽；`active === false` 时不渲染。
- **最右侧固定** [活动列表](#activity-list) 铃铛，工作区不要再挂铃铛。
- 约定：左=上下文（工程名、保存状态等），右=工作区动作（Agent、语言、文档类型等）。

## 与其它 UI 的边界

| 通道 | 管什么 |
| --- | --- |
| **菜单栏** | 命令入口（文件/编辑/查看/帮助…） |
| **状态栏** | 常驻上下文 + 工作区快捷切换 + 活动铃铛 |
| **活动列表** | 瞬时反馈与后台进度（见活动列表文档） |
| **协作浮球** | 连接、成员、多文件草稿与提交 |

## 不要再做的事

- 不要在工作区内再写 `footer.statusbar` / `flow-statusbar` 之类第二条底栏。
- 不要用中文 label 当分发键；用稳定 `id`。
- 不要把会话令牌写入状态栏或活动文案。
