# 工程协作服务（第一版）

React 为 C，Rust 工程服务为 S。`project-core` 不依赖 Tauri 或 HTTP；`project-server` 提供 HTTP/WebSocket。桌面与浏览器使用同一协议，同一工程目录同时仅一个服务进程持有。

## 身份与权威

- Subject 是身份主体，`id/name/kind/enabled`；不要求是自然人。凭证哈希关联主体，角色按工程授予。
- Session 是某主体的一次登录，含客户端名称。多个会话可以属于同一主体。会话令牌只用于当前服务进程，重启后须重新登录。
- Role 为 owner/editor/viewer。owner 管理主体和接管写权；editor 编辑；viewer 读取。所有写入入口都检查服务端权限。
- Lease 为资源上的会话级独占写权，含随机 ID 和服务器到期时间。不能以主体相同代替租约校验。保存同时检查会话、权限、租约和内容修订号。
- 在线状态跟随会话。查看、持有编辑权与正在输入分别表达；仅持有写权的会话可报告输入活动。

## 资源与持久化

资源身份独立于名称和正文里的文档 ID。第一版资源类型为 folder/progress/goalDefinition；正文为现有 `.progress` v1 格式，不改变其作者语义。目标定义 `.py` 随工程导入，由各 C 按现有装饰器声明解析，不在 S 中执行。目录移动、改名、删除也受权限、版本和相关写权约束。

服务目录的 `project.json` 是第一版权威事务快照，包含主体、工程授权、凭证哈希和资源正文。先保存候选快照，再替换内存状态；保存失败不提交。`owner-key` 是本机管理者恢复凭证，不通过公开接口提供；新主体的凭证只在创建时返回一次。不要把服务目录提交到版本库。

这版工程资源通过导入/导出与普通 `.progress` 文件交换，服务目录不是此前浏览器直接读写的工程目录。标签页、选中、视口和未提交草稿保留在各个 C。

会话 60 秒、写权 30 秒有效，客户端定期续租。到期、登出、停用主体或降为只读会撤销相关写权；旧租约不得覆盖新租约。进程重启不恢复会话或租约。

第一版仅 `.progress` 接入。剧本、流程图和皮肤原有路径暂不迁移，文本及节点共同编辑后续按资源类型实现。

## 启动与使用

需要 Node.js（前端构建/开发）和仓库 `rust-toolchain.toml` 指定的 Rust 工具链。桌面构建还需要 Tauri 对应平台的构建环境。Node 不随桌面产品打包。

```sh
npm install
npm run dev
```

开发命令启动 Vite（`http://localhost:5173`）和 Rust S（`127.0.0.1:47831`），Rust 源文件保存后自动重编译/重启，前端继续热更新。Rust 重启会清除会话，需要重新登录；本窗口草稿保留。仅启动前端使用 `npm run dev:ui`，仅启动 S 使用 `npm run server`。可用 `HANSHU_CARGO` 指定 Cargo，`HANSHU_PROJECT_DIR` 指定开发服务数据目录。

1. 打开「进度流程 → 共享工程」。默认 `/__project` 经 Vite 代理到本机 S。
2. Web 调试时将 `.hanshu-server/owner-key` 内容填入主体凭证，设置本端名称后连接。凭证文件不通过公开接口返回。
3. 在「主体与权限」中创建编辑或只读主体，种类可填 account/agent/service 等。把仅返回一次的凭证交给对应主体。
4. 其他窗口以各自凭证连接；同一主体也可以登录多个会话。导入 `.progress` 或从「本机草稿」显式复制到 S，必要时导入目标定义 `.py`。
5. 选择文档，申请写权后编辑，点击保存或 Ctrl+S 提交。其他 C 收到保存结果；输入活动与持有写权分别显示。
6. 释放写权后其他会话可接手。管理者可以接管；原会话立即失去提交能力并保留草稿。草稿可下载，或显式放弃后读取最新版。

会话令牌只保存在内存，浏览器刷新须重新登录，因此复制标签页不会悄悄共用一个编辑会话。未提交正文备份到该窗口的 sessionStorage，重新登录同一主体/工程后可以恢复；关闭窗口前仍应保存或下载草稿。

```sh
npm run desktop:dev
npm run desktop:build
```

Tauri 在本机回环的动态端口启动相同服务模块，数据位于应用本地数据目录的 `project-service` 子目录。共享工程入口自动以本机管理者连接；恢复凭证只经本地 IPC 传递。开发服务和桌面内置服务默认管理各自目录，可通过 UI 服务地址连接到同一个选定 S。

## 独立中心服务

