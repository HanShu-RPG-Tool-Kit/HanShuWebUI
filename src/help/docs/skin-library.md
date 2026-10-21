# 皮肤库

皮肤库与剧本、进度共用同一个服务端工程。C 负责预览、表单和导入准备，皮肤集合与对象文件的持久化统一经过 Rust S，受主体权限、文件写权和版本校验保护。详见[工程服务与多人协作](#collaboration-service)。

## 工程内布局

```
工程根/
  project.json
  src/
  assets/
  .hanshu/skinmanager/          # 皮肤库
    library.json                # schema v5（条目 tags 为自由字符串）
    objects/<ab>/<skinId>.skin
    cache/png/<skinId>.png
    tmp/import-jobs.json
```

对象文件为二进制 `.skin`（像素 + 半透明 flag，不含 model）。分享串：`hanshu-skin:1:<model>:<payload>`。

实现入口：`src/skin/api/SkinApi.ts`、`src/skin/api/projectAdapter.ts`、`src/project/serviceClient.ts`。旧 Tauri 库写入适配器已删除。

## 使用

1. Chrome / Edge 打开开发页，或运行桌面壳。
2. 全局「打开工程…」：连接服务并登录主体
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