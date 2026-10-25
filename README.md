# HanShu RPG Tool Kit · WebUI

React / TypeScript 创作前端，Tauri 桌面壳，Rust 工程协作服务。

## 开发

需要 Node.js 和 `rust-toolchain.toml` 指定的 Rust 工具链；桌面版还需要对应平台的 Tauri 构建环境。

```sh
npm install
npm run dev
```

一条命令启动 Vite 与 Rust S。浏览器访问 `http://localhost:5173`，使用「文件 → 打开工程…」。本机宿主保管 `owner-key`，页面只接收短期 Admin 会话，不需要手填管理凭证。

本机使用「文件 → 打开工程… → 打开本机工程…」，选择工程文件夹，由本机 S 打开并自动连接，无需手填地址和凭证。新建使用「文件 → 新建工程…」，填写工程名称、选择保存位置，S 创建独立子文件夹；已有目录不会被覆盖。目录浏览与取消不写入候选文件夹。同一目录复用服务，切换工程不影响其他窗口正在使用的工程。

多人使用：本机打开工程后，在协作悬浮窗的「用户管理」中创建账号，填写唯一用户名、昵称、初始密码和当前工程权限。使用「文件 → 分享工程…」开启共享并复制地址，对方用账号密码登录。内置 `Admin` 只在本机由宿主建立会话，远端不能登录或复用其令牌，也没有注册入口。密码只在 S 以 Argon2id 哈希保存；临时会话不写入 URL、Cookie 或浏览器存储，刷新后重新登录。关闭共享不影响本机工作。

右下角协作浮球可拖动，点击展开成员、各窗口焦点和本机修改。多个窗口按同一主体分组，多文件草稿与失败恢复集中在「修改」页；收起时保存失败仍有提示。最近连接地址、工程名与可选用户名会在本机保留，不保存密码或令牌。连接其他服务的用户名密码登录位于「文件 → 连接其他服务器…」。

开发启动会先构建供局域网浏览器使用的网页资源；本机 Vite 继续热更新。桌面发行版直接使用内置资源，不附带 Node.js。当前共享提供局域网 HTTP，不包含公网穿透。

- `npm run dev:ui`：只启动前端。
- `npm run server`：只启动 Rust 服务，开发源码修改后自动重建。
- `npm run desktop:dev`：桌面壳自行启动同一 Rust 服务模块。
- `npm run build` / `npm run desktop:build`：前端 / 桌面构建。

连接服务即打开整个工程。剧本、进度、流程图、脚本、礼包、物品、导航点、语言/音频资产和皮肤库共用一套工程服务。C 只保存窗口草稿与缓存；S 持有工程目录，执行经过主体权限、写权和版本验证的修改。客户端不再持有工程目录的文件系统写句柄，也不通过皮肤 IPC 旁路写入。

开发服务默认工程为 `.hanshu-project/`，可用 `HANSHU_PROJECT_DIR` 指定启动时的默认目录，也可从本机目录选择器打开其他工程。桌面版自动连接内置 S，也可在打开窗口中选择「由本机服务打开文件夹…」或连接远端 S。

完整启动、中心服务部署、存储边界、协议和验证见 [工程协作服务](src/help/docs/collaboration-service.md)。

开发或让 Agent 修改工程编辑功能前，先读 [多人协作编程指南](src/help/docs/collaboration-programming.md)：所有工程资源的接入范围、版本与事务规则、失败恢复及验证入口均在这里。

全局「工程历史」由 S 保存，所有工作区和协作者读取同一份历史。每笔有效事务立即留档，界面按编辑时段聚合；可命名版本、比较文件、恢复资源或整个工程。恢复经过权限、写权与版本校验，并生成新版本。旧浏览器本地历史可单独导出。

`.quest` 表单按操作自动提交：连续文字输入合并，开关、目标增删和排序及时提交。S 校验被修改字段的原值，并短暂取得写权；不同字段可并行修改，同一字段冲突时保留输入。撤销／重做引用服务端原操作回执，保留他人不相关的修改；工程历史继续记录每次有效提交。

## 验证

```sh
cargo test -p project-core --manifest-path src-tauri/Cargo.toml
cargo build -p project-server --manifest-path src-tauri/Cargo.toml
npm run check:protocol
npm run test:project-boundary
npm run test:local-projects
npm run test:local-projects:ui
npm run test:local-projects:proxy
npm run test:project-sharing
npm run test:project-sharing:ui
npm run test:collaboration
npm run test:resource-policy
npm run test:project-history
npm run test:project-history:ui
npm run test:skin-drafts
npm run test:skin-collaboration
npm run test:skin-operation-ui
npm run verify:skin-management
npm run build
npm run test:collaboration:ui
npm run test:collaboration:presence
npm run test:presence-protocol
npm run test:resource-status
npm run test:collaboration:unified
npm run test:file-editing
npm run test:progress-edit-session
npm run test:progress-collaboration
npm run test:progress-collaboration:ui
npm run test:collaboration:network
npm run lint
```

浏览器测试使用隔离的测试工程与上下文，不使用用户浏览器数据。Windows 默认使用已安装的 Edge，其他平台须安装 Playwright Chromium。

协议 TypeScript 类型由 Rust 模型生成：修改模型后运行 `npm run generate:protocol`。

协作面板「修改 → 放弃冲突修改并同步修改」会先查未知回执，再去掉冲突文件／字段，提交其余可提交修改，刷新服务器状态。断线、临时锁定或结果仍未知时保留对应草稿，并明确报告尚未完成。
