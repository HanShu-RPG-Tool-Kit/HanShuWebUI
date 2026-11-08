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
| 领域工具 | `src/agent/tools.ts` | 19 个工具按 read / lock / write 三类语义派发 |
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
| read | `list_sources` `read_source` `validate_source` `get_active_file_path` `list_locales` `list_lang_keys` `list_voice_status` `check_export` | `read_source` 返回 `content` + `version`（内容哈希），并登记「本 Run 读过这一版」；`list_lang_keys` / `check_export` **草稿优先**，带 `draft` / `saved` 与 `localeExists` / `active` |
| lock | `lock_source` `unlock_source` `lock_lang` `unlock_lang` | 多路径原子；前置：本 Run 读过 + 版本一致（+ create 时路径不存在）；**不等待，拿不到立即失败**。锁**不看人类是否正在编辑**（D8）：人类未保存的编辑器缓冲算最新内容，读到了就能锁；读取后人类继续改导致版本变化 → `version_stale`。`lock_source` 只锁源文件，语言文本用 `lock_lang({ source, locales? })` 单独锁 |
| write | `create_source` `write_source` `edit_source` `write_lang` `delete_lang_keys` `parse_hs` `unparse_hs` | 必须先持锁；未持锁直接拒绝，错误里带 `lock_source` / `lock_lang` 下一步。agent **没有**改名/删除工具（结构操作只允许用户自己做） |

- 版本 = **内容哈希**（SHA-256）：改了又改回来不算冲突。
- lock 失败也回传 `currentVersion` / `currentContent`，让模型一次往返内自愈。
- `create_source` 的锁语义是「占住一个还不存在的名字」；`lock_source` **不再**展开派生语言资产。
- **写语言是两把锁**：`write_lang` / `delete_lang_keys` / `parse_hs` 需要源文件的锁 + 每个目标语言（`lock_lang`）的锁；
  `unparse_hs` 只改正文，只要源文件的锁。
- **写后哈希自更新**：write 成功即把「本 Run 读到的版本」更新为刚写出的内容哈希——
  agent 当然知道自己改完的文件长什么样，同一 Run 里再锁同一文件不会被判 `version_stale`，也不必重新读一遍。
- 锁的释放：**写成功不再释放**；持有到 `unlock_source` / `unlock_lang`、Run 结束或失败回滚。
- `unlock_*` 的 `held` 是**调用后本 Run 仍持有的全部路径**（含没在本次参数里出现的语言锁），不要拿它当"本次涉及的路径"。
- 人类侧：Agent 持锁的文件在编辑器里转只读（逐文件判断）；锁期间编辑器不自动成键。
- **输出语言（D5）**：工具返回 JSON 内的文本（`error` / `hint` / `notes` / `warnings` / 诊断消息 / `reason`）一律英文；
  工具描述、schema 描述、规则与界面文案保持中文；模型用中文向用户解释英文错误。

### 语言资产：和正文一样只写草稿

- `write_lang` / `delete_lang_keys` / `parse_hs` 的译文**只写本窗口草稿**：`transactions.stageWrite`
  （与编辑器语言暂存同一条通道）+ IndexedDB 镜像；`client.apply` 通道已删除。
  工具返回 `draft: true` / `saved: false` 表示"草稿已写、还没进工程文件"，要用户保存工程才落盘。
- 草稿的镜像写入会同步 `client.assetEpochs`（`putAssetBlob` 提升的缓存 epoch），
  避免 `setProjectSession` 把它误判成"用户未保存草稿"（P0 的假 dirty）。
- `list_lang_keys` / `check_export` **读草稿优先**（staged 文本），没有草稿才读工程文件；
  返回值带 `draft` / `saved`，agent 不能把"读到草稿"当成"已经保存"。
- **语言资产的锁是显式的**：`lock_source` 不再展开派生 `.lang`；写译文前用
  `lock_lang({ source, locales? })` 单独取锁（不存在的新语言文件按 creating 处理）。
  `write_lang` 写前逐个核对语言锁的版本 —— 外部改了 `.lang`、源文件版本却没变时，
  会以「language file changed after locking」拒绝，并提示重新 `lock_lang` + `list_lang_keys` 后重试。
  这是「源版本没变就以为没人动过」的防线。
