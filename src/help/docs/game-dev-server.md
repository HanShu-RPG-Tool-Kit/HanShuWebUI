# 游戏开发服务器（Control）

WebUI **C 侧**直接连接本机 Minecraft 客户端的开发门户，Control 双向传递编辑请求与通知；游戏画面和键鼠使用同一门户的独立串流连接。工程服务 S 负责读取、保存与协作权限。三个部分的职责和端口分别配置。

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

这里的 `127.0.0.1` 指运行浏览器这台电脑上的游戏客户端，不是工程服务 S。网页可能运行在 5173 或其他端口，游戏门户默认仍为 8765。开发启动若用了 `-PdevtoolPort=8767`，此面板也必须改为 8767；或者让客户端恢复默认 8765。修改配置后点「应用」或「立即重连」。

### 常见失败

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| HTTP `401` | 未带密码或密码错 | 默认 `mchhui` |
| HTTP 连不上 | 客户端未起 / 端口被改 | 看 MC 日志 `ready on …` |
| `Failed to fetch`、关闭码 `1006` | 浏览器未完成正常 HTTP/WS 连接，单靠该码不能区分原因 | 核对面板显示的游戏门户地址与实际客户端日志；不要把网页/S 的端口填成门户端口 |
| HTTP 正常、WS 一直挂起、`subscribers` 仍为 0 | **模组**对 `/ws/control` 鉴权握手无 101（旧版查询串精确匹配等） | 升级含「WS 前缀匹配」修复的客户端；本机可用 raw 升级对比：`/ws/stream` 能 101 而 `/ws/control?password=` 无响应即属此情况 |
| 连成 `/ws/stream` | 路径错 | 必须是 `/ws/control` |

## 游戏编辑辅助（WebUI → mod）

礼包编辑器可使用连接的 MC 客户端提供的实时目录，离线时仍可手动输入 ID：

- 药水效果：点击文本框自动展开目录，直接在该文本框输入名称或 ID 搜索，展示游戏当前语言的名称和资源包图标；上下键选择，Enter 或 Tab 接受，Esc 关闭。药水和音效列表自动读取全部结果，底层分批传输，不需要点击加载更多。
- 指令：按光标位置使用原版 Brigadier 补全；上下键选择，Tab 或 Enter 接受。只请求建议，不执行指令。含 `${…}` 插值的输入暂不请求原版补全。
- 音效：点击文本框搜索客户端实际加载的声音事件，列表每行右侧的播放图标可在游戏中试听（悬浮显示说明）。试听不改变当前值、不关闭列表；点击条目正文才选中。游戏聊天提供 `[停止试听]`；新试听替换旧试听，旧消息不能停止新试听。只停止本工具创建的声音实例，不影响其他声音；WebUI 不提供停止入口。
- JavaScript：浏览器 TypeScript Worker 使用共享 `.d.ts` 类型库；游戏通过 `javascript.stubs` 提供 Java 公开签名。方言闸门独立检查 import / require / @hook 的形态。语言服务与工程保存分离，不执行脚本推导类型。

这些服务通过现有带密码的 Control 连接访问，不经过共享工程 S 执行游戏代码。断线、游戏版本不同或旧 Mod 未提供方法时，编辑内容保留，在线辅助可能不可用。

## 地图区域编辑

打开 `.level` 后有三种配合方式，均编辑当前窗口的同一份地图草稿：

- 「离线 3D」只绘制区域体积与地标，不加载游戏世界。
- 「游戏内」通过 `level.edit.begin/sync/end/status/cancel` 绑定草稿，显示真实游戏 JPEG，并经 `/ws/stream-input` 回传 RPIN 键鼠；模组用 `level.edit.changed` 返回几何提案。
- 「魔杖圈选」绑定同样的草稿会话，浏览器继续显示离线 3D；用户右键地图魔杖打开本项目原生世界工作台，选区和属性同步回来。

编辑提案进入本窗口的撤销历史，Ctrl+S 经 S 保存源文件。它不自动发布 PAK。「应用到当前测试世界」另行生成并验证本机测试产物，成功后绑定当前维度；仅支持有权限的本机集成服务端，失败时保留旧包与绑定。工程内新建、尚未发布到游戏的着色器资源须先通过现有资源发布流程加载，不能靠草稿同步获得运行时效果。

