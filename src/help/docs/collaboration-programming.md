# 多人协作编程指南

适用于后续人工或 Agent 修改 WebUI。新增编辑器、资源类型或写入操作前先读本页；协议和详细设计见[工程服务与多人协作](#collaboration-service)。代码接口以当前实现为准，不复制旧版本示例另建写入通道。

## 目前覆盖什么

工程资源统一由 S 管理；“已接入协作”表示共用身份、权限、读取、事务、版本检查和历史，不表示所有编辑器都按字符或节点合并。

| 内容 | 当前提交方式 |
| --- | --- |
| `.hs`、`.char`、普通及目标定义 `.py`、`.md` | 本窗口草稿，保存时文件事务 |
| `.hflow`、`.nav`、`.item`、`.kit` | 本窗口表单／画布草稿，保存时文件事务 |
| `.tts`、`.ttsservice` | 普通源文件草稿，保存时文件事务 |
| `.progress` | `submitProgress` 语义操作，按被修改字段校验；正文与本次语言修改一起提交 |
| 语言 `.lang` | 普通编辑器随正文暂存并合批保存；进度表单使用进度命令 |
| 图片、音频及 `.ref` 等 `assets/` 资源 | 导入／修改可先留草稿；替换、引用、删除等显式操作使用文件事务 |
| 皮肤索引与对象 | `SkinLibrarySession`；条目修改与管理命令，必要时对象和索引合批 |
| `project.json` | 普通版本校验事务；远端工程名称只刷新到干净的本地视图 |
| 新建、改名、移动、删除、历史恢复 | 显式事务；归属资源联动由 S 推导 |

窗口布局、折叠状态、当前选择、Agent 会话、本机 API 凭据等是客户端状态；游戏串流连接与控制是外部服务交互。它们不因打开共享工程就变成共享工程数据。导入读取本机文件、导出下载文件，也不等于取得工程目录写权限。

## 必须保持的边界

- **S 是工程写入权威。** C 只持有 `ProjectClient`／只读远程 `ProjectDirectory`，不添加浏览器文件系统写句柄、Tauri 文件写入 IPC，或绕过事务直接请求提交接口。
- UI 的 `client.writable` 用于禁用操作、解释错误；S 必须再次校验主体、会话、权限、租约、版本／字段原值。隐藏按钮不是权限控制。
- Subject 是身份，Session 是窗口连接，租约属于 Session。不能以显示名、窗口名称或客户端传来的 owner 标志授权；头像和“编辑中”只是在线状态，不是写权。
- 当前授权粒度是整个工程的 owner/editor/viewer，viewer 可以读取公开工程资源；没有逐文件保密权限。`.hanshu/service/` 始终是 S 私有数据。
- 缓存、IndexedDB 和 sessionStorage 都不能作为服务器事实。看见“本地已暂存”不能提示“工程已保存”。

## 新增普通编辑功能

1. 从当前 `useProjectSession()` 获取工程与客户端，源文件路径使用 `sourcePathOf` 等现有映射。不要把磁盘绝对路径交给 C。
2. 读取内容时保留对应版本。`readSnapshot(path)` 返回同一快照的内容与版本；普通编辑器沿用 `client.texts`、`baseline`、`originals`。
3. 输入先更新本窗口草稿并登记脏状态。已有工作区经 `setProjectSession` 更新；单独维护状态的编辑器需要 `transactions.setEditorDirty(owner, paths)`，用独立视图标识作 owner，卸载时以空数组清理自己的登记。
4. 保存型编辑器接入 `saveProjectToDirectory`；独立的立即操作使用 `client.apply(edits, label)`。两者都经过 `EditTransactions`、本地提交日志、S 计划、临时写权、事务和回执。
5. 当前文件使用无界面的 `FilePresenceBar mode="optimistic"`／`useResourcePresence` 发布焦点；成员、连接状态、多文件草稿和提交恢复由 `CollaborationWidget` 集中展示。业务弹窗仍可用 `ResourceSaveStatus` 关联确切的提交编号。不要重新添加占用编辑区的全局头像行或提交行。输入是否可用看 `client.writable`；不要套用旧的 `editing.canEdit` 长期持锁模式。只为活动视图发布焦点，避免隐藏工作区清掉另一视图的状态。

独立操作的简例（实际编辑器应把读取结果保留到用户完成编辑）：

```ts
const { file, version } = await client.readSnapshot(path)
const original = await file.text()
const next = edit(original)
await client.apply([{ op: 'write', path, data: next, version }], '修改资源')
```

不要在用户编辑完成后重新读最新版本，再把旧内容贴到新版本上提交。刷新资源树不应推进脏草稿的版本。读取、生成或导入期间切换工程，要核对原客户端仍是当前绑定；否则结果留在原工程草稿，不能写入新工程。

## 多文件与异步操作

- 一次业务操作涉及多份资源时，提交**一个变更数组**；相邻两次 `apply` 不会自动合成事务。例如配音替换将 `.ogg` 写入和对应 `.ref` 删除合批。
- 保存型编辑器的关联语言或资产用 `transactions.stageWrite(edit, mirror)` 暂存；初始化尚未产生草稿时，先用 `prepareDraft(path, run)` 登记。工程保存会等待准备完成并合并暂存修改；不要另开自动保存通道。
- 源文件改名／删除使用 `sourceCommand`／`sourceCommands`。不要自己遍历语言与配音目录拼删除列表，也不要把引用礼包当成归属文件一起删除。
- S 的关系解析、操作策略和执行机制分别在 `resource_relations.rs`、`resource_policy.rs`、`files.rs`。新增资源类型要同步补关系、策略、目录映射和校验；计划查询不授权，提交时 S 必须重新验证。
- 界面元数据与缓存通常在 S 确认后改变。乐观显示必须有草稿／待确认状态，失败不能静默删掉原内容。多条导入可以允许部分成功，但每条内部的不可分操作必须合批。

## 失败、重试、撤销

- 断线、只读或权限撤销：暂停提交，保留输入；恢复连接后仍使用草稿原版本。
- `conflict`／`locked`：保留原载荷与原版本，展示现场处理入口。不能自动采用服务器最新版本强行重试。
- 超时、回复截断、无效回执或存储结果不明确：视为**结果未知**。让事务层查询原回执；不能换编号重做，尤其是移动、删除和导入。
- `EditTransactions` 已实现编号与日志规则：未知结果沿用原编号及原请求，确定拒绝后的重试换新编号。调用它的查询／重试／冲突处理方法，不在编辑器里另写一套重试循环。
- 成功回执描述原提交结果，可能早于其他人的后续修改。当前视图读取最新 S 状态；只清除本次确认的草稿，不清除提交期间继续输入的内容。刷新失败与服务端拒绝必须区分。
- `.progress` 撤销／重做引用 S 的操作回执，保留他人无关修改。普通编辑器的本地撤销仍是本窗口草稿操作，保存时继续版本检查。共享历史恢复使用预览计划与事务，不能把旧快照直接覆盖整个工程。

## 新增语义命令或服务端端点

优先复用普通事务。确实需要字段／条目粒度时，参考 `progress_commands.rs`、`skin_patch.rs` 和 `skin_commands.rs`：S 校验目标与原值，独立推导修改及写权范围，在同一事务中执行，并返回能精确恢复的结果。不能仅按整文件旧哈希放行任意字段覆盖。

协议模型定义在 Rust，修改后运行 `npm run generate:protocol`，不要手改 `src/collab/generated.ts`。新增端点核对角色、请求大小、路径校验和重放语义；项目私有目录、符号链接／联接、穿越路径、Windows ADS／设备名都不能绕过统一检查。S 不执行作者提供的目标定义或游戏脚本。

本机目录与防火墙能力只属于可信本机宿主；不仅检查网页来源，还要防止 Dev／Preview 把远端请求代理成本机请求。邀请只签发独立 guest 身份，不能向 HTTP 返回 owner 恢复凭证。会话令牌不写 URL 或持久化浏览器存储。

## 验证与已知范围

按改动选择验证，不必每次运行全部套件：

| 改动 | 验证入口 |
| --- | --- |
| 新编辑器、写入入口、文件类型 | `test:project-boundary`、`test:collaboration`，Rust `tests/files.rs`；补实际 UI 的只读与双端冲突验证 |
| 暂存、批次、重试、缓存投影 | `test:edit-transactions`、`test:editor-transactions`、`test:collaboration:ui` |
| 归属、改名、删除 | `test:resource-policy`；Rust `tests/resource_policy.rs` |
| 进度、皮肤命令 | 对应 `test:progress-collaboration[:ui]`／`test:skin-collaboration` 与 Rust 命令测试 |
| 历史、清单、远端刷新 | `test:project-history[:ui]`、`test:project-manifest:ui` |
| 本机打开、分享、网络边界 | `test:local-projects[:ui/:proxy]`、`test:project-sharing[:ui]`、`test:collaboration:network` |

检查同一／不同 Subject 的多 Session、viewer、提交期间降权、独立修改、同资源冲突、回复丢失、重放及重启。新语义命令还要检查不相关字段不被覆盖、同字段冲突和撤销边界。最后运行相关构建、lint 与 `check:protocol`。

2026-10-22 检查未发现现有工程资源绕过 S 的写盘入口；补上了工程清单远端改名不刷新的遗漏。覆盖来自代码检查、核心与 HTTP 测试、隔离浏览器验收，不等于对所有界面组合的穷尽证明。普通文件尚未逐字符／逐节点合并；S 不提供公网 TLS／穿透，也不能保护被外部程序绕过 S 直接修改的磁盘。工程整体备份需包含 S 私有事务与历史数据。其他容量、持久化与网络限制见[工程服务与多人协作](#collaboration-service)。
