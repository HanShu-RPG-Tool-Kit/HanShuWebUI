# 物品库：`.item` 与 `.itemstack`

进度工作区的 **物品库** 存放可复用的物品定义（`.item`）。礼包可以**内嵌**一份 ItemStack，也可以**链接**物品库里的 `.item`（按文件名去扩展名引用）。模组/游戏导出的快照文件是 **`.itemstack`**，导入物品库时会转成 `.item`。

## 两者区别

| | `.item`（物品库） | `.itemstack`（快照 / 交换） |
| --- | --- | --- |
| `format` | `rpgtoolkit:item` | `rpgtoolkit:itemstack` |
| 权威数据 | `item.id` + `item.components` | 同左，另有 **`item.count`** |
| 数量 | **不存**（发放数量由礼包等调用方决定） | 有 `count`（拖入礼包时作默认数量） |
| 标签 | 可选根级 `tags`（与 `.kit` 相同规则） | 无 |
| 必填 | `format`、`schemaVersion: 2`、`item.id`、`item.components` | `format`、`schemaVersion: 3`、`item.id`、`item.components` |
| 用途 | 工程内复用、礼包链接、表视图 | 从游戏/模组导出；导入礼包或转成 `.item` |

引用名：文件 `apple.item` → 礼包链接字段写 `apple`（相对物品库文件名，不含扩展名）。从资源树或物品编辑器拖到礼包物品栏，可创建链接而非内嵌副本。

## `.item` 文件格式

工程文件**只持久化权威数据**，不再写入 `display`：

