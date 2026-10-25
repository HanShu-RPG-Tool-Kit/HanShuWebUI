# 游戏开发服务器（Control）

WebUI **C 侧**连接本机游戏开发门户（`mchhui.rpgtoolkit.devtool.control`），供本地客户端 / mod 向编辑器发起 JSON 请求。串流帧协议已移除；当前只做控制面与查询。

## 入口

- 菜单：**编辑 → 游戏开发服务器**
- 打开后可改主机 / 端口 / 门户密码，并查看控制台（request / response / 连接事件）
- 控制台日志仅本会话内存（约 200 条）；可用「复制到剪贴板」导出全文（含 detail）便于粘贴排查
- App 启动后 C 侧会**自动轮询**尝试连接（默认同密码 `mchhui`，`127.0.0.1:8765`）；关闭「自动连接」即停止

## 已验证连法

前提：MC 客户端已起且日志出现 `rpgtoolkit.devtool server ready on 127.0.0.1:8765`。

1. **HTTP 探活（必须带密码）**  
   `GET /health` + 头 `X-DevTool-Password: mchhui`  
   或 `GET /control/status?password=mchhui`  
   无密码会 `401`，不能据此判断「服务没开」。
2. **WebSocket**（浏览器不能自定义握手头）  
   `ws://127.0.0.1:8765/ws/control?password=mchhui`  
3. 连上后再看 status，`subscribers` 应 ≥ 1。

C 侧按上述实现；握手超过约 4s 仍无 `open` 会中止并提示，避免永远停在「连接中」。

### 常见失败

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| HTTP `401` | 未带密码或密码错 | 默认 `mchhui` |
| HTTP 连不上 | 客户端未起 / 端口被改 | 看 MC 日志 `ready on …` |
| HTTP 正常、WS 一直挂起、`subscribers` 仍为 0 | **模组**对 `/ws/control` 鉴权握手无 101（旧版查询串精确匹配等） | 升级含「WS 前缀匹配」修复的客户端；本机可用 raw 升级对比：`/ws/stream` 能 101 而 `/ws/control?password=` 无响应即属此情况 |
| 连成 `/ws/stream` | 路径错 | 必须是 `/ws/control` |

## 游戏编辑辅助（WebUI → mod）

礼包编辑器可使用连接的 MC 客户端提供的实时目录，离线时仍可手动输入 ID：

- 药水效果：点击文本框自动展开目录，直接在该文本框输入名称或 ID 搜索，展示游戏当前语言的名称和资源包图标；上下键选择，Enter 或 Tab 接受，Esc 关闭。药水和音效列表自动读取全部结果，底层分批传输，不需要点击加载更多。
- 指令：按光标位置使用原版 Brigadier 补全；上下键选择，Tab 或 Enter 接受。只请求建议，不执行指令。含 `${…}` 插值的输入暂不请求原版补全。
- 音效：点击文本框搜索客户端实际加载的声音事件，列表每行右侧的播放图标可在游戏中试听（悬浮显示说明）。试听不改变当前值、不关闭列表；点击条目正文才选中。游戏聊天提供 `[停止试听]`；新试听替换旧试听，旧消息不能停止新试听。只停止本工具创建的声音实例，不影响其他声音；WebUI 不提供停止入口。
- Python：使用浏览器 Worker 内的 Pyright 和 `.pyi` 类型声明。游戏通过 `python.stubs` 提供 Java 公开签名；编辑器不执行脚本来推导类型。语言服务与工程保存分离，补全不会修改工程文件。

这些服务通过现有带密码的 Control 连接访问，不经过共享工程 S 执行游戏代码。断线、游戏版本不同或旧 Mod 未提供方法时，编辑内容保留，在线辅助可能不可用。

## 入站方法（mod → WebUI）

| method | params | 结果 |
| --- | --- | --- |
| `ping` | — | `{ pong: true }` |
| `items.list` | — | `{ items, count }`，每项含 `ref` / `name` / `path` / `id` / `tags` / `displayName?` / `componentCount` |
| `items.get` | `{ ref }` 或 `{ id }`（`name` 同 `ref`） | 完整 `.item` 视图（`display` 若有则来自本机快照缓存）；找不到 `not_found` |
| `items.query` | `{ tag? }` / `{ tags? }` / `{ id? }` | 过滤后的列表（tags 为 AND） |

数据来自当前工程会话中的 `.item` 源文件；未打开工程则列表为空。非法 JSON 的文件会被跳过。

未知 method 返回 `error: "unknown_method"`。

## HTTP：自动发版（publish）

与 Control WebSocket 同门户。菜单 **文件 → 自动发版（auto.pak）**（工程级，`project/exportActions`）会编译 combined PAK，再：

`POST /publish?name=auto.pak` · `Content-Type: application/octet-stream` · 头 `X-DevTool-Password` / `X-Pak-Name`

