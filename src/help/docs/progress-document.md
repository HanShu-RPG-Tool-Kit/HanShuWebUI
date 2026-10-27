# 任务文档（单进度）与表单

顶层包为**任务**（quest）。磁盘扩展名一律 **`.quest`**。单进度作者态使用 `format: "hanshu.progress"`、`version: 1`（与多进度 `hanshu.progress-tree` 同属任务，见 [流程模型](#progress-flow-model)）。不支持的结构保留原文并进入修复界面。

## 数据

- 文档 `id` 是设计文档标识，不表示引擎可识别的任务 ID。`goals` 是扁平目标列表，每项含内部 `id`、脚本类型 `kind` 与实例参数 `config`。Goal 展示语义属类型定义，实例不覆盖标题或描述。
- `config` 只保存显式填写的参数。缺键表示沿用定义默认值；显式等于默认值、空文本、零、false 仍保留。恢复默认＝删除对应键。
- `completion` 支持 `all` / `any` / `custom`。自定义用 `completionGraph`；切到全部或任一时保留该图但不参与判断。空目标列表提示待完善。
- Goal 类型及参数字段唯一来自「脚本 → 目标定义」。目录从 `@goal` / `@config(field(...))` 解析；表单不执行 Python。文件头三引号 JSON（`labels` / `params.*.widget` / `localize`）只供 WebUI。参数控件由可注册的 `goalWidgets` 解析（内置 `text` / `number` / `slider` / `select` / `bool`）；未知控件本阶段回退文本框。
- 没有脚本时显示空目录。定义删除后目标仍保留类型与参数。未声明的旧参数保留在文件中。
- `visibility` 与 `acceptance` **相互独立**；各列表内全部满足才通过，任一方为空则该方直接满足。**承接只要求 `acceptance`，不要求 `visibility`。** 任务状态 `before_accept / after_accept / active / succeeded / ended`；对话 `before / after`；求值 `expr` 仅 `true`。可见性还可写 `repeat`（`satisfied` / `unsatisfied`，`target` 为空）。**可承接数组不得出现 `repeat`**。引擎求值未实现。
- `abandonable` 与 `autoStartWhenAcceptable` 为布尔；新建显式写出，后者缺省 false。
- `rewardKits` 为去重礼包引用数组。
- `authorNotes` 与玩家 `description` 分开。玩家可见 `name` / `description` 存语义键，译文在 `assets/<locale>/lang_quest/<文件>.lang`；作者备注不本地化。

## 交互

目标使用带 Blender 节点配色的卡片，右上角“完成全部 / 完成任一 / 自定义完成”切换。目标区「紧凑 / 列表」两套视图，默认紧凑：按容器宽度算列、按实测高度紧凑排列；列表视图单列可拖拽排序。视图偏好存本机，不写入 `.quest`、不改目标顺序。

顶部双栏：左标题描述，右常显文档 ID、标签与作者备注。参数区：原生数字、布尔、`enum:` 下拉与文本；可一键恢复默认。

完成奖励与周期双栏在目标上方。奖励可从「礼包」拖入 `.kit` 或下拉添加。可见性 / 可承接各用常显卡片；周期卡含「可承接时自动开始」与「可放弃」。可见性可选「重复周期」；可承接顶部常显只读周期投影行。

## 开发试用与验证

`/progress-preview.html` 使用正式组件与同源目标定义脚本。模型验证：`npx tsx scripts/verify-progress-document.ts`。单/多进度统一导出 `.questc`：`npm run test:quest-compile`，格式见[流程模型](#progress-flow-model)。


## 目标显示别名

目标列表、节点标题与选择器统一显示别名。按当前列表中 `kind` 首次出现顺序分配 A、B、C…；同类型内依出现顺序编号。别名不写入文件。目标与节点 `id` 仍为 UUID；Goal 节点的 `goalId` 引用目标 UUID。

## 自定义完成图

选择「自定义完成」后展开通用 React Flow 节点编辑器。Goal / 逻辑节点 / 唯一完成输出；S 为布尔状态（非多进度信号模拟器的瞬时消息）。禁止环与容量超限。只沿完成输出向上求值。

文件只保存节点、参数和连接，例如：

```json
{
  "completion": "custom",
  "completionGraph": {
    "nodes": [
      { "id": "<node UUID>", "type": "goal", "goalId": "<goal UUID>" },
      { "id": "<output UUID>", "type": "output" }
    ],
    "links": [
      { "id": "<link UUID>", "from": "<node UUID>", "to": "<output UUID>" }
    ]
  }
}
```

逻辑节点：`{ "id": "<UUID>", "type": "logic", "op": "and" }`（`and/or/not/xor`）。最多 512 节点、1024 连线。布局不持久化。`completionGraph` 在协作中作为语义字段 CAS。

验证：`npm run test:progress-completion`、`npm run test:progress-completion:ui`、`npm run test:progress-collaboration`；目标视图 UI：`npm run test:progress-goal-views:ui`。
