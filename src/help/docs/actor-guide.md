# 演员模板与脚本

游戏性工作区「演员」分类可创建、导入和编辑 `.actor`。保存路径为 `src/actors/<ID>.actor`，PAK 路径为 `actors/<ID>.actor`；模板 ID 来自文件名，不是正文中的字段。

```json
{
  "format": "rpgtoolkit:actor-template",
  "version": 1,
  "scripts": ["guard"],
  "tags": ["village"],
  "freezeAi": true,
  "despawn": "persistent",
  "display": { "mode": "set", "title": "&a卫兵", "subtitle": "&7东门" },
  "reputation": { "mode": "set", "id": "village_guard" },
  "sounds": {
    "hurt": { "mode": "set", "id": "minecraft:entity.ravager.hurt" },
    "death": { "mode": "mute" },
    "ambient": { "mode": "set", "id": "minecraft:entity.ravager.ambient" },
    "melee": { "mode": "set", "id": "minecraft:entity.player.attack.strong" },
    "move": {
      "mode": "set",
      "ground": "minecraft:block.stone.step",
      "water": "minecraft:entity.generic.swim",
      "air": "minecraft:entity.phantom.flap"
    }
  },
  "loot": {
    "xp": { "mode": "giveXp", "amount": 25 },
    "item": {
      "leave": false,
      "items": [
        { "item": "kit_blade", "count": 1, "chance": 0.35, "playerKill": true },
        { "id": "minecraft:emerald", "count": 2, "chance": 1.0 }
      ]
    }
  },
  "dialogue": {
    "talkId": "卫兵",
    "playerRole": "玩家",
    "entries": [
      { "when": [{ "kind": "talk", "op": "unread", "injectId": "village_intro" }], "inject": "village_intro" },
      { "when": [], "inject": "village_idle" }
    ]
  },
  "interactService": { "type": "shop", "param": { "templates": ["village"] } }
}
```

## 字段

- **必填**：`format` / `version` / `scripts` / `tags` / `freezeAi`
- **可选**（可省略或 `null`；未知键拒载）：`despawn` / `display` / `reputation` / `sounds` / `loot` / `dialogue` / `interactService`

### `despawn`（消失行为）

`inherit`（缺省，遵循原版）／`persistent`（持久化，不因距离或空闲消失）／`despawn`（自然消失，强制按原版判定）。编辑器在模板头部「消失行为」下拉里选择；选 `inherit` 时导出不写这个键，旧版模组仍可加载。

服务端每 tick 按当前模板推导，不写实体 NBT：改模板或重载 PAK 后立即生效。只覆盖走 `Mob.checkDespawn` 的实体，自行覆写 `checkDespawn` 的实体会忽略 `despawn`。

`scripts` 是有序、不重复的演员脚本 ID，对应 `src/script/actor/<ID>.js`。表单可选择脚本、调整顺序、打开脚本及移除绑定；未解析引用会显示缺失并阻止 PAK 导出。标签去重保序。`freezeAi` 软冻结原版 Goal/Brain，保留 navigation/control；它不控制脚本是否运行。

### 死亡掉落（`loot`）

有绑定时即生效，**不**要求脚本会话。时序：原版算出 → **套用模板** → 脚本 `loot`／`lootXp`。经验轴与物品轴独立；整键或子键省略／`null` 等同该侧 leave（跟原版）。

| 字段 | 含义 |
| --- | --- |
| `xp` | 对象或省略／`null`。有对象时 **`mode` 必填**：`leave`｜`dropXp`｜`giveXp`｜`giveLv` |
| `xp.amount` | 非 `leave` 必填且 `>= 0`；`leave` 禁止带 amount。非 leave **替换**原版 XP，且需玩家击杀信用 |
| `item.leave` | 默认 `true`；`false` 先清空本次掉落集合再掷自定义行 |
| `item.items[]` | 可省略（默认 `[]`）；形态同 kit（`item` 链接或 `id`+`components`）；`count` 默认 1；`chance` 默认 1（`[0,1]`）；`playerKill` 默认 `false` |

`died` 若被脚本 `cancel`，模板掉落与 `loot`／`lootXp` 都不会触发。`giveXp`／`giveLv` 在 hook 之后入账，脚本 `cancel` 可否决。

### 显示与声誉副作用

在会话 **init** 时应用（`scripts` 可空）。解绑 actor **不**自动清除二者。整键省略／`null` 等同 `mode: leave`（不动实例）。有对象时 **`mode` 必填**：`leave`｜`set`｜`clear`。