```sh
cargo run --manifest-path src-tauri/Cargo.toml -p project-server -- \
  --project /path/to/service-data \
  --listen 0.0.0.0:47831 \
  --origin http://your-client-host:5173 \
  --web-root dist
```

`--web-root` 可省略；提供时 S 同时提供已构建的前端。静态目录不能包含服务数据目录。允许来源可多次指定，HTTP 和 WebSocket 都检查来源；无 Origin 的程序客户端仍须认证。每个独立服务进程管理一份工程。

桌面版默认只监听本机；启动前设置 `HANSHU_PROJECT_LISTEN=0.0.0.0:47831` 可监听其他设备连接，`HANSHU_PROJECT_ORIGINS` 可填写逗号分隔的客户端来源。局域网设备在客户端填写中心设备地址，使用由该工程签发的凭证。首版未内置 TLS、互联网穿透或反向代理配置；跨互联网部署需另外配置加密接入。

## 协议与校验

HTTP JSON 协议 v1，认证后的请求携带 `Authorization: Bearer <session-token>`。凭证用于建立会话，不能作为会话令牌直接调用资源接口。WebSocket 首条消息提交会话令牌，不将令牌放入 URL。广播的是不含正文和凭证的 Snapshot，C 按资源版本读取所需正文；临时在线状态和写权不增加文档内容版本。

| 路径 | 方法 | 含义 |
|---|---|---|
| `/health` | GET | 协议和存活检查 |
| `/api/sessions` | POST | `{credential, clientName}` 登录 |
| `/api/sessions/current` | DELETE | 登出并释放本会话写权 |
| `/api/project` | GET | 当前主体权限、资源目录、在线会话、写权 |
| `/api/heartbeat` | POST | `{resourceId, leaseId?, typing}` 更新在线状态/续租 |
| `/api/subjects` | POST | 管理者创建主体、授予角色并签发凭证 |
| `/api/subjects/{id}` | PATCH | 管理者修改 editor/viewer 权限或启停主体 |
| `/api/resources` | POST | 新建文件夹、进度或目标定义 |
| `/api/resources/{id}` | GET/PUT/PATCH/DELETE | 读取、保存、改名/移动、删除 |
| `/api/resources/{id}/lease` | POST/DELETE | 申请/接管、释放写权 |
| `/api/events` | WebSocket | 认证后推送当前状态与后续更新 |

401 表示会话失效，403 表示无权限/来源不允许，423 表示写权冲突，409 表示版本/名称/目录冲突，400 表示数据无效。保存携带 `{leaseId, revision, content}`，版本冲突不自动覆盖。单份正文上限 1 MiB，当前最多 1024 项资源、256 个主体和 128 个在线会话。

`src/collab/generated.ts` 从 Rust 权威模型生成，运行 `npm run generate:protocol` 更新，`npm run check:protocol` 检查一致性。第一版执行文档结构校验；未解析的 Goal/礼包/条件对象引用可以作为草稿保留，不表示已有游戏运行时求值。

## 验证（2026-10-15）

- `cargo test -p project-core --manifest-path src-tauri/Cargo.toml`：6 组核心测试覆盖身份、权限、写权、版本、重启、保存失败不提交，以及重复 JSON 键拒绝。
- 构建 `project-server` 后执行 `npm run test:collaboration`：真实进程、多会话、WebSocket、只读限制、接管、停用/降权、版本冲突及重启恢复。
- `npm run build` 后执行 `npm run test:collaboration:ui`：隔离的三个浏览器客户端，两个会话属于同一主体，一个只读非自然人主体；验证表单禁用、保存广播、交接、接管及断线/重启/重新登录后的草稿保留。Windows 使用已安装的 Edge，其他平台需安装 Playwright Chromium。
- 桌面执行 `cargo check/build -p hanshu --manifest-path src-tauri/Cargo.toml`，验证内置服务编译；原有皮肤模块有一条未读字段警告，未因此修改其逻辑。
- 实际启动桌面调试程序，确认动态端口健康检查、本地 IPC 与 React 自动建立的「桌面窗口」会话正常；原生窗口截图读取工具授权超时，未据此声称完成原生点击验收。
- `npm run dev` 的双进程启动与 Vite 代理健康检查已执行；原有进度模型 69 项、编辑组 9 项、目标定义 5 项及进度文档契约验证通过。

第一版未实现密码注册、外部身份提供方、凭证轮换、按资源单独授权、跨项目管理、文本/图操作共同编辑或公网部署。API 会话和权限已落地，不以客户端按钮禁用替代服务端验证。
