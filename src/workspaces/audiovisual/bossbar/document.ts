import {
  BOSSBAR_DEFAULTS,
  BOSSBAR_LIMITS,
  BOSSBAR_NAME_PATTERN,
  bossbarDiagnostic,
  isDisplayRegion,
  isPaintable,
  type BossbarBackgroundComponent,
  type BossbarBarComponent,
  type BossbarBox,
  type BossbarComponent,
  type BossbarDiagnostic,
  type BossbarDisplayRegionComponent,
  type BossbarPaint,
  type BossbarPaintableComponent,
  type BossbarTextComponent,
  type BossbarTextRun,
  type BossbarVariable,
} from './protocol'

/**
 * 文档编辑操作。
 *
 * 全部是纯函数：输入文档，输出新文档（不修改入参）；失败时返回带引用位置的诊断。
 * 显示区域唯一且不能复制/删除；其他组件一律被约束在显示区域内。
 */

export type EditResult<T> = { ok: true; document: T } | { ok: false; diagnostics: BossbarDiagnostic[] }

function nextName(base: string, taken: (name: string) => boolean): string {
  const stem = BOSSBAR_NAME_PATTERN.test(base) ? base : 'item'
  if (!taken(stem)) return stem
  const bare = stem.replace(/[0-9]+$/, '') || 'item'
  for (let index = 1; index < 10000; index += 1) {
    const candidate = bare + index
    if (candidate.length <= 64 && BOSSBAR_NAME_PATTERN.test(candidate) && !taken(candidate)) return candidate
  }
  return bare.slice(0, 60) + '1'
}

export function displayRegionOf(document: BossbarDocumentLike): BossbarDisplayRegionComponent | null {
  return document.components.find(isDisplayRegion) ?? null
}

type BossbarDocumentLike = { components: BossbarComponent[] }

export function paintableComponents(document: BossbarDocumentLike): BossbarPaintableComponent[] {
  return document.components.filter(isPaintable)
}

export function allocateComponentId(
  document: BossbarDocumentLike,
  base = 'layer',
): string {
  const taken = new Set(document.components.map((component) => component.id))
  return nextName(base, (name) => taken.has(name))
}

export function allocateVariableName(
  variables: Record<string, BossbarVariable>,
  base = 'value',
): string {
  const taken = new Set(Object.keys(variables))
  return nextName(base, (name) => taken.has(name))
}

/** 默认组件：以显示区域中心为参照给一个能看见的大小 */
export function createComponent(
  type: Exclude<BossbarComponent['type'], 'display_region'>,
  id: string,
  region: BossbarBox,
): BossbarPaintableComponent {
  const box: BossbarBox = {
    x: region.x + region.width * 0.1,
    y: region.y + region.height * 0.35,
    width: Math.max(8, region.width * 0.8),
    height: Math.max(8, region.height * 0.3),
  }
  const common = { id, box, visible: BOSSBAR_DEFAULTS.visible, opacity: BOSSBAR_DEFAULTS.opacity }
  if (type === 'background') {
    const component: BossbarBackgroundComponent = {
      ...common,
      type: 'background',
      paint: { kind: 'solid', color: '#231016FF' },
    }
    return component
  }
  if (type === 'bar') {
    const component: BossbarBarComponent = {
      ...common,
      type: 'bar',
      progress: 0.5,
      direction: BOSSBAR_DEFAULTS.direction,
      fill: { kind: 'solid', color: '#ED242CFF' },
      smoothMs: BOSSBAR_DEFAULTS.smoothMs,
    }
    return component
  }
  const component: BossbarTextComponent = {
    ...common,
    type: 'text',
    runs: [{ text: '文本' }],
    fontSize: BOSSBAR_DEFAULTS.fontSize,
    color: BOSSBAR_DEFAULTS.textColor,
    align: BOSSBAR_DEFAULTS.align,
    verticalAlign: BOSSBAR_DEFAULTS.verticalAlign,
    shadow: BOSSBAR_DEFAULTS.shadow,
  }
  return component
}

/** 把一个组件的 box 收进显示区域（拖动/缩放/属性栏提交都走这里） */
export function clampBoxToRegion(region: BossbarBox, box: BossbarBox): BossbarBox {
  const width = Math.max(1, Math.min(box.width, region.width))
  const height = Math.max(1, Math.min(box.height, region.height))
  const x = Math.min(Math.max(box.x, region.x), region.x + region.width - width)
  const y = Math.min(Math.max(box.y, region.y), region.y + region.height - height)
  return { x, y, width, height }
}

type WithComponents = { components: BossbarComponent[] }

export function addComponent<T extends WithComponents>(document: T, component: BossbarComponent): T {
  return { ...document, components: [...document.components, component] }
}

