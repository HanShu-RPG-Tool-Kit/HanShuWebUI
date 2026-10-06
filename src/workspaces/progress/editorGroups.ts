import type { FlowEditorGroup, FlowWorkspaceState } from './storage'

/** 0 = 主组（左 / 上，字段在根上），1 = 拆分出的第二组。 */
export type GroupId = 0 | 1
export type SplitZone = 'left' | 'right' | 'top' | 'bottom'

const clampRatio = (value: number) => Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : 0.5

export function readGroup(state: FlowWorkspaceState, id: GroupId): FlowEditorGroup {
  if (id === 1) return state.split?.group ?? { openKeys: [], activeKey: null, pinnedKeys: [] }
  return { openKeys: state.openKeys ?? [], activeKey: state.activeKey, pinnedKeys: state.pinnedKeys ?? [] }
}

function writeGroup(state: FlowWorkspaceState, id: GroupId, group: FlowEditorGroup): FlowWorkspaceState {
  if (id === 0) return { ...state, openKeys: group.openKeys, activeKey: group.activeKey, pinnedKeys: group.pinnedKeys }
  return state.split ? { ...state, split: { ...state.split, group } } : state
}

export const focusedGroupId = (state: FlowWorkspaceState): GroupId => state.split?.focus === 1 ? 1 : 0

/** 关掉若干页；当前页被关时按 VS Code 习惯落到右邻，没有则左邻。 */
function withoutKeys(group: FlowEditorGroup, keys: ReadonlySet<string>): FlowEditorGroup {
  const openKeys = group.openKeys.filter((key) => !keys.has(key))
  const pinnedKeys = group.pinnedKeys.filter((key) => openKeys.includes(key))
  let activeKey = group.activeKey && openKeys.includes(group.activeKey) ? group.activeKey : null
  if (!activeKey) {
    const index = group.activeKey ? group.openKeys.indexOf(group.activeKey) : -1
    if (index >= 0) {
      activeKey = group.openKeys.slice(index + 1).find((key) => openKeys.includes(key))
        ?? group.openKeys.slice(0, index).reverse().find((key) => openKeys.includes(key))
        ?? null
    }
    activeKey ??= openKeys.at(-1) ?? null
  }
  return { openKeys, activeKey, pinnedKeys }
}

function sanitize(group: FlowEditorGroup, docKeys: ReadonlySet<string>): FlowEditorGroup {
  const openKeys = [...new Set(group.openKeys)]
  return withoutKeys({ ...group, openKeys }, new Set(openKeys.filter((key) => !docKeys.has(key))))
}

/** 清理失效页；某一组空了就收起拆分，主组空了由第二组顶上。 */
export function normalizeGroups(state: FlowWorkspaceState): FlowWorkspaceState {
  const docKeys = new Set(state.documents.map((document) => document.key))
  const primary = sanitize(readGroup(state, 0), docKeys)
  const split = state.split
  if (!split) return writeGroup({ ...state, split: null }, 0, primary)
  const secondary = sanitize(split.group, docKeys)
  if (!secondary.openKeys.length) return writeGroup({ ...state, split: null }, 0, primary)
  if (!primary.openKeys.length) return writeGroup({ ...state, split: null }, 0, secondary)
  return writeGroup({
    ...state,
    split: { ...split, group: secondary, ratio: clampRatio(split.ratio), focus: split.focus === 1 ? 1 : 0 },
  }, 0, primary)
}

export function focusGroup(state: FlowWorkspaceState, id: GroupId): FlowWorkspaceState {
  if (!state.split || state.split.focus === id) return state
  return { ...state, split: { ...state.split, focus: id } }
}

/** 在指定组打开（已开则切过去），并让该组获得焦点。 */
export function openInGroup(state: FlowWorkspaceState, id: GroupId, keys: string | string[]): FlowWorkspaceState {
  const list = Array.isArray(keys) ? keys : [keys]
  if (!list.length) return state
  const target: GroupId = state.split ? id : 0
  const group = readGroup(state, target)
  const openKeys = list.reduce((acc, key) => acc.includes(key) ? acc : [...acc, key], group.openKeys)
  return focusGroup(writeGroup(state, target, { ...group, openKeys, activeKey: list[0]! }), target)
}

export function closeInGroup(state: FlowWorkspaceState, id: GroupId, keys: string[]): FlowWorkspaceState {
  const group = readGroup(state, id)
  const pinned = new Set(group.pinnedKeys)
  const closing = new Set(keys.filter((key) => !pinned.has(key)))
  if (!closing.size) return state
  return normalizeGroups(writeGroup(state, id, withoutKeys(group, closing)))
}

export function closeOthersInGroup(state: FlowWorkspaceState, id: GroupId, key: string): FlowWorkspaceState {
  const group = readGroup(state, id)
  const next = writeGroup(state, id, { ...group, activeKey: key })
  return closeInGroup(next, id, group.openKeys.filter((item) => item !== key))
}

