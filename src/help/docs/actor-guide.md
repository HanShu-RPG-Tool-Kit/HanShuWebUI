# 演员模板与脚本

游戏性工作区「演员」分类可创建、导入和编辑 `.actor`。保存路径为 `src/actors/<ID>.actor`，PAK 路径为 `actors/<ID>.actor`；模板 ID 来自文件名，不是正文中的字段。

```json
{
  "format": "rpgtoolkit:actor-template",
  "version": 1,
  "scripts": ["guard"],
  "tags": ["village"],
  "freezeAi": true
}
```

五个字段固定，不能增加其他字段。`scripts` 是有序、不重复的演员脚本 ID，对应 `src/script/actor/<ID>.py`；不带路径或命名空间。表单可选择脚本、调整顺序、打开脚本及移除绑定。未解析引用会显示缺失并阻止 PAK 导出；其他类型同名脚本不能替代演员脚本。标签去重保序。`freezeAi` 软冻结原版 Goal/Brain，保留 navigation/control；它不控制脚本是否运行。

工程保存、只读和冲突沿用[多人协作编程指南](#collaboration-programming)的普通文件事务。改名与删除模板不会改写或删除引用的脚本。WebUI 不执行 Python。

在游戏中使用 `/rt actor bind <entity-uuid> <ID>` 绑定模板；带脚本的模板仅能绑定 Mob。重新 bind 强制重建脚本会话；PAK reload 也重建已加载 Mob 的会话。初始化清空共享黑板，所有脚本恢复 running，按列表顺序接收 init。区块卸载再加载且会话指纹未变时不重新 init。

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

`@hook` 名称补全、类型注解、动态黑板和在线限制见[Python 编辑器与语言服务](#python-language)。