| 字段 | 含义 |
| --- | --- |
| `display.mode` | `leave` 不动名牌；`set` 整板写入（`title`／`subtitle` 可选：原版文本组件 JSON，或魔杖同款 `&` 纯文本）；`clear` 清除名牌 |
| `reputation.mode` | `leave` 不动成员；`set` 需 `id`（已发布阵营）；`clear` 清除成员 |

`leave`／`clear` 不得附带 `title`／`subtitle` 或 `id`。Boss 血条是脚本 API（`event.api().bossBar()`），**不能**写进 `.actor`。

### 音效覆盖（`sounds`）

在会话 **init** 时应用（与名牌／声誉同时机）。解绑 **不**自动回滚。整键省略／`null` 或空对象等同全部跟原版；各槽位也可单独省略（跟原版）。有槽位对象时 **`mode` 必填**：`leave`｜`set`｜`mute`。

| 槽位 | 形态 |
| --- | --- |
| `hurt`／`death`／`ambient`／`melee` | `set` 需 `id`（原版音效事件，如 `minecraft:entity.ravager.hurt`）；`mute` 静音；`leave` 跟原版 |
| `move` | `set` 需同时给 `ground`／`water`／`air` 三个音效事件；`mute` 静音全部移动音；`leave` 跟原版 |

`leave`／`mute` 不得附带 `id` 或 `ground`／`water`／`air`。未知槽位键拒载。

### 对话路由

右键顺序：脚本 `interact` → `dialogue`（首条 `when` 条件组全部满足）→ `interactService` → 原版。

| 字段 | 含义 |
| --- | --- |
| `talkId` / `playerRole` | 非空且互不相同的角色 ID |
| `entries` | 有序；`when` 为条件组（与任务 `visibility` 同一套叶子，AND，空组恒真）；`inject` 为全局 `@inject` 名 |

源文件落盘条件组；导出 server PAK 时编译为一条布尔表达式字符串。旧表达式字符串／旧 `always`／`talk_read`／`talk_unread` 数组在读入时降下为条件组。编辑器点击条目展开条件组（商店展开风格）。表达式叶子可写 `questAcceptable(ctx.player, "id")` 等（与 Mod 条件助手一致；Talk HSC `?` 里则是顶层 `player`）。

### 交互服务

| type | param | 行为 |
| --- | --- | --- |
| `shop` | `{ "templates": ["<源名去.shop>", ...] }`（1–64，顺序即页签） | 按各模板 `stockSubject` 打开：无限无主体 · 玩家→交易玩家 · 游戏→全局 · 角色→本演员 id；不支持自定义参数 |
| `vault` | `{}` | 打开本地仓库 |

## 协作与引用

工程保存、只读和冲突沿用[多人协作编程指南](#collaboration-programming)的普通文件事务。改名与删除模板不会改写或删除引用的脚本／阵营／商店／注入点。WebUI 不执行 JavaScript。

在游戏中使用 `/rt actor bind <entity-uuid> <ID>` 绑定模板；宿主须为 Mob。重新 bind 强制重建会话（`scripts` 可空）；PAK reload 也重建已加载 Mob 的会话。

## Hook 与调度

支持的 hook：`init`、`aistep`、`tick`、`join`、`leave`、`remove`、`hurt`、`attack`、`died`、`loot`、`lootXp`、`kill`、`interact`、`target`、`dimension`、`heal`、`effect`、`collide`、`ridden`、`leash`。

除 init 发给全体外，仅 running 脚本接收 hook。可取消的类型为 hurt、attack、died、loot、lootXp、interact、dimension、heal、effect、ridden；`event.cancel()` 会短路同事件的后续处理。`@hook("name", {cancellable: true})` 的可选声明必须与宿主注册一致，通常省略即可。

处理函数接收 `(event, blackboard)`。黑板在同一实例会话的多个脚本之间共享，不能把实例状态放进模块全局变量；会话结束后不持久化。`event.api()` 提供 `state(id)`、`suspend(id)`、`resume(id)`、`sleep(id, ticks)`、`call(id, functionName, ...args)`。call 向目标函数传 `(event, blackboard, ...args)`，不改变激活态；sleep 到期仅恢复 running。init 完成前禁止调度与 call。

## 类型提示示例

```js
import ActorHurtEvent from "mchhui.rpgtoolkit.feature.actor.hook.ActorHurtEvent"

@hook("hurt")
function on_hurt(event: ActorHurtEvent, blackboard: Blackboard): void {
    blackboard.alerted = true;
    var attacker = event.other();
    if (attacker != null) event.entity().setTarget(attacker);
    var api = event.api();
    // api.state("guard") / api.sleep("guard", 20)
}
```

`@hook` 名称补全、显式事件签名类型、动态黑板与共享 Java 类型库见[JavaScript 编辑器与语言服务](#javascript-language)。声誉阵营见[声誉阵营](#reputation-guide)。
