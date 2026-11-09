/**
 * 封段提示 / 段状态 / 归档简化日志（阶段 5-B / 草案 D4）验收。
 *
 * 覆盖：
 * ① `segmentSealed` 时输入区上方有短提示（不禁止发送，提示本身不是禁用控件）；
 * ② 段列表：sealed 段显示「已封存」、不再标成活跃；下拉选项带（已封存）；
 * ③ 归档摘要：`改动 N 个文件`、`· 有回滚`；旧归档没有字段则完全不显示；
 * ④ 简化日志：只读 path + 短哈希（beforeHash → afterHash），没有任何回滚入口。
 *
 * 跑法：node scripts/run-verification.mjs scripts/verify-agent-segment-ui.ts
 */

import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SegmentSealedHint } from '../src/AgentPanel'
import { SegmentBar } from '../src/agent/view/SegmentBar'
import { SnapshotList } from '../src/agent/view/SnapshotList'
import { segmentOptionLabel } from '../src/agent/view/derive'
import type { SegmentInfo, SnapshotInfo } from '../src/agent/contracts'

const SEGMENT: SegmentInfo = {
  id: 'seg-1',
  title: '第一段',
  createdAt: 1,
  updatedAt: 2,
  windowId: 'w1',
  state: 'sealed',
  runCount: 3,
}

const ACTIVE: SegmentInfo = { ...SEGMENT, id: 'seg-2', title: '第二段', state: 'active', runCount: 1 }

const SNAPSHOT: SnapshotInfo = {
  id: 'snap-1',
  scope: 'project-1',
  segmentId: SEGMENT.id,
  title: '保存点一',
  createdAt: 3,
  entryCount: 12,
  filesChanged: 3,
  rolledBack: true,
  rollbackLog: [
    { path: '序章.hs', beforeHash: 'abcdef1234567890', afterHash: '123456abcdef7890' },
    { path: 'assets/zh_cn/lang_hs/序章.lang', beforeHash: null, afterHash: 'deadbeefcafe' },
  ],
}

/** 旧归档：没有 filesChanged / rolledBack / rollbackLog */
const LEGACY: SnapshotInfo = {
  id: 'snap-0',
  scope: 'project-1',
  segmentId: SEGMENT.id,
  title: '旧保存点',
  createdAt: 1,
  entryCount: 4,
}

const noop = () => undefined

/* ── ① 封段提示 ── */
const hint = renderToStaticMarkup(createElement(SegmentSealedHint))
assert.ok(hint.includes('本次保存已封存当前会话；发送消息将开始新会话'), '封段提示文案')
assert.ok(!hint.includes('<button'), '只是提示，不禁用发送')

/* ── ② 段状态：sealed 显示已封存，不显示活跃 ── */
const sealedBar = renderToStaticMarkup(
  createElement(SegmentBar, {
    segments: [ACTIVE, SEGMENT],
    currentId: SEGMENT.id,
    loading: false,
    creating: false,
    deleting: false,
    canDelete: true,
    onSelect: noop,
    onCreate: noop,
    onDelete: noop,
  }),
)
assert.ok(sealedBar.includes('已封存段'), '当前选中的 sealed 段直接标「已封存段」')
assert.ok(!sealedBar.includes('>活跃段<'), 'sealed 段不再显示「活跃段」')
assert.ok(sealedBar.includes('已封存 · 3 轮'), '段元信息显示已封存')
assert.ok(sealedBar.includes('（已封存）'), '下拉选项带封存标记')

const activeBar = renderToStaticMarkup(
  createElement(SegmentBar, {
    segments: [ACTIVE],
    currentId: ACTIVE.id,
    loading: false,
    creating: false,
    deleting: false,
    canDelete: true,
    onSelect: noop,
    onCreate: noop,
    onDelete: noop,
  }),
)
assert.ok(activeBar.includes('活跃段'), '活跃段照旧显示活跃')
assert.ok(!activeBar.includes('已封存'), '活跃段不带封存文案')
assert.equal(segmentOptionLabel(SEGMENT), '第一段 · 3 轮（已封存）')
assert.equal(segmentOptionLabel(ACTIVE), '第二段 · 1 轮')

/* ── ③ 归档列表摘要 + ④ 简化日志 ── */
const listHtml = renderToStaticMarkup(
  createElement(SnapshotList, {
    snapshots: [SNAPSHOT, LEGACY],
    loading: false,
    usageBytes: null,
    persistState: 'idle',
    opened: null,
    openedLoading: false,
    busyId: null,
    onRefresh: noop,
    onPersist: noop,
    onClose: noop,
    onOpen: noop,
    onCloseOpened: noop,
    onFork: noop,
    onDelete: noop,
  }),
)
assert.ok(listHtml.includes('改动 3 个文件 · 有回滚'), '摘要：改动数 + 有回滚')
assert.equal((listHtml.match(/改动 \d+ 个文件/g) ?? []).length, 1, '旧归档没有字段就不显示摘要')
assert.ok(listHtml.includes('改动明细（2）'), '简化日志可展开')
assert.ok(listHtml.includes('序章.hs'), '日志列出 path')
assert.ok(listHtml.includes('abcdef12 → 123456ab'), '短哈希 beforeHash → afterHash')
assert.ok(listHtml.includes('— → deadbeef'), '新建文件（before=null）显示 —')
assert.ok(!/强制回滚|重试回滚|放弃回滚|帮 忙处理/.test(listHtml), '只读：没有回滚入口')

/* ── 归档详情同样展示摘要与日志；旧归档不显示 ── */
const openedHtml = renderToStaticMarkup(
  createElement(SnapshotList, {
    snapshots: [SNAPSHOT],
    loading: false,
    usageBytes: null,
    persistState: 'idle',
    opened: { id: SNAPSHOT.id, title: SNAPSHOT.title, items: [], snapshot: SNAPSHOT },
    openedLoading: false,
    busyId: null,
    onRefresh: noop,
    onPersist: noop,
    onClose: noop,
    onOpen: noop,
    onCloseOpened: noop,
    onFork: noop,
    onDelete: noop,
  }),
)
assert.ok(openedHtml.includes('改动 3 个文件 · 有回滚'), '详情展示摘要')
assert.ok(openedHtml.includes('改动明细（2）'), '详情展示简化日志')
assert.ok(!/强制回滚|重试回滚|放弃回滚/.test(openedHtml), '详情只读：没有回滚入口')

const legacyOpenedHtml = renderToStaticMarkup(
  createElement(SnapshotList, {
    snapshots: [LEGACY],
    loading: false,
    usageBytes: null,
    persistState: 'idle',
    opened: { id: LEGACY.id, title: LEGACY.title, items: [], snapshot: LEGACY },
    openedLoading: false,
    busyId: null,
    onRefresh: noop,
    onPersist: noop,
    onClose: noop,
    onOpen: noop,
    onCloseOpened: noop,
    onFork: noop,
    onDelete: noop,
  }),
)
assert.ok(!legacyOpenedHtml.includes('改动'), '旧归档无摘要/日志')

console.log(
  '通过：封段提示、段状态（已封存）、归档简化日志（改动数/有回滚/短哈希，只读无回滚入口）',
)
