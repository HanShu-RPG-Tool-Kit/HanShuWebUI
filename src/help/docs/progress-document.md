# 任务文档（单进度）与表单

顶层包为**任务**（quest）。磁盘扩展名一律 **`.quest`**。单进度作者态使用 `format: "hanshu.progress"`、`version: 1`（与多进度 `hanshu.progress-tree` 同属任务，见 [流程模型](#progress-flow-model)）。不支持的结构保留原文并进入修复界面。

## 数据

- 文档 `id` 是设计文档标识，不表示引擎可识别的任务 ID。`goals` 是扁平目标列表，每项含内部 `id`、脚本类型 `kind` 与实例参数 `config`。Goal 展示语义属类型定义，实例不覆盖标题或描述。
- `config` 只保存显式填写的参数。缺键表示沿用定义默认值；显式等于默认值、空文本、零、false 仍保留。恢复默认＝删除对应键。
- `completion` 支持 `all` / `any` / `custom`。自定义用 `completionGraph`；切到全部或任一时保留该图但不参与判断。空目标列表作者态提示待完善；运行时为空是错误，不得默认成功或失败。
- **目标完成语义**（单进度与多进度进度节点同一套）：`completion` 判定的是进度是否进入**可交付态**（成功侧）或**失败结算**（失败侧），不是直接改写终态文案。
  - **完成全部**（`all`）：全部目标成功 → 可交付；任一目标失败 → 进度失败。
  - **完成任一**（`any`）：任一目标成功 → 可交付；全部目标失败 → 进度失败。
  - **自定义完成**（`custom`）：由 `completionGraph` 边沿推到「完成输出」的成功入 / 失败入决定；见下节。
  - 配置了 `submission`：可交付后仍运行中，等实际提交成功才进入已成功；失败侧仍直接失败结算。
  - 未配置 `submission`：可交付后**自动交付**，进度进入已成功并结束。
  - 进度结束（成功 / 失败 / 取消等）后，其上挂载的 goals 随之关闭；不必另写「成功后取消其余目标」——关闭是进度结束的自然结果。
- Goal 类型及参数字段唯一来自「脚本 → 目标定义」。目录从文件级 `@goal(id)` 与 `@config(field(...))` 元数据解析；表单不执行 JavaScript。文件头 `/* JSON */` 注释（`labels` / `params.*.widget` / `localize`）只供 WebUI。参数控件由可注册的 `goalWidgets` 解析（内置 `text` / `number` / `slider` / `select` / `bool`）；未知控件本阶段回退文本框。
- 没有脚本时显示空目录。定义删除后目标仍保留类型与参数。未声明的旧参数保留在文件中。
- `visibility` 与 `acceptance` **相互独立**；各列表内全部满足才通过，任一方为空则该方直接满足。**承接只要求 `acceptance`，不要求 `visibility`。** 任务状态 `before_accept / after_accept / active / succeeded / ended`；对话 `before / after`；求值 `expr` 仅 `true`。可见性还可写 `repeat`（`satisfied` / `unsatisfied`，`target` 为空）。**可承接数组不得出现 `repeat`**。引擎求值未实现。
- `abandonable` 与 `autoStartWhenAcceptable` 为布尔；新建显式写出，后者缺省 false。
- `rewardKits` 为去重礼包引用数组。
- `authorNotes` 与玩家 `description` 分开。玩家可见 `name` / `description` 存语义键，译文在 `assets/<locale>/lang_quest/<文件>.lang`；作者备注不本地化。

## 交互

目标使用带 Blender 节点配色的卡片，右上角“完成全部 / 完成任一 / 自定义完成”切换。目标区「紧凑 / 列表」两套视图，默认紧凑：按容器宽度算列、按实测高度紧凑排列；列表视图单列可拖拽排序。视图偏好存本机，不写入 `.quest`、不改目标顺序。

顶部双栏：左标题描述，右常显文档 ID、标签与作者备注。参数区：原生数字、布尔、`enum:` 下拉与文本；可一键恢复默认。

完成奖励与周期双栏在目标上方。奖励可从「礼包」拖入 `.kit` 或下拉添加。可见性 / 可承接各用常显卡片；周期卡含「可承接时自动开始」与「可放弃」。可见性可选「重复周期」；可承接顶部常显只读周期投影行。

## 任务分类（UI 目录）

与单／多进度文档并列的固定虚入口「任务分类」映射 `src/quest/catalog.json`（不是新的资源类型，也不替代资源树整理文件夹）。格式 `hanshu.quest-catalog` version 1：`directories[]` 含自动生成的 `id`、语义键 `title`（`directories.<id>.title`）、以及无序去重的 `quests` 任务基名集合。多对多：同一 `.quest` 可出现在多个目录。导出进 shared PAK 为 `quest/catalog.json`；验证：`npm run test:quest-catalog`。

## 开发试用与验证

模型验证：`npx tsx scripts/verify-progress-document.ts`。单/多进度统一导出 `.questc`：`npm run test:quest-compile`，格式见[流程模型](#progress-flow-model)。任务分类：`npm run test:quest-catalog`。


## 目标显示别名

目标列表、节点标题与选择器统一显示别名。按当前列表中 `kind` 首次出现顺序分配 A、B、C…；同类型内依出现顺序编号。别名不写入文件。目标与节点 `id` 仍为 UUID；Goal 节点的 `goalId` 引用目标 UUID。

## 自定义完成图

选择「自定义完成」后展开通用 React Flow 节点编辑器。节点种类：Goal、逻辑、完成输出。禁止环与容量超限（最多 512 节点、1024 连线）。布局不持久化；`completionGraph` 在协作中作为语义字段 CAS。

### 端口与求值

- **Goal**：两个出口——成功、失败。目标实例进入对应终态后沿该口**边沿推一次**（不是持续电平）。
- **逻辑**：仍为单轨布尔（`and` / `or` / `not` / `xor`）。作者分别编织通向完成输出成功入或失败入的树；逻辑节点本身不做成败双口。
- **完成输出**：两个入口——成功入、失败入。允许新建多个完成输出；彼此是**或**（竞态）关系：任一被命中即锁存本进度的完成结果（可交付或失败），之后忽略。
- 多个完成输出先后或并发触发、且结果不一致时：**first-wins，协议无稳定优先级**；运行时按实例观察到的时序取第一个。编辑器可对「同一目标集合既能到达成功入又能到达失败入」给 warning，不阻止编辑或导出。
- 求值只从各完成输出向上追溯；断开的草稿不参与。

### 文件形态

文件只保存节点、参数和连接。Goal 出口与完成输出入口用连线的端口区分（成功 / 失败）；逻辑节点入出仍为单轨。示意：

```json
{
  "completion": "custom",
  "completionGraph": {
    "nodes": [
      { "id": "<node UUID>", "type": "goal", "goalId": "<goal UUID>" },
      { "id": "<logic UUID>", "type": "logic", "op": "and" },
      { "id": "<output UUID>", "type": "output" }
    ],
    "links": [
      { "id": "<link UUID>", "from": "<node UUID>", "fromPort": "output", "to": "<output UUID>", "toPort": "input" },
      { "id": "<link UUID>", "from": "<node UUID>", "fromPort": "output2", "to": "<output UUID>", "toPort": "input2" }
    ]
  }
}
```

逻辑节点：`{ "id": "<UUID>", "type": "logic", "op": "and" }`（`and/or/not/xor`）。端口命名与多进度一致：成功侧 `output` / `input`，失败侧 `output2` / `input2`。

验证：`npm run test:progress-completion`、`npm run test:progress-completion:ui`、`npm run test:progress-collaboration`；目标视图 UI：`npm run test:progress-goal-views:ui`。
