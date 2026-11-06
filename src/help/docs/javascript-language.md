# RPGTK-JS 编辑器与语言服务

RPGTK-JS 是本项目的 Nashorn ES5 脚本方言，工程源文件为 `src/script/<common|goal|kit|shop|actor|player>/<id>.js`。IBE 插件仍使用其独立 Python 运行时，不属于这里的内容脚本。

## 作者语法

```javascript
import SoundEvents from "net.minecraft.sounds.SoundEvents"
import PlayerEvent from "mchhui.rpgtoolkit.feature.script.player.PlayerEvent"
require fx from "effects"

@hook("tick")
function on_tick(event: PlayerEvent, board: Blackboard): void {
    fx.spark(event.player());
}
```

`import Ident from "FQCN"` 只引 Java 类型；`require Ident from "common id"` 只引通用脚本。它们必须独占顶层一行，不能用 ES 模块具名导入、相对路径或 Node 式 `require()`。通用脚本通过 `exports.name = value` 导出；宿主负责模块缓存和权限，不允许 `load` / `loadWithNewGlobal`。

`@hook` 必须在自由函数声明正上方一行，函数有两个具名参数。所有顶层具名函数都必须为每个参数和返回值写类型，签名只占一行；允许简单名、点分名和数组类型，禁止可选参数、默认参数、泛型、interface/type、类和箭头函数。复杂类型由共享 `.d.ts` 提供命名类型。可选第二参数为 `{cancellable:false}`；common 事件订阅使用完整事件类名与 `{priority:"NORMAL",receiveCancelled:false}`。编辑器、PAK 导出与 Mod 作者源码加载均硬校验这些规则。

