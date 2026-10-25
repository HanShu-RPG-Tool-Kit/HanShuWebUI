# 开发入口

- 开发文档与用户手册的唯一正文来源是 `src/help/docs/`，不要在 `docs/` 另写平行正文。
- 修改工程读取、编辑、保存、资源管理、导入或历史功能前，先读 [多人协作编程指南](src/help/docs/collaboration-programming.md)。本机工程与远端工程遵循同一 C/S 权威边界。
- 详细架构与限制见 [工程服务与多人协作](src/help/docs/collaboration-service.md)，启动和验证入口见 [README](README.md)。

- 新增或修改节点编辑器前，阅读[通用节点编辑器接入规范](src/help/docs/node-editor.md)。优先复用 `src/nodeEditor/`，业务文档通过适配器接入，不直接持久化 React Flow 状态。

- 修改资源分类、文件夹、新建格式或路径时，先读[资源分类与共享组织](src/help/docs/resource-organization.md)。共享虚拟文件夹经 `meta/explorer.json` 和 S 文件事务管理，不能退回本机视图存储。
