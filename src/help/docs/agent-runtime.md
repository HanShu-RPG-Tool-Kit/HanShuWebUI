# Agent 运行时

> 实现说明。设计决策的完整推导见当时的架构评审文档；这里记录**落地后的形状**、边界与已知偏差。

## 一句话

对话由浏览器内的 `pi-durable` 管理、只存本机；工程权威仍归 Rust S；一个 Run 是可撤销的原子回合；
人与 agent 通过「读锚定版本 + 显式锁 + 写时校验」共享工作区；对话按「活跃段（窗口内可继续）+ 归档段（工程级不可变）」两层组织。

## 分层

| 层 | 位置 | 职责 |
|---|---|---|
| UI | `src/AgentPanel.tsx`、`src/agent/view/` | 只渲染 `AgentRuntimeView`，不持有对话状态 |
| 适配（唯一 import PI 的层） | `src/agent/pi/` | `facade` 装配 Harness / 活跃段 / 归档段库；`models` 注入本机密钥；`tools` 把工具包成 `defineTool`；`arbiter` 接锁与撤销日志；`view` 把 PI 视图映射成面板视图 |
| 运行时支撑 | `src/agent/runtime/` | `version`（内容哈希）· `lockTable`（锁）· `runUndo`（Run 撤销日志） |
| 本地存储 | `src/agent/store/` | `dbNames`（库命名）· `windowId`（窗口认领）· `snapshotStore`（归档段库）· `segmentPurge`（删除活跃段） |
| 领域工具 | `src/agent/tools.ts` | 18 个工具按 read / lock / write 三类语义派发 |
| 契约 | `src/agent/contracts.ts` | 上述各层之间唯一的类型耦合面 |

**不变量：`@earendil-works/*` 只允许出现在 `src/agent/pi/`。** UI、工作区、工具层都不直接依赖 PI。

## 存储

全部在用户浏览器 IndexedDB，**不经过 S、不进工程目录**：

```
活跃段库  hanshu.agent.session.<windowId>.<工程 scope>   ← pi-durable（8 个 store）
归档段库  hanshu.agent.archive.<工程 scope>              ← 自有记录格式，追加写入
```

- **工程 scope**：远端用 S 的 `projectId`，本机用工程的 `project.json.id`。
- **windowId**：`sessionStorage` 中的 UUID（跨刷新稳定）；启动时用一次 Web Lock 认领，
  抢不到（复制标签页）→ 换新 UUID、开新空库。活跃段只归创建窗口。
- 段元数据（标题/时间/runCount）存在 localStorage；**对话正文永远不进 localStorage**。

## 工具三语义（严格模式）

| 语义 | 工具 | 规则 |
|---|---|---|
| read | `list_sources` `read_source` `validate_source` `get_active_file_path` `list_locales` `list_lang_keys` `list_voice_status` `check_export` | `read_source` 返回 `content` + `version`（内容哈希），并登记「本 Run 读过这一版」；`list_lang_keys` 读**工程文件**（S 权威），带 `version` 与 `localDraft` |
| lock | `lock_source` | 多路径原子；前置：本 Run 读过 + 版本一致 + 非 human-dirty（+ create 时路径不存在）；**不等待，拿不到立即失败** |
| write | `create_source` `write_source` `edit_source` `rename_source` `delete_source` `write_lang` `delete_lang_keys` `parse_hs` `unparse_hs` | 必须先持锁；未持锁直接拒绝，错误里带 `lock_source` 下一步 |

- 版本 = **内容哈希**（SHA-256）：改了又改回来不算冲突。
- lock 失败也回传 `currentVersion` / `currentContent`，让模型一次往返内自愈。
- `rename_source` 源 + 目标都要锁；`create_source` 的锁语义是「占住一个还不存在的名字」。
- **写后哈希自更新**：write 成功即把「本 Run 读到的版本」更新为刚写出的内容哈希——
  agent 当然知道自己改完的文件长什么样，同一 Run 里再锁同一文件不会被判 `version_stale`，也不必重新读一遍。
- 锁的释放：被 write 消费 → 立即释放；Run 结束/中止 → 兜底释放。
- 人类侧：Agent 持锁的文件在编辑器里转只读（`agentWritingFile`）。

### 语言资产：写入即落盘、锁覆盖派生文件

- `write_lang` / `delete_lang_keys` / `parse_hs` 的译文**立即提交一次 S 文件事务**（`client.apply`），
  返回 `writtenPaths` / `version` 即代表工程文件里已经有了；不再出现"工具说写了、磁盘上没有"。
  正文（`.hs`）仍是本窗口草稿，等「保存工程」；只有译文走立即落盘（它不在正文保存批次里）。