export function updateComponent<T extends WithComponents>(
  document: T,
  id: string,
  patch: Partial<BossbarComponent>,
): T {
  return {
    ...document,
    components: document.components.map((component) =>
      component.id === id ? ({ ...component, ...patch } as BossbarComponent) : component,
    ),
  }
}

export function removeComponent<T extends WithComponents>(
  document: T,
  id: string,
): EditResult<T> {
  const target = document.components.find((component) => component.id === id)
  if (!target) {
    return { ok: false, diagnostics: [bossbarDiagnostic('missing', 'components', '组件不存在：' + id)] }
  }
  if (target.type === 'display_region') {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('display_region', 'components', '显示区域不能删除；可以调整它的范围')],
    }
  }
  return { ok: true, document: { ...document, components: document.components.filter((component) => component.id !== id) } }
}

/** 单条移动；显示区域不参与排序 */
export function moveComponent<T extends WithComponents>(
  document: T,
  id: string,
  targetIndex: number,
): T {
  const index = document.components.findIndex((component) => component.id === id)
  if (index < 0 || document.components[index].type === 'display_region') return document
  const clamped = Math.max(0, Math.min(document.components.length - 1, targetIndex))
  if (clamped === index) return document
  const next = [...document.components]
  const [moved] = next.splice(index, 1)
  next.splice(clamped, 0, moved)
  return { ...document, components: next }
}

export function duplicateComponent<T extends WithComponents>(
  document: T,
  id: string,
): EditResult<T> {
  const index = document.components.findIndex((component) => component.id === id)
  if (index < 0) {
    return { ok: false, diagnostics: [bossbarDiagnostic('missing', 'components', '组件不存在：' + id)] }
  }
  const source = document.components[index]
  if (source.type === 'display_region') {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('display_region', 'components', '显示区域不能复制，只能有一个')],
    }
  }
  const region = displayRegionOf(document)
  const clone = structuredClone(source)
  clone.id = allocateComponentId(document, source.id.replace(/[0-9]+$/, '') || 'copy')
  const shifted = { ...clone.box, x: clone.box.x + 8, y: clone.box.y + 8 }
  clone.box = region ? clampBoxToRegion(region.box, shifted) : shifted
  const next = [...document.components]
  next.splice(index + 1, 0, clone)
  return { ok: true, document: { ...document, components: next } }
}

/** 整体移动：显示区域与全部组件同时平移，作为一次可撤销操作 */
export function translateAll<T extends WithComponents>(
  document: T,
  dx: number,
  dy: number,
): T {
  return {
    ...document,
    components: document.components.map((component) => ({
      ...component,
      box: { ...component.box, x: component.box.x + dx, y: component.box.y + dy },
    })),
  }
}

/** 作者主动执行：把显示区域设为全部可绘制组件的联合外框 */
export function fitRegionToComponents<T extends WithComponents>(
  document: T,
): EditResult<T> {
  const region = displayRegionOf(document)
  if (!region) {
    return { ok: false, diagnostics: [bossbarDiagnostic('display_region', 'components', '缺少显示区域')] }
  }
  const paintables = paintableComponents(document)
  if (!paintables.length) {
    return { ok: false, diagnostics: [bossbarDiagnostic('empty', 'components', '没有可绘制组件', 'warning')] }
  }
  const left = Math.min(...paintables.map((component) => component.box.x))
  const top = Math.min(...paintables.map((component) => component.box.y))
  const right = Math.max(...paintables.map((component) => component.box.x + component.box.width))
  const bottom = Math.max(...paintables.map((component) => component.box.y + component.box.height))
  return {
    ok: true,
    document: updateComponent(document, region.id, {
      box: { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) },
    }),
  }
}

// ------------------------------------------------------------------ 引用扫描

export type VariableReference = {
  path: string
  componentId: string
  role: 'progress' | 'text' | 'visibility'
}

export function variableReferences(
  document: WithComponents,
  name: string,
): VariableReference[] {
  const references: VariableReference[] = []
  document.components.forEach((component, index) => {
    if (isDisplayRegion(component)) return
    const base = 'components[' + index + ']'
    if (typeof component.visible === 'object' && component.visible.var === name) {
      references.push({ path: base + '.visible.var', componentId: component.id, role: 'visibility' })
    }
    if (component.type === 'bar') {
      if (typeof component.progress === 'object' && component.progress.var === name) {
        references.push({ path: base + '.progress.var', componentId: component.id, role: 'progress' })
      }
      return
    }
    if (component.type !== 'text') return
    component.runs.forEach((run, runIndex) => {
      if ('var' in run && run.var === name) {
        references.push({ path: base + '.runs[' + runIndex + '].var', componentId: component.id, role: 'text' })
      }
    })
  })
  return references
}