- **programmatic 写入禁成键**：agent 写正文后，编辑器不会把这段内容自动成键成新的 `.lang` 草稿
  （内容级抑制：内容仍是 agent 写出的那一版时不触发成键），避免"写一次正文多一份语言草稿"。
- `check_export` 的预检会报告每种语言缺多少键（`warnings` + `missingTranslations`），
  不再让用户靠肉眼翻 `.lang` 文件；顶层 `warnings` 最多 200 条，超出时带 `truncated: true` 与 `warningTotal`。
  顶层只放**与当前工作区相关**的警告（缺译文 + orphan 资产/键），导出编译器的其余警告按
  `groups { translations, assets, gameplay }` 分组、英文输出，避免游戏性噪声淹没译文问题。
- **键稳定性与 orphan（D9）**：`parse_hs` 生成键时先复用「同文本已有的键」，不再因为 `.lang` 里有历史键
  而换新键——`unparse_hs → parse_hs` 往返拿回同一个键，其他语言译文不会丢。正文不再引用的历史键
  通过 `list_lang_keys.orphanKeys` 暴露，`delete_lang_keys` 可以删（它不要求键在正文里）；`check_export` 会统计 orphan。
- **参数与键校验（D6）**：`read_source` 的 `offset` / `limit` 必须是正整数（0/负数/小数直接报错，不带病调用）；
  `offset` 超过总行数返回 `offset out of range` + `totalLines`，不静默 clamp；`limit > 2000` 时截断并回 `limitClamped: true`。
  译文键必须是 8 位小写十六进制（自动成键的形态），大写/非法进 `invalidKeys`、同一次调用重复进 `duplicates`，
  **不再替模型做 trim/小写归一化**，有问题整次拒绝、不写草稿。
- **detached 资源**：`list_sources` 会给已被移出工程的文件标 `detached: true`；读写工具仍可读，
  但写（`write_source` / `edit_source`）一律拒绝并提示"请用户另存为新文件"。
- **跨包同名**：按逻辑名命中多个包时不再抛异常，返回结构化英文错误 + hint（用带目录的完整逻辑名消歧）。
- `validate_source` 在编辑器诊断之外**另跑 agent lint**（英文消息 + 行号）：非法角色名、全角冒号、
  对白文本里未转义的 `-`、对白块内的选项行、以及**形似键但格式不对**的片段（如大写 `7F3A91C`）；不改编辑器波形。
- **`changed` 用版本判断（D9）**：`write_source` / `edit_source` 的 `changed` 由"写后版本 ≠ 写前锁版本"得出，
  内容完全一致地重写会返回 `changed:false`（工具 JSON 同时给出 `version`，以版本为准）。
- **只读工具语义（D10）**：
  - `list_lang_keys.localeExists` = **该源文件在该语言下的 `.lang` 文件是否已存在**（`version !== null || saved`）；
    `localeInProject` 才表示"工程语言表里是否有该语言"。判断"已有译文"用 `version` / `saved`，不要用 `localeExists`。
  - 分页语义统一：`read_source` / `list_lang_keys` 的 offset 越界都返回 `ok:false` + `total`（`list_lang_keys` 为 `total`，`read_source` 为 `totalLines`），不静默返回空页。
  - `list_voice_status` 支持 `offset` / `limit`（默认 1/100，上限 500），返回 `total` / `missingCount` / `missingSample`（最多 10 条） / `truncated`，不再一次吐出全部 `entries` 与 `missing` 键名。
  - **未成键检测**：`list_lang_keys` 返回 `unparsedTextCount` + `unparsedSamples`；`validate_source` 会为未成键正文追加一条 agent-lint 汇总。
  - **错误码统一**：所有失败返回体带 `errorCode`（`not_found / not_unique / detached / not_read / version_stale / held / already_exists / invalid_arguments / invalid_keys / keys_not_in_source / keys_in_use / write_failed / host_error`），lock 另保留 `reason`；调用方按 `errorCode` 分支，不要做字符串匹配。
- **`delete_lang_keys` 零破坏（D10）**：默认拒绝删除正文仍在引用的键（`reason:'keys_in_use'` + `inUseKeys`），要删必须显式 `force:true`。
- **`version_stale` 只来自外部改动（C4）**：同一 Run 内写成功会刷新"本 Run 读到的版本"，因此同 Run 再锁不会 stale；
  只有人类或其它 Run 改了文件才会触发。
