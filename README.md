# HanShu RPG Tool Kit · WebUI

React / TypeScript 创作前端，Tauri 桌面壳，Rust 工程协作服务。

## 开发

需要 Node.js 和 `rust-toolchain.toml` 指定的 Rust 工具链；桌面版还需要对应平台的 Tauri 构建环境。

```sh
npm install
npm run dev
```

一条命令启动 Vite 与 Rust S。浏览器访问 `http://localhost:5173`，点击全局「打开工程…」连接服务。Web 开发的管理者凭证在 `.hanshu-project/.hanshu/service/owner-key`，不写进前端代码或公开接口。

- `npm run dev:ui`：只启动前端。
- `npm run server`：只启动 Rust 服务，开发源码修改后自动重建。
- `npm run desktop:dev`：桌面壳自行启动同一 Rust 服务模块。
- `npm run build` / `npm run desktop:build`：前端 / 桌面构建。

连接服务即打开整个工程。剧本、进度、流程图、脚本、礼包、物品、导航点、语言/音频资产和皮肤库共用一套工程服务。C 只保存窗口草稿与缓存；S 持有工程目录，执行经过主体权限、写权和版本验证的修改。客户端不再持有工程目录的文件系统写句柄，也不通过皮肤 IPC 旁路写入。

开发服务默认管理 `.hanshu-project/`，可用 `HANSHU_PROJECT_DIR` 指向已有的普通工程目录。桌面版自动连接内置 S，也可在打开窗口中选择「由本机服务打开文件夹…」或连接远端 S。

完整启动、中心服务部署、存储边界、协议和验证见 [工程协作服务](src/help/docs/collaboration-service.md)。

全局「工程历史」由 S 保存，所有工作区和协作者读取同一份历史。每笔有效事务立即留档，界面按编辑时段聚合；可命名版本、比较文件、恢复资源或整个工程。恢复经过权限、写权与版本校验，并生成新版本。旧浏览器本地历史可单独导出。

`.progress` 表单按操作自动提交：连续文字输入合并，开关、目标增删和排序及时提交。S 校验被修改字段的原值，并短暂取得写权；不同字段可并行修改，同一字段冲突时保留输入。撤销／重做引用服务端原操作回执，保留他人不相关的修改；工程历史继续记录每次有效提交。

## 验证

```sh
cargo test -p project-core --manifest-path src-tauri/Cargo.toml
cargo build -p project-server --manifest-path src-tauri/Cargo.toml
npm run check:protocol
npm run test:project-boundary
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
