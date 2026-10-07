# 皮肤库

皮肤库与剧本共用**同一个工程文件夹**。浏览器 / Tauri WebView 通过 File System Access 读写，**不再依赖**独立的 `skin-http` 或 Vite `/api` 代理。

## 工程内布局

```
工程根/
  project.json
  *.hs …
  assets/
  .hanshu/skinmanager/          # 皮肤库
    library.json                # schema v5（条目 tags 为自由字符串）
    objects/<ab>/<skinId>.skin
    cache/png/<skinId>.png
    tmp/import-jobs.json
```

对象文件为二进制 `.skin`（像素 + 半透明 flag，不含 model）。分享串：`hanshu-skin:1:<model>:<payload>`。

| 适配器 | 何时使用 |
| --- | --- |
| **FSA**（默认） | 已打开剧本工程；数据在 `.hanshu/skinmanager` |
| Tauri IPC | 仅当设置 `VITE_SKIN_USE_TAURI=1`（对照/回退） |

实现入口：`src/skin/api/SkinApi.ts`、`src/skin/local/`、`src/skin/api/fsaAdapter.ts`。

## 使用

1. Chrome / Edge 打开开发页，或运行桌面壳。
2. **剧本**工作区：文件 → 打开工程… / 新建工程…
3. 切到**皮肤**工作区：导入本地 PNG（正方形 N×N 或半高 N×N/2，N∈[64…1024]）、管理文件夹；标签写在皮肤上，系统自动收集。
4. 未打开工程时皮肤页会提示先打开工程。

联网导入（玩家名 / URL）：

- **浏览器（`npm run dev`）**：玩家名经 Vite 同源代理访问 Mojang；PNG URL 直接 `fetch`（需目标站允许 CORS）。
- **桌面壳**：走 Tauri IPC → `skin-core` 的 `safe_fetch` / 玩家解析（无 CORS 限制）。

## 与 Rust skin-core

- `src-tauri/crates/skin-core` 供可选 Tauri IPC、联网拉取与黄金 fixtures。
- 独立进程 `skin-http` 已移除。
- Codec 对拍：`npm run test:skin-codec`。

## 旧数据

早期桌面版可能把库写在 `app_local_data_dir()/skin-manager/`。不会自动迁移；需要时手动拷进当前工程的 `.hanshu/skinmanager/`。