- **locale 以返回值为准（C1）**：请求的标签可能被归一化（`en` → `en_us`），`lock_lang` / `write_lang` / `parse_hs` 返回的 `locale` 才是工程实际标签。
- **锁期间不自动成键**：本 Run 持锁的文件，编辑器不会自动成键（解锁后也不补做），agent 改正文不会与自动成键抢键位。
- **逆解析必须同语言（C2）**：键名是文本哈希，`unparse_hs(locale)` 之后必须用**同一个 locale** 重新 `parse_hs`；
  跨语言逆解析会生成新键、旧键变孤儿并把错误文本灌进目标语言。`unparse_hs` / `parse_hs` 的成功返回带 `note` 提醒。
- **只读/写入语义补充（D11）**：
  - `unlock_lang` 省略 `locales` = 释放**本 Run 为该源文件持有的全部语言锁**（含工程语言表之外的手写 locale，如 `fr_fr`）；显式传 locales 只释放对应语言。`unlock_source` 同理只放本 Run 的源锁。
  - `lock_source` 在占名前先经 `validateSourceName` 校验逻辑名（非法名字直接 `invalid_arguments`，**不会白占名字**）；`create_source` 对非法名字同样返回 `invalid_arguments`。
  - `unparse_hs` 遇到**不能安全内联**的译文（含 `//`、选项文案/回复含 `:`、行首 `?`/`!`/`@`/`#`/`*`）不替换，返回 `unrepresentable`；`multiline` 与 `unrepresentable` 都带 hint 提示用 `edit_source` 处理。
  - `validate_source` 现在会校验 `:>>name` 的跳转目标是否存在（本文件 `@name` + 跨文件注入点），缺失报 `agent-lint: jump target not found: name`；诊断统一带 `line`（保留 `offset`）。
  - `write_lang` 对将来无法安全逆解析的译文给 `warnings`（`{locale,key,reasons}`，只警告不拒绝），避免把 `//`、`:`、行首结构字符写进语言文件。
  - `lock_source` 的 `already_exists` 失败体不再回传整篇 `currentContent`（只给 `currentVersion` + `contentOmitted:true`），减少长文件 payload。
  - `write_lang` 逐语言结果用 `fileTotal`（语言文件条目数，含 orphan），`list_lang_keys.total` 是正文键数；`list_lang_keys` 另有 `hasSaved` / `hasDraft` 自解释字段。
  - `check_export` / `list_sources` 返回 `includesDrafts: true`：它们按**工作区视角**统计，包含尚未保存的草稿。

## Run 生命周期

```
submit(input) → 多轮模型回合（工具调用）→ 最终答案 = 一个 Run
```

- 页面存活时**失败/中止** → 先**预演**有序操作日志（源文件 + 语言草稿），再决定：
  - 全部可安全恢复 → 自动逆序回滚；
  - 任一冲突（版本已变 / 人类正在编辑 / 没有写前快照 / 通道不可用）→ **一个文件都不动**，
    在失败记录旁挂「待处理回滚」，给三个选项：**让 Agent 帮忙处理冲突** / **强制回滚** / **放弃回滚**；
    回滚失败后还有「重试回滚」。
- 强制回滚会丢弃 agent 工作之后的编辑（界面二次确认）；放弃 = 丢弃日志、什么都不恢复。
- **保存 = 放弃回滚**：保存封段后待处理回滚自动消失，不弹提示。
- **只回滚工程文件/草稿，不回滚对话条目**：失败的 Run 在对话里留一条记录，用户能看到当时想做什么。
- 刷新 / 崩溃后：待处理回滚会从活跃段库（IndexedDB）恢复——预演已安全则直接自动回滚，否则挂回失败卡片。
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
     └ 成功 → 当前活跃段**封存**（sealed）：不再接受 Run，下次发送自动开新段
     └ 失败 → 不回滚文件；告警「文件已保存、对话未落盘」，下次保存补写
