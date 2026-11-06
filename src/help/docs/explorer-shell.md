# 通用资源管理器底座

剧本、游戏性、视听效果三个工作区的资源管理器共用一套薄壳：`src/explorerShell/`。本文说明命名、壳的边界、可插拔分类表与共享虚拟文件夹协议。修改任何资源管理器前，先读[资源分类与共享组织](#resource-organization)与[多人协作编程指南](#collaboration-programming)。

## 工程，不是包

一个目录就是一个**工程**（Project），一个窗口只绑定一个工程。界面统一叫「工程」，没有「工程内多包」。三个工作区的资源树顶都是分类，不挂工程名行；工程名在顶栏（来自 `project.json`／目录名）。新建、打开、导入工程走工程菜单。

代码里还留着历史名字，含义如下：

| 名字 | 实际含义 |
| --- | --- |
| `Workspace.packages` | 当前窗口的工程列表；界面只用 `packages[0]`，保留数组只为兼容旧草稿与会话通道 |
| `ScriptPackage` | 已弃用的 `Project` 别名 |
| 游戏性 `FlowDocument.package` / `FlowPackageId` | 业务**分类**（任务、物品、脚本……），不是工程 |
| 共享文件夹 `category`（旧名 `package`） | 文件夹所属业务分类 |

## 结构

```
工程 → 资源管理器壳
          ├─ 分类适配器       GAMEPLAY / AUDIOVISUAL / STAGEPLAY 分类表
          ├─ 组织适配器       meta/explorer.json，按注册的组织域校验
          ├─ 领域视图（插件） 游戏性：任务格式分组、表视图、内置脚本、启动列表
          └─ 剧本 assets 附加件（临时）
```

壳提供：

- `ExplorerShellFrame`：标题栏、PanelDock 拖动 / 停靠回边缘、工具按钮槽。三个工作区都用它。
- `ExplorerTreeRow`：缩进、展开箭头、图标、状态类名（`selected` / `is-open` / `drop-target` / `is-builtin` / `is-detached`）。
- `CategoryExplorer`：通用的「分类 → 共享虚拟文件夹 → 源文件」树，含搜索、多选、键盘导航、就地改名、右键菜单和组内拖放。剧本与视听效果直接使用它；游戏性因任务视图、表视图等领域插件仍用自己的树（`FlowExplorer`），但同用外框、行组件与组织协议。
  - `onCreate(category, folderKey, anchor)`：新建入口给出目标分类、目标共享文件夹（分类根为 `null`）和触发位置；工作区据此弹出自己的类型菜单，创建后用 `placeSource` 登记归属。
  - `slots`：`rootClass`（追加根类名）、`tools`（标题栏工具，排在壳自带按钮前，如剧本 `+剧`）、`prepend`（树顶附加内容，如未打开工程时的提示）、`blankMenuItems`（树空白处右键附加项）。
  - `renameRequest`：`{ id, seq }` 的 `seq` 变化时展开到该文件并进入行内改名，用于「创建后立即改名」。
  - `addons`：挂在分类树之后的附加视图（剧本 `assets/` 真实目录）。
- `virtualFolders.ts`：新建 / 改名 / 移动 / 删除虚拟文件夹与登记放置的纯函数，结果全部经 `parseOrganization` 复核。
- `commitOrganization`：把组织改动作为 `meta/explorer.json` 的普通文件事务交给 S；S 明确拒绝时回滚投影，结果不确定时不回滚。
- `relocation.ts`：源文件改名 / 删除后的归属搬迁（`relocatedExplorer`）与随源文件事务附带的组织写入（`organizationEdits`）。S 已认识的源文件由 `sourceCommands` 在同一事务里搬迁归属，调用方只更新本窗口投影；尚未保存的新文件只在本窗口，改名 / 删除后单独经 `commitOrganization` 提交归属。

壳**不**认识：任务视图、物品 / 实体表、进入游戏、礼包拖拽 MIME、`assets/` 真实目录。这些留在各工作区插件里。图标统一来自 `src/explorerIcons.tsx`。

## 外观

三个工作区的资源树是同一产品观感，以游戏性资源树为标杆：`explorerShell.css` 的默认值就是游戏性 `--fl-*`（面板 `#303030`、标题栏 `#383838`、悬停 `#3d3d3d`、选中 `#3a5278`），行高 `24px × --fl-s`、标题栏 `26px × --fl-s`、工具按钮 `20px × --fl-s`、字号 `--fl-font-sm` / `--fl-font-xs`、图标 `16px × --fl-s`，搜索框与页脚同游戏性。壳在游戏性 / 视听根上读到 `--fl-*`，在剧本等未定义处退回同值（缩放退回 `--app-ui-scale`）。

工作区不再另写一套资源树皮肤：视听只把自己的同值接到 `--fl-*`；剧本主树直接用壳类名（根类名 `explorer-shell stageplay-explorer`），旧 `.explorer-*` 只剩 `assets/` 附加件的行，并在壳内按同一行高 / 选中色对齐。确需换肤时只改 `--xs-*` 变量，不覆盖结构类名。

## 分类表与组织域

`src/project/organizationDomains.ts` 注册三个组织域：

| 域 | 分类表 | 共享虚拟文件夹 |
| --- | --- | --- |
| `gameplay` | `GAMEPLAY_CATEGORIES`，另含 `section:<分类>:<键>` 固定分组 | 支持 |
| `audiovisual` | `AUDIOVISUAL_CATEGORIES` | 支持；**仅限有原生格式的分类** |
| `stageplay` | `STAGEPLAY_CATEGORIES`（汉书剧本、角色卡、创作资料） | 支持 |

三个工作区的「文件夹」语义一致：都是 `meta/explorer.json` 里的共享虚拟文件夹，只整理归属，**不改磁盘路径**（`sourcePathOf` 不变），新建 / 改名 / 移动 / 删除文件夹都经 S 文件事务提交。剧本 `assets/` 是唯一的例外，它是真实目录，见下文附加件。

注册表要求分类 ID 全局唯一、每个资源类型只属于一个分类，否则启动即报错。`parseOrganization` 用注册表校验文件夹分类、父链和放置：

- 文件夹分类必须在某个支持文件夹的域里，且该分类的 `types` 非空。视听占位分类（`types` 为空）**不能**建文件夹；等它接入资源类型后自动放开。
- 放置的源文件类型必须属于文件夹所在分类；脚本还要求真实类型目录一致。例如 `.char` 不能放进「汉书剧本」的文件夹。
- 每个域只替换自己的文件夹：任一工作区投影组织时都保留其他两域的文件夹与归属（`projectDomainOrganization`）。

## 剧本资源管理器

`src/workspaces/stageplay/StageplayExplorer.tsx` 基于 `CategoryExplorer`，分类适配器在同目录 `explorerCategories.ts`（对标视听）：

- 分类即 `STAGEPLAY_CATEGORIES`，顺序同 `STAGEPLAY_WORKSPACE_GROUP_ORDER`；文件经 `isStageplayExplorerSource` 过滤，游戏性 / 视听文件不进入。
- 组织：已打开工程时为 `project.explorer ?? emptyOrganization()`，`onOrganize` 走 `commitOrganization`；未打开工程为 `null`，只读。
- 新建：标题栏 `+剧` 与应用菜单「新建剧本」打开全部剧本类型，创建在对应分类根；分类 / 文件夹右键「新建汉书剧本」「新建角色卡」直接创建，「新建创作资料…」在点击处弹出该分类的类型子集。带 `folderKey` 时创建后 `placeSource` 登记归属。创建后分配默认名并进入行内改名。
- 改名 / 删除：仍走剧本工作区现有事务（连带搬迁 / 删除各语言文本与配音），归属随之搬迁或清除。
- 工程根下不属于任何剧本分类的旧文件（如历史 `.voice`）在「工程根（未归类）」只读列出，可打开、删除；它们不能建夹。

新增工作区分类表时，在 `organizationDomains.ts` 注册一个域，不要把分类塞进别的工作区表。

## 元数据版本

`meta/explorer.json` 当前写 `version: 2`，文件夹分类字段为 `category`。旧工程的 `version: 1` 使用 `package` 字段，读取时按同义处理；只要组织没被修改就不会被判为脏、不会被重写。任何组织修改提交后统一写成 v2。旧版客户端读不了 v2 文件，混用新旧客户端协作前应先升级。

游戏性个人界面草稿里的旧文件夹字段 `package` 同样在读取时迁移为 `category`。

## 删除与只读

删除虚拟文件夹只移除文件夹及其子树和放置，**不删除源文件**；文件回到分类根。删除源文件时，放置清理与源文件删除放在同一事务。未绑定工程或只读成员时，壳只读：可以浏览，不能整理。

## 剧本 assets 附加件（临时）

`assets/` 是磁盘上的真实目录，新建 / 删除文件夹会改工程路径，不能当作共享虚拟文件夹处理，也不进入壳的核心。剧本工作区暂时在分类树之后挂 `src/workspaces/stageplay/StageplayAssetsAddon.tsx` 展示并管理它（导入、新建 / 删除目录、拖放移动）。

退出条件：资产工作区接管 `assets/` 的浏览与管理后，删除该附加件及剧本工作区里对应的处理函数，壳本身不需要改动。

## 验证

`npm run test:resource-organization` 覆盖 v1 兼容读取、分类注册校验、剧本分类建夹、三域互不擦除与虚拟文件夹操作。界面改动先 `npm run build`（UI 脚本使用 `dist/`），再跑 `npm run test:explorer-shell:ui`：真实 S 下检查剧本树无工程名行、挂着 assets 附加件、剧本新建虚拟文件夹以 v2 提交且保留游戏性文件夹（不建磁盘目录）、在该文件夹内新建剧本会登记归属、游戏性读出 v1 旧文件夹、视听新建文件夹以 v2 提交且保留游戏性与剧本文件夹。