- `list_lang_keys` / `check_export` 读的也是工程文件（S 权威），不是本机 IndexedDB 镜像。
  镜像只在 S 写成功后同步一份给界面用。
- **派生语言资产的锁覆盖**：`lock_source` 会把该源文件**已存在**的语言资产一起锁进去；
  `write_lang` 等写前逐个核对版本 —— 外部改了 `.lang`、源文件版本却没变时，
  会以「语言文件在 lock 之后被外部修改」拒绝，并提示重新 lock + `list_lang_keys` 后重试。
  这是「源版本没变就以为没人动过」的防线。
- `check_export` 的预检会报告每种语言缺多少键（`warnings` + `missingTranslations`），
  不再让用户靠肉眼翻 `.lang` 文件。

## Run 生命周期

```
submit(input) → 多轮模型回合（工具调用）→ 最终答案 = 一个 Run
```

- 页面存活时**失败/中止** → 按版本守卫回滚工程文件：逆序回放 before-image，
  每个路径先比对「当前哈希 == 本 Run 写出时的哈希」，被后续改动覆盖过的一律跳过并标记人工合并。
- **只回滚工程文件，不回滚对话条目**：失败的 Run 在对话里留一条记录，用户能看到当时想做什么。
- 刷新 / 崩溃后不回滚：工作区按镜像恢复，那半套改动当作用户的未保存草稿。
- 撤销日志**只在内存**，不落盘。
- 打开时不自动续跑：检测到未完成 Run → `abort()` 并标记中断，不续跑、不回滚。
- **不设对话轮次上限**（`maxTurns` 不配置）：长任务不会被强制截断；要停只能停止或让模型自己收尾。
- 对话里可查看模型**思考**：默认折叠，点「思考」展开；只展示厂商返回的可见思考，不额外请求。
- 与 pi-durable 默认语义相反（配置层，不改框架）：`retry.enabled = false`、`restartLimit = 1`、
  工具不标 `replay: "safe"`（中断的工具调用不重跑）。

## Run 与保存双向互斥

| 方向 | 规则 |
|---|---|
| Run 活跃 → 保存 | 保存按钮 / 快捷键 / 语言文本保存全部禁用，提示「Agent 运行中，暂不可保存」 |
| 保存事务进行中 → 启动 Run | 禁止（`AgentRuntimeOptions.canStartRun` 闸门） |

保存路径（两步，非原子，顺序固定）：

```
① 文件草稿 → S 事务（版本校验 / 冲突对话框，现有流程）
     └ 失败 → 不产归档，活跃段原样保留
② 文件确认提交后 → 段自上次归档之后的新增条目追加进归档段库，写一条归档记录
     └ 失败 → 不回滚文件；告警「文件已保存、对话未落盘」，下次保存补写
```

## 活跃段与归档段

- **活跃段**：窗口内可继续的对话，可跑 Run、可多次保存；保存**不封段**（缓存前缀稳定的关键）；
  可以新建、切换、**删除**（删除会连同该段对话一起消失，不可恢复；归档段库不受影响）。
- **归档段**：不可变，按工程 scope 存归档段库，同工程所有窗口可读。UI 只展示时间与对话条数。
  归档记录用 `parentSnapshotId` 串成谱系：同一段继续保存 → 父是该段上一次归档；
  从某个归档「继承对话」后新段产出的归档 → 父是被继承的那个归档。
- 归档 ≠ 段结束；一个活跃段库可含 N 个段；切换工程只休眠、不封存。
- 归档段库的三项操作：
  - **打开**：只读查看归档时的对话（含思考折叠）；
  - **继承对话**：以该归档为起点新建一个活跃段接着聊（只复制对话类条目；
    `pi.compaction` / `pi.reset` 是上下文分界，复制会破坏语义，跳过）；
  - **删除**：连带删除**所有直接/间接继承它的段**（活跃段与归档段都算），删除前 UI 二次确认。
- `navigator.storage.persist()` 争取持久化配额；归档段库占用 > 50 MB 黄条、> 100 MB 红条；
  归档段**永不自动删除**（删活跃段不会删归档；删归档段才动归档，且只按谱系级联）。

> 删除会话的实现：pi-durable 1.5.0 没有「删单个会话」的 API，`IndexedDbStorage.delete()` 删的是整库。
> 所以先关 Harness，再按 1.5.0 的库结构逐条删除会话的记录（`src/agent/store/segmentPurge.ts`）；
> 删除归档段就是「先按谱系算出要删的归档与段，再删段、再从叶子往根删归档」。
> **升级 PI 时必须重新核对 `dist/storage/indexeddb.js` 的 STORES / INDEXES**；结构不符会 fail-closed。

## 配置