```

## 活跃段与归档段

- **活跃段**：窗口内可继续的对话，可跑 Run、可多次保存直到封存；
  可以新建、切换、**删除**（删除会连同该段对话一起消失，不可恢复；归档段库不受影响）。
- **保存即封段（D4）**：保存产出归档后当前段置为 `sealed`，面板显示「已封存」；
  发送消息会自动开一个新的活跃段（不会立刻建空段）。封存段仍可查看历史，但不能再跑 Run。
- **待处理回滚会在活跃段内持久化**（IndexedDB `hanshu.agent.undo.<scope>`）：
  刷新/重开面板后仍能强制/放弃/重试；打开时若预演已安全则直接回滚并清日志，否则挂回失败卡片。
  保存封段 / 切段 / 删段 / 放弃 / 强制成功都会清掉持久化日志。
- **归档段**：不可变，按工程 scope 存归档段库，同工程所有窗口可读。
  归档记录带**简化日志**：`filesChanged`、`rolledBack`、以及只含哈希的
  `rollbackLog[{path, beforeHash, afterHash}]` —— **不存正文/资产，不提供回滚入口**。
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
node scripts/run-verification.mjs scripts/verify-agent-store.ts    # 版本/锁/撤销日志/归档段库/windowId（28 项）
node scripts/run-verification.mjs scripts/verify-agent-undo.ts     # 有序操作日志：预演/冲突/force/语言回放/restore（17 项）
node scripts/run-verification.mjs scripts/verify-agent-undo-journal.ts # 待处理回滚持久化：roundtrip/体积保护/key（9 项）
node scripts/run-verification.mjs scripts/verify-agent-rollback-ui.ts # 失败卡片三选项（SSR：按钮、禁用、动作映射）
node scripts/run-verification.mjs scripts/verify-agent-segment-ui.ts  # 封段提示/段状态/归档简化日志（SSR）
node scripts/run-verification.mjs scripts/verify-agent-tools.ts    # 三语义派发/严格模式/参数与键校验/无中文输出/errorCode（33 项）
node scripts/run-verification.mjs scripts/verify-agent-ops.ts      # 分页边界、agent lint（含跳转目标/未成键）、反解析安全、键复用/orphan、导出 warning 映射
node scripts/run-verification.mjs scripts/verify-agent-arbiter.ts  # 两把锁、写后锁仍在、未锁拒绝、撤销回放、offset 越界、heldPaths（24 项）
node scripts/run-verification.mjs scripts/verify-hanshu-text-safety.ts # 底层语法：安全内联判定、注入点/跳转引用扫描（7 项）
node scripts/run-verification.mjs scripts/verify-agent-panel.ts    # 视图派生/阈值/掩码
node scripts/run-verification.mjs scripts/verify-agent-config.ts   # 两档模型、模型 id 校验
node scripts/run-verification.mjs scripts/verify-agent-runtime.ts  # 真 Harness 闭环（MemoryStorage + faux 模型，5 项）
node scripts/verify-agent-segment-purge.mjs                        # 删除活跃段（真实浏览器 IndexedDB，Playwright）
node scripts/verify-agent-archive.mjs                              # 归档段打开/继承/级联删除（真实浏览器 + 真 Harness，不调模型）
node scripts/run-verification.mjs scripts/verify-agent-lang-lock.ts # 语言锁（lock_lang/unlock_lang）/外部回写拦截/导出译文预检（14 项）
node scripts/run-verification.mjs scripts/verify-agent-lang-draft.ts # 语言草稿：草稿优先读、assetEpochs 同步、localOnly 分支、镜像失败撤销
node scripts/run-verification.mjs scripts/verify-agent-lock-targets.ts # 锁目标映射：源锁/语言锁只读分离、成键抑制、路径归一
node scripts/run-verification.mjs scripts/verify-agent-lock-ui.ts    # 锁状态驱动资源树按钮 + AssetPreview 只读（SSR）
```

`run-verification.mjs` 支持一次传多个脚本：`node scripts/run-verification.mjs scripts/verify-a.ts scripts/verify-b.ts`。

`verify-agent-runtime.ts` 走的是与生产同一套 Harness / Conversation / defineTool 代码路径：
Run 作答、工具回合、刷新后可续、中止结算、失败不重试，全部不联网。

## 已知偏差与取舍

1. **锁的持有上限是「一次 Run」**：pi-durable 没有暴露「回合边界」回调，
   `lock_source` / `lock_lang` 拿到的锁会一直持有到本 Run 结束（人类在这些文件上一直只读），
   除非 agent 主动 `unlock_source` / `unlock_lang`。写成功**不会**释放锁。
2. **语言锁是显式的，不覆盖配音二进制**：`lock_source` 不展开派生 `.lang`，语言用 `lock_lang` 单独锁
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
