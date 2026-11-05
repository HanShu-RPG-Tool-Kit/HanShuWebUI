# 脚本资源：类型、内置脚本与新建模板

## 目录与身份

脚本有六种类型：common（通用）、goal（目标定义）、kit（礼包）、shop（商店）、actor（演员）、player（玩家）。工程统一保存为 `src/script/<类型>/<文件名>.js`；PAK 通常对应 `script/<类型>/<文件名>.js`；goal 特例导出为 `goal_scripts/<文件名>.js`，界面分类为 `goal-def`，均属于 server 平面。类型是真实分类，类型内的用户文件夹是保存到工程 `meta/explorer.json` 的共享整理视图，不创建磁盘子目录；文件名在同类型内唯一，不同类型可以同名。

脚本类型由工程路径决定，不通过执行 JavaScript 猜测类型。拖动到另一类型属于类型转换，会改变源文件路径，经 S 的版本校验与事务执行；代码不会被自动改写成新类型。检查入口后再转换。目录规则集中在 scriptResources/types.ts、workspace.ts，禁止业务页面自己拼另一套路径。

## 内置脚本与模板

维护目录位于 `src/scriptResources/`：

- `builtin/<类型>/*.js`：内置可用脚本。直接增删改文件，构建时自动收集；资源管理器在对应类型下显示只读「内置」。空类型无需填充虚假的可执行文件。
- `templates/<类型>/*.js`：新建代码模板；默认使用 default.js，资源管理器新建脚本可选择同类型其他模板。模板不参与目标定义收集，不作为内置运行脚本导出。

模板正文可用 `{{name}}` 插入新建脚本的名称。新建产生普通工程草稿，后续通过工程服务保存。模板文件自身不进入工程；生成后的文件正常导出。修改模板不追溯修改已有工程脚本。

## 覆盖与导出

身份键为「脚本类型＋文件名」。先收集内置，再叠加工程；工程同类型同名脚本整份覆盖内置，代码不合并。不同类型互不覆盖。目标目录解析和 PAK 导出复用同一有效资源集合，覆盖后不会把内置版本的旧目标类型残留在表单里。内置资源不写入工程，也不伪装为可编辑草稿；PAK 导出时自动补齐未被覆盖的内置脚本。

同一有效资源集合中，不同文件声明相同 goal 类型 ID 是定义冲突，不能把文件覆盖与 goal ID 覆盖混为一谈。

## 通用／玩家启动列表

`common` 与 `player` 各有一份有序启用清单。工程路径为 `src/script/common/load.json`、`src/script/player/load.json`；导出到 server PAK 为 `script/common/load.json`、`script/player/load.json`。格式：

```json
{
  "format": "rpgtoolkit:script-load",
  "version": 1,
  "scripts": ["economy", "login_motd"]
}
```

`scripts` 为去重的扁平脚本 id（文件名去掉最后一个 `.js`）。**出现即启用**；未列入的脚本不会自动挂载，common 仍可作为库被 require。空数组表示不自动启用任何脚本。同 priority／同 hook 内按列表下标破平；跨 priority 仍先比事件总线优先级。

**PAK 导出与启用无关**：`load.json` 只决定运行时挂载顺序，不裁剪产物。工程内全部 `.js`（及未被覆盖的内置脚本）仍照常进入 server PAK；未启用脚本同样导出，供 common 引用或日后启用。

资源树在「通用脚本」「玩家脚本」分类下各有固定虚入口「通用启动列表」「玩家启动列表」（不可改名／移动／删除），编辑的就是上述文件。候选包含工程脚本与**有效内置脚本**（内置会随 PAK 导出；工程同名整文件覆盖后按覆盖结果计入）。改名不级联改写列表；缺失 id 在编辑器标红，编译导出记为 **warning** 并跳过该项，不阻断整包。

验证：`npm run test:script-load`。

## 类型能力与 Mod 契约

