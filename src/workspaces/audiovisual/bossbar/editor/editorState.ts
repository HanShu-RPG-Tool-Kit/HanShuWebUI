import { useCallback, useEffect, useRef, useState } from 'react'
import {
  defaultValueOf,
  isValueCompatible,
  type BossbarDocument,
  type BossbarValue,
  type BossbarValueMap,
  type BossbarVariable,
  type BossbarVariableType,
} from '../protocol'

/**
 * 编辑器本机状态与撤销栈。
 *
 * 相机、网格、参考底图、临时锁定/隐藏和面板布局只保存在当前工程/文档的本机状态里，
 * 不写进 .bossbar，也不是共享工程数据。
 */

export type BossbarInspectorTab = 'component' | 'variables' | 'atlas'

export type BossbarEditorViewState = {
  zoom: number
  panX: number
  panY: number
  grid: number
  showGrid: boolean
  showRulers: boolean
  /** 本机临时锁定（不影响游戏） */
  locked: string[]
  /** 本机临时隐藏（不影响游戏显隐） */
  hidden: string[]
  /** 预览底图：工程内 assets/ 路径，仅本机参考 */
  referenceAsset: string | null
  referenceOpacity: number
  playbackSpeed: number
  inspectorTab: BossbarInspectorTab
}

export const DEFAULT_EDITOR_VIEW: BossbarEditorViewState = {
  zoom: 1,
  panX: 0,
  panY: 0,
  grid: 8,
  showGrid: true,
  showRulers: true,
  locked: [],
  hidden: [],
  referenceAsset: null,
  referenceOpacity: 0.35,
  playbackSpeed: 1,
  inspectorTab: 'component',
}

const STORAGE_PREFIX = 'hanshu.bossbarEditor.v2::'

function storageKey(projectId: string, fileId: string): string {
  return STORAGE_PREFIX + projectId + '::' + fileId
}

function editorViewState(input: Partial<BossbarEditorViewState>): BossbarEditorViewState {
  const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    zoom: Math.max(0.1, finite(input.zoom, 1)),
    panX: finite(input.panX, 0),
    panY: finite(input.panY, 0),
    grid: Math.max(1, finite(input.grid, 8)),
    showGrid: typeof input.showGrid === 'boolean' ? input.showGrid : true,
    showRulers: typeof input.showRulers === 'boolean' ? input.showRulers : true,
    locked: Array.isArray(input.locked) ? input.locked.filter((id): id is string => typeof id === 'string') : [],
    hidden: Array.isArray(input.hidden) ? input.hidden.filter((id): id is string => typeof id === 'string') : [],
    referenceAsset: typeof input.referenceAsset === 'string' ? input.referenceAsset : null,
    referenceOpacity: Math.max(0, Math.min(1, finite(input.referenceOpacity, 0.35))),
    playbackSpeed: Math.max(0.1, Math.min(2, finite(input.playbackSpeed, 1))),
    inspectorTab: input.inspectorTab === 'variables' || input.inspectorTab === 'atlas' ? input.inspectorTab : 'component',
  }
}

export function loadEditorViewState(projectId: string, fileId: string): BossbarEditorViewState {
  try {
    const raw = localStorage.getItem(storageKey(projectId, fileId))
    return raw ? editorViewState(JSON.parse(raw)) : editorViewState(DEFAULT_EDITOR_VIEW)
  } catch {
    return editorViewState(DEFAULT_EDITOR_VIEW)
  }
}

export function saveEditorViewState(
  projectId: string,
  fileId: string,
  state: BossbarEditorViewState,
): void {
  try {
    localStorage.setItem(storageKey(projectId, fileId), JSON.stringify(editorViewState(state)))
  } catch {
    /* 无痕模式只保留内存 */
  }
}

/** 文档源码的撤销栈：设计视图与源码视图编辑同一份草稿，所以以字符串为步骤 */
export type BossbarHistory = {
  canUndo: boolean
  canRedo: boolean
  commit: (content: string) => void
  undo: () => string | null
  redo: () => string | null
  reset: () => void
  depth: number
}

const HISTORY_LIMIT = 128

export function useBossbarHistory(current: string): BossbarHistory {
  const [past, setPast] = useState<string[]>([])
  const [future, setFuture] = useState<string[]>([])
  const seenRef = useRef(current)
  const expectedRef = useRef<string | null>(null)

  useEffect(() => {
    if (current === seenRef.current) return
    const previous = seenRef.current
    seenRef.current = current
    if (expectedRef.current === current) {
      expectedRef.current = null
      return
    }
    expectedRef.current = null
    setPast((stack) => [...stack, previous].slice(-HISTORY_LIMIT))
    setFuture([])
  }, [current])

  const commit = useCallback(
    (content: string) => {
      if (content === current) return
      expectedRef.current = content
      setPast((stack) => {
        const next = [...stack, current]
        return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
      })
      setFuture([])
    },
    [current],
  )

  const undo = useCallback((): string | null => {
    if (!past.length) return null
    const previous = past[past.length - 1]
    expectedRef.current = previous
    setPast(past.slice(0, -1))
    setFuture([...future, current])
    return previous
  }, [current, future, past])

  const redo = useCallback((): string | null => {
    if (!future.length) return null
    const next = future[future.length - 1]
    expectedRef.current = next
    setFuture(future.slice(0, -1))
    setPast([...past, current])
    return next
  }, [current, future, past])

  const reset = useCallback(() => {
    expectedRef.current = null
    setPast([])
    setFuture([])
  }, [])

  return {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    commit,
    undo,
    redo,
    reset,
    depth: past.length,
  }
}