目标定义在 import / require 之后、业务函数之前，连续写唯一的 `@goal("id")`、`@config(field(...))`、`@state(field(...))` 三行；空字段也保留空注解。`field(name,type)` 表示必填，`field(name,type,defaultLiteral)` 表示有默认值，第四参数可用 `{required:true}` 覆盖。事件使用紧邻函数上一行的 `@subscribe(EventAlias,{priority:"NORMAL",receiveCancelled:false})`；`update_state`、`localize`、`deliver` 是带类型签名的顶层函数。交付声明见[脚本资源](#script-resources)。

## 行号与类型

方言变换严格一行换一行。编辑侧仅注释 hook / Goal 注解，保留参数与返回类型，交给 TS 子集虚拟文档；导出时同行剥掉签名类型，import / require 转成运行时绑定。作者文件与 PAK 均用 `.js`。作者、虚拟文档、PAK 源码和引擎报错保持相同行数，不产生 source map；hook 不再注入参数 JSDoc。

`monaco/javascript/JavaScriptEditor` 使用独立浏览器 Worker 中 TypeScript 的 tsserver 语言服务引擎。它分析 JS、推导类型、提供成员补全、悬浮信息、调用签名和诊断，不执行作者脚本。相同工程与宿主类型共享 Worker；各文档保持模块隔离，最后一个编辑器关闭时释放。离线仍可分析普通 JavaScript 和工程 common 导出；同步本地类型库后也能分析 Java 类型。

`javascript.stubs` 返回工程级共享 `.d.ts` 虚拟文件，Java 类型按 `JavaTypeMap` 与 `Java.type` 关联，不把全量 Minecraft 类型插入每个缓冲区。显式 Java imports 同时提供值和签名可用的类型；相关 Java 类型按需加载。有本地完整类型库时优先使用该快照；没有时在线按需请求，断线和游戏进程变化清理在线临时类型。不同宿主仅拥有各自的全局变量：kit 的 kit/player/players/random，shop 的 shop/player，goal 的 cfg/st/pick_locale/update_satisfied_state/complete/fail。事件类型由作者签名明确声明，`Blackboard` 保持动态键。类型判断使用原生 `value instanceof JavaType`。

## Java 回调推导

Java 方法要求公开函数式接口（单一抽象方法，SAM）时，可以传普通内嵌 `function`，无需写参数类型。类型库提供 JS 函数签名和 Java 接口对象两种参数形式，保留 Consumer、Predicate、Function、Comparator 等签名；继承泛型和回调参数的 `? super T` 会代入具体类型。例如 `List<ServerPlayer>.forEach(function(player) { ... })` 中 player 推导为 ServerPlayer；removeIf 的回调必须返回 boolean；Stream.map 的返回类型可继续传给后续回调。悬浮、成员补全和诊断沿用现有语言服务。

需要 API 声明保留具体泛型。裸集合或无类型上下文的独立函数不能可靠推导参数；多抽象方法接口不作为函数回调，声明自身含泛型方法的复杂 SAM 暂不展开。此功能不开放作者箭头语法，也不要求内嵌 function 写类型。使用本地类型库的用户升级 Mod 后须手动重新同步，旧快照不会自动变成新签名。

## 本地游戏类型库

从菜单栏「编辑 → 同步游戏类型库…」打开同步窗口，连接游戏后点击「开始同步」。不会在打开窗口、打开工程或重连时自动下载完整库。窗口显示扫描进度、已获取类数量、声明大小和上次同步时间，支持取消；取消、断线或保存失败保留之前的完整快照。新版 WebUI 需要配套支持 `javascript.library.page` 的 Mod。

同步覆盖当前游戏类索引中可反射的公开类型、依赖与 actor/player hook 快照；无法读取或非公开类计入不可用候选，不代表这些类有可用静态声明。新库分批下载到本机 IndexedDB 的 `hanshu.java-library.v1`，完整保存后原子替换当前快照。它是 C 侧提示缓存，不写工程、不上传 S。缓存按游戏 host:port 区分，不保存密码；清除网站数据会删除缓存，不同浏览器或 WebUI origin 不共享缓存。更换游戏／模组版本后须手动重新同步，旧快照不会自动更新。

刷新或重启 WebUI 后离线也可以补全、悬浮、查看重载参数、检查类型和搜索导入 Java 类。Worker 仅从本地库按需加载相关声明，不一次解析整个库。未同步、未收录或动态生成的类不保证离线可用。

通用脚本按 id 发布独立虚拟模块，`require fx from "effects"` 的类型来自该模块的 exports。其他宿主不能互相 require。类型检查不是运行时授权，工程保存依旧经 S 的原有文件事务。

补全列表区分方法与字段：接受无参方法 `level` 会插入 `level()`；有参方法会把光标放入括号并显示参数提示；字段保持字段名，已有调用括号不会重复插入。诊断发现未加载的 Java 接收者类型时会按需请求类型库，类型更新后重新检查，避免空占位声明留下误报。普通 JS 检查器的延迟结果不会覆盖方言脚本自己的诊断。

## Java 类导入

按 **Alt+/** 手动打开补全列表（原有 Ctrl+Space 仍可用）。悬浮和调用参数提示显示类型；重载方法的参数提示保留各个签名，可用提示框的上下箭头切换，并随当前参数更新提示。离线补全不因游戏开发服务器自动重连轮询而收起；仅在**已连接变为断开**时关闭补全／参数提示，避免沿用失效的在线结果。

在 `@hook("` 内补全会列出宿主钩子 id，并在详情中显示注册表里的 `eventClass`（若有）。语言服务会按已写的 `@hook` **预加载**对应事件类型声明，但**不会改写**函数参数类型——`event`／`blackboard` 仍须作者签名声明；写对类型后才有成员补全。已连接游戏或已同步类型库时，还会对照注册表检查第一个参数类型是否等于该 hook 的 `eventClass`（允许 import 别名或简短类名；`any` 与错误基类会报方言错误）。player／actor 脚本可用右键或 **Ctrl+Alt+H**「插入钩子函数…」：从当前宿主／本地类型库钩子表选择一项，一次写入 `import`、`@hook` 与带事件类型的函数骨架。

悬浮、参数提示和类型报错中的 Java 类型使用简短类名（例如 `ServerLevel`），隐藏虚拟类型库的 `jvm_…_d_…` 命名空间；数组和各个重载的类型仍保留。内部分析继续使用完整类型标识。

右键「导入 Java 类…」或 Ctrl+Alt+J，通过 `javascript.classes.search` 搜索游戏公开类。可选别名自动避让已有名称；确认后插入方言 import，一次撤销可恢复。操作重新核验工程、连接、文档版本和只读状态，不会把迟到搜索结果写进已切换的文档。

## 反馈语言服务问题

补全缺失、红线不正确、参数提示异常或长时间无响应，都可以导出诊断文件：

1. 在当前页面复现一次问题，保持相关脚本打开。
2. 点击编辑器右上角的「诊断」，可填写操作步骤、预期结果与实际结果。
3. 点击「下载诊断文件」，将生成的 `.json` 发给协助排查的人；界面异常也可附一张截图。

文件包含当前源码、编辑与运行时变换、红线、相关 common / Java 类型虚拟文档、游戏连接状态，以及近期补全、悬浮、参数提示和异常记录。只下载到本地，不会自动上传；连接配置中的密码不写入报告。只读、离线和 Worker 无响应时也可以导出，无法取得的 Worker 快照会明确标注超时或错误。

记录从当前页面加载后开始，采用有数量上限的近期历史；切换编辑器保留历史，刷新页面后需重新复现。导出不会运行作者脚本、修改文件或保存工程。

## 验证入口

`test:javascript-dialect` 验证同行变换、红线与跨仓契约；`test:javascript-builtins` 验证全部内置目标；`test:javascript-language` 以真实浏览器 Worker 验证成员与返回类型、common 导出、诊断行号和多文档隔离。这些自动化不等于已在原生 Minecraft 客户端完成全部玩法验收。

`test:javascript-diagnostics` 验证真实编辑器下载、只读/离线导出、Worker 超时与崩溃证据、凭据脱敏和资源释放。

`test:javascript-members` 验证玩家模板无内置 JS 误报、Java 方法/字段按需加载、真实补全接受与括号/光标行为，以及未知成员仍正确报错。

`test:java-library` 验证编辑菜单入口、手动分页同步、IndexedDB 持久化、失败/取消保留旧库，以及刷新后的真实离线类型链、悬浮、诊断和类搜索。

`test:java-callbacks` 使用 Mod 实际反射生成的声明验证泛型回调参数与返回值、流式 map、重载、Java 接口对象兼容、错误返回与非 SAM 拒绝，以及冷启动 Monaco 回调依赖加载。
