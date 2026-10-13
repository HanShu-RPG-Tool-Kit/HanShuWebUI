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
  },
  "display": {
    "locale": "zh_cn",
    "name": [{ "text": "锋利钻石剑", "color": "#55FFFF" }],
    "icon": { "mime": "image/png", "size": 128, "glint": true, "data": "…" },
    "snapshotOf": "fnv1a:…"
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
| `display` | 可选。仅编辑器展示用的游戏快照（名称、tooltip、图标等），**不是**权威数据 |

`display.snapshotOf` 是生成快照时对 `id + components` 的指纹（不含 count）。编辑改了 id/组件后指纹对不上 → 快照过期：tooltip 改由 WebUI 近似渲染，图标可保留并标过期。

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
  "display": { "…": "schemaVersion ≥ 2 时可带快照" }
}
```

- `schemaVersion` 1：只有 `item`；2：可带 `display`。
- 拖入**礼包**物品栏：按内嵌 ItemStack 追加（保留 count / components / display）。
- 拖入**物品库**：转成 `.item`（去掉 count，改 format，保留组件与快照；`tags` 为空）。

## 编辑器

- 物品库可新建 / 导入 `.item`；也可拖入 `.itemstack` / `.json` 转成 `.item`。
- 主区：物品 ID、**标签**行、预览（快照优先）、NBT 风格组件树；可「查看源码」。
- 资源树有只读 **物品库表视图**：汇总文件名、引用名、ID、显示名、标签、组件数、快照状态。
- 本地化：`.item` 的标签与指令类字段一样**不进** `lang_*`；玩家可见名称若在组件/快照里，由游戏侧处理。

## 与礼包的关系

详见 [礼包：超参数与修饰器](#kit-guide)。礼包条目可以是：

1. **内嵌**：完整 `{ id, count, components, display? }`（或从 `.itemstack` 拖入）；
2. **链接**：`{ "item": "引用名", "count": n }`——展开时从物品库取 id/components/display，数量仍由礼包字段（可绑定修饰器）决定。

物品上的 `tags` 与礼包上的 `tags` 彼此独立：物品标签描述物品分类，礼包标签描述发放包分类；链接展开**不会**把物品 tags 并入礼包 tags。
