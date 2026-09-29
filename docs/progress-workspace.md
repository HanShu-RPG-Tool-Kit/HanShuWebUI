# 进度流程原型

“进度流程”是 HanShu 的内容设计工作区，工作区 ID 为 `progress-flow`。任务、章节推进、探索解锁是文档的内容类别。当前阶段先确定作者如何组织阶段、分支和条件，执行规则由后续引擎设计。

## 树图文档

原生文档使用 `format: "hanshu.progress-tree"`、`version: 1`，文件后缀为 `.hflow`。JSON 是文档的序列化方式。模型不包含游戏资源 ID 规则、注册表、数据包路径或 Mod 字段，不提供旧 `.quest` 格式的转换、迁移或兼容导出。

```json
{
  "format": "hanshu.progress-tree",
  "version": 1,
  "id": "a-stable-document-id",
  "kind": "task",
  "title": { "text": "驿站的约定", "key": "story.station.title" },
  "description": { "text": "设计这段内容的推进过程。" },
  "root": "start",
  "nodes": {
    "start": {
      "title": { "text": "收到邀请" },
      "description": { "text": "作者对这个阶段的说明。" },
      "branching": "parallel",
      "completion": "continue",
      "children": [
        {
          "id": "accept",
          "target": "prepare",
          "title": { "text": "接受邀请" },
          "trigger": "confirm",
          "conditions": { "mode": "all", "items": [] }
        }
      ],
      "onEnter": [], "onFinish": [], "rewards": []
    },
    "prepare": {
      "title": { "text": "准备出发" },
      "description": { "text": "" },
      "branching": "parallel",
      "completion": "finish",
      "children": [], "onEnter": [], "onFinish": [], "rewards": []
    }
  }
}
```

节点按稳定 ID 平铺保存；节点的有序 `children` 描述父子关系、分支名称、目标节点与推进条件。这样既直接表达树，又避免长流程造成 JSON 深层嵌套。没有第二份独立的连线表；画布连线由 `children` 派生。

`branching` 描述并行推进、选择一条或按顺序选择的设计意图；`completion` 显式描述继续或结束。当前原型不执行这些声明。叶节点可以暂不标记结束，编辑器将其显示为设计提示。

条件声明支持人工标记、累计事件、等待信号、等待其他阶段和外部条件引用；节点引用放在 `nodeRefs` 中，重命名和删除时统一维护。动作与奖励使用 `{id, reference, params}` 资源引用，编辑器不读取游戏对象或执行脚本。这些字段是可继续讨论的创作协议，不是已经实现的运行时 API。

展示文字使用 `{text, key?}` 明确区分设计原文和可选本地化键。当前 UI 预览原文；没有原文时显示文本键。语言资源、参数化文本及运行时翻译留待后续设计。

## 编辑与保存

- 树图与属性面板编辑同一份树图文档。
- 右键节点打开操作菜单，可新建下一节点、编辑属性、设置或取消结束标记；新节点会自动连接、选中并进入画布视野。支持 Shift+F10、方向键与 Esc。
- 添加阶段、调整分支顺序、移动整棵子树、重命名节点、删除分支；移动保留分支 ID 和条件。
- 重命名更新起点、父子关系及节点条件引用；删除清理后续子树与引用，空等待条件会报告问题。
- 文档结构视图可直接修改 JSON；结构错误保留为草稿，语法和容器形状恢复后再显示树图。
- 每份文档有会话内撤销/重做；源码连续输入合并为一次编辑。
- 条件参数、动作和奖励 JSON 修改需要先应用或放弃，避免切换时丢失未提交内容。
- 本机草稿库使用 `hanshu.progressWorkspace.v1`，原始未完成源码也会保存。读取失败时阻止自动覆盖。
- 导入 `.hflow` / 原生 JSON 文档；导出通过结构校验的树图，或下载未经校验的原始草稿。

校验覆盖树的单根、单父、可达性、分支和条件声明及资源引用形状。尚未定义运行时的失效条件、分支竞态、提交事务和复杂等待依赖；编辑器不声称能模拟执行。

## 验证

运行 `npm run test:progress` 检查结构、引用维护、子树移动、文本往返和存储。运行 `npm run build`、`npm run lint` 检查应用。
