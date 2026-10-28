# 地图模板与导航（.level / .nav）

本页是 WebUI 侧的地图数据模型与编辑约定，对应 Mod 侧 RPGToolKit Level 模型 v3。**编辑侧不一定与运行时一一对应，但编译产物必须对齐**。

## 概念

- `level` 指世界/地图的数据模型，不是 `net.minecraft.world.level.Level`。
- 一个 MC 维度就是一个实例；维度存档自己保存「绑定了哪个地图模板」。
- 模板只描述内容（区域、静态导航点），不持有维度、玩家或运行态。
- 不做到达判定：导航只给方向和距离。

## 资源树

「地图」是唯一的地图分类：

```
地图
├─ 地图模板        .level（一个文件包含区域 + 静态导航器）
└─ 导航器
   ├─ 静态导航器   视图：模板内声明的导航点，按模板分组列出
   └─ 动态导航器   目录：独立 .nav 文件
```

- **地图模板**：源文件 `src/level/<模板名>.level`；模板名（去后缀）就是模板 ID。
- **静态导航器**：不是目录、没有自己的文件。点一行会打开所属 `.level`；改名/删除都在模板 JSON 里做。
- **动态导航器**：源文件 `src/navigator/<名称>.nav`，自己声明 `level`。

## .level 作者格式

```json
{
  "tags": ["demo:hub"],
  "regions": [
    {
      "id": "spawn",
      "areas": [
        {"x": [32, 47], "z": [32, 47], "y": [60, 90]},
        {"shape": "circle", "center": [40, 40], "radius": 8, "y": "all"}
      ],
      "custom_data": {}
    }
  ],
  "navigation": [
    {
      "id": "old_tower",
      "type": "rpgtoolkit:pos",
      "param": {"x": 40, "y": 72, "z": 40},
      "custom_data": {
        "rpgtoolkit:display_name": "old_tower.display_name",
        "rpgtoolkit:display_icon": "minecraft:compass",
        "rpgtoolkit:display_max_distance": 256
      }
    }
  ],
  "custom_data": {}
}
```

- 区域 `areas` 至少 1 个、最多 256 个；`shape` 可省略，按字段推断：`x`/`z` = 矩形，`center`/`radius` = 圆，`points` = 多边形。
- `y` 为 `"all"` 或 `[min, max]`。
- 子对象 `id` 只在本模板内唯一，不能包含 `$ \ / : * ? " < > |`。
- `tags` 与礼包/商店同一套规范化（去首尾空白、NFC、大小写不敏感去重）。
- `custom_data` 直接暴露为 JSON 对象。

## 编译

一个 `.level` 编译成多个运行时文件：

| 产物 | 内容 |
| --- | --- |
| `levels/<模板>.json` | `{ tags, custom_data }` |
| `regions/<模板>$<区域 id>.json` | `{ level, areas, custom_data }` |
| `navigation_points/<模板>$<导航点 id>.json` | `{ level, type, param, custom_data }` |

- 子对象导出 ID = `<模板名>$<本地 id>`，文件名与 ID 对齐。
- `level` 字段由编译器写入，作者文档里不写。
- 一个 `.nav` 编译成 `navigation_points/<名称>.json`，内容即 v3 形状。
- 重复导出路径（例如模板子项与动态导航点撞名）会报编译错误。

## .nav（动态导航点）

```json
{
  "level": "hub",
  "type": "rpgtoolkit:pos",
  "param": {"x": 40, "y": 72, "z": 40},
  "custom_data": {
    "rpgtoolkit:display_name": "display_name",
    "rpgtoolkit:display_icon": "minecraft:compass"
  }
}
```

- 本轮只支持 `rpgtoolkit:pos`。
- **旧版 `.nav`（`dimension` / `label` / `radius` / `public` / `entity_*` / 顶层 `x,y,z`）会被明确拒绝**，不静默丢字段。
- `display_*` 只是显示提示，不是授权，也不是到达判定。

## 本地化

`display_name` 是**语义键**，不是明文。译文与 `.quest` / `.kit` 同布局：

- `.level` → `assets/<locale>/lang_level/<模板名>.lang`
- `.nav` → `assets/<locale>/lang_nav/<名称>.lang`

动态导航点的 `display_name` 固定使用键 `display_name`。静态导航点建议用 `<导航点 id>.display_name`；在模板编辑区下方的「本地化文本」里填写当前语言译文。模板主体目前直接显示 JSON（可视化编辑器后续再做）。

## 已知边界

- 不提供到达判定、接近半径或公开标记。
- 模板改名会改变其所有子对象的导出 ID；引用方需自行处理。
- 跨维度、跨服转移不在本模型内。
