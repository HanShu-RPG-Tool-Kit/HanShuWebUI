# 面板与布局

每个工作区各自 mount 一个 `src/ui/PanelDock.tsx`，**各自一份布局**；面板声明与能力已经搬出工作区组件。本文记录**已定的边界**：哪些已经做、哪些明确不做。改面板或布局前先读本文，与[通用资源管理器底座](#explorer-shell)、[IDE 壳：菜单栏与状态栏](#ide-chrome)配合看。

## 结论：一个视图一套布局，工作区不做混合

一个窗口一次只看一个视图（**不做**把剧本文档和游戏性文档并排打开的混合布局），所以：

- **布局按视图独立**：每个工作区（以及嵌在文档里的 BOSS 血条设计视图）各有自己的布局键与 `DockLayout`。在剧本里浮起资源管理器，切到游戏性不会跟着变；「查看 → 编辑器布局 → 恢复」只重置当前视图。
- **app workspace 保留**：它仍是「当前视图 + 菜单归属 + 命令分派」的作用域（见 `src/workspaces/registry.ts`、`MenuContext.workspaceId`）。布局不取代它——两者是两根轴，见下节。
- **不做**「`App` 持有唯一 PanelDock、删掉 `.app-workspace-pane`」：那一步的收益只有面板跨视图拖动与混合文档，既然不做混合布局，就没有人用得上，却要重写菜单分派与四个工作区的挂载模型。

菜单跟着 `workspaceId` 走**不是缺陷**：它问的是「现在能对什么做什么」，而一个视图只有一个编辑器，tab 就是答案。只有真要做混合布局时才需要把菜单改成跟焦点（`activeEditor`）走。

## 现状

`PanelDock` 是通用布局引擎：它只管 `DockPanelSpec[]`（id / 默认位置 / 尺寸 / `render(dock)`），把布局存成 `localStorage` 里的一份 `DockLayout`（lanes / panels / floatGroups）。引擎只负责几何，谁提供面板由工作区决定：

| 宿主 | 文件 | 面板数 | 布局键 |
| --- | --- | --- | --- |
| 剧本 | `src/workspaces/StageplayWorkspace.tsx` | 5（资源管理器、资产管理器、Agent、备选角色、录音棚） | `hanshu.panelDock`（历史默认键） |
| 游戏性 | `src/workspaces/GameplayWorkspace.tsx` | 2（资源管理器、资产管理器） | `hanshu.panelDock.gameplay` |
| 视听效果 | `src/workspaces/AudiovisualWorkspace.tsx` | 2（资源管理器、资产管理器） | `hanshu.audiovisualDock.v1` |
| 皮肤管理器 | `src/skin/SkinWorkspace.tsx` | 2（皮肤库、详情） | `hanshu.panelDock.skin` |
| BOSS 血条设计视图 | `src/workspaces/audiovisual/bossbar/editor/BossbarDesignView.tsx` | 4 | `hanshu.panelDock.bossbar` |

每个 `<PanelDock storageKey={…}>` 都必须显式传自己的键，各视图的键互不相同：`verify-panel-dock` 会读这五个文件，校验常量互不重复。少了这条，某个视图会悄悄落回默认键、和剧本共用一份布局。

面板 `id` 只在**同一份布局内**唯一，跨视图重名没有含义：剧本和游戏性各有一个叫 `explorer` 的面板，它们是各自布局里的一条记录。

```
App ── activeWorkspaceId（视图作用域）──┬─ 菜单分派 handleMenuAction(id)
                                        └─ 四个工作区常驻挂载，.app-workspace-pane.active 控制显隐
```

这是**有意保留**的，不是遗留。工作区之间各持自己的编辑器、文档状态与面板摆放。

## 已定的分层

```
每个工作区（视图作用域）
 ├─ 文档与编辑状态        工作区自己持有
 ├─ 面板声明  dockPanels.tsx / 各自 dockPanels   「要什么面板」
 ├─ 能力模块  assetActions.ts 等                 「面板能做怎么」
 └─ PanelDock（自己的 DockLayout）              「面板摆在哪」
```

三条规则：

1. **面板是声明，不是闭包**。面板所需的一切由宿主以显式参数传入（见下文 `StageplayDockHost`），面板不读宿主内部变量。
2. **布局是每个视图自己的数据**。一个视图只读自己那个 `storageKey`；面板 id 在某份布局里定位，换视图就是换一份布局。
3. **切换视图不卸载工作区**。四个工作区常驻挂载，切 tab 只改 `.active`，各自的布局与面板内未提交的输入都在。

## 未做：一个 Layout + 面板注册表（仅混合布局需要）

如果将来要做「剧本与游戏性文档并排」，才需要：`App` 持有唯一 `PanelDock`、面板注册表带 `scope`、菜单跟聚焦编辑器走（`MenuContext.activeEditor`）。**当前不做**，原因见文首结论。

## 已做

| 步骤 | 内容 | 固定在 |
| --- | --- | --- |
| 1 | 面板声明搬出工作区组件：`dockPanels.tsx` 导出 `stageplayDockPanels(host)`，依赖集中在 `StageplayDockHost` | `verify-panel-dock`：工作区不得内联 `DockPanelSpec[]` |
| 2 | 每个视图一份独立布局键（`verify-panel-dock` 校验五个键互不相同） | `verify-panel-dock:ui`：剧本里浮起的资源管理器不会让游戏性也变浮窗 |
| 3 | assets 写操作抽成能力模块 `assetManager/assetActions.ts`，面板在三个视图共用 | `verify-explorer-shell:ui`：真实导入 / 删除 + 三个视图里的渲染尺寸；`verify-panel-dock`：处理函数不得回到工作区 |
| 4 | 共用面板自带样式令牌（`assetManager/assetManager.css`），观感不靠宿主祖先类名 | `verify-panel-dock`：面板样式不得引用 `--xs-*` |

这三步都是「声明 / 能力 / 布局数据」的分层，与是否做混合布局无关，因此长期保留。`verify-panel-dock` 的守卫守的是**这个已获得的结构**，不是某个待完成的迁移。

形状：

```ts
// src/workspaces/stageplay/dockPanels.tsx
export type StageplayDockHost = { view, project, readOnly, explorer, assets, agent, roles, studio }
export function stageplayDockPanels(host: StageplayDockHost): DockPanelSpec[]
```

工作区只负责把当前状态整理成 host；面板声明不再知道 `workspaceRef`、`view` 之类的工作区内部结构。

能力模块同一模式（factory + 显式 deps，不持有状态）：

```ts
// src/workspaces/assetManager/assetActions.ts（剧本 / 游戏性 / 视听共用）
export type AssetActionDeps = { workspaceRef, projectRef, commitWorkspace, flushEditorInto?, onAssetsChanged? }
export function createAssetActions(deps): AssetActions
```

新增能力时照这个来：工作区只注入「怎么存、句柄在哪、提示怎么弹」，逻辑留在模块里；面板拿到的是一组回调，不需要整个工作区。

## 面板约定

- 标题栏是拖动 / 停靠手柄：`is-draggable` + `onTitlePointerDown`，提示语用 `dockTitleHint(dock)`；能复用的直接用 `src/ui/DockPanelTitle.tsx`。
- 面板自己滚动，标题栏固定在顶上（不要给整块面板加 `overflow: auto` 再给标题 `position: sticky`——滚下去手柄就没了）。
- 面板 `id` 只在同一份布局内定位：改名等于换记录（旧记录让位给默认位置）。不同视图可以重名，互不影响。
- 布局偏好只存本机；「查看 → 编辑器布局」用 `resetPanelDock(storageKey)` 恢复默认，**只重置当前视图**。
- 新增视图时同时加一个布局键常量并传给 `PanelDock`；不要复用别人的键，也不要依赖默认值。
- **跨视图共用的面板自带样式**：用量表自己定义（命名带前缀，如 `--am-*`），选择器都带自己的根类名（`.asset-manager .explorer-row …`）。不要借宿主壳上的变量（`.explorer-shell` 的 `--xs-*` 只在资源管理器内部有定义，面板挂进别的视图的停靠栏时会整条失效——`width: var(--xs-icon)` 失效后 `svg` 退回 100% 宽，一行被图标填满）；也要盖过宿主的通用元素规则（游戏性有 `:is(.gameplay-workspace) button { border; background; padding }`）。

## 验证

`npm run test:panel-dock:ui` 覆盖拖动浮起、刷新后布局持久化、停靠回边缘、标签合并与隐藏、恢复默认布局，以及「在剧本里浮起的资源管理器不会让游戏性也变浮窗」。舞台剧增加/减少面板时同步扩这条用例。

`npm run test:explorer-shell:ui` 覆盖资产管理器标题栏可拖动、游戏性与视听也能呼出同一份面板（并校验图标尺寸与行样式，防止样式再次依赖宿主祖先）、树外杂项不占空栏，以及真实资产导入 / 删除。`npm run test:panel-dock` 是静态守卫：面板声明与 assets 能力都不得回到工作区组件里，assets 能力不得依赖配音模块，三个视图都必须用共享的 `assetManager/assetActions`，五个 `PanelDock` 必须各传一个互不相同的布局键。
