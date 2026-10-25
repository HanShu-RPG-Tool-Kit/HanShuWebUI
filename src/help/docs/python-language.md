# Python 编辑器与语言服务规范

所有独立 Python 资源统一使用 `monaco/python/PythonEditor`，不要直接用普通 Monaco Editor 代替，也不要复制某个业务自己的补全器。分析使用真实 Pyright Worker；Java 类型来自 MC `python.stubs` 按需反射生成的 .pyi，不维护手写的 MC API 假数据。

## 环境与隔离

编辑器传入脚本类型。`profiles.ts` 是宿主注入能力的集中定义：common 无礼包全局变量；goal 提供现有目标 SDK 的装饰器、BaseGoalPy、st/cfg；kit 提供 kit/player/players/random；item/entity/enchantment/player 只提供普通 Python 和按需 Java 类型，宿主 hook/黑板未实现前不虚构对应 API。

Worker 按「工程连接实例＋脚本类型」共享，同一环境多个编辑器复用，不跨工程或类型泄漏注入变量。每个视图拥有独立 LSP 文档，使用工程的有效资源和当前草稿填充虚拟 project/<类型>/；补全可读取 common 库的未打开源文件。内置覆盖规则与导出相同。

只在游戏 Control 在线时启动分析。断线立即终止 Worker、清除诊断、关闭提示浮层，保留编辑、语法高亮与草稿；重连重新获取运行环境并分析最新草稿。最后一个编辑器卸载时释放服务。异步回复必须检查文档/连接仍有效。

## Worker 文件桥接

`pyright.worker.ts` 只维护给上游 Pyright 的虚拟文件系统桥接，不实现 Python 语义分析。Java stub 更新限制为 .pyi，工程代码限制为 project/ 内的 .py，禁止路径穿越。文件变化通知 Pyright 使导入缓存失效，不往作者代码前拼接隐藏行。

ZenFS 的可写挂载使用普通有界缓冲区；默认可增长缓冲区会为每个小文件预留近 4GB 地址空间，大量反射 stub 会分配失败。通过挂载 metadata 的 noResizableBuffers 能力配置，不修改上游 Pyright 包源码。

验证：`test:python-language` 运行真实 Worker、桌面 CSP 产物、反射 fixture 的链式/别名 Java 补全、类型环境隔离、工程库导入以及离线/重连/释放生命周期。
