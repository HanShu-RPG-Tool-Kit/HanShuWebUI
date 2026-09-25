# MC 皮肤管理器迁移说明(skin-manager → HanShuWebUI)

按 `skin-manager-tauri-migration-review.md` 的技术建议,将原 Node(Fastify + React SPA)
皮肤站完整迁移为 Tauri 桌面工作区。

## 架构

```
src-tauri/
  Cargo.toml                 # Tauri package + Cargo workspace
  src/skin/                  # 薄 IPC 适配层
    commands.rs              # 24 个 skin_* commands(DTO、错误序列化、spawn_blocking)
    events.rs                # skin://job-updated / skin://library-updated
    state.rs                 # SkinState 初始化(app_local_data_dir/skin-manager)
  crates/skin-core/          # 独立业务 crate(不依赖 Tauri)
    src/codec.rs             # hskin1:P 布局、SHA-256、有界 zlib、稳定错误码
    src/normalize.rs         # PNG 前置检查、legacy 64x32 展开、alpha 规则
    src/storage/             # schema v3 读写、v1/v2 迁移、原子提交、对象 GC
    src/imports.rs           # job 状态机、staging、两阶段导入
    src/network/             # SafeFetcher(IP 策略、DNS pinning)、Mojang provider
    tests/                   # 黄金 fixtures 对照 + 存储与导入集成测试
src/skin/                    # 前端工作区(React 19 + CSS Modules)
  SkinWorkspace.tsx          # 原 App 迁移,三栏布局
  components/                # FolderTree / TagPicker / ImportQueuePanel / SkinThumb / SkinPreview3D
  api/                       # SkinApi 接口 + Tauri adapter(组件不直接 import Tauri API)
  contracts/types.ts         # IPC 契约(纯类型,无 Node 内置模块)
  styles/workspace.module.css
```

## 与旧实现的兼容性

- **hskin1 codec**:P 布局、skinId、限制(24KiB/18KiB/512KiB/64KiB)与错误码逐字节对齐;
  5 组跨语言黄金 fixtures(Node 导出)验证 rgba/skinId 完全一致。
- **zlib 解压更严格**:拒绝截断流、zlib 流后尾随数据(旧 Node 解码器会忽略尾随字节)。
- **library.json schema v3**:字段名、类型、含义不变;v1/v2 自动迁移,迁移幂等,
  v1 备份保留在 `library.json.v1-migration-backup`。
- **三态 folderId**:patch 中缺失=不变、null=未归档、值=移动;查询同样区分。
- **SSRF 加固**:IPv6 用 CIDR 判断(fe80::/10 而非字符串前缀)、每跳全地址校验、
  `resolve_to_addrs` 连接 pinning、`no_proxy()`、手动跳转(≤3,拒绝 https→http 降级)、
  `Accept-Encoding: identity`、有界响应体。**行为变化**:仅允许 80/443 标准端口。
- **损坏库不再静默清空**:主文件+备份都损坏时拒绝覆盖,进入可诊断错误。

## 数据位置

`app_local_data_dir()/skin-manager/`(Windows 用本地数据位置,不放 roaming):
`library.json`、`objects/<ab>/<skinId>.hskin`、`cache/png/`、`tmp/`。

## 测试

- `cargo test --workspace`:55 个测试(32 单测 + 4 黄金对照 + 19 集成)。
- 前端:`tsc -b`、`vite build`、`oxlint`(0 error)。
- 旧 Node 仓库 27 个测试在迁移前全部通过(基线冻结),fixtures 由其导出。

## 已知限制(第一版)

- 旧目录迁移流程(评审步骤 11)未实现:旧库需手动复制到上述数据目录。
- E2E(WebdriverIO)与三平台打包 smoke 未包含在本 PR。
- 拖放文件导入未接 Tauri 窗口 drag-drop 事件;文件导入走原生对话框。