type ReferenceRewrite =
  | { kind: 'rename'; to: string }
  | { kind: 'constant'; double: number; bool: boolean; text: string }

function rewriteRun(run: BossbarTextRun, from: string, action: ReferenceRewrite): BossbarTextRun {
  if (!('var' in run) || run.var !== from) return run
  if (action.kind === 'rename') return { ...run, var: action.to }
  return { text: action.text, ...(run.color ? { color: run.color } : {}) }
}

function rewriteReferences<T extends WithComponents>(
  document: T,
  from: string,
  action: ReferenceRewrite,
): T {
  return {
    ...document,
    components: document.components.map((component) => {
      if (isDisplayRegion(component)) return component
      let next: BossbarPaintableComponent = component
      if (typeof component.visible === 'object' && component.visible.var === from) {
        next = { ...next, visible: action.kind === 'rename' ? { var: action.to } : action.bool }
      }
      if (next.type === 'bar' && typeof next.progress === 'object' && next.progress.var === from) {
        next = { ...next, progress: action.kind === 'rename' ? { var: action.to } : action.double }
      } else if (next.type === 'text') {
        next = { ...next, runs: next.runs.map((run) => rewriteRun(run, from, action)) }
      }
      return next
    }),
  }
}

export function renameVariable<T extends WithComponents & { variables: Record<string, BossbarVariable> }>(
  document: T,
  from: string,
  to: string,
): EditResult<T> {
  if (!Object.hasOwn(document.variables, from)) {
    return { ok: false, diagnostics: [bossbarDiagnostic('unknown_reference', 'variables.' + from, '变量不存在')] }
  }
  if (Object.hasOwn(document.variables, to)) {
    return { ok: false, diagnostics: [bossbarDiagnostic('duplicate_id', 'variables.' + to, '变量名已存在')] }
  }
  if (!BOSSBAR_NAME_PATTERN.test(to)) {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('name', 'variables.' + to, '变量名需匹配 [A-Za-z][A-Za-z0-9_]{0,63}')],
    }
  }
  const variables: Record<string, BossbarVariable> = {}
  for (const [key, value] of Object.entries(document.variables)) {
    variables[key === from ? to : key] = value
  }
  return {
    ok: true,
    document: rewriteReferences({ ...document, variables }, from, { kind: 'rename', to }),
  }
}

export function removeVariable<T extends WithComponents & { variables: Record<string, BossbarVariable> }>(
  document: T,
  name: string,
  replacement?: { double?: number; bool?: boolean; string?: string },
): EditResult<T> {
  const references = variableReferences(document, name)
  if (references.length && replacement === undefined) {
    return {
      ok: false,
      diagnostics: references.map((reference) =>
        bossbarDiagnostic('referenced', reference.path, '变量 ' + name + ' 仍被 ' + reference.componentId + ' 引用'),
      ),
    }
  }
  const variables = { ...document.variables }
  delete variables[name]
  let next = { ...document, variables }
  if (references.length) {
    next = rewriteReferences(next, name, {
      kind: 'constant',
      double: replacement?.double ?? 0,
      bool: replacement?.bool ?? false,
      text: document.variables[name]?.type === 'double' ? String(replacement?.double ?? 0)
          : document.variables[name]?.type === 'bool' ? String(replacement?.bool ?? false) : replacement?.string ?? '',
    })
  }
  return { ok: true, document: next }
}

export function upsertVariable<T extends { variables: Record<string, BossbarVariable> }>(
  document: T,
  name: string,
  variable: BossbarVariable,
): EditResult<T> {
  if (!BOSSBAR_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('name', 'variables.' + name, '变量名需匹配 [A-Za-z][A-Za-z0-9_]{0,63}')],
    }
  }
  if (Object.keys(document.variables).length >= BOSSBAR_LIMITS.variables && !Object.hasOwn(document.variables, name)) {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('budget', 'variables', '单文档最多 ' + BOSSBAR_LIMITS.variables + ' 个变量')],
    }
  }
  return { ok: true, document: { ...document, variables: { ...document.variables, [name]: variable } } }
}

export function removeVariableForce(
  document: { variables: Record<string, BossbarVariable> },
  name: string,
): typeof document {
  const variables = { ...document.variables }
  delete variables[name]
  return { ...document, variables }
}

// ------------------------------------------------------------------ 概览

export function collectDocumentHints(document: WithComponents): BossbarDiagnostic[] {
  const hints: BossbarDiagnostic[] = []
  if (!paintableComponents(document).length) {
    hints.push(bossbarDiagnostic('empty_canvas', 'components', '只有显示区域：先添加背景、条或文本', 'warning'))
  }
  return hints
}

export function setTexture<T extends { texture: string }>(document: T, texture: string): T {
  return { ...document, texture }
}

export type { BossbarPaint }