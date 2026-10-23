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

## 入站方法（mod → WebUI）

| method | params | 结果 |
| --- | --- | --- |
| `ping` | — | `{ pong: true }` |
| `items.list` | — | `{ items, count }`，每项含 `ref` / `name` / `path` / `id` / `tags` / `displayName?` / `componentCount` |
| `items.get` | `{ ref }` 或 `{ id }`（`name` 同 `ref`） | 完整 `.item` 视图（`display` 若有则来自本机快照缓存）；找不到 `not_found` |
| `items.query` | `{ tag? }` / `{ tags? }` / `{ id? }` | 过滤后的列表（tags 为 AND） |

数据来自当前工程会话中的 `.item` 源文件；未打开工程则列表为空。非法 JSON 的文件会被跳过。

未知 method 返回 `error: "unknown_method"`。

## 出站方法（WebUI → mod）

WebUI 在 Control `phase===open` 时主动发 `{ type: request, id, method, params }`，等待同 `id` 的 `{ type: response }`（出站默认超时约 20s，覆盖单条图标等待约 8s）。

### `items.renderSnapshots`

批量生成展示快照，写入 C 侧 IndexedDB（见 [物品库指南](#item-guide)）。请求/响应 JSON 形状不变；约束与实现以模组侧为准。

| | |
| --- | --- |
| **params** | `{ items: [{ key, id, components }], includeIcon?: boolean }`（`includeIcon` 默认 `true`；亦接受扁平一项） |
| **key** | 与 WebUI 指纹一致：`fnv1a(id+components)`，不含 count |
| **批量上限** | ≤ **128**；超出 mod 返回 `too_many_items`，WebUI 退避重试（按 24 切批仍可用，吃满吞吐用 128） |
| **吞吐** | 等 RPC 期间客户端约每帧处理一批（约 128）；图标单条等待约 **8s** |
| **result** | `{ snapshots: [{ key, ok, error?, display? }] }` |
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

WebUI 入口：物品库资源树对 `.item` 右键 **在游戏中编辑…**。冲突或找不到文档时丢弃并走 [活动列表](#activity-list)。

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
