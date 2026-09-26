# MC 皮肤管理器说明（HanShuWebUI）

## 当前架构（工程内 FSA）

皮肤库与剧本共用**同一个工程文件夹**，浏览器 / Tauri WebView 均通过
File System Access 读写，**不再依赖** `skin-http` 或 Vite `/api` 代理。

```
工程根/
  project.json
  *.hs …
  assets/
  .hanshu/skinmanager/          # 皮肤库
    library.json                # schema v5（条目 tags 为自由字符串，无独立标签注册表）
    objects/<ab>/<skinId>.hskin
    cache/png/<skinId>.png
    tmp/import-jobs.json        # 导入任务快照
```

前端仍走 `SkinApi`（[`src/skin/api/SkinApi.ts`](../src/skin/api/SkinApi.ts)）：

| 适配器 | 何时使用 |
|--------|----------|
| **FSA**（默认） | 已打开剧本工程；数据在 `.hanshu/skinmanager` |
| Tauri IPC | 仅当设置 `VITE_SKIN_USE_TAURI=1`（对照/回退） |

相关代码：

- [`src/skin/local/`](../src/skin/local/) — TS 编解码 / 库 / 规范化
- [`src/skin/api/fsaAdapter.ts`](../src/skin/api/fsaAdapter.ts)
- [`src/project/bindingBus.ts`](../src/project/bindingBus.ts) — 工程句柄订阅

## 使用

1. Chrome / Edge 打开开发页，或运行桌面壳。
2. **剧本**工作区：文件 → 打开工程… / 新建工程…
3. 切到**皮肤**工作区：导入本地 PNG（64×64 或 64×32）、管理文件夹；标签写在皮肤上，系统自动收集。
4. 未打开工程时皮肤页会提示先打开工程（不再出现 Bad Gateway）。

联网导入（玩家名 / URL）已支持：

- **浏览器（`npm run dev`）**：玩家名经 Vite 同源代理访问 Mojang；PNG URL 直接 `fetch`（需目标站允许 CORS，如 `textures.minecraft.net`）。
- **桌面壳**：走 Tauri IPC → `skin-core` 的 `safe_fetch` / 玩家解析（无 CORS 限制）。

## 与 Rust skin-core 的关系

- `src-tauri/crates/skin-core` 仍保留，供可选 Tauri IPC、联网拉取与黄金 fixtures。
- 独立进程 **`skin-http` 已移除**。
- Codec 对拍：`npm run test:skin-codec`（对照 `skin-core/tests/fixtures`）。

## 旧数据

早期桌面版可能把库写在 `app_local_data_dir()/skin-manager/`。
不会自动迁移；需要时手动把该目录内容拷进当前工程的 `.hanshu/skinmanager/`。

## 历史迁移笔记

原先从 Node(Fastify) → Tauri IPC 的细节见仓库历史；现行权威路径是**工程内 FSA**。
