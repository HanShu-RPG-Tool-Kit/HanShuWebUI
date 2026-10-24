# 礼包引擎发放契约 V1

| 项 | 值 |
| --- | --- |
| 标识 | `hanshu.kit.runtime` |
| 版本 | **1**（与 [表达式标准 V1](#kit-expr) 配套） |
| 适用 | 游戏引擎领取 / 发放 `.kit` |
| 编辑器 | 不执行本契约；只预览与校验 |

本文规定：**谁调用、注入什么、按什么顺序发放、失败怎么办**。数值求值仍以 [hanshu.kit.expr](#kit-expr) 为准；作者用法见 [礼包指南](#kit-guide)。

> 礼包本身**无状态**：不记冷却、不记「已领」。冷却 / 每日 / 只领一次由调用方（进度、指令、商店等）负责。

## 1. 一句话

调用方在**服务端主线程**一次 `grant`，传入**一名或多名**在线玩家：引擎展开礼包一次 → 按玩家列表发放（自动填分配超参数）→ 汇总报告。

## 2. 调用面

概念 API（语言无关；Mod 侧名称可不同，语义须一致）：

```text
grant(
  players,                # 领取目标，非空；单人就传一人的列表 / 重载
  kitId,                  # 礼包引用，与资源文件名去 .kit 后一致
  params? = {},           # 超参数覆盖；未给出的用声明 default
  options? = {}
) → GrantReport
```

| `options` | 默认 | 含义 |
| --- | --- | --- |
| `dryRun` | `false` | 只求值 / 校验，不改玩家状态、不跑指令与脚本 |
| `rngSeed` | 引擎自选 | 随机池用；同 seed 应得到相同抽取（便于测试） |

- `players` 去重规则由实现自定，但**顺序稳定**（决定 `distributionId`）。
- 列表中离线 / 无效项：跳过并记错误，其余继续；若过滤后为空 → 整次失败。
- `GrantReport` 至少包含：整体结果、按玩家细分结果、警告 / 错误（含 [表达式错误类别](#kit-expr) 与本节类别）。

**不在本契约内**：按 `tags` 批量发放的调度器、权限节点、GUI 领取页。引擎须提供按 id 领取，以及按 tag **查询**礼包 id 列表（只读）：

```text
listByTag(tag) → [kitId, …]
```

## 3. 超参数注入

1. 先按 [继承与组合](#kit-guide) 展开得到有效 `params` / `modifiers` / 条目（深度上限与编辑器一致：**8**；成环则整次 `grant` 失败，不发放）。
2. 对每个有效超参数：`params` 覆盖 → 否则 `default`。覆盖值无法按声明类型解释时**回落 default**，并记一条警告（与表达式标准第 6 节一致）。
3. 默认四参语义（可删改声明，但调用方若依赖须自行保证存在）：

| id | 约定 |
| --- | --- |
| `intensity` | 奖励强度 |
| `difficulty` | 难度 |
| `distributionCount` | 本次分配人数（≥1） |
| `distributionId` | 当前玩家序号，`0 … distributionCount-1` |

**多人一次 `grant` 时的分配参数**（在调用方 `params` 之后叠加，**引擎写入优先于 default，但不覆盖调用方已显式传入的同名键**）：

| 情况 | 引擎行为 |
| --- | --- |
| 调用方未传 `distributionCount` | 对每位领取者注入 `distributionCount = len(players)`（过滤后） |
| 调用方未传 `distributionId` | 对第 `i` 位（0 起）注入 `distributionId = i` |
| 调用方已传上述任一键 | 尊重调用方；此时多人列表仍逐人发放，但分配公式完全由调用方负责 |

单人 `grant` 且未传分配键时：`distributionCount = 1`，`distributionId = 0`。

## 4. 发放流水线

引擎在服务端主线程同步执行整个流水线。脚本为可信服务器代码；作者自行负责耗时、线程调度和副作用。阻塞脚本会阻塞服务器，不设强制超时。

**共享一次**：步骤 1（展开）。  
**对每位领取者依次**跑步骤 2–8（该玩家自己的超参数视图，含上节的 `distributionId`）：

```text
1. 展开 + 准备修饰器环境（一次）
2. 按该玩家超参数绑定求值（expr）
3. 固定物品 items
4. 随机池 pools（按 rolls / weight；每位玩家独立抽，除非实现文档另述）
5. 药水效果 effects
6. 经验 experience
7. 指令 commands（插值后）
8. 内联脚本 script
9. 反馈 feedback
```

说明：

- **3–6** 使用该玩家视图下的最终整数（[表达式标准第 9 节](#kit-expr)）。平分类修饰器依赖 `distributionCount` / `distributionId`，因此必须**按人求值**。
- **7** 在脚本之前。
- **9** 尽量执行：该玩家前面有非致命警告时仍应尝试反馈；展开失败或 `dryRun` 时跳过。

### 4.1 物品与链接

- 内嵌堆：按 `id` + `components` + 最终 `count` 构造。
- `item` 链接：调用当前服务端的 `ItemTemplates` API 创建 `.it` 模板实例，保留模板绑定并正常参与后续同步；**找不到引用 → 该条跳过 + 错误**，不中止该玩家其余步骤，也不中止其他玩家。
- `count ≤ 0`：不给予。
- **背包满**：剩余堆在该玩家脚下落地（与原版 `give` 接近）；记警告，不视为整次失败。

### 4.2 随机池

- 每位玩家按最终 `rolls` 独立抽取；权重 ≤0 的分组不参与。Mod 按稳定目标顺序从总种子为每位玩家派生独立随机流，脚本消耗 random() 不影响其他玩家的随机池。
- 池内物品同样走 4.1。

### 4.3 效果与经验

- 效果：`amplifier` / `duration` 按字段规则；`duration == 0` 表示无限，不经修饰器。
- 经验：`kind = points | levels` 对应原版加点 / 加等级。

### 4.4 指令

- 插值规则见 [表达式标准第 11 节](#kit-expr)；**含插值错误的行不执行**，记错误，继续下一行。
- 执行身份：**服务端**，`CommandSourceStack` 的实体 / 玩家为**当前**领取者，使 `@s` 指向该玩家。权限按控制台级；不要用「玩家本人权限」静默失败。
- 每位玩家整表指令各跑一遍。

### 4.5 反馈

- `message` / `title` / `subtitle`：按礼包本地化键解析后发给**当前**玩家（空串跳过）。
- `sound`：非空则对该玩家播放；无效 id 记警告。

## 5. 脚本注入

内联 `script` 为 Python。引擎在**独立**全局字典中执行，仅注入下表。

每位领取者各执行一遍脚本（与流水线一致）；同一 `grant` 内后一名玩家看到前一名已造成的世界副作用。

### 5.1 全局名

| 名字 | 可变 | 含义 |
| --- | --- | --- |
| `kit` | 否 | 本礼包求值句柄（见 5.2）；数值已按**当前玩家**超参数视图绑定 |
| `player` | 否 | **当前**领取者，裸 `net.minecraft.server.level.ServerPlayer`（见 5.3） |
| `players` | 否 | 本次 `grant` 的领取者列表（同序），元素同为裸 `ServerPlayer` |
| `random` | 否 | 可调用的 `random()`，返回 `[0, 1)` 浮点随机；与池子共用本次种子派生的流 |

引擎不额外注入其它服务端单例、文件系统或网络门面；这不构成访问限制，可信脚本可以正常 import，或通过裸游戏对象调用服务端 API。

### 5.2 `kit`

| 接口 | 返回 | 说明 |
| --- | --- | --- |
| `kit.param(id)` | 按声明类型的 `float`/`int`/`bool`/`str` | 未知 id → 异常 `name` |
| `kit.mod(id, x)` | `float` | 应用修饰器；不做字段取整；失败抛表达式类别异常 |
| `kit.expr(src)` | `float` | 独立表达式（不可用 `x`） |
| `kit.id` | `str` | 当前礼包引用 |
| `kit.tags` | `tuple[str, …]` | 展开后的有效标签 |

### 5.3 `player`（裸游戏对象）

`player` **不是**包装类型。在当代未混淆的服务端映射下，脚本拿到的就是真实的 `ServerPlayer`（GraalPy / 同类宿主的 Java 对象互操作）。

- 可用该类型及通过它到达的公共 API（背包、发消息、传送等），与 Java 插件相同。
- 引擎**不**再提供 `player.give` / `player.message` 一类门面。
- 作者自行承担版本 API 差异；帮助与示例按当前目标 MC / NeoForge 编写。

```python
from net.minecraft.network.chat import Component
from net.minecraft.world.item import ItemStack
from net.minecraft.core.registries import BuiltInRegistries
from net.minecraft.resources import Identifier

bonus = int(round(kit.mod("loot", 3)))
if kit.param("difficulty") >= 2:
    item = BuiltInRegistries.ITEM.getValue(Identifier.parse("minecraft:diamond"))
    player.getInventory().add(ItemStack(item, max(1, bonus)))
    player.sendSystemMessage(Component.literal("高难度额外奖励"))
```

信任模型：

- PAK 脚本视为可信服务器程序，与服务端 Java 代码同等级；相信作者知道自己在做什么。
- 不设置 import 白名单、沙箱、执行预算或强制超时；可正常导入 Python 模块和游戏 Java 类。
- 入口在服务端主线程；长时间运行会阻塞服务器。作者自行安排异步工作，并负责把游戏状态修改调度回正确线程。

### 5.4 脚本失败

- 未捕获异常 → 记在**当前玩家**结果上，**跳过该玩家后续步骤**（含 feedback）；**不回滚**已发放内容；**继续下一名玩家**。
- `kit.*` 出错抛异常，信息带 [表达式错误类别](#kit-expr)。

## 6. 失败语义汇总

| 情况 | 行为 |
| --- | --- |
| 未知 `kitId` / 展开成环 / 深度超限 / 无有效玩家 | 整次失败，零发放 |
| 单条物品解析失败、插值失败、无效音效 | 跳过该项，继续该玩家与其余玩家 |
| 背包满 | 落地；警告 |
| 某玩家脚本异常 | 不回滚；跳过该玩家后续；继续其他人 |
| `dryRun` | 无世界副作用；仍可做展开与 expr 校验 |

整体成功：没有「整次失败」类错误即可；允许 `ok_with_warnings` 或部分玩家失败（报告须可区分）。

## 7. 与编辑器预览的关系

| | WebUI 编译结果 | 引擎 `grant` |
| --- | --- | --- |
| 超参数 | 用「预览值」 | 用调用方 `params` + default + 分配键规则 |
| 随机池 | 可模拟 | 真实 rng（或 `rngSeed`）；按人独立抽 |
| 指令 / 脚本 | 不执行 | 按人执行 |
| 反馈 | 不播放 | 按人发给玩家 |

数值字段在两边必须用同一套 expr 规则，否则算实现 bug。

## 8. 版本

- 本文为 V1 发放契约：Java 方法名可以不同，但下列语义不应静默偏离——多人一次 `grant`、按人流水线、`player` 为裸 `ServerPlayer`、不回滚、无礼包内状态；若偏离须升版并改本文。
- 后续增量（共享一次随机池、可选沙箱限制等）不得改变 V1 已规定的成功路径结果。

## 9. Mod 内置门户

`/rt` 与 `/rpgtoolkit` 等价，标准门户需要管理员权限：

```text
/rt kit
/rt kit view [关键词]
/rt kit list [关键词]
/rt kit info <id>
/rt kit give <id> [players] [request]
/rt kit preview <id> [players] [request]
```

`players` 为原版在线玩家选择器，省略时为自己；控制台需明确指定目标。`request` 是一个 JSON 对象，支持 `params` 与 `options`，两者都可省略。传请求对象时需明确写出目标，例如：

```text
/rt kit give starter @s {"params":{"difficulty":2},"options":{"dryRun":true,"rngSeed":42}}
/rt kit give team_reward @a {"options":{"rngSeed":42}}
```

`preview` 强制 `dryRun=true`，不能被请求里的 false 关闭。种子为有符号 64 位整数；不传时自动生成并在报告中返回。多人选择器作为一次 grant 处理，重复 UUID 保留第一次出现的玩家。

箱子界面使用服务端 ChestGui：可搜索、翻页、查看默认参数下的奖励，再明确点击“发放给自己”。详情随机池为 seed=0 的模拟；实际领取重新抽取。预览不会执行指令、脚本和反馈，也不会发放任何东西。
