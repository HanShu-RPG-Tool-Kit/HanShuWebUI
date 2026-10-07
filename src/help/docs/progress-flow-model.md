# 进度流程模型说明

本文描述 HanShu 进度流程工作区**当前**的画布模型与信号运行时（以 `src/workspaces/progress/model.ts`、`signals.ts` 为准）。集线器 / 网关 / 合取·析取节点 / checkpoint 树时代字段已移除。画布操作用法见 [进度工作区](#progress-workspace)。

## 1. 模型定位

| 层 | 职责 |
|----|------|
| **作者图** | 节点 + 类型化端口连线；文档 `hanshu.progress-tree` v1 |
| **运行时** | 信号沿导线传播；checkpoint / Goal / Predicate 的状态机 |
| **校验** | 端口基数、引用完整性；画布连线成环仅 **warning** |

Checkpoint **之间不能直连**，推进必须经「变迁」类节点。**开始节点（entry）** 是唯一信号源，并承载整张图的名称 / 说明；文档根 `id` 是可修改的稳定文档身份（与资源文件名分开），协议字段另见下文。

## 2. 文档结构（摘要）

```json
{
  "format": "hanshu.progress-tree",
  "version": 1,
  "id": "a-stable-document-id",
  "entry": {
    "id": "entry",
    "target": "start",
    "title": { "text": "驿站的约定" },
    "description": { "text": "设计这段内容的推进过程。" }
  },
  "nodes": {
    "start": {
      "title": { "text": "收到邀请" },
      "description": { "text": "" }
    }
  },
  "ends": { "finish": {} },
  "logic": { "links": [] },
  "goals": {},
  "predicates": {},
  "transitions": {},
  "conditionals": {},
  "diffs": {},
  "merges": {},
  "swaps": {},
  "layout": { "positions": {}, "notes": {}, "groups": {} }
}
```

解析只接受当前结构：标题与说明必须写在 `entry`；`FlowText` 仅含 `{ text }`（无本地化 `key`）。根级 `title` / `description` / `kind`、`hubs` / `gateways`、`entry.kind`、`logic.nodes`，以及 checkpoint 上的 `completion` / `children` / `branching` / `onEnter` / `onFinish` / `rewards` 均视为非法，不做迁移。流程结束用 `ends` 节点表达，不再用 checkpoint 的 `completion: finish`。

## 3. 节点一览

### 3.1 状态节点

| 节点 | 文档键 | 状态 | 角色 |
|------|--------|------|------|
| **开始** | `entry` | （信号源，无 ckpt 态） | 图标题/说明 + 唯一 S 出；`target` 接一条 checkpoint |
| **Checkpoint** | `nodes` | 未激活 → 活跃中 → 已激活；或 → 已取消 | 阶段落点；入点收 **S**，出点可发 **A** |
| **结束** | `ends` | （无运行时态） | 流程终点；仅 **input**，自 checkpoint **激活出** 可多线汇入 |
| **Goal** | `goals` | 未激活 → 订阅中 → 已关闭 | 可人工完成的目标；订阅中发 **G** / **G-Y** / **G-N** |
| **Predicate** | `predicates` | 同 Goal | 条件谓词；订阅中发 **P** |

Goal / Predicate 的 `kind`（人工、计数、信号、等待阶段、外部）是**设计意图字段**，当前模拟器不解释具体条件，只模拟订阅 / 完成 / 关闭。

### 3.2 变迁与结构节点

| 节点 | 文档键 | 端口拓扑（入 → 出） |
|------|--------|---------------------|
| **线性变迁** | `transitions` | Goal（多，合取）+ Parent（1）→ Next（1） |
| **条件变迁** | `conditionals` | Predicate（1）+ Parent（1）→ Next（1） |
| **差分变迁** | `diffs` | Goal（1）+ Parent（1）→ 成功 / 失败（各 1） |
| **合并变迁** | `merges` | A 入（多）→ Next（1） |
| **交换变迁** | `swaps` | 每槽 inN（1）↔ outN（1）；末槽用尽自动扩容 |

## 4. 信号与状态

### 4.1 信号表

| 记号 | 种类 | 典型含义 |
|------|------|----------|
| **S** | `ckpt-transition` | 携带「原状态 → 新状态」，仅当与 ckpt 当前信念一致才接受 |
| **A** | `activation` | 激活 / 订阅（变迁 → Goal·Predicate；ckpt 出点 → 下游） |
| **G** | `goal-complete` | Goal 完成（线性合取） |
| **G-Y / G-N** | `goal-yes` / `goal-no` | 差分成功 / 失败 |
| **P** | `predicate-complete` | 谓词成立 |
| **D** | `cancel` | 关闭 Goal / Predicate |
| **C / C-R** | `query` / `query-response` | 「是否已关闭/已激活」询问与回报 |
| **S-C** | `cancel-cascade` | 取消级联（回灌上游） |
| **G-C** | `goal-cancel-cascade` | 活跃 ckpt 被取消后，通知变迁关掉 Goal/Predicate |

### 4.2 Checkpoint 与 S-C

- 进入 **已激活**：从 S **入点**发出 **S-C**（并可由出点发 **A**）。
- **入点**收 S-C：不转发；若当前为活跃中 → 已取消，并发 **G-C**；未激活则只吞掉。
- **出点**回灌 S-C：活跃中 → 已取消 + G-C；**未激活只转发、不改自身状态**。

### 4.3 变迁语义摘要

**线性变迁**

1. Parent 收 **A** → Next 发 S(未激活→活跃中)，向全部 Goal 发 **A**；无 Goal 则直接再发 S(活跃中→已激活)。
2. 某 Goal 发 **G** → 对该 Goal 回 **D**，向全部 Goal 发 **C**；均已关闭并回报 **C-R** 后 Next 发 S(活跃中→已激活)。
3. Next 回灌 S-C → Parent；回灌 G-C → 全部 Goal 发 **D**。

**条件变迁**（同线性，但单 Predicate）

1. Parent **A** → Next S(未激活→活跃中) + Predicate **A**；无谓词则直接完成。
2. **P** → 对该谓词 **D**，Next S(活跃中→已激活)。
3. S-C / G-C 转发规则同线性（G-C → Predicate **D**）。

**差分变迁**

1. Parent **A** → 成功口 S(未激活→活跃中) + Goal **A**。
2. **G-Y** → 成功口 S(活跃中→已激活)。
3. **G-N** → 成功口 **S-C**，失败口 S(未激活→已激活)。
4. 成功/失败口回灌 S-C → Parent + Goal **D**。

**合并变迁**

1. 任一条入线 **A** → Next S(未激活→活跃中)，并向全部入线上游发 **C**。
2. 全部回报 **C-R**（上游须为已激活 ckpt）→ Next S(活跃中→已激活)。
3. Next 回灌 S-C → 全部 A 来源。

**交换变迁**

1. 某槽收 **A** → 同槽 out 发 S(未激活→已激活)；其余槽 **入点**发 **S-C**。
2. 某 out 回灌 S-C → 同槽入点回灌。

**起点**：Ctrl 触发发出 S(未激活→已激活) 到唯一出口。

## 5. 结构约束

- Checkpoint 禁止直连；入口 / Parent / Next / 差分双出 / 交换槽等多处为**单线替换**。
- Goal / Predicate 出口单线；线性 Goal 口允许多线合取；条件 Predicate 口与差分 Goal 口均为单线。
- 画布有向边 = `entry.target` + `logic.links`。成环只警告，不阻断编辑（弹窗 + 校验栏）。

## 6. 表达能力分析

### 6.1 已具备的组合能力

| 模式 | 如何表达 | 说明 |
|------|----------|------|
| **顺序推进** | ckpt → 线性/条件 → ckpt | 基本流水线 |
| **多目标同时成立** | 线性变迁多 Goal + G 合取（C/C-R） | 「几件事都做完才过」 |
| **谓词门闩** | 条件变迁 + Predicate | 「条件成立才过」；单谓词 |
| **成败分叉** | 差分变迁 | 同一父阶段拆成功/失败后继 |
| **多路汇合** | 合并变迁 | 「几条线都已激活才继续」 |
| **互斥切换** | 交换变迁 | 选中一路完成，其余路上游被 S-C |
| **并行扇出** | 已激活 ckpt 多出线发 A | 需作者自行控汇合 |
| **取消传播** | S-C / G-C / D | 活跃路径可被上游取消并关掉目标 |
| **空合取/空谓词** | 无 Goal / 无 Predicate 的线性或条件 | Parent A 后直接完成 |

### 6.2 覆盖与缺口

- **线性任务链 / AND 汇合 / 差分成败 / 交换互斥**：强覆盖。
- **无通用布尔组合、无保留式 OR、无内建重试/子流程**：复杂条件拆阶段，或留到引擎解释 `kind`。
- **可恢复性**：稳态节点信念可快照；扇出中途中断靠引擎约定（排空再存档 / 重建 C 轮）。

### 6.3 小结

当前模型适合描述：**阶段图 + 目标/谓词门闩 + 成败分叉 + 多路汇合/互斥切换 + 取消级联** 的叙事/任务进度。逻辑组合被专门化进变迁；元数据集中在开始节点，checkpoint 只保留阶段内容。

## 7. 相关代码

- 结构与连线：`src/workspaces/progress/model.ts`
- 信号与模拟：`src/workspaces/progress/signals.ts`
- 画布创建：`src/workspaces/progress/canvas.ts`
- 回归：`npm run test:progress`（`scripts/verify-progress-model.ts`）