export function closeRightInGroup(state: FlowWorkspaceState, id: GroupId, key: string): FlowWorkspaceState {
  const group = readGroup(state, id)
  const index = group.openKeys.indexOf(key)
  if (index < 0) return state
  return closeInGroup(state, id, group.openKeys.slice(index + 1))
}

export function closeAllInGroup(state: FlowWorkspaceState, id: GroupId): FlowWorkspaceState {
  return closeInGroup(state, id, readGroup(state, id).openKeys)
}

/** 固定页挪到组内最前（排在已有固定页之后）。 */
export function togglePinInGroup(state: FlowWorkspaceState, id: GroupId, key: string): FlowWorkspaceState {
  const group = readGroup(state, id)
  if (!group.openKeys.includes(key)) return state
  if (group.pinnedKeys.includes(key)) {
    return writeGroup(state, id, { ...group, pinnedKeys: group.pinnedKeys.filter((item) => item !== key) })
  }
  const pinnedKeys = [...group.pinnedKeys, key]
  const rest = group.openKeys.filter((item) => item !== key)
  const openKeys = [...rest.filter((item) => pinnedKeys.includes(item)), key, ...rest.filter((item) => !pinnedKeys.includes(item))]
  return writeGroup(state, id, { ...group, openKeys, pinnedKeys })
}

function insertBefore(list: string[], key: string, beforeKey: string | null) {
  const rest = list.filter((item) => item !== key)
  const index = beforeKey ? rest.indexOf(beforeKey) : -1
  return index < 0 ? [...rest, key] : [...rest.slice(0, index), key, ...rest.slice(index)]
}

/** 拖页：同组内重排；跨组则移动过去（源组空了会收起拆分）。`beforeKey` 为空表示放到末尾。 */
export function moveTab(state: FlowWorkspaceState, from: GroupId, to: GroupId, key: string, beforeKey: string | null): FlowWorkspaceState {
  const source = readGroup(state, from)
  if (!source.openKeys.includes(key)) return state
  if (from === to) return writeGroup(state, from, { ...source, openKeys: insertBefore(source.openKeys, key, beforeKey) })
  if (!state.split) return state
  let next = writeGroup(state, from, withoutKeys(source, new Set([key])))
  const target = readGroup(next, to)
  const pinnedKeys = source.pinnedKeys.includes(key) && !target.pinnedKeys.includes(key) ? [...target.pinnedKeys, key] : target.pinnedKeys
  next = writeGroup(next, to, { openKeys: insertBefore(target.openKeys, key, beforeKey), activeKey: key, pinnedKeys })
  return normalizeGroups(focusGroup(next, to))
}

/**
 * 拆出第二组。`copy` 保留原页（右键「拆分」，同 VS Code）；`move` 把页挪过去（拖到边缘），
 * 但源组只剩这一页时退化为复制，免得留下空组。
 */
export function splitTab(state: FlowWorkspaceState, key: string, zone: SplitZone, mode: 'copy' | 'move'): FlowWorkspaceState {
  if (state.split) return state
  const source = readGroup(state, 0)
  if (!source.openKeys.includes(key)) return state
  const moving = mode === 'move' && source.openKeys.length > 1
  const remaining = moving ? withoutKeys(source, new Set([key])) : source
  const fresh: FlowEditorGroup = { openKeys: [key], activeKey: key, pinnedKeys: moving && source.pinnedKeys.includes(key) ? [key] : [] }
  const before = zone === 'left' || zone === 'top'
  return normalizeGroups(writeGroup({
    ...state,
    split: {
      group: before ? remaining : fresh,
      direction: zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical',
      ratio: 0.5,
      focus: before ? 0 : 1,
    },
  }, 0, before ? fresh : remaining))
}

/** 合并两组：第二组的页追加到主组末尾，保留焦点组的当前页。 */
export function joinGroups(state: FlowWorkspaceState): FlowWorkspaceState {
  if (!state.split) return state
  const primary = readGroup(state, 0)
  const secondary = state.split.group
  const activeKey = (state.split.focus === 1 ? secondary.activeKey : primary.activeKey) ?? primary.activeKey
  return normalizeGroups(writeGroup({ ...state, split: null }, 0, {
    openKeys: [...primary.openKeys, ...secondary.openKeys.filter((key) => !primary.openKeys.includes(key))],
    activeKey,
    pinnedKeys: [...new Set([...primary.pinnedKeys, ...secondary.pinnedKeys])],
  }))
}

export function setSplitRatio(state: FlowWorkspaceState, ratio: number): FlowWorkspaceState {
  return state.split ? { ...state, split: { ...state.split, ratio: clampRatio(ratio) } } : state
}
