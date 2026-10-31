# 声誉阵营

游戏性工作区「声誉」分类可创建、导入和编辑 `.rep`。保存路径为 `src/reputations/<ID>.rep`，PAK 路径为 `reputations/<ID>.rep`；阵营 ID 来自文件名。

```json
{
  "format": "rpgtoolkit:reputation-faction",
  "version": 1,
  "defaultPoints": 1000,
  "neutralPoints": 500,
  "friendlyPoints": 1500,
  "hostile": ["bandit"],
  "hidden": false,
  "attackedByMobs": true,
  "banner": "<Base64 PNG，可选>"
}
```

## 字段

必填：`format` / `version` / `defaultPoints` / `neutralPoints` / `friendlyPoints` / `hostile` / `hidden` / `attackedByMobs`。可选：`banner`。未知键拒载；**不要**在 `.rep` 写 `name` 或 `color`。

| 字段 | 含义 |
| --- | --- |
| `defaultPoints` | 玩家尚未写入该阵营时的有效点数 |
| `neutralPoints` | 点数 ≥ 此值为中立下限；小于此值为敌对 |
| `friendlyPoints` | 点数 ≥ 此值为友好；必须 ≥ `neutralPoints` |
| `hostile` | 单向敌对的其它阵营 ID；需两边各自声明才互敌 |
| `hidden` | 为 true 时不出现在玩家声誉页 |
| `attackedByMobs` | 成员是否吸引附近无目标的敌对生物 |
| `banner` | 可选 Base64 PNG；游戏内以竖旗展示（缩进 ≤24×40，保持像素比），解码后 ≤ 256 KiB；可用 `/rt banner` 导出 Base64 再粘贴进编辑器 |

站位：`hostile` / `neutral` / `friendly`。当 `neutralPoints == friendlyPoints` 时没有中立区间，点数会从敌对直接跳到友好。

## 本地化

显示名与描述走 HanShu 惯例：

- 路径：`assets/<locale>/lang_rep/<ID>.lang`
- 语义键：`name`、`description`
- 新建时以文件基名播种显示名

PAK 导出保留该布局（shared 平面）。运行时 Mod 需按同样约定读取；不要再写单文件 `lang_reputation.lang`。

## 引用与协作

- Actor 模板的 `reputation` 字段引用本分类阵营 ID。
- `hostile` 与 Actor 引用都是非归属关系：改名／删除不自动改写对端。
- 保存走统一文件事务；虚拟文件夹归属在 `meta/explorer.json`。

详见[演员模板与脚本](#actor-guide)、[资源分类与共享组织](#resource-organization)。
