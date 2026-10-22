# 游戏开发服务器（Control）

WebUI **C 侧**连接本机游戏开发门户（`mchhui.rpgtoolkit.devtool.control`），供本地客户端 / mod 向编辑器发起 JSON 请求。串流帧协议已移除；当前只做控制面与查询。

## 入口

- 菜单：**编辑 → 游戏开发服务器**
- 打开后可改主机 / 端口 / 门户密码，并查看控制台（request / response / 连接事件）
- App 启动后 C 侧会**自动轮询**尝试连接（默认同密码 `mchhui`，`127.0.0.1:8765`）；关闭「自动连接」即停止

连接：`ws://127.0.0.1:8765/ws/control?password=…`  
状态：`GET /control/status`

帧格式见模组包文档（`request` / `notify` / `response`）。WebUI 作为订阅者：收 request，同连接回 response。

## WebUI 实现的方法

| method | params | 结果 |
| --- | --- | --- |
| `ping` | — | `{ pong: true }` |
| `items.list` | — | `{ items, count }`，每项含 `ref` / `name` / `path` / `id` / `tags` / `displayName?` / `componentCount` |
| `items.get` | `{ ref }` 或 `{ id }`（`name` 同 `ref`） | 完整 `.item` 视图；找不到 `not_found` |
| `items.query` | `{ tag? }` / `{ tags? }` / `{ id? }` | 过滤后的列表（tags 为 AND） |

数据来自当前工程会话中的 `.item` 源文件；未打开工程则列表为空。非法 JSON 的文件会被跳过。

未知 method 返回 `error: "unknown_method"`。

## 边界

- 属于 **C 侧外部服务交互**：连接配置与日志保存在本机（`localStorage`），不是共享工程数据。
- 仅 loopback + 门户密码；不代替工程服务（S）鉴权。
- 本协议不规定其它 method；后续工具可继续在 C 侧注册处理。

## Mod 侧示例

```java
ControlHub.INSTANCE.request("items.list", null)
    .thenAccept(result -> { /* 勿直接碰 MC 客户端线程 */ });
```