G自由观察只移动编辑镜头；「进入游戏试玩」恢复实际玩家和原版键位，玩家走入／离开区域才触发对应运行时效果。应用结果、当前模式和操作提示在编辑器内显示。连接面板正在编辑但尚未应用的端口不会被状态轮询覆盖。完整用法见[地图模板与导航](#level-guide)，实现和复验入口见[区域编辑器开发与验收](#region-editor-development)。

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
| **自动刷新** | 默认开；**编辑 → 自动刷新物品快照** 可关。关闭后 UI 不再因 miss/过期自动入队；手动“刷新当前文档 / 刷新全部”仍可用，覆盖 `.item`、`.itemstack`、`.kit`、`.shop`，并按指纹去重 |
| **其它错误** | 如 `no_level`：整包失败，WebUI 短暂退避 |

模组返回的 `display` 可不带 `snapshotOf`；WebUI **写入缓存时**用请求的 `key` 覆盖/写入 `snapshotOf`。刷新过程用活动列表稳定 id `items.snapshot-refresh` 更新进度条，队列清空后标成功。

### `items.edit.open` / `items.edit.done`

客户端 IBE 物品编辑（包 `mchhui.rpgtoolkit.devtool.itemedit`）。**两条独立消息**，不是「开会话 → 等结果」：

| 方向 | method | 类型 |
| --- | --- | --- |
| WebUI → mod | `items.edit.open` | request；成功即完，不 hold |
| mod → WebUI | `items.edit.done` | notify；用户在 IBE 点完成时另发 |

基础物品载荷为 `{ uuid, hash, item: { id, components } }`，并带下文的 TNBT 格式标记。`hash` 为 WebUI 的物品指纹；WebUI 同时按不透明 `uuid` 绑定原工程、文档和版本。无 cancel 通知；打开编辑器不持有工程写锁。

WebUI 入口：物品库资源树对 `.item` 右键 **发送到游戏内编辑**，或点击物品编辑器预览下方的同名按钮。结果按原源文件和语言版本组成一个事务提交。源文件、译文或本窗口草稿发生冲突时，整批不写入，冻结的结果进入协作面板的可恢复提交，并走 [活动列表](#activity-list) 提示。

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

open 中 count 忽略，Mod 强制为 1；done 不携带 count，返回全部生效持久化组件。Mod 不计算 hash，uuid/hash 原样回传；C 侧接收者验证格式、原会话与原版本，再走工程事务路径，不能把 notify 当作工程写权限。关闭 IBE 不发取消消息。

参考 Mod `docs/itemedit.md`。

### 工程显示文本本地化 v2

打开物品或实体前，WebUI 请求 `localization.capabilities`；支持端返回 `{version: 1, protocols: ["hanshu-localization-v1"]}`。新会话使用 `version: 2`，物品增加 `editId`、`receiver`（均为本次不透明接收标识）；实体沿用原有 `editId`、`receiver`。成功响应须回显 `version` 与 `editId`，done 须回显接收标识和源 `hash`。

open 的可选 `localization` 包含 `protocol`、`activeLocale`、`availableLocales` 和 `bindings`。每条绑定仅包含不透明 `bindingId`、字段名、`semanticKey`、只读 `runtimeKey`、`componentKind: "translate"` 及本次授权语言的 `translations`。不下发工程文件路径。IBE 的语言分类编辑译文，源 Component 保持引用；绑定创建、解除及删除绑定行在 WebUI 完成。

done 的 `localization` 回传 `{protocol: "hanshu-localization-v1", operations: [...]}`。首版只接受 `translation.set`、`translation.remove`，字段为 `bindingId`、`locale`、`expected` 和 set 的 `value`。`expected: null` 表示缺失，与空字符串不同。重复操作、未知绑定/语言/操作、附带任意路径、原值不匹配，以及被替换或重复的翻译引用均拒绝。

WebUI 保留 open 时的源正文、源版本、所有授权语言正文和版本。结果通过 `ProjectClient.apply` 将源文件与语言修改一次提交；未修改语言以版本检查参与同一事务。IBE 无语言文件写入能力。提交结果未知时沿用事务日志原编号查询，不能创建新请求重做；本地草稿冲突也先持久保存冻结结果，供协作面板恢复。

旧端不支持该能力时，WebUI 提示本地化不可编辑，仍允许编辑其他字段；回写时要求原本地化 Component 原样保留。旧端若转换绑定或高级文本，WebUI 恢复 open 时冻结的原始 TNBT，再提交其他字段；包含绑定的 Lore 列表整体只读，不接受旧端重排或删除。新版 open 还携带只读字段列表 `readOnlyFields`；没有稳定绑定身份的高级 Lore 使用 `freezeLore` 禁止结构操作。游戏端规范化未知字段也不会改写这些源文本。普通游戏内 IBE 会话没有工程本地化分类。

### 实体属性增量协议

`localization.capabilities.protocols` 可另行包含 `hanshu-entity-attributes-v2`，独立于显示文本能力。支持时 `entities.edit.open` 携带可选 `attributes`：

```json
{
  "protocol": "hanshu-entity-attributes-v2",
  "bindings": [{
    "bindingId": "opaque",
    "attributeId": "minecraft:max_health",
    "base": 20,
    "modifiers": [{"id":"example:bonus","amount":2,"operation":"add_value"}]
  }]
}
```

`bindingId` 绑定 open 时的属性记录；`base: null` 表示尚无该属性记录。属性授权范围在 open 时固定，修饰器 ID 可直接编辑，须为有效资源标识符且在同一属性内唯一；不再预分配 ID。工程路径不从回包推导。未知记录、重复 ID、非有限数值和旧格式 `Attributes` 不授予编辑权。

done 的 `attributes` 为 `{protocol: "hanshu-entity-attributes-v2", operations: [...]}`，操作形式：

| op | 比较原值 | 新值 |
| --- | --- | --- |
| `attribute.base.set` | `expected: number \| null` | `value: number` |
| `attribute.base.remove` | `expected: number` | 无；仅允许清空修饰器且无未知属性字段的记录 |
| `attribute.modifier.set` | `expected: {amount, operation} \| null` | `value: {amount, operation}` |
| `attribute.modifier.remove` | `expected: {amount, operation}` | 无 |

每项携带 `bindingId`，修饰器项另带 `modifierId`。运算方式为 `add_value`、`add_multiplied_base`、`add_multiplied_total`；变更数值必须有限且绝对值不超过 `1e12`，游戏端还按原版属性注册表验证基础值范围。所有 expected 都比较 open 的冻结原值，同一字段不得重复提交。一个批次可先移除修饰器再移除基础值；已有未知属性字段会阻止基础值移除。向尚未设置的属性添加修饰器时，必须在同批次设置基础值。

完整候选模板的原生 `attributes` 和旧版 `Attributes` 必须与 open 一致，键的排序不影响比较。WebUI 验证全部增量后只修改授权字段，保留未知字段及无关记录；源与本次语言文件仍通过同一次工程事务提交。未协商到能力时，不发送属性编辑上下文，并拒绝旧端对完整属性数据的任何覆盖。

## JavaScript 语言服务

脚本编辑器在浏览器 Worker 内使用 TypeScript 的 tsserver 语言服务引擎，分析与补全不执行作者代码。游戏通过 `javascript.stubs` 提供 Java 公开签名的 `.d.ts` 类型库，通过 `javascript.classes.search` 提供类搜索，通过 `javascript.playerHooks` / `javascript.actorHooks` 和对应 `.changed` 通知提供 hook 注册表。

类型声明按 `runtimeId` 缓存在编辑会话内，断线或游戏进程变化会清理，不保存到工程或 PAK。Java imports 经同行变换成为 `Java.type("FQCN")`，类型库中的 `JavaTypeMap` 为其提供静态类型；完整 MC API 不内联进每份作者缓冲区。详细语法、生命周期和验证入口见[JavaScript 编辑器与语言服务](#javascript-language)。

修饰器统一列表使用 `attribute.modifiers.replace` 操作，`rows` 每项包含目标 `bindingId`、`modifierId`、`value:{amount,operation}`，已有条目另携带 `origin:{bindingId,modifierId}`。origin 必须来自 open 快照且不可重复，用于跨属性移动或重命名时保留未知 NBT 字段；新条目省略 origin。该操作不得与单修饰器 set/remove 混用。新增属性须在同批操作显式设置基础值。

### IBE 文本会话（`ibe-display-text-v1`）

能力协商优先选择该协议。`items.edit.open`、`entities.edit.open` 使用 version 2，在 `displayText` 中发送 `protocol`、`activeLocale`、`availableLocales` 和有序 `rows`；不同时发送旧 `localization`。每行包含 `rowId`、`field`、`present`、`localized`、`literal`、`translations`，外加 open 专属 `source/reference/readOnly`。无工程路径和文件写入凭据。旧版继续使用原本地化协议；含停用本地化备份的 lore 会冻结结构，避免按行号错配。

Done 的 `displayText` 为 `{protocol,rows}`，不带 `source/reference/readOnly`。原行的 `rowId/field` 不可变，位置可变；移除行代表删除，名称行身份须保留，通过 `present:false` 表示未设置。新 lore 行为 `new:<唯一标识>`、`field:item.lore`，复制可带 `copyOf` 指向 open 中的原 lore 身份，由 WebUI 分配独立本地化绑定。新身份、重复身份、来源和语言均经校验；固定文本与译文分别保存，模式切换不隐式覆盖另一份内容。

客户端按身份恢复源行、顺序与编辑信息，不按文字相等或数组索引匹配。原始 NBT 文本不能绕过表单；其他组件／实体字段仍走既有编辑流程。结果最终与全部已读取语言版本合并成一个 S 事务，冲突时整批保留待处理。`rowId/copyOf` 只在本次会话生效，不导出到 Minecraft。
