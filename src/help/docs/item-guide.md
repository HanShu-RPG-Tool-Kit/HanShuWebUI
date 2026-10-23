# 物品库：`.item` 与 `.itemstack`

进度工作区的 **物品库** 存放可复用的物品定义（`.item`）。礼包可以**内嵌**一份 ItemStack，也可以**链接**物品库里的 `.item`（按文件名去扩展名引用）。模组/游戏导出的快照文件是 **`.itemstack`**，导入物品库时会转成 `.item`。

## 两者区别

| | `.item`（物品库） | `.itemstack`（快照 / 交换） |
| --- | --- | --- |
| `format` | `rpgtoolkit:item` | `rpgtoolkit:itemstack` |
| 权威数据 | `item.id` + `item.components` | 同左，另有 **`item.count`** |
| 数量 | **不存**（发放数量由礼包等调用方决定） | 有 `count`（拖入礼包时作默认数量） |
| 标签 | 可选根级 `tags`（与 `.kit` 相同规则） | 无 |
| 必填 | `format`、`schemaVersion`、`item.id` | `item`；`format` 缺省时按 itemstack 认 |
| 用途 | 工程内复用、礼包链接、表视图 | 从游戏/模组导出；导入礼包或转成 `.item` |

引用名：文件 `apple.item` → 礼包链接字段写 `apple`（相对物品库文件名，不含扩展名）。从资源树或物品编辑器拖到礼包物品栏，可创建链接而非内嵌副本。

## `.item` 文件格式

工程文件**只持久化权威数据**，不再写入 `display`：

```json
{
  "format": "rpgtoolkit:item",
  "schemaVersion": 1,
  "tags": ["reward", "event/summer"],
  "item": {
    "id": "minecraft:diamond_sword",
    "components": {
      "minecraft:enchantments": { "levels": { "minecraft:sharpness": 5 } }
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `format` | 固定 `rpgtoolkit:item` |
| `schemaVersion` | 当前为 `1` |
| `tags` | 可选。游戏标签 string[]；空则不写入。交互与礼包相同（chip、回车/逗号添加）；去重大小写不敏感，保留先出现的写法。建议用稳定标识如 `reward`、`event/summer` |
| `item.id` | 必填，命名空间物品 ID，新建默认 `minecraft:stick` |
| `item.components` | 组件对象（可为空 `{}`） |

旧工程若仍带 `display`：解析时 **ingest 进本机缓存**（指纹一致→新鲜；不符→仍保留并标过期，同时排队刷新）。新快照写入缓存时**覆盖**旧条目。工程文件本身不回写 `display`（保存时剥掉）。

## 展示快照（本机缓存）

名称、tooltip、图标等展示数据在 **C 侧 IndexedDB**（`hanshu.itemSnapshots.v1`），不进工程目录、也不经 S。

- **指纹**：`fnv1a(id + components)`（**不含 count**）。缓存键与过期判定均为该指纹；写入时会把 `display.snapshotOf` 规范为请求时的指纹。
- **刷新**：WebUI 经 Control **出站**调用 mod 的 `items.renderSnapshots`（批量 ≤128，`includeIcon` 默认 true）。`iconPending: true` 时先显示文本快照，条目仍留在 needed 队列稍后重试。
- **miss / 过期**：编辑器先用 WebUI 近似渲染，并登记 needed；连上游戏开发服务器后自动 drain。
- **count**：数量变化不改指纹、不触发重新快照（发放数量由礼包等决定）。

## `.itemstack` 文件格式

```json
{
  "format": "rpgtoolkit:itemstack",
  "schemaVersion": 2,
  "item": {
    "id": "minecraft:apple",
    "count": 16,
    "components": {}
  },
  "display": { "…": "schemaVersion ≥ 2 时可带快照；可残缺" }
}
```

- 校验 `format` / `schemaVersion` 1..2；`item` 必填；`display` 可选。
- **导入权威只认 `item`**。`display`（若有）只 ingest 进本机 IDB，**不写入** `.item` / `.kit` 文件。
- `tooltipRaw` 等解析层忽略字段与现 Web 渲染一致。
- 拖入**礼包**物品栏：按内嵌 ItemStack 追加（保留 count / components；display 进缓存）。
- 拖入**物品库**：转成 `.item`（去掉 count，改 format，保留组件；`tags` 为空；display 进缓存）。

桌面拖出的 `.itemstack` 仍可带 `display` 方便交换，但工程持久化路径不依赖它。

## 编辑器

- 物品库可新建 / 导入 `.item`；也可拖入 `.itemstack` / `.json` 转成 `.item`。
- 主区：物品 ID、**标签**行、预览（本机快照优先）、NBT 风格组件树；可「查看源码」。
- 菜单 **编辑 → 刷新物品快照** / **刷新全部物品快照**：强制向客户端重新拉取（旧缓存保留至新快照覆盖；未连接则排队）。结果出现在 [活动列表](#activity-list)（统一状态栏铃铛）。
- 资源树有只读 **物品库表视图**：汇总文件名、引用名、ID、显示名、标签、组件数、快照状态（新鲜 / 刷新中 / 过期 / 无）。
- 本地化：`.item` 的标签与指令类字段一样**不进** `lang_*`；玩家可见名称若在组件/快照里，由游戏侧处理。

## 本机查询（游戏开发服务器）

打开工程后，本机 mod 可通过 [游戏开发服务器](#game-dev-server) Control：

- **入站**：`items.list` / `items.get` / `items.query` 读当前会话物品库（C 侧镜像）。
- **出站（WebUI→mod）**：`items.renderSnapshots` 批量拉展示快照写入本机缓存。

## 导出

导出 PAK 时，内置 **Item** 编译器把每个 `.item` 编成 server 平面的 **`.it`**（路径如 `items/apple.it`）：

```json
{
  "item": {
    "id": "minecraft:apple",
    "components": {}
  }
}
```

只保留运行时 `item`；`format` / `schemaVersion` / `tags` / `display` 不进包。详见 [导出 PAK](#export-pak)。

## 与礼包的关系

详见 [礼包：超参数与修饰器](#kit-guide)。礼包条目可以是：

1. **内嵌**：`{ id, count, components }`（或从 `.itemstack` 拖入；display 只进本机缓存）；
2. **链接**：`{ "item": "引用名", "count": n }`——展开时从物品库取 id/components，展示名/图标来自本机快照缓存，数量仍由礼包字段（可绑定修饰器）决定。

物品上的 `tags` 与礼包上的 `tags` 彼此独立：物品标签描述物品分类，礼包标签描述发放包分类；链接展开**不会**把物品 tags 并入礼包 tags。