- API Key 由用户在 Agent 面板填写，存 localStorage（`hanshu.agent.apiKey`），**不进构建产物**；
  每次模型请求现读，改 Key / 清 Key 立刻生效。界面上只写一句「Key 只在本机浏览器保存，不会上传」。
- **两档模型可分别设置**：Pro 与 Flash 各有一个模型 id
  （`hanshu.agent.model.pro` / `hanshu.agent.model.flash`，默认 `deepseek-v4-pro` / `deepseek-flash`）；
  顶栏 Pro/Flash 只切换用哪一档，下一次 Run 前重写会话配置，所以「下一轮生效」。
  自建网关的模型若不在 pi-ai catalog 里，会按同协议克隆一份补进 provider 目录。
- **思考强度可分别设置**：Pro / Flash 各一个档位
  （`hanshu.agent.thinking.pro` / `.flash`，可选 minimal / low / medium / high / xhigh / max，默认 **high**）；
  顶栏切换档位后下一轮生效。界面上「思考」按钮默认折叠，不打断阅读。
- 网关地址默认 **`https://api.deepseek.com`**（`hanshu.agent.baseUrl` 可改成自建 OpenAI 兼容端点）；
  它在运行时创建时固定，改后由面板回调让工作区重建运行时。

## 验收

```bash
node scripts/run-verification.mjs scripts/verify-agent-store.ts    # 版本/锁/撤销日志/归档段库/windowId（24 项）
node scripts/run-verification.mjs scripts/verify-agent-tools.ts    # 三语义派发与严格模式（12 项）
node scripts/run-verification.mjs scripts/verify-agent-arbiter.ts  # 写后哈希自更新、未锁拒绝、撤销回放（5 项）
node scripts/run-verification.mjs scripts/verify-agent-panel.ts    # 视图派生/阈值/掩码
node scripts/run-verification.mjs scripts/verify-agent-config.ts   # 两档模型、模型 id 校验
node scripts/run-verification.mjs scripts/verify-agent-runtime.ts  # 真 Harness 闭环（MemoryStorage + faux 模型，5 项）
node scripts/verify-agent-segment-purge.mjs                        # 删除活跃段（真实浏览器 IndexedDB，Playwright）
node scripts/verify-agent-archive.mjs                              # 归档段打开/继承/级联删除（真实浏览器 + 真 Harness，不调模型）
node scripts/verify-agent-lang-lock.ts                             # 语言资产锁覆盖/外部回写拦截/导出译文预检（5 项）
```

`verify-agent-runtime.ts` 走的是与生产同一套 Harness / Conversation / defineTool 代码路径：
Run 作答、工具回合、刷新后可续、中止结算、失败不重试，全部不联网。

## 已知偏差与取舍

1. **锁的持有上限是「一次 Run」，不是「一次模型回复」**：pi-durable 没有暴露「回合边界」回调，
   `lock_source` 后若既不写也不释放，锁会持有到本 Run 结束（人类在该文件上一直只读）。
   写操作成功会立即消费锁，所以实际长时间持锁只发生在「锁了却没写」的异常路径，Run 结束即兜底释放。
2. **派生资产只覆盖语言文本，不覆盖配音二进制**：`lock_source` 会展开到该源文件**已存在**的各语言 `.lang`
   并做版本校验（`readAssetText`）；配音（`.ogg` / `.ref`）仍不作版本覆盖 —— 它们由源文件的结构操作联动，
   文本工具不直接写它们。
3. **工具顺序执行**（`toolExecution: 'sequential'`）：并行派发会让「读版本 → 加锁」在同轮工具之间交错，
   顺序执行让锁归属与撤销日志可解释。
4. **段元数据（标题/时间）存 localStorage**：`ConversationRecord` 只带 id / 谱系，不带标题；
   标题从第一条用户消息派生。删掉 localStorage 只是丢标题，不影响对话。
5. **复制工程目录会连 `project.json.id` 一起复制**，两个副本在本浏览器共享归档段库。
   二期用一次性 `agentScope` UUID 修复。
6. **"封存"目前只是语义**：窗口关闭后活跃段库仍留在 IndexedDB 里，本期不写封存标记、也不回收
   （清理策略未定，见设计文档 §15）。重开同窗口（windowId 相同）仍可继续。
7. **归档段只在运行时存活时产出**：保存时若 Agent 面板已关闭（运行时已释放），文件照常保存，
   只是这次不产归档；下次打开面板再保存会补写（增量以 `tailEntryId` 为锚）。
8. **「打开归档段」看到的是归档那一刻的副本**：归档不可变，不会随后续对话变化；只读，想接着聊用「继承对话」。
9. **未做**：导出/导入、孤儿活跃段库回收、工具结果去重、大结果截断（见设计文档 §15）。
