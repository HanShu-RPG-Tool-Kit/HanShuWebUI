# IDE 活动列表

全应用统一的**活动 / 通知**通道：短提示与可更新进度任务都进这里，**不插入编辑区 layout**（避免顶栏横幅把界面挤抖）。

## 用户怎么用

- **IDE 统一状态栏最右侧**的铃铛（与 Cursor 通知铃同位置语义；见 [IDE 壳](#ide-chrome)）：未读角标；点击向上弹出活动面板。
- 面板内按时间倒序列出活动；可单条关闭或「清空」。
- 打开面板视为已读（角标清零）。`Esc` 或点面板外关闭。

典型会出现的内容：保存结果、导入/导出、刷新物品快照、资源树操作失败等。

活动数据全局一份；铃铛固定在壳状态栏最右，不随工作区再画第二条底栏。不再用悬浮按钮或占编辑区 layout 的横幅。

## 开发约定

入口：`src/activity/`（`notify` / `pushActivity` / `updateActivity`）。

| API | 用途 |
| --- | --- |
| `notify(title, options?)` | 短提示；可省略 `kind`（按文案推断 success/error/warning/info） |
| `pushActivity({ title, kind?, detail?, source?, progress?, done?, id? })` | 完整写入；可带稳定 `id` 便于后续更新 |
| `updateActivity(id, patch)` | 更新进度或把 `progress` 标为 `done` |
| `dismissActivity` / `clearActivities` | 移除 |

`kind`：`info` | `success` | `warning` | `error` | `progress`。

`source` 建议用稳定小写标识（如 `progress`、`items`、`project`），面板上可展示。

### 进度任务示例

```ts
import { pushActivity, updateActivity } from '../activity'

const id = pushActivity({
  kind: 'progress',
  title: '刷新物品快照',
  source: 'items',
  progress: { current: 0, total: 128 },
  done: false,
})
// …
updateActivity(id, { progress: { current: 24, total: 128 } })
updateActivity(id, { kind: 'success', title: '已刷新 128 个物品快照', done: true, progress: undefined })
```

不确定进度用 `progress: 'indeterminate'`。

### 不要再做的事

- 不要在工作区顶栏再加占文档流的 `notice` 条（已从进度工作区移除）。
- 不要把会话令牌、密码写入活动内容。
- 活动列表是 **C 侧 UI 状态**（内存），刷新页面会清空；不是 S 事务日志。待确认提交仍看协作浮球「修改」。

## 与其它 UI 的边界

| 通道 | 管什么 |
| --- | --- |
| **活动列表** | 瞬时反馈、后台活动进度 |
| **协作浮球** | 连接、成员、多文件草稿与提交恢复 |
| **状态栏** | IDE 唯一底栏；工作区填左右槽，最右固定活动铃铛（见 [IDE 壳](#ide-chrome)） |
| **对话框 / 表单内联** | 字段校验、局部操作说明（可继续留在组件内） |

新增编辑器接入：成功/失败调用 `notify` 或 `pushActivity`，并写上 `source`。
