# 区域编辑器开发与验收

本页是 WebUI 侧实现、计划修正与 PR 复验入口。用户操作见[地图模板与导航](#level-guide)，连接配置见[游戏开发服务器](#game-dev-server)，保存边界见[多人协作编程指南](#collaboration-programming)。配套 Mod 仓库的权威文档为 `docs/landmark-protocol.md`、`docs/online-region-editing.md` 和 `docs/development/region-editor-review.md`。

## 已实现的工作流

离线 Three.js、游戏原生工作台和浏览器属性面板共用 `.level` 草稿。中间视口是主要编辑面，左侧按区域/编号体积选择，右侧按范围、高度、显示和扩展分组；视图相机不写入历史。已注册的地标显示属性用中文业务表单，未知 `custom_data` 默认折叠并按 JSON 类型编辑，不把任意英文测试键伪装成游戏功能。

在线画面由游戏渲染；浏览器不重建世界。本项目提供独立世界镜头、原生工具栏和属性检查器，不依赖或自动打开Axiom。地图魔杖可在没有画面串流时绑定当前地图，右键进入原生工作台后编辑同一草稿。源文件保存必须使用现有工程事务；Mod 不写工程源目录。「应用到当前测试世界」是独立的显式操作，仅在有权限的本机集成服务端生成测试 PAK、验证加载结果并绑定当前维度。

区域创建采用两次点击（矩形起点/终点，圆心/半径），也保留按住左键拖出的快捷方式。第一点与悬停预览不提交历史；第二点或拖动松手提交一次。左键本体仅选择，金色中心负责移动，角、边、半径、顶点与绿色上下控制点负责变形。原生选取按三维表面命中，不能用背后的地形方块代替作者体积。视口顶部持续显示工具和下一步，不能绘制时显示具体原因。

原生工作台和离线视口使用相同操作：中键围绕焦点环绕，Shift+中键平移，滚轮缩放；G进入自由观察，鼠标直接转向，WASD移动，Space上升、Shift下降、Ctrl加速，Esc释放鼠标。自由观察不要求按住右键，Q/E不占作镜头升降。F对准选中并保留观察方向，包括无界高度的稳定参考带。属性输入保留文本按键，失焦及退出释放交互。相机状态不写`.level`或历史，也不移动实际玩家。

新增矩形、圆和多边形使用四格有限高度，完成后选中新体积并回到选择工具；多边形支持Enter或点击首点完成。「进入游戏试玩」切回实际玩家，隐藏作者控制点并保留原版背包等键位；浏览器提供返回编辑入口。临时效果预览和移动编辑镜头不能替代玩家实际进入／离开区域，区域运行时验收前须成功应用当前草稿。

## 实现定位与边界

| 代码 | 职责 |
| --- | --- |
| `workspaces/gameplay/LevelEditor.tsx` | 文档内历史、面板、选择、在线/魔杖绑定 |
| `levelVolumeView.tsx`、`levelVolumeEdit.ts`、`levelGeometry.ts` | 离线三维、手势、共享坐标约定 |
| `levelInspector.tsx`、`levelCustomData.tsx`、`levelCustomTree.tsx` | 业务属性、类型树、未完成输入与取消 |
| `levelOnline.ts`、`levelOnlineControl.ts` | 单一编辑身份、修订、提案去重、心跳与取消 |
| `levelOnline.ts`、`LevelEditor.tsx` 与 Mod 的 `TestWorld*` | 编辑／观察／试玩状态，显式测试世界应用及成功／拒绝回执；服务器负责权限、维度与运行时加载检查 |
| `streamViewport.tsx`、`streamInput.ts` | 真实帧、letterbox 映射、RPIN、焦点与释放 |
| `gameDevServer/controlHub.ts`、`protocol.ts` | 本机门户、鉴权连接、诊断与双向 RPC |
| `export/compile/compilers/level.ts` | `.level` 拆分、地标引用校验、旧协议拒绝 |

普通文件历史由工作区按源资源维护，不能在编辑器卸载或切页后另建一条丢失历史的栈。preview 只显示临时草稿，commit 才产生一次历史。身份包含工程、窗口客户端和完整源路径；迟到、重复、取消或跨文档通知必须被忽略。

整数矩形/高度的外表面使用 max+1，圆与多边形 XZ 保留 0.5 列中心偏移；地标无偏移。拖动吸附增量，保留原始小数。`y:"all"` 的薄显示带不能写入源文件。魔杖生成有限高度的整数盒子，单方块选区不得退化。

## 按最终实现修正计划

区域效果与几何共用作者数据链：`levelDoc.ts`接受并保留`music`、`environment`，编译器原样写入区域产物；`regionEffects.ts`提供原有格式的校验，`regionEffectsPanel.tsx`提供雾／天空／后处理／音乐分组。Mod仍用生产codecs验证提案。几何拖动、双端历史和S保存均须保留这些配置段。

两端中文控件词表由Mod的`tools/export-region-effect-controls.py`结合内置manifest生成，Web快照为`regionEffectControls.generated.json`。`level.effects.library`读取当前游戏资源的类型化参数；`level.effects.preview`绑定当前身份／修订／选中区域，并使用独立UUID及10秒租期。浏览器每3秒续期，关闭或失联后恢复底层最新环境。预览不写工程或运行时目录，试听从游戏客户端发声。

| 原设想或遗漏 | 当前处理 |
| --- | --- |
| SVG/二维图作为唯一离线编辑面 | Three.js 三维体积，二维只是可选正交视图 |
| 浏览器加载世界或地图瓦片 | 当前编辑器不加载；在线直接显示游戏画面 |
| Axiom 不兼容、留待以后 | 已改为项目自身原生工作台；无Axiom实例需独立验收 |
| 在线只串流、Ctrl+Z 不接作者数据 | 原生控制点与同一草稿、侧栏、历史和保存闭环 |
| 魔杖不在本轮 | 已加入物品、两点选区、线框/网格墙、原生确认与同草稿提交 |
| 直接暴露整个 custom_data JSON 和混淆删除范围 | 中文已注册属性、折叠的类型树、体积/区域/地标分开删除 |
| 只完成几何，已有环境与音乐未进作者模型 | 两端效果面板、解析／保存／导出、实际游戏预览与音乐试听；不能用custom_data冒充业务接线 |
| 环境只有固定预设 | 全参数与有序效果栈；工程共享命名方案；GLSL模板／源码／中文参数制作与实际GPU编译预览 |
| 编辑镜头移动被当成玩家走入区域 | 自由观察与原版试玩分开；实际玩家进出验证环境和音乐 |
| 草稿同步后以为运行时已加载 | 显式应用到测试世界，显示应用结果；拒绝时保留旧测试包与绑定 |

旧原稿已放入 Mod 的 `docs/archive/level/`，附原始哈希和取代说明。当前协议不再依赖父目录或系统临时目录。没有新增完整 Residence 保护、收费或成员系统，已实现区域工作台的世界镜头；不包含MCA世界渲染或Axiom完整建筑工具。

## 可重复验证

先构建 WebUI 并准备真实工程服务二进制。常用纯逻辑回归：

```sh
npm run build
npm run test:level-online
npm run test:level-edit
npm run test:level-volume
npm run test:level-geometry-parity
npm run test:level-layout
npm run test:level-custom
npm run test:stream-input
npm run test:region-effects
npm run test:region-effects:ui
npm run test:region-effects:export
```

`test:region-editor:ui`使用真实S和模拟门户，覆盖布局、表单、中文扩展、删除、撤销及保存。它不能证明游戏渲染或操控。`test:region-editor:native`（另两个native入口同义）使用独立无Axiom客户端、维护中的MinecraftTestMCP与真实门户：魔杖右键、原生选区/高度/属性、浏览器实际鼠标与键盘、自由观察、实际玩家试玩、测试世界应用与拒绝恢复、双端历史、S保存和离线预览。

```powershell
$env:REGION_MCT_WRAPPER = '<独立 MinecraftTestMCP 的 codex_viewport_session.py 绝对路径>'
$env:REGION_MCT_TARGET = '<本轮拥有的隔离客户端 target>'
$env:REGION_NATIVE_PORT = '<该隔离客户端门户端口>'
npm run test:region-editor:native
```

脚本只可指向本轮拥有的独立主世界、玩家名Dev；通过原生命令在测试坐标布置小范围平台。作者夹具经S事务种入，之后修改与保存走产品界面，文件仅用于读回核验。浏览器是独立无头上下文，不附着用户的Edge。默认报告在 `node_modules/.cache/native-world-editor/`；可用 `REGION_NATIVE_ARTIFACTS` 指定本地目录。旧Axiom专用/旧魔杖确认脚本已由当前原生回归取代并删除。

截图区分浏览器页面和原生 framebuffer。原生 PNG 保持裁剪原尺寸、像素哈希和文件哈希，禁止缩放或转 JPEG 后称为原生证据。Mod 的本轮验收记录注明实际结果与未测范围。

## PR 使用

无Axiom的当前工作台验收入口为 `scripts/verify-native-world-editor.ts`。

本次持续修订现有 [Web #30](https://github.com/HanShu-RPG-Tool-Kit/HanShuWebUI/pull/30) 与 [Mod #20](https://github.com/HanShu-RPG-Tool-Kit/ModRPGToolKit/pull/20)。正文说明旧 `.nav`/地标迁移、同一草稿和 S 保存边界、无 Axiom 的原生工作台、显式测试世界应用、配套版本、测试入口及未测项。不要将未执行的全仓测试或其他加载器兼容性写成已通过。共享工作树可能有其他修改，提交前审阅范围并保留原有暂存区，不提交测试世界、门户密码、MCP 私有配置或临时日志。

最新一轮完整原生流程48项通过，真实S／模拟门户UI 29项通过，页面无未捕获错误；Mod定向JUnit 141项、生产／GameTest编译和生产JAR检查通过。Web构建、lint及区域体积／视口／在线／输入检查通过。实机覆盖实际W/S进出、两类雾、天空／后处理／音乐、原版背包、未注册扩展拒绝和未发布着色器资源拒绝，失败时保留旧测试包。详细范围见配套Mod的 `docs/archive/level/原版操作与测试世界应用验收-20261104.md`。下文38项和41项是此前轮次的历史记录，不与48项叠加，也不代表当前版本全量验证；本轮未重跑全量JUnit／服务端GameTest、旧新组合兼容、其他加载器／第三方光影或长时压力。

效果资源编辑回归还覆盖：高级定义的无效／空白输入跨页签保留；同一转场资源的天空与后处理配置独立保留；源文件保存成功与应用到区域失败分别显示。

属性交互采用固定分类与操作区、连续滚动的参数区。日常效果使用中文用途说明、颜色、滑块、曲目及工程贴图选择；制作窗口默认参数视图，控件定义使用折叠区。雾距离图只表示距离关系，不以装饰图片冒充着色器预览。后处理缓冲图与处理步骤通过表单编辑并验证引用、数量、读写冲突及最终输出，原始定义仅保留为高级入口。

原生 WorkbenchScroll 保留控件实例与输入，负责裁剪、命中范围、滚轮、滚动条和键盘焦点跟随。隐藏面板必须清除命中范围；侧栏拖动优先交回原生控件，只有实际世界手势进入画布拖动。向量分量更新读取当前草稿，不使用创建控件时捕获的旧数组。

2026-11-04交互复验：真实S布局29项、效果制作10项、独立客户端完整38项通过；构建、lint与区域定向检查通过。客户端流程额外核对仅按右键不产生转向，以及深层灯光的三轴连续编辑与S保存。详细范围见配套Mod的 docs/archive/level/属性交互与连续滚动验收-20261104.md。

随后统一交互复验：完整原生流程41项通过，增加本体选择与显式控制点、中键环绕／Shift中键平移、输入拖选、分类切换视口稳定和大俯仰角F对准检查。原生按可见世界视口取景，另验窄视口下的高度拖动和属性开关；nearest覆盖编码缩放与浏览器绘制。高度断言等待最终提交确认，滚动遇到过期令牌重新观察。曾有一次S原子替换明确拒绝，完整复跑未复现，未改为绕过事务或自动重放。详细证据和限制见配套Mod的 `docs/archive/level/统一交互与原生工作台复验-20261104.md`。收帧／解码／共享绘制器整体重构仍单独处理。
