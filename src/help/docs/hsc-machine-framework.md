# HSC 机器实现框架（标准参考）

本文是 [抽象汉书自动机](#hsc-machine) 之上的**实现分层参考**：如何把步进语义做成可扩展的「机器类型」，并**可以实例化**出运行中的会话。

- **规范到哪为止**：Program 装载、Machine Type（模板）、`spawn` → Machine Instance、标准钩子与能力/拒绝。  
- **不规范**：实例如何分配给玩家/房间/线程、对象池、网络权威、存档。  
- **不做**：持久化。标准**不**要求 `serialize` / `deserialize` / 定时 `tick`；机器状态视为**会话内、不可作为存档契约**。

语言/引擎可用类、接口或组合实现；名称可改，**角色与边界**应对齐本文。

---

## 1. 三层对象

| 层 | 角色 | 持有什么 |
|----|------|----------|
| **Program** | 不可变剧本 IR（通常来自 `.hsc`） | 语句序列；可供多 Type/多 Instance **只读共享** |
| **Machine Type（模板）** | 「这类会话怎么跑」 | 钩子、能力声明、`accept` 规则；**不**持有 PC / 玩家状态 |
| **Machine Instance（实例）** | 一次正在跑的会话 | PC、选项树会话、注入的 Driver/View/Context |

关系（示意）：

```text
Program ──load/accept──► Machine Type ──spawn(ctx)──► Machine Instance
                              ▲
                              │ 可选：compose(Feature…)
```

汉书格式本身由超类（基座 Type）约定：**凡合规 Program 都具备装载能力**（能解析进内部表示）。  
具体 Type 可在装载后 **Reject** 某些文件（缺入口、不支持的信号等）——「装得进」≠「这台机器愿意跑」。

---

## 2. 超类（基座 Machine Type）

建议概念名：`HscMachine` / `AbstractHscRuntime`（仅参考）。

基座负责：

1. **解析 / 装载**合规 `.hsc`（或等价序列）→ 内部 Program 视图。  
2. **步进**符合 [抽象汉书自动机](#hsc-machine)（线性规则、选项树、信号契约、系统返回等）。  
3. 提供 **钩子空实现**（见 §4）；子类或 Feature 只覆盖需要的点。  
4. 提供 **`spawn(context) → Instance`**：标准只要求「能实例化」，不规定 context 里必须有哪些键。

基座**不**规定：多人如何分 Instance、Instance 挂在哪个系统对象上。

---

## 3. 装载与拒绝

```text
load(program) → Accept(readyTypeView) | Reject(code, message?)
```

| 结果 | 含义 |
|------|------|
| **Accept** | 本 Type 愿意用该 Program 做后续 `spawn` |
| **Reject** | 解析可能已成功，但本 Type 拒绝运行（能力不符、缺 `@entry` 等） |

建议（参考，非强制枚举）：

- 基座：语法/结构合法 → 至少完成解析；若基座本身无额外能力限制，则 Accept。  
- 具体 Type：再跑 `accept(program)`（入口名、信号白名单、最大选项深度等）。  
- Reject 应有稳定 **code**，便于工具与日志；不要静默当空程序跑。

非法 / 不合语法的文本：与抽象机一致——**不约定**运行时行为，应在进 `load` 前被编译或校验拦住。

---

## 4. 标准钩子表（参考）

钩子在 **Type** 上定义，由 **Instance** 在步进时调用。  
默认行为 = 抽象机纯语义（钩子不改控制流）。

| 钩子 | 典型时机 | 可否改变抽象机控制流 |
|------|----------|----------------------|
| `onLoad` / `onReject` | 装载结果 | 否（仅通知） |
| `onEnter` | Instance 开始跑（入口 PC 已定） | 否 |
| `onHalt` | 遇到 `@@` 或会话结束 | 否 |
| `beforeLine` / `afterLine` | 线性扫描每条语句前后 | **否**（观察/伴随；改 PC 视为不符合本参考） |
| `onDialogue` | 执行对白 | 否（呈现由 View；文本已由机器选定） |
| `beforeSignal` | 调用 `?` / `!` / `!:` / `:!` 之前 | 可 **deny** 本次调用（参考：denied 的 `?` 视为假；`!` 族跳过调用） |
| `afterSignal` | 驱动器返回之后 | 否 |
| `onChoiceTreeEnter` / `onChoiceTreeExit` | 进入 / 离开选项树会话 | 否 |
| `onMenuPresent` | 每次展示菜单前（`?` 求值之后或与之配合） | 可叠加标注/过滤 UI，**不得**破坏「`?` 为假则不可见」的契约 |
| `onOptionPicked` | 用户选定某选项后、发射 `!:` 前 | 否 |
| `onReply` | 执行答复时 | 否 |
| `onJump` | `:>>` 跳转时 | 否 |
| `onSysReturn` | `--<` / `--<<` 时 | 否 |

**明确不列入本标准参考的钩子：**

- `onTick`（帧/定时驱动不在 HSC 契约内）  
- `onSerialize` / `onDeserialize`（**不可持久化**；存档若需要，由上层自建，不属 HSC 机器标准）

「不显式阻塞」仍见抽象机 §7：同步调用驱动器可以；不表示等待任务等长期后果结束。

---

## 5. 能力声明（Capability，参考）

Type 可声明自己支持什么，供 `accept` 与工具使用，例如：

```text
capabilities: {
  entryPoints: ["@dialog_hello"] | any
  signals: { allow: "all" } | { allow: [id…] } | { deny: [id…] }
  sysReturn: true|false
  jumps: true|false
  maxChoiceDepth: number | unlimited
}
```

字段名与集合形态可实现自定；语义应是：**Accept 的 Program 不得依赖 Type 未声明的能力**。

---

## 6. Feature 组合（参考）

深继承可选；更常见的是基座 + Feature 列表：

```text
Type = BaseHscMachine.compose([
  MonologueFeature,
  TimelineFeature,
  …
])
```

每个 Feature 可贡献：能力增量、钩子子集、额外 `accept` 规则。  
具体机器（独白 / 对白 / 过场）= 不同 Feature 组合的 **Type**，再 `spawn` 出 Instance。  
**禁止**为每个玩法复制一套 PC/选项树循环。

---

## 7. 实例化

### 7.1 标准要求

- Type 必须提供某种 **`spawn` / `createInstance`（名称不限）**，得到 **Instance**。  
- Instance 开始时：绑定一份 Program（或 Type 已 load 的视图）、初始 PC（通常某 `@`）、以及实现方传入的 **context**（Driver、View、调用方任意柄）。  
- Instance 运行期间持有：PC、选项树会话等抽象机状态。

### 7.2 标准不要求

- 按玩家 / 队伍 / 房间如何分配 Instance  
- 对象池、复用、亲和性线程  
- 谁是网络权威、如何复制 UI  
- 将 Instance 写入存档或从存档恢复  

多人、宿主权威、客户端投影等，均属**产品架构**，只要不违背抽象机步进与本文钩子边界即可。

### 7.3 Type vs Instance 放什么（参考）

| 放在 Type | 放在 Instance |
|-----------|----------------|
| 钩子实现、能力、`accept` | PC、选项会话 |
| 共享的 Program 只读引用策略 | 本次注入的 Driver / View / Context |
| Feature 组合结果 | 「正在跑」的短暂 UI/输入等待 |

---

## 8. 与驱动器、视图的边界

| 角色 | 职责 |
|------|------|
| **Machine（Type+Instance）** | 何时步进、何时进树、何时调用信号、PC/`>>`/`<<`/`--<` |
| **SignalDriver** | `?`→bool，`!`/`!:`/`:!`→void；参数语义 |
| **View** | 对白/选项如何呈现；系统返回的 GUI 文案 |

Driver / View 由 `spawn(context)` 注入；**不要**写在 Type 的全局单例上（否则无法多实例）。

---

## 9. 符合性（参考检查清单）

实现若声称符合本框架参考，应满足：

1. 合规 `.hsc` 可被基座解析装载；具体 Type 的 Reject 有明确 code。  
2. 步进与 [抽象汉书自动机](#hsc-machine) 一致；钩子默认不改控制流。  
3. 存在 Type → Instance 的实例化路径。  
4. **不**把 HSC 机器状态当作标准存档格式；无强制 serialize 契约。  
5. 非法剧本不靠运行时「猜」；不约定行为。

---

## 10. 文档关系

| 文档 | 内容 |
|------|------|
| [.hs 语法说明](#hanshu-syntax) | 作者写法 |
| [抽象汉书自动机](#hsc-machine) | Program 如何步进 |
| **本文** | Type / Instance / 钩子 / 能力 / 实例化边界（标准参考） |
