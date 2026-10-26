# 多进度任务（树图）模型

本文描述游戏性工作区中**多进度**作者态的模型语义：一层节点、信号方向、以及与引擎的边界。文件为 **`.quest`**（`format: "hanshu.progress-tree"`）。单进度表单见 [任务文档](#progress-document)；节点、端口、信号的逐项实现参考见 [多进度节点图](#progress-node-graph)；画布操作用法见 [游戏性工作区](#gameplay-workspace)。

## 1. 模型定位

| 层 | 职责 |
|----|------|
| **进度图** | 进度节点（阶段）+ 变迁 + 谓词 + 结束；文档 `hanshu.progress-tree` v1 |
| **运行时** | A（顺流激活）/ Q（逆流查询）/ C（逆流取消）/ N（否定应答）；进度是唯一有持久状态的节点 |
| **校验** | 端口、连线、目标结构；画布成环仅 warning |

进度节点是**唯一**同时拥有状态与内容的东西：它将来承载内嵌的 goal 元素（`goals[]` + `completion`），当前先由信号模拟器手动结算。变迁只做「等条件、放行、消费输入」，谓词只回答查询，结束节点锁存 quest 唯一终局并终止传播，剩余队列不再投递。

## 2. 文档结构（摘要）

```json
{
  "format": "hanshu.progress-tree",
  "version": 1,
  "id": "a-stable-document-id",
  "start": "progress_start",
  "progress": {
    "progress_start": {
      "title": { "text": "progress.progress_start.title" },
      "questTitle": { "text": "progress.progress_start.questTitle" },
      "description": { "text": "progress.progress_start.description" },
      "runningLog": { "text": "progress.progress_start.runningLog" },
      "completedLog": { "text": "progress.progress_start.completedLog" },
      "goals": [],
      "completion": "all"
    }
  },
  "predicates": {},
  "transitions": {},
  "ends": {},
  "logic": { "links": [] },
  "layout": { "positions": {}, "notes": {}, "groups": {} }
}
```

解析只接受当前结构：旧集合 `entry` / `nodes` / `goals` / `conditionals` / `diffs` / `merges` / `swaps`、根级 `name` / `description` / `title` / `kind`、变迁节点带内容，一律视为非法，不做迁移。

## 3. 节点语义

| 节点 | 内容与语义 |
|---|---|
| **开始进度** | 唯一；没有左端口，任务开始时直接进入运行中；有两个右端口（成功 / 失败）；承载 `questTitle` 与 `description` |
| **进度** | 阶段。`title` / `runningLog` / `completedLog` / `goals` / `completion`（含 `custom`）；A 进入 → 运行中并向左端口发 C（消费输入）；结算 → 已成功 / 已失败并按端口发 A；Q 按结局回报 A / N；C 在运行中使其已取消、未激活时向上游转发 |
| **谓词** | 无左端口；`conditions` 组内取「与」，**空条件恒假**；为真发 A；Q 回 A / N；C 忽略 |
| **变迁** | 左端口分「合取」（全部 A）与「析取」（任一 A）；收到 A 开一轮 Q；非空端口都满足才放行，并向输入发 C（消费） |
| **结束** | 成功入 / 失败入；进入即记录任务终局；`title` 与 `rewardKits`；可以有多个 |

状态只存在于模拟器：进度五态，变迁只有一轮查询的临时簿记。

**连接约束只有一条**：右端口 → 左端口，且不能成环（含自环）。与开始进度节点**联通**（连线视为无向）的节点是生效节点，其余是草稿节点。

**编辑**：双击节点在画布上打开表单视图（每个节点最多一张，会话内有效），不再使用模态弹窗。

## 4. 设计取舍

- **成功与失败是端口，不是第三种信号**：边从哪个口离开就代表哪种结局，画布上直接可见。
- **Q 让边成为电平触发**：新激活的变迁可以追问已有节点，读到「已经成功过」的事实；没有 Q，只能等边沿。
- **C 逆流 = 消费/互斥**：变迁放行时、进度被激活时都会向自己的输入端口发 C——「这个消费者不要你了」。仍在运行的上游会被取消，已结算 / 已取消的忽略；同一端口多候选上游时先到者赢。
- **变迁放行后重复收到 A 不会重复推进**：下游进度只接受未激活时的 A，天然幂等；真相机里这是「消费一次」。
- **旧模型的差分变迁、合并变迁、交换变迁不再需要**：差分被进度的双出口取代，合并被合取 / 析取端口取代，交换被「放行即取消其余输入」取代。
- **谓词无状态、全局监听**：谓词是事实源而不是可开关的节点。事实在**实例初始化**（首次接取 / load）时整体播报一次已为真者，之后只在 假→真 的上升沿增量广播；Q 永远按当前真值回答，所以晚到的消费者不会漏掉事实。代价是事实可能“提前成立并提前触发”，这是作者用法问题，不靠状态解决。
- **跨任务依赖**：谓词条件可以引用别的任务状态，引擎必须在所有实例状态加载完之后再统一初始化并广播。
- **传播是 FIFO 队列**：每个投递立刻完成自己的状态变化，产生的信号追加到队尾；端口的持久 `order` / `reverseOrder` 与外部结算顺序参与结果；数组重排不影响运行。具体规则见[多进度节点图](#progress-node-graph)的「信号处理顺序」。

## 5. 表达能力的当前边界

已具备：链式推进、成败分叉、合取门（全部满足）、析取门（任一满足）、谓词门、汇合后再放行、互斥（先到者取消其余）、任务成功 / 失败终局。

尚未接入：进度内的 goal 自动判定与 `completion` 策略、谓词表达式、外部激活（对话 / 事件 key）、竞速裁决、多令牌实例身份、导出时剥离 `layout`。

## 6. 相关代码

- 结构与校验：`src/workspaces/gameplay/model.ts`
- 信号与模拟器：`src/workspaces/gameplay/signals.ts`
- 画布创建与布局：`src/workspaces/gameplay/canvas.ts`
- 回归：`npm run test:progress`（`scripts/verify-progress-model.ts`）

多进度画布使用 React Flow 上的 HanShu 通用节点编辑器；适配器位于 `quest/graphAdapter.ts`，框选、连线、小刀、Group、注释及排版共用 `src/nodeEditor/`。新增编辑器遵循[通用节点编辑器接入规范](#node-editor)，不得复制原来的手写画布。


模拟器支持待投递队列、逐条单步、播放/暂停、速度与沿线动画。终局 first-wins 并清空队列；预算故障回退整次事件。完整排序、规模限制与故障约定见[多进度节点图](#progress-node-graph)。