```json
{
  "format": "rpgtoolkit:item",
  "schemaVersion": 2,
  "tags": ["reward", "event/summer"],
  "item": {
    "id": "minecraft:diamond_sword",
    "components": {
      "minecraft:enchantments": { "type": "compound", "value": { "minecraft:sharpness": { "type": "int", "value": 5 } } }
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `format` | 固定 `rpgtoolkit:item` |
| `schemaVersion` | 当前为 `2`；原型阶段拒绝旧格式，不做自动推断转换 |
| `tags` | 可选。游戏标签 string[]；空则不写入。交互与礼包相同（chip、回车/逗号添加）；去重大小写不敏感，保留先出现的写法。建议用稳定标识如 `reward`、`event/summer` |
| `item.id` | 必填，命名空间物品 ID，新建默认 `minecraft:stick` |
| `item.components` | **完整组件集合**，值为 [TNBT JSON](#tnbt-json)；可为空 `{}`，表示没有持久化组件 |

组件集合不继承物品默认值，也不接受 `remove` 或 `!component`。游戏侧适配契约要求导出实际生效的全部持久化组件，加载时内部生成默认组件的移除项。新建 `.item` 的空集合不会自动生成原版默认组件，通常建议从游戏导出作为起点。上面的精简组件示例仅演示语法，不代表合法完整钻石剑配置。

组件具体值是否合法由目标游戏环境（MC 26.1.2、模组、数据包注册表）校验。WebUI 可保存未知组件以保留作者数据，游戏生成物品时必须拒绝未知、暂态或不合法组件，不能静默丢弃。组件内部的嵌套 ItemStack 保持原版 NBT 结构，不递归套用工程包装。

## 展示快照（本机缓存）

名称、tooltip、图标等展示数据在 **C 侧 IndexedDB**（`hanshu.itemSnapshots.v1`），不进工程目录、也不经 S。

- **指纹**：`fnv1a(格式标记 + id + 规范化 components)`（**不含 count**）。缓存键与过期判定均为该指纹；写入时会把 `display.snapshotOf` 规范为请求时的指纹。
- **刷新**：WebUI 经 Control **出站**调用 mod 的 `items.renderSnapshots`（批量 ≤128，`includeIcon` 默认 true）。`iconPending: true` 时先显示文本快照并短暂重试；同一指纹约 3 次仍无图标则接受纯文本并停止对该项重试（否则会一直打同一批）。
- **自动刷新**：默认开启。菜单 **编辑 → 自动刷新物品快照** 可关掉；关掉后 miss/过期不再自动入队（清空当前 needed），仍可用手动「刷新物品快照 / 刷新全部」。偏好记在本机 `localStorage`。
- **miss / 过期**：自动刷新开启时，编辑器先用 WebUI 近似渲染并登记 needed；连上游戏开发服务器后 drain。
- **count**：数量变化不改指纹、不触发重新快照（发放数量由礼包等决定）。

Mod 已升级 `.itemstack` v3、快照与 IBE 编辑交换协议；两端需使用同一新版。旧版 Mod 的 v1/v2 文件仍拒绝导入，不自动推断迁移。`.it` 模板使用独立的版本化运行时格式，见下方模板同步。

## `.itemstack` 文件格式

```json
{
  "format": "rpgtoolkit:itemstack",
  "schemaVersion": 3,
  "item": {
    "id": "minecraft:apple",
    "count": 16,
    "components": {}
  },
  "display": { "…": "可选展示快照；可残缺" }
}
```

- 严格读取 `.itemstack` v3；旧 v1/v2 拒绝并提示重新从游戏导出；`display` 可选。
- **导入权威只认 `item`**。`display`（若有）只 ingest 进本机 IDB，**不写入** `.item` / `.kit` 文件。
- `tooltipRaw` 等解析层忽略字段与现 Web 渲染一致。
- 拖入**礼包**物品栏：按内嵌 ItemStack 追加（保留 count / components；display 进缓存）。
- 拖入**物品库**：转成 `.item`（去掉 count，改 format，保留组件；`tags` 为空；display 进缓存）。

桌面拖出的 `.itemstack` 仍可带 `display` 方便交换，但工程持久化路径不依赖它。

## 编辑器

- 物品库可新建 / 导入 `.item`；也可拖入 `.itemstack` / `.json` 转成 `.item`。资源树里的分类文件夹（如 `食物/自然/`）只是视图归属；磁盘路径为 `src/items/<文件名>.item`。重命名只改文件名；**已保存到工程**的走事务 `move`，**尚未保存的草稿**只改本机名（下次保存写入新路径）。不能写成带路径的名字。
- 双栏编辑：左侧为图标、游戏提示文本与简洁快照状态；右侧为物品 ID、标签、常用组件卡片和完整组件树。窄面板自动改成单栏。格式名、版本与指纹不在表单展示，仍可「查看源码」。
- 常用组件通过标题右侧「＋」下拉菜单添加，内置外观、附魔、存储附魔、属性修改器，以及损耗值、最大耐久、堆叠上限、修复费用。卡片与树编辑同一份 `components`，互相即时反映修改；已有的复杂或不支持的数据格式保留原样，使用树编辑，不自动转换。
- 卡片使用与进度 goal 一致的彩色标题条。组件树有不可删除的 `components` 根节点，按「值类型、组件 / 键、值」排列。Minecraft 组件名是根下的键（如 `minecraft:damage`）；byte、short、int、long、float、double、string、compound、list 和三种数值数组是 NBT 值类型。没有 Boolean 或 Null；布尔组件通常使用 byte 0/1，具体以游戏 Codec 为准。
- 右键根或容器条目通过「添加 → string / compound / …」直接插入空白编辑行，填写键和值，回车提交，Esc 取消。未完成的空行不进入文档，重复键会提示。容器值按所选类型建立空 compound、list 或数值数组；数组元素无需键。“添加”为多级菜单：string、compound、list 直接选择，数值与数值数组按组展开。右键还可重命名或删除；根节点不允许删除，不提供类型转换操作。
- 双击键名或按 F2 重命名，选中行后可按 Shift+F10 打开菜单，左右方向键折叠或展开。只读时允许查看与展开，不允许修改。
- 拖到礼包使用资源管理器中的物品资源，编辑器内不再提供重复拖拽胶囊。
- 菜单 **编辑 → 自动刷新物品快照**（勾选开关）/ **刷新物品快照** / **刷新全部物品快照**：后两项强制向客户端重新拉取（旧缓存保留至新快照覆盖；未连接则排队）。[活动列表](#activity-list) 会显示带进度条的「刷新物品快照」任务，批次写完后变为「已刷新 N 个」。
- 资源树有只读 **物品库表视图**：汇总文件名、引用名、ID、显示名、标签、组件数、快照状态（新鲜 / 刷新中 / 过期 / 无）。
- 本地化：基础名称、自定义名称和每行 lore 可显式转换为工程本地化；标签、模型 ID 和指令类字段不进语言资产。语言资产归属与保存规则见下节。

## 外观、附魔与属性修改器

- **外观**：集中编辑 `item_name`、`custom_name`、`lore`、`item_model`、`rarity`、`enchantment_glint_override`。名称优先级为 `custom_name → item_name → 注册项默认名称`。名称与说明复用礼包的富文本控件，支持颜色、字形、分段和工程本地化；高级 Component 只读保留，可进入组件树编辑。`tooltip_display` 使用独立显示策略卡片，隐藏 lore 只改变展示，不删除文本。模型 ID 回车或离开输入框时提交。说明最多 256 行。未设置、空字符串和空列表是不同状态，× 表示明确删除；外观编辑区始终显示，卡片标题的 × 清空这组组件并保留编辑区；最后一个字段设为未设置也不会隐藏卡片。
- **附魔 / 存储附魔**：每条包含附魔 ID 和整数等级 1..255，支持添加、改名与移除。内置原版 ID 建议，但允许模组和数据包 ID；不声称离线验证了注册表存在性或附魔适用物品。目标 MC 26.1.2 的值为 ID → 等级的 compound，没有旧版 levels 包装。
- **属性修改器**：使用目标版本的 list，每条包含 `type`、`id`、`amount`、`operation` 和可选 `slot`。表单支持多条记录、增删、自定义属性 ID、三种运算和全部目标版本槽位；同一属性内的修饰器 ID 不允许重复。新条目生成未占用的 `hanshu:modifier_N`。修改已知字段保留 `display` 及其他额外字段；不支持的结构、非有限数值留给组件树处理。

这些表单直接更新同一份 TNBT JSON，没有第二份语义数据，也没有绕过现有草稿与协作事务。`.item` 与礼包中的内嵌 ItemStack 使用相同卡片。默认按外观、附魔、属性修改器、其他组件排列，窄面板自动将属性表单改为单栏。

## 显示文本本地化

现有固定文本保持原样。选择「工程本地化」时才生成 `translate` 引用，并将当前文本作为当前语言的种子。工程语言资产位于 `assets/<locale>/lang_item/<逻辑名>.lang`，键为 `display.item_name`、`display.custom_name` 或 `display.lore.<稳定 ID>`。切换语言只切换译文，不重写 Component。

运行时键形如 `hanshu.item.<不透明标识>.display.custom_name`，由 WebUI 生成并显示为只读。标识保存在 `translate` 本身，不增加 `.item` 元数据或改变 schema。每行本地化 lore 的 ID 随该行一起移动；插入、删除和排序不会把后续行的译文绑定到另一行。普通 Minecraft 翻译键不会因没有工程语言文件而被转换。

语言值可以是普通字符串或富文本 Component JSON 字符串。保存工程时，源文档与所有待保存语言资产合入同一版本检查事务；只读或离线工程不能提交。源文件改名、移动和删除由工程服务联动各语言文件，历史恢复沿用同一资源归属。源路径变化不改变不透明运行时键。

导出 PAK 会将仍被 Component 引用的语义键编成全局运行时键，写入 `assets/<locale>/lang_item/<逻辑名>.lang`，语言产物属于 shared 平面。未引用的译文和没有已导出源文档的语言文件会被裁剪。未提供任何语言译文的引用会产生编译警告。

## 扩展常用组件卡片（开发）

在 `src/workspaces/quest/itemComponents/registry.ts` 使用 `registerItemComponentEditor` 注册组件的命名空间 ID、标题、`createValue`、`accepts` 和 React `Editor`，返回函数用于注销；重复 ID 会拒绝。内置注册见同目录 `builtins.tsx`、`complexCards.tsx`；纯结构操作在 `complexModel.ts`。这是代码扩展入口，不是运行时加载外部脚本。

可选 `wide: true` 让复杂卡片占满一行，`order` 控制顺序（默认 100）；可选 `tone` 为 `steel`（默认）、`amber`、`violet` 或 `green`，由宿主统一绘制彩色标题，不在各个编辑器里另做卡片外壳。

`Editor` 接收 TNBT `NbtValue` 类型的 `value`、`disabled` 和 `onChange`，仅提交该组件的新 TNBT 值；添加、移除、卡片外壳及整份文档更新由宿主统一处理。`accepts` 必须拒绝编辑器不能无损处理的数据形状，禁止为套用表单而丢掉未知字段。不要缓存另一份组件副本或直接写文件，继续沿用 `ItemEditor.onChange` 的草稿与工程事务。注册是内存操作，不修改工程文件；只读状态必须传递至每个输入与按钮。

多组件分组使用 `kind: "group"` 的 `ItemComponentGroupEditor`，声明 `componentIds`、`caption`、`createComponents` 和 `Editor`。分组 Editor 接收完整 `ItemComponents`，宿主只应用声明范围内的改动，并保留其他组件。相关组件存在时自动显示分组，替代同 ID 的独立卡片；`alwaysVisible: true` 的表单分组在组件为空时也保持显示；分组之间不允许重复声明组件，注销分组后独立卡片恢复。分组的 UI ID（如 `hanshu:appearance`）不进入物品组件集合。

## 本机查询（游戏开发服务器）

打开工程后，本机 mod 可通过 [游戏开发服务器](#game-dev-server) Control：

- **入站**：`items.list` / `items.get` / `items.query` 读当前会话物品库（C 侧镜像）；`items.edit.done` 为 IBE 完成通知。
- **出站（WebUI→mod）**：`items.renderSnapshots` 批量拉展示快照；`items.edit.open` 呼出客户端 IBE（资源树 `.item` 右键或编辑器预览下方「发送到游戏内编辑」）。写回只认 `hash` 乐观锁，见 [游戏开发服务器](#game-dev-server)。

## 模板同步与导出

`.item` 是模板的作者文档。编辑器的「模板同步」卡片与物品定义一起保存，沿用工程草稿、保存和协作事务；规则不进入展示快照指纹。

- 默认所有组件锁定，且不允许未声明的额外组件。
- 点击组件右侧「模板锁定」可切换为「实例管理」：创建实例时使用模板初值，此后保留实例当前值；实例删除该组件也会保持删除。
- 展开 compound 后可开放单个字段。开放父字段意味着开放整棵子树，包含后来新增的子字段；子节点显示「随父节点」。只想保留子弹数，就只开放对应的 ammo 字段。
- list 和数值数组只能整体开放，不按下标设置规则。
- 「允许组件」可以声明模板初始集合里没有的实例组件，例如允许玩家附魔。它不向模板添加空组件。
- 「允许未声明的额外组件」是更宽泛的开放：只保留模板之外的组件，不会让已有模板组件自动变成实例管理。
- 删除或改变字段类型后，失效规则会明确报错；恢复字段或点击「收回开放」，修复前不能导出该模板。

`.item` v2 可选的 `sync` 字段如下；未填写时为默认封闭规则：

```json
{
  "allowExtraComponents": false,
  "instanceComponents": ["minecraft:damage", "minecraft:enchantments"],
  "instanceFields": [
    { "component": "example:gun", "path": ["magazine", "ammo"] }
  ]
}
```

路径按 compound 的真实键名保存为数组，空键、带点号的键不会被误拆。父规则覆盖子规则；整组件开放覆盖该组件所有字段规则。

导出 PAK 时，内置 Item 编译器把 `apple.item` 编成 server 平面的 `items/apple.it`：

```json
{
  "format": "rpgtoolkit:item-template",
  "schemaVersion": 1,
  "componentFormat": "tnbt-json-v1",
  "componentMode": "complete",
  "tags": ["food"],
  "item": {
    "id": "minecraft:apple",
    "components": {}
  },
  "sync": {
    "allowExtraComponents": false,
    "instanceComponents": [],
    "instanceFields": []
  }
}
```

空组件集合仅演示结构，不会继承原版默认组件。物品标签 `tags` 会保留到 `.it`，展示快照不进入 `.it`。标签去首尾空白、NFC 规范化并按大小写不敏感去重；没有标签时导出空数组。它是 HanShu 模板标签，与 Minecraft 注册表标签独立。没有 revision 或 follow 模式。

模板 ID 就是扁平文件名去掉 `.it`，如 `apple`，不含命名空间和子目录。改文件名就是改模板 ID。Minecraft 底层物品 ID 则可以修改：同步时重建新类型，再恢复允许的实例状态与数量。

Mod 在实例的持久化组件 `rpgtoolkit:item_template` 中保存模板 ID（字符串）。`.itemstack` 导出会保留此绑定；将它导入为一个新的 `.item` 时会移除绑定，避免把实例身份写进模板。

运行时先用当前模板重建完整组件集合，再恢复允许的实例组件／字段；未开放的旧组件随之移除。最终校验失败会保留原物品。数量不由模板同步覆盖；堆叠上限降低时仍保留原数量，原位更新，不拆栈、不检查空余槽位，也不因此延后同步。主动调用同步入口时同样保留原数量。

服务端启动及 `/rpgtoolkit pak reload` 会加载 `.it`。本机开发发版目前仍需执行该服务端重载命令。管理员可用 `/rpgtoolkit item give apple 1` 创建绑定实例，用 `/rpgtoolkit item sync` 主动同步自身背包。

实例采用惰性同步：登录、拾取完成和每 20 tick 检查玩家背包与玩家装备；容器只在打开时检查一次。使用、攻击和持续使用时只检查实际使用的那只手，不扫描背包。掉落物、生物装备和当前容器没有周期扫描；它们可能暂时保留旧模板，物品进入玩家侧后再同步。换物品导致手持引用变化时会取消当次操作并提示重试，避免继续使用旧实例。模板缺失时不删除物品，但会阻止其参与已接入的手持关键操作。

Mod 的服务入口 `ItemTemplates.forServer(server)` 可查询模板、按标签过滤、创建和发放实例；ItemStack 标签查询通过绑定 ID 读取当前目录，不在实例中复制标签。

运行时模板会预编译为原生组件；未变化实例使用服务端内存缓存，不执行 JSON／整物品 NBT 往返。字段例外只处理对应组件的局部 NBT，文件格式不增加 revision。

第一版不会扫描离线玩家、未打开的箱子或自定义仓库内部存档；物品进入已接入槽位后再同步。嵌套物品与第三方容器不做通用递归同步。礼包中的作者链接仍按下节展开，不会因此自动变成运行时模板绑定。

## 与礼包的关系

详见 [礼包：超参数与修饰器](#kit-guide)。礼包条目可以是：

1. **内嵌**：`{ id, count, components }`（或从 `.itemstack` 拖入；display 只进本机缓存）；
2. **链接**：`{ "item": "引用名", "count": n }`——展开时从物品库取 id/components，展示名/图标来自本机快照缓存，数量仍由礼包字段（可绑定修饰器）决定。

物品上的 `tags` 与礼包上的 `tags` 彼此独立：物品标签描述物品分类，礼包标签描述发放包分类；链接展开**不会**把物品 tags 并入礼包 tags。


固定文本编辑不依赖语言表读取成功。语言资产读取失败时显示错误并可重试，绑定/译文编辑暂不可用；原有固定名称仍可编辑保存，错误语言文件不被覆盖为空表。原版及模组的普通 Minecraft 翻译键不属于工程本地化绑定，保持原样、只读展示；只有匹配当前资源类型的 HanShu 工程键才进入工程译文编辑。
