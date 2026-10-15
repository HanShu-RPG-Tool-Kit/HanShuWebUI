# HanShu RPG Tool Kit · WebUI

React / TypeScript 创作前端，Tauri 桌面壳，Rust 工程协作服务。

## 开发

需要 Node.js 和 `rust-toolchain.toml` 指定的 Rust 工具链；桌面版还需要对应平台的 Tauri 构建环境。

```sh
npm install
npm run dev
```

一条命令启动 Vite 与 Rust S。浏览器访问 `http://localhost:5173`，在「进度流程 → 共享工程」连接服务。Web 开发的管理者凭证在 `.hanshu-server/owner-key`，不写进前端代码或公开接口。

- `npm run dev:ui`：只启动前端。
- `npm run server`：只启动 Rust 服务，开发源码修改后自动重建。
- `npm run desktop:dev`：桌面壳自行启动同一 Rust 服务模块。
- `npm run build` / `npm run desktop:build`：前端 / 桌面构建。

第一版共享工程支持主体、会话、工程角色、资源目录、`.progress` 独占写权、在线活动与保存广播。支持导入本机进度草稿和目标定义脚本。现有剧本、流程图、皮肤工作区的本地编辑路径继续保留。

完整启动、中心服务部署、存储边界、协议和验证见 [工程协作服务](docs/collaboration-service.md)。

## 验证

```sh
cargo test -p project-core --manifest-path src-tauri/Cargo.toml
cargo build -p project-server --manifest-path src-tauri/Cargo.toml
npm run check:protocol
npm run test:collaboration
npm run build
npm run test:collaboration:ui
npm run lint
```

浏览器测试使用隔离的测试工程与上下文，不使用用户浏览器数据。Windows 默认使用已安装的 Edge，其他平台须安装 Playwright Chromium。

协议 TypeScript 类型由 Rust 模型生成：修改模型后运行 `npm run generate:protocol`。
