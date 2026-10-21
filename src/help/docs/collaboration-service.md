# 工程服务与多人协作

React 是 C，Rust 工程服务是 S。连接 S 就是打开一个完整工程，剧本、进度、流程图、脚本、物品、礼包、导航器、资产与皮肤工作区使用同一工程会话。原来的独立「共享进度」入口已移除。

## 权威边界

- S 持有普通工程目录，维护主体、会话、授权、写权与文件版本。所有工程创建、保存、覆盖、改名、移动和删除都由 S 执行。
- C 不持有工程目录的 OS 文件系统句柄。`ProjectDirectory` 是只读的远程目录引用，不含 `createWritable`、`removeEntry` 或任意本机路径打开能力。写入通过明确的 HTTP 工程命令请求。
- 浏览器本地存储、IndexedDB 是草稿与缓存，不能直接覆盖服务端工程。文件导入只读取用户选择的文件；导出下载到客户端，不能指定服务端绝对路径。
- 桌面版运行同一 S。选择本机工程目录的对话框由可信的 Rust 宿主弹出，返回服务连接信息；C 不获得目录写权限。旧皮肤库写入 IPC 与 WebView 文件读写自动授权已移除，原生网络辅助仍可用于下载皮肤。

## 主体、会话与授权

Subject 是身份主体，包含 `id/name/kind/enabled`，可表示自然人、agent、服务或工具。凭证登录建立 Session；同一主体打开两个客户端，会得到两个独立会话。

工程角色为 owner/editor/viewer。owner 创建主体、调整授权、停用主体和接管写权；editor 修改资源；viewer 读取资源。权限由 S 检查，绕过界面直接请求也不会获得写入能力。目前采用管理者签发的高熵凭证，不提供密码注册、密码找回或第三方登录。以后可增加认证入口，继续复用同一主体与工程授权。

会话令牌只保存在内存，不写 URL 或持久化浏览器存储。会话有效期 60 秒，客户端每 8 秒心跳；服务重启后重新登录。管理者恢复凭证仅位于 S 的私有目录，HTTP 不返回它；新主体凭证仅创建时返回一次。

## 工程目录

```text
工程根/
  project.json                 # 原工程清单，不是服务身份数据库
  src/                         # .hs/.char/.py/.progress/.hflow/.nav/.item/.kit
  meta/                        # 创作资料与配音服务配置
  assets/                      # 语言、图片、音频等
  .hanshu/
    skinmanager/               # 皮肤集合与对象文件
    service/                   # S 私有状态，不经资源 API 暴露
      project.json             # 主体、授权、凭证哈希
      owner-key
      service.lock
      file-undo.json           # 事务期间存在的恢复日志
```

S 打开普通工程目录，直接读写这些资源，不需要把进度文件另外导入一份独立数据库。原型第一版的独立协作数据库不作为普通目录工程自动兼容。

仅允许访问工程清单、`src`、`meta`、`assets`、`.hanshu/skinmanager`。S 拒绝绝对路径、`..`、Windows 设备名/ADS、大小写冲突、符号链接/目录联接，以及服务私有目录。工程目录同时只能由一个 S 进程管理。

## 修改与一致性

每个文件的版本是其内容哈希，目录版本包含整个子树。C 提交读取时的版本，S 同时验证会话、权限、写权与版本；409/423 不会自动改用新版本重试覆盖。

写权属于会话，30 秒有效并随心跳续租。第一次提交某个资源时申请写权，界面可查看持有者、释放全部写权，管理者可接管。不同资源可由不同会话同时持有；同一资源的未提交本地编辑仍是草稿，只有有效写权持有者能提交。

源文件及其语言、配音资源共用源文档写权，防止两个人分别修改 `.progress` 和它的标题语言文件。S 为改名/删除推导完整关联资源列表，并检查事务包含全部关联项。目录操作也检查子树中的写权。

文件事务先校验整批修改，再保存撤销日志、执行原子文件替换。执行失败尝试回滚；回滚失败则拒绝继续提供文件操作，重启先恢复日志，再接受客户端。逐文件原子替换与恢复日志保护的是经 S 访问的工程；不会向绕过 S 的第三方磁盘读取程序承诺跨文件原子视图。

保存只提交变更，不根据客户端清单中缺少的条目删除文件，也不整树删除后重写 `assets`。删除是显式命令。`.progress` 执行结构校验，皮肤库索引检查基本结构；普通源码可以保留未完成内容，S 不执行目标定义或游戏脚本。