- common：公共库、全局服务、事件订阅；主动启用顺序由 `src/script/common/load.json` 决定，未被列入的可通过 require 作为库使用。
- goal：注册目标类型，沿用 goal 自己的配置与实例状态。
- kit：一次礼包调用；官方宿主不提供事件订阅入口，不承诺安全沙箱。可信程序员主动绕过契约属于其自身责任。
- shop：商店交易预提交脚本，注入 shop/player，通过条目句柄暂存 delta，契约见[商店模板](#shop-guide)。
- actor（演员脚本）：已接入演员模板绑定、hook、会话内共享黑板和脚本调度；契约见[演员模板与脚本](#actor-guide)。
- player（玩家脚本）：已支持分类、专属图标、新建模板、工程保存、启动列表及 PAK 导出。作者为 `@hook` 函数参数与返回值显式写类型，语言服务使用这些签名，名称由游戏 `javascript.playerHooks` 注册表驱动；事件与宿主 API 按需反射。启动序见 `src/script/player/load.json`。

WebUI 的编辑、方言校验与 PAK 导出对接 Nashorn 内容脚本宿主。common/player 按启动列表挂载，actor 按模板顺序执行，goal 注册类型，kit/shop 按业务调用执行。导出保持作者行号并附带 hook 元数据。`import Type from "package.Type"` 只引 Java 类型，`require library from "id"` 只引 common 的 exports；不支持 Node、ES 模块或相对路径。

语言服务规范见[JavaScript 编辑器与语言服务](#javascript-language)。

### goal 交付约定

Goal 不声明“是否需要交付”。外部（进度提交／调试命令）要求交付时调用 `deliver(instance, context)`；未实现则成功 no-op。副作用只应写在 `deliver`，条件跟踪不能扣物。`submission` 是进度／目标节点可选的玩家入口配置，与 goal 类型无关；详见[多进度节点图](#progress-node-graph)。


## 旧工程与验证

原型阶段不维护旧的 src/goal/、src/script/*.js 或 src/scripts/ 布局兼容层。旧 Python 内容脚本需改写为方言 JS，并保存为 src/script/<类型>/*.js；仅改后缀不会转换语言。旧目录需将文件移到 src/script/<类型>/；打开旧路径时给出具体路径错误，不自动迁移、不覆盖文件。内置 goal 已改写为方言 JS，保持事件、状态、本地化与交付语义。

验证：`npm run test:script-resources` 覆盖六类型路径、会话往返、同名隔离、整文件覆盖和 PAK server/client 内容；`test:goal-definitions` 与 `test:new-file-types` 验证目标解析和创建入口；`test:script-resources:ui` 对真实 S 验证创建、保存、重开与内置覆盖。


## 礼包脚本引用

.kit 的 script 字段使用明确引用：`"script": [{"ref": "新手礼包-发放脚本"}]`。ref 是 script/kit/ 下文件名去掉最后一个 .js 的 ID，不能使用路径、命名空间或从 common 等其他类型解析。ID 本身可以包含普通点号，不能再自动去除其末尾的 .js。空列表表示本地未指定，继承时沿用父礼包。

礼包表单提供搜索选择、打开、新建并关联、清除引用。新建自动按礼包名命名并避让；不再内嵌代码编辑器。旧版字符串 script 只作为待提取代码保留，明确显示提示；“提取为礼包脚本”在同一次草稿变更中创建脚本并替换引用，保存时两文件经过 S 合批事务，失败保留草稿及服务端旧版本。不会把旧字符串猜成文件名。未提取代码或引用缺失时 PAK 编译报错。

脚本改名/删除不自动改写礼包引用；引用不授予联动写权或级联删除，用户需修复缺失引用。Mod 发放前检查直接引用，缺失时整个发放失败、不给奖励；执行中的 JavaScript 异常仍按既有流水线规则处理，不回滚此前已发放内容。
