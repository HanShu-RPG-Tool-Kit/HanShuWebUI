# 演员模板与脚本

游戏性工作区「演员」分类可创建、导入和编辑 `.actor`。保存路径为 `src/actors/<ID>.actor`，PAK 路径为 `actors/<ID>.actor`；模板 ID 来自文件名，不是正文中的字段。

```json
{
  "format": "rpgtoolkit:actor-template",
  "version": 1,
  "scripts": ["guard"],
  "tags": ["village"],
  "freezeAi": true,
  "display": { "mode": "set", "title": "&a卫兵", "subtitle": "&7东门" },
  "reputation": { "mode": "set", "id": "village_guard" },
  "dialogue": {
    "talkId": "卫兵",
    "playerRole": "玩家",
    "entries": [
      { "when": [{ "kind": "talk_unread", "inject": "village_intro" }], "inject": "village_intro" },
      { "when": [], "inject": "village_idle" }
    ]
  },
  "interactService": { "type": "shop", "param": { "template": "village" } }
}
```

## 字段

- **必填**：`format` / `version` / `scripts` / `tags` / `freezeAi`
- **可选**（可省略或 `null`；未知键拒载）：`display` / `reputation` / `dialogue` / `interactService`

`scripts` 是有序、不重复的演员脚本 ID，对应 `src/script/actor/<ID>.py`。表单可选择脚本、调整顺序、打开脚本及移除绑定；未解析引用会显示缺失并阻止 PAK 导出。标签去重保序。`freezeAi` 软冻结原版 Goal/Brain，保留 navigation/control；它不控制脚本是否运行。

### 显示与声誉副作用

有脚本：在会话 **init** 时应用。无脚本：在绑定时应用。解绑 actor **不**自动清除二者。整键省略／`null` 等同 `mode: leave`（不动实例）。有对象时 **`mode` 必填**：`leave`｜`set`｜`clear`。

| 字段 | 含义 |
| --- | --- |
| `display.mode` | `leave` 不动名牌；`set` 整板写入（`title`／`subtitle` 可选，`&` 纯文本）；`clear` 清除名牌 |
| `reputation.mode` | `leave` 不动成员；`set` 需 `id`（已发布阵营）；`clear` 清除成员 |

`leave`／`clear` 不得附带 `title`／`subtitle` 或 `id`。Boss 血条是脚本 API（`event.api().bossBar()`），**不能**写进 `.actor`。

### 对话路由

右键顺序：脚本 `interact` → `dialogue`（首条 when 全满足）→ `interactService` → 原版。

| 字段 | 含义 |
| --- | --- |
| `talkId` / `playerRole` | 非空且互不相同的角色 ID |
| `entries` | 有序；`when` 为 AND 条件集合，空数组恒真；`inject` 为全局 `@inject` 名 |
| 条件 `kind` | `always`（禁止 inject）／`talk_read`／`talk_unread`（后两者必须带 inject） |

### 交互服务

| type | param | 行为 |
| --- | --- | --- |
| `shop` | `{ "template": "<源名去.shop>" }` | 打开无限库存商店模板 |
| `vault` | `{}` | 打开本地仓库 |

## 协作与引用

工程保存、只读和冲突沿用[多人协作编程指南](#collaboration-programming)的普通文件事务。改名与删除模板不会改写或删除引用的脚本／阵营／商店／注入点。WebUI 不执行 Python。

在游戏中使用 `/rt actor bind <entity-uuid> <ID>` 绑定模板；带脚本的模板仅能绑定 Mob。重新 bind 强制重建脚本会话；PAK reload 也重建已加载 Mob 的会话。

## Hook 与调度

支持的 hook：`init`、`aistep`、`tick`、`join`、`leave`、`remove`、`hurt`、`attack`、`died`、`kill`、`interact`、`target`、`dimension`、`heal`、`effect`、`collide`、`ridden`、`leash`。

除 init 发给全体外，仅 running 脚本接收 hook。可取消的类型为 hurt、attack、died、interact、dimension、heal、effect、ridden；`event.cancel()` 会短路同事件的后续处理。`@hook(name, cancellable=...)` 的可选声明必须与宿主注册一致，通常省略即可。

处理函数接收 `(event, blackboard)`。黑板在同一实例会话的多个脚本之间共享，不能把实例状态放进模块全局变量；会话结束后不持久化。`event.api()` 提供 `state(id)`、`suspend(id)`、`resume(id)`、`sleep(id, ticks)`、`call(id, func_name, *args)`。call 向目标函数传 `(event, blackboard, *args)`，不改变激活态；sleep 到期仅恢复 running。init 完成前禁止调度与 call。

## 类型提示示例

```python
from __future__ import annotations
from typing import Protocol, cast
from mchhui.rpgtoolkit.feature.actor.hook import ActorHurtEvent
from mchhui.rpgtoolkit.feature.actor.script import ActorScriptApi

class GuardBoard(Protocol):
    alerted: bool

@hook("hurt")
def on_hurt(event: ActorHurtEvent, blackboard: GuardBoard) -> None:
    blackboard.alerted = True
    attacker = event.other()
    if attacker is not None:
        event.setTarget(attacker)
    api = cast(ActorScriptApi, event.api())
    # api.state("guard") / api.sleep("guard", 20)
```

`@hook` 名称补全、类型注解、动态黑板和在线限制见[Python 编辑器与语言服务](#python-language)。声誉阵营见[声誉阵营](#reputation-guide)。
