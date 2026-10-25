# 通用节点编辑器接入规范

本文是 HanShu 节点编辑器的开发规范。实现与公共类型位于 `src/nodeEditor/`；React Flow (`@xyflow/react`) 承接视口、节点、Handle、连接、选择与测量。进度流程是一个业务使用方，不是通用编辑器的父模块。

## 1. 分层与依赖

| 层 | 职责 |
|---|---|
| React Flow | 视口坐标变换、拖动事件、节点测量、框选、Handle 连接与选择 |
| `nodeEditor/` | 统一交互与样式、注册节点、端口归一化、分组、注释、小刀、右键菜单、轻度排版 |
| 业务适配器 | 从业务文档生成节点/连线视图，将编辑意图转成业务修改，执行业务连接校验 |
| 工作区 / 编辑会话 | 草稿、撤销/重做、只读与活动视图、保存、协作事务和失败恢复 |

**通用层不得导入工作区、进度模型、信号模拟、工程存储或项目客户端。** 新编辑器优先复用本模块；不要复制一套指针、缩放或选择状态机。当前是 TypeScript 注册与回调扩展，不另造 JSON 配置语言或运行时插件协议。

## 2. 公共入口与视图模型

从 `src/nodeEditor/index.ts` 导入 `NodeEditor`、`NoteNode`、`arrangeNodes` 和公共类型。`ContextMenu` 是独立可复用的菜单组件，同时供资源管理器和组件树使用。

- `EditorNode`：`id/type/position/width/height/ports/data/label`；`deletable:false` 用于保护起点等节点，`draggable:false` 禁止移动。
- `Port`：节点内唯一 `id`、`direction`、可访问 `label`，以及可选 `side/x/y/kind/color`。`side` 决定显示方位，`direction` 决定输入输出语义，两者独立。左右侧使用节点内的 `y`，上下侧使用 `x`；偏移未提供时居中。旧接入不写 `side` 时，输入默认左侧、输出默认右侧。端口规则不从显示名推断。
- `EditorEdge`：唯一 `id`、`source/target/sourcePort/targetPort`，可带颜色和可访问名称。
- `NodeRegistry`：`type → { component }`，组件收到 `NodeViewProps`，包括只读、选中、拖动状态和节点视图。
- `EditorGroup`：`id/name/nodes`；仅表达编辑归组，不表达执行顺序、运行子流程或权限。
- `EditorSelection`：节点与连线 ID 列表，是编辑器状态，不是业务节点属性。

这里的节点和连线是**视图投影**，不是新的全局存档协议。业务 `data` 可以包含当前模拟状态和回调等临时对象，不能把它原样 JSON 序列化。不得把 React Flow 的 `measured`、内部节点、DOM、Provider、选中状态或临时 Group 节点写入业务文档。

节点尺寸由适配器给出。节点组件应填满自身视图框；表单控件标记 `nodrag`，需要独立滚动/平移的区域标记 `nopan`。不要在节点组件里再实现节点拖动或给世界坐标叠加一次 CSS translate。动态端口增删、方位、偏移、输入输出方向或节点尺寸改变时，公共外壳负责更新 React Flow 的内部测量。

## 3. 最小接入

```tsx
import { NodeEditor, type NodeRegistry } from '../../nodeEditor'

const registry: NodeRegistry = {
  action: { component: ActionNode },
}

<NodeEditor
  documentId={document.id}
  nodes={view.nodes}
  edges={view.edges}
  registry={registry}
  active={isActivePane}
  readOnly={!client.writable}
  canConnect={connection => validateBusinessConnection(document, connection)}
  onConnect={connection => editDraft(connect(document, connection))}
  onMove={positions => editDraft(move(document, positions))}
  onDelete={selection => editDraft(remove(document, selection))}
/>
```

`editDraft` 是示意名称，接入时使用当前编辑会话的真实草稿入口。完整独立示例见 `nodeEditor/Example.tsx`：不导入进度模块，可以独立创建节点、连线、分组和注释。进度适配器参考 `workspaces/quest/graphAdapter.ts`。

`documentId` 是画布实例身份；切换文档会重建独立的 React Flow Provider，旧拖动、连线、小刀、菜单和视口状态不跨文档续接。同一文档可同时在多个窗格打开，每个组件实例有独立视口和选择状态。

## 4. 编辑意图与原子性