成功体含 `installed` / `kinds` / `publishedOrSkipped`；某 kind `RETAINED` 时 `ok` 仍可能为 true。实现：`src/gameDevServer/publish.ts`。主机/端口/密码与 Control 偏好相同（默认 `127.0.0.1:8765` / `mchhui`）。

## 出站方法（WebUI → mod）

WebUI 在 Control `phase===open` 时主动发 `{ type: request, id, method, params }`，等待同 `id` 的 `{ type: response }`（出站默认超时约 20s，覆盖单条图标等待约 8s）。

### `items.renderSnapshots`

批量生成展示快照，写入 C 侧 IndexedDB（见 [物品库指南](#item-guide)）。当前 WebUI 请求声明 `componentFormat: "tnbt-json-v1"`、`componentMode: "complete"`，组件值使用 [TNBT JSON](#tnbt-json)；响应必须回显相同 componentFormat 和 componentMode，否则不缓存结果，避免把旧协议生成的错误预览当作新快照。Mod 的文件、快照与 IBE 交换层已统一使用这套表示。

| | |
| --- | --- |
| **params** | `{ componentFormat: "tnbt-json-v1", componentMode: "complete", items: [{ key, id, components }], includeIcon?: boolean }`（`includeIcon` 默认 `true`；亦接受扁平一项） |
| **key** | 与 WebUI 指纹一致：`fnv1a(id+components)`，不含 count |
| **批量上限** | ≤ **128**；超出 mod 返回 `too_many_items`，WebUI 退避重试（按 24 切批仍可用，吃满吞吐用 128） |
| **吞吐** | 等 RPC 期间客户端约每帧处理一批（约 128）；图标单条等待约 **8s** |
| **result** | `{ componentFormat: "tnbt-json-v1", componentMode: "complete", snapshots: [{ key, ok, error?, display? }] }` |
| **display** | 可无 `icon`；可有 `iconPending: true`（文本先可用，WebUI 会再请求图标） |
| **iconPending 重试** | 同一指纹最多 **3** 次仍 `iconPending` 则接受纯文本快照并出队（避免 mod 图标永远不就绪时干烧）；强制刷新会重置计数 |
| **自动刷新** | 默认开；**编辑 → 自动刷新物品快照** 可关。关闭后 UI 不再因 miss/过期自动入队（手动刷新仍可用） |
| **其它错误** | 如 `no_level`：整包失败，WebUI 短暂退避 |

模组返回的 `display` 可不带 `snapshotOf`；WebUI **写入缓存时**用请求的 `key` 覆盖/写入 `snapshotOf`。刷新过程用活动列表稳定 id `items.snapshot-refresh` 更新进度条，队列清空后标成功。

### `items.edit.open` / `items.edit.done`

客户端 IBE 物品编辑（包 `mchhui.rpgtoolkit.devtool.itemedit`）。**两条独立消息**，不是「开会话 → 等结果」：

| 方向 | method | 类型 |
| --- | --- | --- |
| WebUI → mod | `items.edit.open` | request；成功即完，不 hold |
| mod → WebUI | `items.edit.done` | notify；用户在 IBE 点完成时另发 |

`params` / `done` 载荷：`{ uuid, hash, item: { id, components } }`（也接受扁平 `id`/`components`）。`uuid` 仅 hint（原样回传，业务可忽略）；`hash` 为 WebUI 版本令牌（当前用 `itemFingerprint`），写回时与本地指纹比对。无 cancel 通知、无写锁。

WebUI 入口：物品库资源树对 `.item` 右键 **发送到游戏内编辑**，或点击物品编辑器预览下方的同名按钮。冲突或找不到文档时丢弃并走 [活动列表](#activity-list)。

## 边界

- 属于 **C 侧外部服务交互**：连接配置与日志保存在本机（`localStorage`），不是共享工程数据。
- 物品展示快照缓存是 **C 侧 IndexedDB 状态**，不进工程文件、不经 S。
- 仅 loopback + 门户密码；不代替工程服务（S）鉴权。
- 本协议不规定其它 method；后续工具可继续在 C 侧注册处理。

## Mod 侧示例

```java
// 入站：查物品库
ControlHub.INSTANCE.request("items.list", null)
    .thenAccept(result -> { /* 勿直接碰 MC 客户端线程 */ });

// 出站由 WebUI 发起 items.renderSnapshots；mod 实现 handler 即可
```


### `items.edit.open` / `items.edit.done` 物品载荷

两条消息独立，沿用既有 uuid/hash 时序；升级的是载荷格式。open 的 params、opened 响应和 done 的 params 均携带 `componentFormat: "tnbt-json-v1"`、`componentMode: "complete"`。缺少/错误标记时 Mod 明确拒绝，不猜测旧 JsonOps patch。

```json
{
  "componentFormat": "tnbt-json-v1",
  "componentMode": "complete",
  "uuid": "opaque-hint",
  "hash": "original-version-token",
  "item": { "id": "minecraft:stick", "components": {} }
}
```

open 中 count 忽略，Mod 强制为 1；done 不携带 count，返回全部生效持久化组件。Mod 不计算 hash，uuid/hash 原样回传；C 侧原有接收者应先验证格式与原版本，再走原有草稿/事务路径，不能把 notify 当作工程写权限。关闭 IBE 不发取消消息。

参考 Mod `docs/itemedit.md`。本次协议适配不新增 WebUI IBE 按钮或替换现有回写协调实现。

## 礼包 Python 语言服务

礼包脚本编辑器使用 `monaco-pyright-lsp@0.1.7` 自带的 Pyright 1.1.386 Worker，提供语法诊断、类型推导、成员补全、悬浮类型和参数提示。Worker 与 typeshed 跟随 C 部署，运行时不请求 CDN、不执行作者脚本；未连接 Minecraft 时仅保留文本编辑、撤销与普通语法着色，不创建 Python Worker，不提供语言服务诊断、补全、悬浮或参数提示。连接后先准备 `python.stubs` 和玩家类型，再分析脚本，避免用不完整的上下文产生红线。

在线时一个 Worker 管理多个独立文档，最后一个编辑器关闭时清理。断线立即终止 Worker、撤销语言服务 Provider、清空所有脚本的 Pyright 诊断，并关闭已有补全窗口；不会修改草稿、光标和撤销历史。重连自动重新创建服务并分析最新草稿。初始化途中断线或关闭编辑器也会清理，旧服务的迟到结果不回填；旧 Mod 缺少 stub 服务时不启动文档分析。`__builtins__.pyi` 注入运行时全局，源文档不插入隐藏代码，保留模块 docstring、`__future__`、诊断行号及编辑范围。`player` 是 `ServerPlayer`，`players` 是该类型的元组，`random()` 返回 `float`；`kit.id` / `tags` 只读，`param()` 因动态参数 ID 返回 `Any`。

连接后的 `python.stubs` 先取 `ServerPlayer`，再取显式 `from net… import Class`、`java.type("全限定类名")` 所需类。返回类型的占位 `.pyi` 保留 Java 类型身份；补全前使用 Pyright 的 type-definition / hover 结果继续请求所需类，更新 Worker 虚拟文件系统并清理导入缓存。因此别名、函数返回值和玩家循环由 Pyright 推导，不是字符串补全表。每次请求最多 24 个类；单次光标请求最多追踪当前行末 16 个标识符、6 轮依赖，特别长的链可拆成局部变量。

存根按游戏进程 `runtimeId` 缓存在编辑会话内；重连时重新核对，游戏重启会清除旧类和缺失类结果。缓存不是工程内容，不进入 PAK 或协作事务。MC 端只执行 `Class.forName(name, false, loader)` 与 public 签名反射，不读取字段值、不初始化类、不调用成员。包含扁平化的公有继承成员、重载、静态成员、构造函数、数组与可表达的泛型；缺失的调试参数名显示 `arg0` 等。继承成员中无法绑定的泛型、Java method type variables、动态对象及无法反射的类型保守降为 `Any`；完整 Java 子类型关系、nullability、GraalPy 的所有隐式转换和任意动态 import 不做完整建模。连接端 classpath 没有的服务端专属模组类型不可获得。分析模块名 `jvm_*` 不会自动写入用户脚本。

验证入口：`npm run test:python-language` 自行启动隔离 Vite 和真实浏览器 Worker，使用桌面原有 CSP。先在相邻 Mod 仓库运行 `gradlew.bat test --tests "mchhui.rpgtoolkit.devtool.python.*"`，会生成 `build/python-stubs-test.json`；Web 验证随后用这些**实际 MC 反射签名 + mock Control 运输**检查玩家链式访问、别名、元组、多文档、诊断和 future import，以及离线不启动、断线清理、最新草稿重连、最后一个编辑器释放和初始化中断线。可用 `PYTHON_STUB_FIXTURE` 指定夹具；没有夹具时明确跳过 MC 集成部分。先 `npm run build` 后测试，还会检查生产 Worker。此验证不等于启动原生 MC 客户端并完成真实 Control 往返。

当前生产 Worker 为独立懒加载资源，约 19.6 MB（gzip 约 4.22 MB，含 typeshed）；本机浏览器验收初始化约 1.8–3.6 秒，实际 MC 签名首次链式补全约 0.84 秒，缓存后约 0.08 秒。耗时随设备与类数量变化。构建保留上游 `eval` 分支警告，但现有语言服务路径在 `script-src 'self'` 下通过验证，没有放宽 CSP。