WebSocket 通知文件版本与主体/写权状态，不广播全部正文。C 按版本读取变化，更新未修改的资源，保留本地修改。窗口内的源文件正文草稿保存在 sessionStorage，并携带原版本；重连不会把旧草稿自动覆盖到 S。二进制草稿仍依赖窗口缓存，关闭前应提交或导出。

## 开发与本机使用

```sh
npm install
npm run dev
```

同时启动 Vite（`http://localhost:5173`）和 Rust S（`127.0.0.1:47831`）。默认工程目录 `.hanshu-project/`，管理者凭证 `.hanshu-project/.hanshu/service/owner-key`；用 `HANSHU_PROJECT_DIR` 指定已有工程。点击全局「打开工程…」，服务地址默认 `/__project`，填入凭证和本端名称。空目录第一次打开时可填写工程名称。

`npm run dev:ui` 仅启动 C；`npm run server` 仅启动 S。Rust 源码修改后开发服务重编译/重启，需重新登录，窗口源文件草稿可恢复。

`npm run desktop:dev` 启动桌面壳与内置 S，默认目录为应用本地数据目录的 `projects/default`，经本地 IPC 自动登录。打开窗口中的「由本机服务打开文件夹…」可以选择普通工程；也可输入远端服务地址与凭证。

## 局域网中心服务

```sh
npm run build
cargo run --manifest-path src-tauri/Cargo.toml -p project-server -- --project /path/to/project --listen 0.0.0.0:47831 --origin http://192.168.1.10:47831 --web-root dist
```

替换目录和中心设备 IP，放行相应防火墙端口。其他设备访问 `http://192.168.1.10:47831`，使用各自主体凭证打开工程。`--origin` 可重复指定；C 单独部署时填写其页面来源。`--web-root` 可省略，此时只提供 API。静态目录不能包含工程及凭证目录。

首版不内置 TLS、互联网穿透、跨项目目录浏览或多服务器复制。公网部署需另外配置加密接入。多人同步以文件写权和版本校验为基础，还没有 `.hs` 或节点图操作级的共同编辑。

## HTTP / WebSocket 协议 v2

认证请求携带 `Authorization: Bearer <session-token>`。WebSocket 在首条消息认证，不在 URL 中携带令牌。

| 路径 | 方法 | 含义 |
| --- | --- | --- |
| `/health` | GET | 协议与存活检查 |
| `/api/sessions` | POST | 凭证登录 `{credential,clientName}` |
| `/api/sessions/current` | DELETE | 登出并撤销写权 |
| `/api/project` | GET | 主体、会话、角色、写权与文件修订计数 |
| `/api/heartbeat` | POST | 续会话与已持有的文件写权 |
| `/api/subjects` | POST | owner 创建主体并签发凭证 |
| `/api/subjects/{id}` | PATCH | owner 改角色或启停主体 |
| `/api/files` | GET | 文件树、各文件/目录的版本 |
| `/api/files/content?path=…&version=…` | GET | 读取文件；可要求特定版本 |
| `/api/files/source-plan?path=…&destination=…` | GET | S 推导源文件操作及关联项 |
| `/api/files/leases` | POST / DELETE | 申请/接管、释放写权 |
| `/api/files/commit` | POST | `{changes:[{op,path,version,leaseId,content?,destination?,destinationVersion?}]}` |
| `/api/events` | WebSocket | 当前状态与后续通知 |

操作为 `write/mkdir/remove/move`，正文使用 Base64，`version:null` 表示原来不存在。旧 `/api/resources` 入口已移除。类型由 Rust 生成到 `src/collab/generated.ts`。

## 验证与当前限制

2026-10-21 验证：Rust 身份/权限与目录文件测试，真实 HTTP/WebSocket 多会话测试，三个隔离浏览器客户端测试，前端构建、协议一致性与桌面 Rust 编译。浏览器测试验证全局打开、进度和语言同步、写权交接、剧本保存与刷新、皮肤集合新增与刷新、服务重启后的正文草稿恢复；测试中直接文件系统写入口设为报错，调用数为零。自动测试在同一机器执行，不声称完成两台物理设备的局域网验收。

```sh
cargo test --manifest-path src-tauri/Cargo.toml -p project-core
cargo build --manifest-path src-tauri/Cargo.toml -p project-server
npm run check:protocol
npm run test:project-boundary
npm run test:collaboration
npm run build
npm run test:collaboration:ui
```

首版单个文件上限 32 MiB、工程 256 MiB / 16384 个文件和目录，批量事务最多 4096 项，网络请求正文上限 48 MiB。文件树使用内存扫描和串行提交，面向小规模工程；后续可优化索引和存储，不改变 C 无直接工程写入能力的边界。服务运行时应通过 S 编辑工程，暂不监听外部工具的磁盘修改。
