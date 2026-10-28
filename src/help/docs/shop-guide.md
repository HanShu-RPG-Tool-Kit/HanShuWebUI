# 商店模板（.shop）

本页规范 WebUI 的商店模板与编辑方式。游戏性工作区「商店」分类创建和导入 `.shop`，源文件保存于 `src/shop/<文件名>.shop`。文件夹遵循[资源分类与共享组织](#resource-organization)，读写、只读权限、冲突与保存遵循[多人协作编程指南](#collaboration-programming)。导出后 PAK 的 `shop/<文件名>.shop` 是游戏侧模板唯一真相；游戏内 UI 只使用模板，不保存另一份世界 JSON 模板。

## 模板与实例

商店模板定义名称、标签、库存主体类型、商店条件组、商品条目、超参数、修饰器和有序脚本列表。模板不提供继承或组合，不保存具体主体实体、delta 或实例参数值。

组合属于商店实例的能力。实例引用一个或多个模板，每次引用独立传入超参数、绑定具体主体实体。实例为会话级；同一模板可在不同会话使用不同参数，但一个会话中最多引用一次。实例管理的约束如下，本文不定义其实例文件格式：

- 保留每份模板的名称、条件组、条目表及模板边界，不将多个模板展开成一张无来源的表。
- 相同商品、相同局部条目 ID 默认各自保留，不自动合并或覆盖。组合后的展示条目身份由「模板引用 key + 条目 ID」确定；key 必须显式提供且在会话内非空唯一，同一模板不可重复引用（按稳定模板 ID 检查）。
- 每次模板引用的超参数、修饰器和脚本作用域相互独立；不把同名定义并入全局命名空间。

Mod 只保留 `/rpgtoolkit shop list` 和 `open`（可用 `/rt` 别名）。由可信服务端调用者提供在线交易玩家和会话配置，NPC 绑定与交互触发不属于商店能力。完整示例：

```text
/rt shop open <玩家名字或UUID或单玩家选择器> {"shops":[{"key":"merchant","template":"村庄商店","subject":{"type":"actor","id":"00000000-0000-0000-0000-000000000001"},"params":{}}]}
```

shops 为有序列表（1–64 项），顺序决定展示顺序；每项必须提供 key、template、subject、params。template 为源文件名去掉 .shop，不是模板内部稳定 ID；有限主体显式提供类型与 UUID，无限主体写 null。超参数跟随各模板引用，不写入模板。简写 `/rt shop open <玩家> <模板引用>` **仅允许无限库存模板**，自动使用 key=main、subject=null、params={}；有限库存不会隐式绑定执行者或玩家。open 要求 GM 权限，可由控制台执行，打开真实交易而非模拟预览。游戏内 create/edit/use/bind/unbind/path/reload 已移除，模板重载归统一 PAK 管线。

## 库存主体

`stockSubject` 只声明类型：`infinite`（无限库存）、`player`（玩家）、`game`（游戏全局）、`actor`（角色）。有限库存由调用方显式传入主体 UUID；actor 不要求对应实体在线。旧 world/server/npc 类型不再接受。

同一个库存主体同时承担收款方与供货方。主体身份使用 DataBackend 的「主体类型 + UUID」，不会把裸 UUID 视为全局唯一类型。无限库存是特殊语义，不绑定真实主体、不保存或修改 delta。

GAME 的全局主体使用零 UUID；主体身份本身不提供跨服同步，共享数据由 DataBackend 的存储配置决定。旧主体数据不自动迁移。

## 条目交易额度与标签

商店及每个条目的 `tags` 都是标签列表，与 kit 一样去除首尾空白、Unicode NFC 规范化、大小写不敏感去重并保留首个写法。标签支持脚本筛选关联，但不是额度数据主键。

条目的 `initialCapacity` / `maxCapacity` 是非负安全整数，初始值不能超过最大值，缺省为 0 / 1。**额度与条目有关，与支付或获得物品的数量无关。** 一次交易发 64 个物品也只占一次额度。

```text
current = initialCapacity + delta
有限主体剩余次数 = maxCapacity - current
成功交易 n 次，默认暂存 delta += n
```

额度状态由 Mod 经 DataBackend 按「主体 + 模板稳定 ID + 条目稳定 ID」保存；关闭会话、重开 UI 不重置。同主体对同模板的多个会话共享额度，各引用参数作用域仍独立。脚本可以对相关条目暂存正负 delta，仅限制安全整数和加法溢出，不自动钳制到 0..最大额度；当前额度可为负，也可超过最大额度，是否可交易仍按公式判断；模板改名不改变稳定 ID，修改稳定 ID 则得到另一份额度身份。

无限主体仅使用 `initialCapacity < maxCapacity` 作为额度开放标志，显示 `∞`，不受差值限制且交易不累加 delta；相等表示额度关闭，大于最大值是配置错误。无限不绕过物品支付、商店条件或商品条件。

## 两层条件

商店级 `visibility` 与 `availability` 是两个独立条件组，复用单进度任务的任务、对话、求值条件编辑方式；不引入任务专属的重复周期条件。

Mod 默认接入对话已读和表达式；任务状态由宿主通过 `ShopService.ConditionResolver` 对接实际任务运行时，未提供时明确拒绝使用相关条件，不伪造任务状态。会话 API 的调用者负责授权，主体参与者判定不是任意打开商店的许可。

商品级同名字段是表达式字符串，在条目表单中直接展示，也可在表格单元格内编辑，允许引用本模板超参数和修饰器，采用下述商店表达式 V1。空字符串表示没有额外条件。商店条件组与商品表达式分别建模和编辑，WebUI 不将二者改写或拼接为一个 AND 表达式，也不推导统一条件树。可见性与可用性是不同职责。

### 商店表达式 V1

`hanshu.shop.expr` V1 的数值层严格复用[kit 表达式 V1](#kit-expr)，Mod 仍由约定语法前端转交 AviatorScript，而非执行任意 Aviator 源码。增加 `true` / `false`、数值比较 `== != < <= > >=`、`!`、`&&`、`||` 和条件括号。数值 0 为假，其余有限数值为真；空条件为真。字符串不参与运算，比较双方必须是 kit 数值表达式，不支持比较链、赋值、成员访问或脚本语句。

组合按顶层 `||`、`&&`、前置 `!`、数值比较分层解析；`!level < 2` 表示 `!(level < 2)`，建议明确写括号。`&&` / `||` 短路求值，但所有分支均静态检查语法和名字，`true || unknown` 仍然非法。求值错误不当作通过。跨端一致性样例为 `scripts/fixtures/shop-expr-v1.json`。

## 商品条目与物品

每个商品条目拥有模板内唯一、非空且稳定的 `id`。调整顺序、修改支付或获得内容不改变 ID；数组顺序即展示顺序。

商品条目、商店条件组、超参数、修饰器和脚本在同一页面编辑。商品区域可切换表单或表格视图：表单以交易目录选择当前条目；表格每行是一笔完整交易，支付与获得各自的单元格列出全部物品及数量。点击物品单元格的“编辑物品详情”切到该条目的表单，编辑物品引用、组件、数量与修饰器；表达式可直接在表格单元格输入。两种视图共用选择、排序、增删和草稿数据，切换不会丢失修改或改变条目 ID。视图选择不写入 `.shop`。

`payment` 是支付内容列表，`goods` 是获得内容列表。一次交易按整份列表描述支付和获得，列表内全部参与，没有任选一种支付的隐含语义。

每项复用 kit 的物品结构与数量语义：链接物品库时为 `item`（`.item` 文件名去后缀）+ `count`；内嵌 ItemStack 时为 `id` + TNBT `components` + `count`，不是另造一个 `itemstack` 包装字段。物品行支持拖入 `.item`、`.itemstack`、组件编辑以及数量修饰器 `mods.count`。数量为非负整数，修饰器求值和取整规则与 kit 一致。

不定义虚拟物品类型。每个支付或获得项目都必须具有 item 或内嵌 ItemStack。用户需要虚拟资源时自行通过脚本实现；WebUI 不提供虚拟余额、虚拟物品选择器或默认交易钩子。

## 超参数、修饰器和脚本

`params`、`modifiers` 使用 kit 的声明格式和编辑器，商店默认均为空，不带礼包专属参数。预览值仅留在编辑器会话中，不写入模板。数量可通过 ƒ 绑定修饰器。

`script` 是有序 `{ref}` 数组，专属类型为**商店脚本**，工程位于 `src/script/shop/`，PAK 位于 `script/shop/`。`ref` 为文件名去掉最后一个 `.py` 的 ID，不能传路径或从 common/kit 等其他类型回退查找；ID 本身的点号不再去除。同一引用不重复绑定，WebUI 支持搜索选择、打开和排序，公共库通过 `from common...` 导入。

Mod 在交易预提交阶段按涉及模板引用及其脚本列表顺序执行，注入 `shop` 与 `player`。`shop.id/tags`、`param(id)`、`mod(id,x)`、`expr(source)`（数值）、`condition(source)`（布尔）、`entry(id)`、`entries(tag=None)` 在当前模板引用作用域内工作。条目句柄提供 `id/tags/quantity/delta/current/initialCapacity/maxCapacity`；`adjustDelta(amount)` 暂存正负调整。默认交易增量已在脚本前暂存，脚本可观察到本单变更；无限主体不允许调整 delta。

脚本抛错时引擎不提交本单物品与额度计划。脚本仍是可信 Python，直接通过裸 `player` 或其他 Java API 产生的外部副作用无法自动回滚；应通过暂存句柄维护额度，不能自行扣物、写主体或把副作用误当成交易的一部分。实际恢复与持久化契约以 Mod 商店文档为准。

交易外补货或主动关闭可由经过宿主授权的服务端代码调用 `ShopService.adjustDelta(server, subject, templateSourceId, entryId, amount)`。交易脚本运行期间禁止走这个立即持久化入口，必须使用当前 `shop.entry(...).adjustDelta(...)` 暂存句柄。

## 文件示例

```json
{
  "format": "hanshu.shop",
  "version": 1,
  "id": "village-trader",
  "name": "name",
  "tags": ["village"],
  "stockSubject": "actor",
  "visibility": [],
  "availability": [],
  "params": [{"id":"priceScale","kind":"float","default":1,"hint":"价格倍率"}],
  "modifiers": [{"id":"price","label":"价格","expr":"x * priceScale"}],
  "script": [],
  "entries": [{
    "id": "bread",
    "tags": ["food/sell"],
    "initialCapacity": 0,
    "maxCapacity": 10,
    "payment": [{"id":"minecraft:emerald","components":{},"count":2,"mods":{"count":"price"}}],
    "goods": [{"item":"面包","count":3}],
    "visibility": "",
    "availability": ""
  }]
}
```

`name` 是本地化语义键，名称存于 `assets/<locale>/lang_shop/<文件名>.lang`，新建时以文件基名播种译文。模板 ID、条目 ID、物品引用、脚本 ID、表达式、超参数标识符和修饰器标识符不参与本地化。商品展示使用 kit 的物品展示快照，不额外保存虚拟图标；支付 / 获得面板提供当前条目的快照汇总和刷新，菜单「编辑 → 刷新当前文档物品快照」则覆盖本商店所有条目的物品。

导出前校验模板结构、重复条目 ID、物品内容、额度、脚本引用和条件语法。商店源文件输出到 PAK 的 `shop/` 服务端平面，语言资源使用共享平面。运行时通过统一 PAK 内容管线加载不可变模板快照；旧游戏内模板编辑和世界松散 JSON 不作为来源。