// -------------------------------------------------------------- 模拟数据与场景

export function defaultsForVariables(document: BossbarDocument): BossbarValueMap {
  const values: BossbarValueMap = {}
  for (const [name, variable] of Object.entries(document.variables ?? {})) {
    values[name] = defaultValueOf(variable)
  }
  return values
}

export type BossbarScenario = {
  id: string
  label: string
  values: BossbarValueMap
}

export type BossbarSimulationMode = 'value' | 'missing' | 'wrong-type'

export function variableSimulationMode(variable: BossbarVariable, value: BossbarValue | undefined): BossbarSimulationMode {
  return value === undefined ? 'missing' : isValueCompatible(variable, value) ? 'value' : 'wrong-type'
}

export function simulateVariable(
  values: BossbarValueMap,
  name: string,
  variable: BossbarVariable,
  mode: BossbarSimulationMode,
): BossbarValueMap {
  const next = { ...values }
  if (mode === 'missing') delete next[name]
  else if (mode === 'wrong-type') next[name] = variable.type === 'bool'
    ? { type: 'string', value: 'true' }
    : { type: 'bool', value: true }
  else next[name] = values[name] && isValueCompatible(variable, values[name]) ? values[name] : defaultValueOf(variable)
  return next
}

/** 只调整实际绑定到进度条的 double 变量，其他服务端数据保持默认值。 */
export function buildScenarios(document: BossbarDocument): BossbarScenario[] {
  const defaults = defaultsForVariables(document)
  const scenarios: BossbarScenario[] = [{ id: 'default', label: '默认值', values: { ...defaults } }]
  const progressNames = [...new Set(document.components.flatMap((component) =>
    component.type === 'bar' && typeof component.progress !== 'number' &&
      document.variables[component.progress.var]?.type === 'double' ? [component.progress.var] : [],
  ))]
  const progressName = progressNames.find((name) => /health|hp/i.test(name)) ?? progressNames[0]
  if (progressName) {
    for (const [id, label, value] of [
      ['full', '100%', 1],
      ['injured', '35%', 0.35],
      ['low', '8%', 0.08],
      ['empty', '0%', 0],
      ['overheal', '超过 1', 1.4],
      ['negative', '低于 0', -0.2],
    ] as const) scenarios.push({ id, label, values: { ...defaults, [progressName]: { type: 'double', value } } })
  }
  const boolName = Object.keys(document.variables).find((name) => document.variables[name].type === 'bool')
  if (boolName) scenarios.push({
    id: 'toggle-' + boolName,
    label: '切换 ' + boolName,
    values: { ...defaults, [boolName]: { type: 'bool', value: defaults[boolName]?.value !== true } },
  })
  return scenarios
}

/** 长名字 / emoji / 空值等边界输入的快捷场景 */
export function edgeCaseScenarios(document: BossbarDocument): BossbarScenario[] {
  const defaults = defaultsForVariables(document)
  const stringNames = Object.keys(document.variables ?? {}).filter(
    (name) => document.variables[name].type === 'string',
  )
  if (!stringNames.length) return []
  const target = stringNames[stringNames.length - 1]
  return [
    {
      id: 'edge-long',
      label: '长名字',
      values: { ...defaults, [target]: { type: 'string', value: '被诅咒的赤焰守卫·终焉形态（第二阶段）' } },
    },
    { id: 'edge-emoji', label: 'emoji', values: { ...defaults, [target]: { type: 'string', value: '🔥赤焰守卫🔥 👑' } } },
    { id: 'edge-empty', label: '空字符串', values: { ...defaults, [target]: { type: 'string', value: '' } } },
  ]
}

/** 变量面板的类型化输入：返回新值或 null（输入不合法） */
export function parseVariableInput(
  variable: BossbarVariable,
  raw: string,
): BossbarValue | null {
  const trimmed = raw.trim()
  switch (variable.type) {
    case 'double': {
      if (!/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(trimmed)) return null
      const value = Number(trimmed)
      if (!Number.isFinite(value)) return null
      return { type: 'double', value }
    }
    case 'bool':
      return trimmed === 'true' ? { type: 'bool', value: true } : trimmed === 'false' ? { type: 'bool', value: false } : null
    case 'string': {
      if ([...raw].length > variable.maxLength) return null
      return { type: 'string', value: raw }
    }
    default:
      return null
  }
}

export function defaultValueText(variable: BossbarVariable): string {
  switch (variable.type) {
    case 'double':
      return String(variable.default)
    case 'bool':
      return variable.default ? 'true' : 'false'
    default:
      return variable.default
  }
}

export const VARIABLE_TYPE_LABELS: Record<BossbarVariableType, string> = {
  double: 'double（浮点）',
  bool: 'bool',
  string: 'string',
}