- `onMove(positions)`：拖动中只更新预览，释放后一次提交所有相关节点的位置；一次 Group / 多选移动对应一个业务修改。
- `onConnect(connection)`：输入起拖与输出起拖统一为输出 → 输入，再经过 `canConnect`；自环、端口容量、类型和节点类别的许可由业务决定。
- `onDelete(selection)`：一次传递全部待删除节点与连线，通用层先过滤 `deletable:false`。业务仍须清理相关连线和分组，不可只删视觉元素。
- `onCut(edgeIds)`：小刀松开后一次传递被切到的连线。Esc、失焦、指针取消不提交。
- `onGroup/onUngroup/onRenameGroup`：业务持久化归组信息；通用层只产生包围盒和联动预览。
- `onArrange(ids)`：可覆盖公共排版策略。未提供时使用 `arrangeNodes`，再通过 `onMove` 产生一次位置修改。
- `onNodeDoubleClick/onEdgeDoubleClick/onNodeClick`：打开业务表单、执行本地模拟等行为。通用层不判断 Goal、checkpoint 或对话的含义。

**不要在 React Flow 每次 `onNodesChange` 中保存工程。** 尺寸测量、选择、视口和拖动预览均不是保存事件。通用层没有自己的业务撤销栈，也不直接发起文件事务；沿用工作区已有历史。工程保存与失败恢复遵循[多人协作编程指南](#collaboration-programming)。

## 5. 配置与扩展

`features` 可分别关闭 `groups/knife/arrange/selection/connections`，默认启用。只有提供相应业务回调，才能获得可持久化的业务行为；不需要的功能应显式关闭。

`interaction` 可覆盖 `panOnDrag/zoomOnScroll/minZoom/maxZoom`。默认沿用 HanShu 手感：右键拖动平移、滚轮缩放、左键空白处框选、双击空白后第二次按住并拖动切线、双击不缩放也不创建节点。简单右击仍打开菜单，拖动后不误弹菜单。

`menuItems(context)` 扩展节点、连线、Group、画布菜单，context 包含世界坐标和当前选择。创建节点的业务入口放在此处，或由工作区按钮调用同一创建函数。公共菜单合并分组、排版与删除；业务不要再重复加整套通用操作。

`toolbar` 是 React Flow Provider 内的 React 内容插槽，可配合 React Flow `Panel` 与官方 Hook 增加视图工具；复杂扩展可以直接使用官方 API，不为每个 API 再包装一层。

`NodeEditorApi` 提供 `fit/focus/zoom/center`；`onViewportChange` 供缩放读数等 UI 使用。视口状态不应默认写成业务文档修改。

## 6. 分组、注释与排版语义

Group 成员继续保存绝对世界坐标，不把它们迁成 React Flow `parentId` 的相对坐标；拖动整个 Group 或其成员时保持联动。包围盒由当前尺寸与位置派生，不单独持久化。双击标题或右键重命名，Ctrl+G 分组、Ctrl+Shift+G 解除。第一版采用平面分组，不支持嵌套 Group 或运行子流程。

注释注册为 `note: { component: NoteNode }`，其 `data` 符合 `NoteData`。双击编辑标题和正文，Ctrl+Enter 确认，Esc 取消；右下角调整尺寸，只在释放时回调 `onChange`。注释没有业务端口，其内容不会参与流程执行。

公共排版是原有轻度排版算法：只微调已有行列、近似等距的间距；移动不超过 32 像素，检查未选择节点，避免新建或加剧重叠。不会按照拓扑重排整张图。业务可以替换策略，但应明确菜单名称与预期。

## 7. 只读、取消与状态边界

`readOnly` 或 `active:false` 禁止创建、修改、连线、分组、删除、小刀提交和注释编辑；只读仍可浏览画布。业务节点内部也必须遵守 `NodeViewProps.readOnly`。这些是交互保护，不能替代 S 的权限检查。

外部文档刷新后适配器重新投影；不要用当前 React Flow 内部数据反向覆盖整份业务文档。已有业务修改应继续保留读取版本，遵守当前文件/字段的冲突策略。

多进度任务保留 `.quest`（`hanshu.progress-tree`）、原有节点身份、动态交换槽、端口校验和信号模拟。React Flow 的临时分组节点不会进入 `layout.positions`。进度与通用层的选择/连线 ID 由适配器映射，逻辑连线 ID 使用独立视图前缀，避免与起点连接冲突。

## 8. 验证入口

```sh
npm run test:node-editor:ui
npm run test:progress
npm run build
```

浏览器验证使用独立 Vite 和真实 React Flow：拖动只提交一次、鼠标连接、小刀、分组与重命名、多选联动、注释编辑和调整尺寸、右键拖动、缩放、只读保护；进度用例验证原生格式、交换端口自动扩容、信号模拟、双击编辑和不可删除起点。截图保存在 `node_modules/.cache/node-editor-ui/`，不作为源文件提交。

已有进度模型测试继续验证序列化、端口/信号规则与轻度排版。新增节点类型至少补业务连接和文档往返验证；涉及通用交互时补浏览器操作，不用仅检查 JSX 字符串代替真实交互。此套测试不等于穷尽所有大图、触摸设备或操作系统输入组合。

## 9. 统一节点外观

从公共入口导入 `NodeFrame`、`NodeHeader`、`PortLabel`、`NodeField`。进度节点与独立示例均使用同一套基础组件。

- `NodeFrame`：节点边框、背景、选中和拖动外观；支持 `accent` 和普通 div 属性。业务颜色可用 `--node-background`、`--node-foreground` 覆盖。
- `NodeHeader`：`icon/title/badge/color`，标题自动省略，徽标保持右对齐；默认高度 24px。
- `PortLabel`：`direction/side/x/y/color`，与对应 `Port` 共享方位和偏移。左右标签在节点内靠边垂直居中，上下标签在节点内靠边水平居中；业务节点应为标签预留空间，不要让标题或表单覆盖它。
- `NodeField`：`label` 与表单控件插槽，自动标记 `nodrag/nopan/nowheel`，业务负责值、校验和只读状态。它不产生保存或撤销记录。

基础组件只定义视觉与排版。节点字段提交的时机、模拟状态、国际化和业务权限仍由使用方负责。避免在通用外壳加入特定游戏或节点类型的判断。

## 10. 大图与多视图验证

超过 300 个节点时启用 React Flow 视口裁剪，完整节点和连线仍留在视图数据里，仅减少屏幕外 DOM。小图沿用完整渲染。节点初次挂载使用 React Flow 自动测量；端口签名改变后才主动更新内部测量，避免大量首次测量重复触发。文档刷新时使用 ID 索引复用旧测量结果。

`test:node-editor:ui` 另外验证两个独立窗格，每个 600 个节点、599 条连线：连续 12 次分组移动各产生一次提交，调用方历史可撤销和重做全部移动，另一窗格数据与视口不受影响；大图只渲染可见节点，定位远处节点后屏幕外节点可重新出现。该历史是测试夹具的调用方历史，不代表已经覆盖工程服务或全部工作区历史路径。

本地无头 Edge 本次加载测得约 0.7 秒，仅是测试环境观测值，不是性能承诺。这些用例属于交互与重复操作回归，不替代小时级耐久测试、内存泄漏分析或真实多人网络验收。


## 11. 四向端口与纵向节点图

一个画布可以混用 `left/right/top/bottom` 四种端口方位。左右或上下排版由业务节点位置决定，无须另一套画布组件或修改文档协议。`side` 不决定连接许可：顶部端口可以是输出，底部端口也可以是输入，连接仍只允许语义输出 → 输入，并执行业务 `canConnect`。

上进下出的节点示例：

```ts
const ports: Port[] = [
  { id: 'parent', direction: 'input', side: 'top', label: '父节点' },
  { id: 'children', direction: 'output', side: 'bottom', label: '子节点', x: 108 },
]
```

`x/y` 为相对节点左上角的像素坐标，只读取当前方位所在轴；例如 `side:'top', x:0` 位于顶部左端，`x` 缺省则在顶部中央。多个同侧端口使用不同偏移区分。标签接入时传同一个端口的 `direction/side/x/y`，无需自己转换百分比或猜测坐标。

已连接的连线和拖动预览统一按两端实际方位生成曲线，从输入端起拖也会按输出 → 输入归一化。更新端口偏移、方位和节点尺寸会主动刷新锚点测量，既有连线不必删掉重建。曲线只负责朝向与弯曲，不提供自动避障；自环使用按源方位旋转的绕行曲线。

独立示例 `src/nodeEditor/DirectionalExample.tsx` 展示向下、向上、向左、向右的节点位置与端口配置，以及运行中移动端口、交换方位。它不依赖进度模型，不是行为树运行时。行为树接入时仍需业务模型保存孩子的显式执行顺序、校验父子关系并提供树形排列；拖动位置不能隐式改变执行顺序。通用轻度排版不会自动推断这些语义。

验证：`npm run test:node-directions` 检查 16 种方位组合的曲线、默认值与偏移，`npm run test:node-directions:ui` 检查四种布局、反向起拖的预览和实际连接，以及端口移动、换边后的锚点更新。原有画布与大图回归继续使用 `test:node-editor:ui`。
