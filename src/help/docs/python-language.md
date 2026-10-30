# Python 编辑器与语言服务规范

所有独立 Python 资源统一使用 `monaco/python/PythonEditor`，不要直接用普通 Monaco Editor 代替，也不要复制某个业务自己的补全器。分析使用真实 Pyright Worker；Java 类型来自 MC `python.stubs` 按需反射生成的 .pyi，不维护手写的 MC API 假数据。

## 环境与隔离

编辑器传入脚本类型。`profiles.ts` 是宿主注入能力的集中定义：common 无礼包全局变量；goal 提供现有目标 SDK 的装饰器、BaseGoalPy、st/cfg；kit 提供 kit/player/players/random；shop 提供 shop/player，支持模板参数、修饰器、条件和条目额度暂存句柄；actor 注入 `hook` 和 `Blackboard`，hook 名使用 Literal 联合类型，支持 18 种名称的字符串补全与无效名称诊断；ActorEvent / ActorScriptApi 来自游戏反射。item/enchantment/player 只提供普通 Python 和按需 Java 类型，宿主未实现前不虚构对应 API。

Worker 按「工程连接实例＋脚本类型」共享，同一环境多个编辑器复用，不跨工程或类型泄漏注入变量。每个视图拥有独立 LSP 文档，使用工程的有效资源和当前草稿填充虚拟 project/<类型>/；补全可读取 common 库的未打开源文件。内置覆盖规则与导出相同。

只在游戏 Control 在线时启动分析。断线立即终止 Worker、清除诊断、关闭提示浮层，保留编辑、语法高亮与草稿；重连重新获取运行环境并分析最新草稿。最后一个编辑器卸载时释放服务。异步回复必须检查文档/连接仍有效。

## Worker 文件桥接

`pyright.worker.ts` 只维护给上游 Pyright 的虚拟文件系统桥接，不实现 Python 语义分析。Java stub 更新限制为 .pyi，工程代码限制为 project/ 内的 .py，禁止路径穿越。文件变化通知 Pyright 使导入缓存失效，不往作者代码前拼接隐藏行。

ZenFS 的可写挂载使用普通有界缓冲区；默认可增长缓冲区会为每个小文件预留近 4GB 地址空间，大量反射 stub 会分配失败。通过挂载 metadata 的 noResizableBuffers 能力配置，不修改上游 Pyright 包源码。

验证：`test:python-language` 运行真实 Worker、桌面 CSP 产物、反射 fixture 的链式/别名 Java 补全、类型环境隔离、工程库导入以及离线/重连/释放生命周期。

## 演员脚本与类型注解

Pyright 使用 basic 类型检查，支持参数、返回值、变量注解、泛型（例如 `list[str]`）、联合类型（例如 `str | None`）、类型收窄、签名和悬停提示。类型不匹配会显示诊断；不会执行作者代码。语言服务仍仅在游戏 Control 在线时启用。

`@hook("` 可列出全部 hook，`@hook("ai` 可过滤到 `aistep`。装饰器保留被装饰函数的类型，但不会依据 hook 名自动标注函数参数：`def on_tick(event, blackboard)` 的参数仍为未知类型。新建模板显式注解 `event: ActorEvent` 和 `blackboard: Blackboard`；伤害事件可导入 `ActorHurtEvent` / `ActorDamageEvent` 获取具体成员。

Blackboard 是运行时动态 Python 对象，任意属性的静态类型默认为 Any。需要精确补全时，可用作者自己的 `Protocol` 声明黑板字段，再把参数注解为该 Protocol。`event.api()` 在 Mod Java 签名中返回 Object，链式补全无法自动识别 ActorScriptApi；可导入该类并用 `typing.cast(ActorScriptApi, event.api())` 显式标注。注解只影响分析，不保证运行时参数、nullability 或动态属性已初始化。

验证 `test:python-language` 增加了真实 Worker 的 18 个 hook 候选、前缀过滤、泛型/联合/返回值注解、类型收窄、装饰后返回类型和错误诊断。
