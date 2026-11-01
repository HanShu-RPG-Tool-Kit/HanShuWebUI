import {
  BOSSBAR_DEFAULTS,
  BOSSBAR_FORMAT,
  BOSSBAR_LIMITS,
  BOSSBAR_LONG_MAX,
  BOSSBAR_LONG_MIN,
  BOSSBAR_NAME_PATTERN,
  BOSSBAR_V1_VERSION,
  BOSSBAR_VERSION,
  bossbarDiagnostic,
  defaultValueOf,
  defaultLayout,
  normalizeName,
  normalizeTemplateId,
  parseLong,
  type BossbarAnimation,
  type BossbarBarComponent,
  type BossbarBox,
  type BossbarComponent,
  type BossbarDiagnostic,
  type BossbarDocument,
  type BossbarDocumentV1,
  type BossbarLayout,
  type BossbarPaint,
  type BossbarTextRun,
  type BossbarUv,
  type BossbarVariable,
} from './protocol'
import { BOSSBAR_DEFAULT_TEXTURE } from './protocol'
import { BOSSBAR_V2_SCHEMA } from './schema'
import { validateAgainstSchema } from './schemaValidate'
import { decodeBase64, decodedTextureBytes, normalizeBase64, pngInfo, validatePngPixels } from './png'
import { estimateSnapshotBytes } from './rules/values'

/** 解析结果：要么规范文档，要么一组可定位到字段的诊断 */
export type BossbarParseResult =
  | { ok: true; document: BossbarDocument }
  | { ok: false; diagnostics: BossbarDiagnostic[] }

/** 检查结论：编辑器据此决定进设计视图、显示升级按钮还是只保留源码 */
export type BossbarInspection =
  | { status: 'ok'; document: BossbarDocument; canonical: string }
  | { status: 'v1'; document: BossbarDocumentV1 }
  | { status: 'unsupported'; version: unknown }
  | { status: 'invalid'; diagnostics: BossbarDiagnostic[] }

export class BossbarParseError extends Error {
  readonly diagnostics: BossbarDiagnostic[]
  constructor(diagnostics: BossbarDiagnostic[]) {
    super(diagnostics.map(describeDiagnostic).join('；') || 'BOSS 血条文档无效')
    this.name = 'BossbarParseError'
    this.diagnostics = diagnostics
  }
}

export function describeDiagnostic(diagnostic: BossbarDiagnostic): string {
  return diagnostic.path ? diagnostic.path + '：' + diagnostic.message : diagnostic.message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fill(record: Record<string, unknown>, key: string, fallback: unknown): void {
  if (!(key in record)) record[key] = fallback
}

function normalizeAnimation(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const next: Record<string, unknown> = { ...raw }
  fill(next, 'mode', BOSSBAR_DEFAULTS.animationMode)
  fill(next, 'phaseMs', BOSSBAR_DEFAULTS.phaseMs)
  return next
}

function normalizePaint(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  if (raw.kind !== 'texture') return raw
  const next: Record<string, unknown> = { ...raw }
  fill(next, 'fit', BOSSBAR_DEFAULTS.fit)
  if (next.fit === 'nine-slice' && !('insets' in raw)) {
    next.insets = [...BOSSBAR_DEFAULTS.nineSliceInsets]
  }
  if ('animation' in raw && raw.animation !== null && raw.animation !== undefined) {
    next.animation = normalizeAnimation(raw.animation)
  } else {
    delete next.animation
  }
  return next
}

function normalizeComponent(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const next: Record<string, unknown> = { ...raw }
  if (raw.type === 'display_region') return next
  fill(next, 'visible', BOSSBAR_DEFAULTS.visible)
  fill(next, 'opacity', BOSSBAR_DEFAULTS.opacity)
  if (raw.type === 'background') {
    next.paint = normalizePaint(raw.paint)
    return next
  }
  if (raw.type === 'bar') {
    fill(next, 'direction', BOSSBAR_DEFAULTS.direction)
    next.fill = normalizePaint(raw.fill)
    if ('trail' in raw) {
      if (raw.trail === null || raw.trail === undefined) {
        delete next.trail
      } else {
        const trail = isRecord(raw.trail) ? raw.trail : {}
        const normalizedTrail: Record<string, unknown> = { ...trail, paint: normalizePaint(trail.paint) }
        fill(normalizedTrail, 'delayMs', BOSSBAR_DEFAULTS.trailDelayMs)
        fill(normalizedTrail, 'durationMs', BOSSBAR_DEFAULTS.trailDurationMs)
        next.trail = normalizedTrail
      }
    }
    fill(next, 'smoothMs', BOSSBAR_DEFAULTS.smoothMs)
    return next
  }
  if (raw.type === 'text') {
    fill(next, 'fontSize', BOSSBAR_DEFAULTS.fontSize)
    fill(next, 'color', BOSSBAR_DEFAULTS.textColor)
    fill(next, 'align', BOSSBAR_DEFAULTS.align)
    fill(next, 'verticalAlign', BOSSBAR_DEFAULTS.verticalAlign)
    fill(next, 'shadow', BOSSBAR_DEFAULTS.shadow)
    return next
  }
  return next
}

function normalizeVariable(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const next: Record<string, unknown> = { ...raw }
  if (raw.type === 'string') fill(next, 'maxLength', BOSSBAR_LIMITS.stringMaxLength)
  return next
}

/** 补齐默认值（不校验）。未知字段与类型错误原样保留，交给 schema 报 */
export function normalizeBossbarDocument(raw: Record<string, unknown>): unknown {
  const next: Record<string, unknown> = { ...raw }
  fill(next, 'priority', BOSSBAR_DEFAULTS.priority)
  if (isRecord(raw.layout)) {
    const layout: Record<string, unknown> = { ...raw.layout }
    fill(layout, 'dock', BOSSBAR_DEFAULTS.dock)
    fill(layout, 'scale', BOSSBAR_DEFAULTS.scale)
    fill(layout, 'safeMargin', BOSSBAR_DEFAULTS.safeMargin)
    next.layout = layout
  }
  if (isRecord(raw.texture) === false && typeof raw.texture === 'string') {
    next.texture = normalizeBase64(raw.texture) ?? raw.texture
  }
  if (isRecord(raw.variables)) {
    next.variables = Object.fromEntries(
      Object.entries(raw.variables).map(([key, value]) => [key, normalizeVariable(value)]),
    )
  }
  if (Array.isArray(raw.components)) {
    next.components = raw.components.map(normalizeComponent)
  }
  return next
}

function schemaDiagnostics(raw: Record<string, unknown>): BossbarDiagnostic[] {
  return validateAgainstSchema(raw, BOSSBAR_V2_SCHEMA).map((issue) =>
    bossbarDiagnostic(issue.code, issue.path, issue.message),
  )
}

function obsoleteFieldDiagnostics(raw: Record<string, unknown>): BossbarDiagnostic[] {
  const diagnostics: BossbarDiagnostic[] = []
  if (!Array.isArray(raw.components)) return diagnostics
  raw.components.forEach((component, index) => {
    if (!isRecord(component)) return
    const base = 'components[' + index + ']'
    if ('range' in component) {
      diagnostics.push(bossbarDiagnostic('obsolete_field', base + '.range', 'range 已移除，请使用服务端提供的 progress（double 字面量或变量引用）'))
    }
    if (!Array.isArray(component.runs)) return
    component.runs.forEach((run, runIndex) => {
      if (!isRecord(run)) return
      for (const field of ['ratio', 'format', 'digits']) {
        if (field in run) diagnostics.push(bossbarDiagnostic('obsolete_field', base + '.runs[' + runIndex + '].' + field,
          field + ' 已移除，文本片段只允许字面量 text 或变量 var；数值格式由服务端提供'))
      }
    })
  })
  return diagnostics
}

// ------------------------------------------------------------------ 语义校验

export type BossbarTextureInfo = { width: number; height: number; byteLength: number }

function uvInside(uv: BossbarUv, info: BossbarTextureInfo): boolean {
  return (
    uv.x >= 0 &&
    uv.y >= 0 &&
    uv.width > 0 &&
    uv.height > 0 &&
    uv.x + uv.width <= info.width &&
    uv.y + uv.height <= info.height
  )
}

/** 结构合规之后的语义校验：唯一显示区域、AABB、UV、类型、预算 */
export function validateBossbarSemantics(
  document: BossbarDocument,
  texture: BossbarTextureInfo,
): BossbarDiagnostic[] {
  const diagnostics: BossbarDiagnostic[] = []
  const variables = document.variables ?? {}
  const components = Array.isArray(document.components) ? document.components : []

  const ids = new Set<string>()
  const regions: number[] = []
  components.forEach((component, index) => {
    if (!component || typeof component !== 'object') return
    if (typeof component.id === 'string') {
      if (ids.has(component.id)) {
        diagnostics.push(
          bossbarDiagnostic('duplicate_id', 'components[' + index + '].id', '组件 ID 重复：' + component.id),
        )
      }
      ids.add(component.id)
    }
    if (component.type === 'display_region') regions.push(index)
  })

  if (regions.length === 0) {
    diagnostics.push(
      bossbarDiagnostic('display_region', 'components', '必须有且只有一个显示区域组件（display_region）'),
    )
  } else if (regions.length > 1) {
    for (const index of regions.slice(1)) {
      diagnostics.push(
        bossbarDiagnostic(
          'display_region',
          'components[' + index + '].type',
          '只能有一个显示区域，实际有 ' + regions.length + ' 个',
        ),
      )
    }
  }

  const regionIndex = regions[0] ?? -1
  const region = regionIndex >= 0 ? components[regionIndex] : null
  const regionBox = region && region.type === 'display_region' ? region.box : null

  if (regionBox) {
    if (regionBox.width > BOSSBAR_LIMITS.displayRegion.maxWidth) {
      diagnostics.push(
        bossbarDiagnostic(
          'display_region',
          'components[' + regionIndex + '].box.width',
          '显示区域宽度不能超过 ' + BOSSBAR_LIMITS.displayRegion.maxWidth,
        ),
      )
    }
    if (regionBox.height > BOSSBAR_LIMITS.displayRegion.maxHeight) {
      diagnostics.push(
        bossbarDiagnostic(
          'display_region',
          'components[' + regionIndex + '].box.height',
          '显示区域高度不能超过 ' + BOSSBAR_LIMITS.displayRegion.maxHeight,
        ),
      )
    }
  }

  const checkBox = (box: BossbarBox): boolean =>
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0

  const checkUv = (uv: BossbarUv | undefined, path: string): BossbarUv | null => {
    if (!uv || typeof uv !== 'object') return null
    if (!uvInside(uv, texture)) {
      diagnostics.push(
        bossbarDiagnostic(
          'uv_out_of_bounds',
          path,
          'UV 超出图集 ' + texture.width + '×' + texture.height + '：' +
            uv.x + ',' + uv.y + ' ' + uv.width + '×' + uv.height,
        ),
      )
      return null
    }
    return uv
  }

  const checkPaint = (paint: BossbarPaint | undefined, path: string, fillOnly: boolean) => {
    if (!paint) return
    if (paint.kind === 'solid') return
    const uv = checkUv(paint.uv, path + '.uv')
    if (fillOnly && paint.fit !== 'stretch') {
      diagnostics.push(
        bossbarDiagnostic('paint_fit', path + '.fit', '条填充的纹理只允许 stretch'),
      )
    }
    if (paint.fit === 'nine-slice' && paint.insets) {
      const [left, top, right, bottom] = paint.insets
      if (left + right > (uv?.width ?? 0)) {
        diagnostics.push(
          bossbarDiagnostic('insets', path + '.insets', '左右边距超过 UV 宽度 ' + (uv?.width ?? 0)),
        )
      }
      if (top + bottom > (uv?.height ?? 0)) {
        diagnostics.push(
          bossbarDiagnostic('insets', path + '.insets', '上下边距超过 UV 高度 ' + (uv?.height ?? 0)),
        )
      }
    }
    const animation = paint.animation
    if (!animation) return
    if (!animation.frames.length) {
      diagnostics.push(bossbarDiagnostic('animation', path + '.animation.frames', '帧列表不能为空'))
      return
    }
    const first = animation.frames[0].uv
    if (uv && (first.x !== uv.x || first.y !== uv.y || first.width !== uv.width || first.height !== uv.height)) {
      diagnostics.push(
        bossbarDiagnostic(
          'animation',
          path + '.animation.frames[0].uv',
          'paint.uv 必须与动画第一帧相同',
        ),
      )
    }
    animation.frames.forEach((frame, index) => {
      const frameUv = checkUv(frame.uv, path + '.animation.frames[' + index + '].uv')
      if (frameUv && (frameUv.width !== first.width || frameUv.height !== first.height)) {
        diagnostics.push(
          bossbarDiagnostic(
            'animation',
            path + '.animation.frames[' + index + '].uv',
            '同一动画所有帧的尺寸必须相同（' + first.width + '×' + first.height + '）',
          ),
        )
      }
    })
  }

  components.forEach((component, index) => {
    const base = 'components[' + index + ']'
    if (!component || typeof component !== 'object') return
    if (!checkBox(component.box)) {
      diagnostics.push(
        bossbarDiagnostic('box', base + '.box', '坐标必须是有限数值，宽高必须大于零'),
      )
    } else if (regionBox && component.type !== 'display_region') {
      const inside =
        component.box.x >= regionBox.x - 1e-9 &&
        component.box.y >= regionBox.y - 1e-9 &&
        component.box.x + component.box.width <= regionBox.x + regionBox.width + 1e-9 &&
        component.box.y + component.box.height <= regionBox.y + regionBox.height + 1e-9
      if (!inside) {
        diagnostics.push(
          bossbarDiagnostic(
            'outside_region',
            base + '.box',
            '组件必须完整位于显示区域内',
          ),
        )
      }
    }
    if (component.type === 'display_region') return

    if (isRecord(component.visible) && typeof component.visible.var === 'string') {
      const variable = Object.hasOwn(variables, component.visible.var) ? variables[component.visible.var] : undefined
      if (!variable) {
        diagnostics.push(
          bossbarDiagnostic('unknown_reference', base + '.visible.var', '引用了未声明的变量 ' + component.visible.var),
        )
      } else if (variable.type !== 'bool') {
        diagnostics.push(
          bossbarDiagnostic('variable_type', base + '.visible.var', '显隐只能绑定 bool 变量，' + component.visible.var + ' 是 ' + variable.type),
        )
      }
    }

    if (component.type === 'background') {
      checkPaint(component.paint, base + '.paint', false)
      return
    }
    if (component.type === 'bar') {
      if (typeof component.progress === 'object') {
        const variable = Object.hasOwn(variables, component.progress.var) ? variables[component.progress.var] : undefined
        if (!variable) {
          diagnostics.push(bossbarDiagnostic('unknown_reference', base + '.progress.var', '引用了未声明的变量 ' + component.progress.var))
        } else if (variable.type !== 'double') {
          diagnostics.push(bossbarDiagnostic('variable_type', base + '.progress.var', '进度只能引用 double 变量，' + component.progress.var + ' 是 ' + variable.type))
        }
      }
      checkPaint(component.fill, base + '.fill', true)
      if (component.trail) checkPaint(component.trail.paint, base + '.trail.paint', true)
      return
    }
    component.runs.forEach((run: BossbarTextRun, runIndex: number) => {
      const runPath = base + '.runs[' + runIndex + ']'
      if ('var' in run) {
        const variable = Object.hasOwn(variables, run.var) ? variables[run.var] : undefined
        if (!variable) {
          diagnostics.push(bossbarDiagnostic('unknown_reference', runPath + '.var', '引用了未声明的变量 ' + run.var))
          return
        }
      }
    })
  })

  for (const [name, variable] of Object.entries(variables)) {
    const path = 'variables.' + name
    if (!BOSSBAR_NAME_PATTERN.test(name)) {
      diagnostics.push(bossbarDiagnostic('name', path, '变量名不合法'))
      continue
    }
    if (variable.type === 'long') {
      const parsed = parseLong(variable.default)
      if (parsed === null) {
        diagnostics.push(
          bossbarDiagnostic('long', path + '.default', 'long 默认值必须是 int64 范围内的十进制字符串'),
        )
      } else if (parsed < BOSSBAR_LONG_MIN || parsed > BOSSBAR_LONG_MAX) {
        diagnostics.push(bossbarDiagnostic('long', path + '.default', 'long 默认值超出 int64 范围'))
      }
    }
    if (variable.type === 'string') {
      const length = [...variable.default].length
      if (length > variable.maxLength) {
        diagnostics.push(
          bossbarDiagnostic('variable_default', path + '.default', '默认值超过 maxLength ' + variable.maxLength + '（' + length + '）'),
        )
      }
    }
  }

  const snapshot = estimateSnapshotBytes(document)
  if (snapshot.worstBytes > BOSSBAR_LIMITS.upsertBudgetBytes) {
    diagnostics.push(bossbarDiagnostic('budget', 'variables',
      '最坏变量快照 ' + snapshot.worstBytes + ' 字节，超过 ' + BOSSBAR_LIMITS.upsertBudgetBytes + ' 字节预算，请减少变量数或字符串 maxLength'))
  }
  return diagnostics
}

// ------------------------------------------------------------------ 解析入口

export function parseBossbarDocument(source: string): BossbarParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (cause) {
    return {
      ok: false,
      diagnostics: [
        bossbarDiagnostic('json', '', 'JSON 无法解析：' + (cause instanceof Error ? cause.message : String(cause))),
      ],
    }
  }
  if (!isRecord(raw)) {
    return { ok: false, diagnostics: [bossbarDiagnostic('json', '', 'BOSS 血条正文必须是 JSON 对象')] }
  }
  if (raw.format !== BOSSBAR_FORMAT) {
    return { ok: false, diagnostics: [bossbarDiagnostic('format', 'format', 'format 必须是 ' + BOSSBAR_FORMAT)] }
  }
  if (raw.version === BOSSBAR_V1_VERSION) {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('version', 'version', 'v1 文档需要显式升级为可视化血条后才能设计或导出')],
    }
  }
  if (raw.version !== BOSSBAR_VERSION) {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('version', 'version', '不支持的 version：' + JSON.stringify(raw.version))],
    }
  }

  const documentBytes = new TextEncoder().encode(JSON.stringify(raw)).length
  if (documentBytes > BOSSBAR_LIMITS.documentBytes) {
    return {
      ok: false,
      diagnostics: [
        bossbarDiagnostic('budget', '', '文档 ' + documentBytes + ' 字节，超过上限 ' + BOSSBAR_LIMITS.documentBytes),
      ],
    }
  }

  const normalized = normalizeBossbarDocument(raw)
  const obsolete = obsoleteFieldDiagnostics(raw)
  if (obsolete.length) return { ok: false, diagnostics: obsolete }
  const structural = schemaDiagnostics(normalized as Record<string, unknown>)
  if (structural.some((entry) => entry.severity === 'error')) {
    return { ok: false, diagnostics: structural }
  }

  const candidate = toCanonicalDocument(normalized as BossbarDocument)

  const bytes = decodeBase64(candidate.texture)
  const info = bytes ? pngInfo(bytes) : null
  if (!bytes || !info) {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('texture', 'texture', 'texture 必须是有效的 Base64 PNG')],
    }
  }
  if (info.apng) {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('texture', 'texture', '不接受 APNG：动画必须来自显式 UV 序列')],
    }
  }
  if (bytes.length > BOSSBAR_LIMITS.texture.maxBytes) {
    return {
      ok: false,
      diagnostics: [
        bossbarDiagnostic('texture', 'texture', 'PNG ' + bytes.length + ' 字节，超过上限 ' + BOSSBAR_LIMITS.texture.maxBytes),
      ],
    }
  }
  if (info.width > BOSSBAR_LIMITS.texture.maxSide || info.height > BOSSBAR_LIMITS.texture.maxSide) {
    return {
      ok: false,
      diagnostics: [
        bossbarDiagnostic('texture', 'texture', 'PNG 尺寸 ' + info.width + '×' + info.height + ' 超过 4096'),
      ],
    }
  }
  if (decodedTextureBytes(info.width, info.height) > BOSSBAR_LIMITS.texture.decodeBytes) {
    return {
      ok: false,
      diagnostics: [bossbarDiagnostic('texture', 'texture', '单图集解码内存超过 64MiB')],
    }
  }
  if (!validatePngPixels(bytes)) {
    return { ok: false, diagnostics: [bossbarDiagnostic('texture', 'texture', 'PNG 像素流损坏、截断或超出声明大小')] }
  }

  const texture = { width: info.width, height: info.height, byteLength: bytes.length }
  const semantic = validateBossbarSemantics(candidate, texture)
  if (semantic.some((entry) => entry.severity === 'error')) {
    return { ok: false, diagnostics: semantic }
  }

  const metadata = new TextEncoder().encode(
    JSON.stringify({ ...candidate, texture: '' }),
  ).length
  if (metadata > BOSSBAR_LIMITS.metadataBytes) {
    return {
      ok: false,
      diagnostics: [
        bossbarDiagnostic('budget', '', '非纹理元数据 ' + metadata + ' 字节，超过上限 ' + BOSSBAR_LIMITS.metadataBytes),
      ],
    }
  }

  return { ok: true, document: candidate }
}

/** 不抛异常地检查源码，供编辑器决定视图 */
export function inspectBossbar(source: string): BossbarInspection {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { status: 'invalid', diagnostics: [bossbarDiagnostic('json', '', 'JSON 无法解析')] }
  }
  if (!isRecord(raw) || raw.format !== BOSSBAR_FORMAT) {
    return {
      status: 'invalid',
      diagnostics: [bossbarDiagnostic('format', 'format', 'format 必须是 ' + BOSSBAR_FORMAT)],
    }
  }
  if (raw.version === BOSSBAR_V1_VERSION) {
    return {
      status: 'v1',
      document: { format: BOSSBAR_FORMAT, version: BOSSBAR_V1_VERSION, id: String(raw.id ?? '') },
    }
  }
  if (raw.version !== BOSSBAR_VERSION) return { status: 'unsupported', version: raw.version }
  const result = parseBossbarDocument(source)
  if (!result.ok) return { status: 'invalid', diagnostics: result.diagnostics }
  return { status: 'ok', document: result.document, canonical: stringifyBossbar(result.document) }
}

/** 抛错版本，供编译器与测试使用 */
export function parseBossbar(source: string): BossbarDocument {
  const result = parseBossbarDocument(source)
  if (!result.ok) throw new BossbarParseError(result.diagnostics)
  return result.document
}

// ------------------------------------------------------------------ 规范化输出

function orderedUv(uv: BossbarUv): Record<string, unknown> {
  return { x: uv.x, y: uv.y, width: uv.width, height: uv.height }
}

function orderedAnimation(animation: BossbarAnimation): Record<string, unknown> {
  return {
    mode: animation.mode,
    phaseMs: animation.phaseMs,
    frames: animation.frames.map((frame) => ({
      uv: orderedUv(frame.uv),
      durationMs: frame.durationMs,
    })),
  }
}

function orderedPaint(paint: BossbarPaint): Record<string, unknown> {
  if (paint.kind === 'solid') return { kind: 'solid', color: paint.color }
  return {
    kind: 'texture',
    uv: orderedUv(paint.uv),
    fit: paint.fit,
    ...(paint.fit === 'nine-slice'
      ? { insets: [...(paint.insets ?? BOSSBAR_DEFAULTS.nineSliceInsets)] }
      : {}),
    ...(paint.animation ? { animation: orderedAnimation(paint.animation) } : {}),
  }
}

function orderedRun(run: BossbarTextRun): Record<string, unknown> {
  const content = 'text' in run ? { text: run.text } : { var: run.var }
  return { ...content, ...(run.color ? { color: run.color } : {}) }
}

function orderedComponent(component: BossbarComponent): Record<string, unknown> {
  const box = {
    x: component.box.x,
    y: component.box.y,
    width: component.box.width,
    height: component.box.height,
  }
  if (component.type === 'display_region') {
    return { id: component.id, type: 'display_region', box }
  }
  const common = {
    id: component.id,
    type: component.type,
    box,
    visible: isRecord(component.visible) ? { var: component.visible.var } : component.visible,
    opacity: component.opacity,
  }
  if (component.type === 'background') {
    return { ...common, paint: orderedPaint(component.paint) }
  }
  if (component.type === 'bar') {
    const bar = component as BossbarBarComponent
    return {
      ...common,
      progress: typeof bar.progress === 'number' ? bar.progress : { var: bar.progress.var },
      direction: bar.direction,
      fill: orderedPaint(bar.fill),
      ...(bar.trail
        ? {
            trail: {
              paint: orderedPaint(bar.trail.paint),
              delayMs: bar.trail.delayMs,
              durationMs: bar.trail.durationMs,
            },
          }
        : {}),
      smoothMs: bar.smoothMs,
    }
  }
  return {
    ...common,
    runs: component.runs.map(orderedRun),
    fontSize: component.fontSize,
    color: component.color,
    align: component.align,
    verticalAlign: component.verticalAlign,
    shadow: component.shadow,
  }
}

function orderedVariable(variable: BossbarVariable): Record<string, unknown> {
  if (variable.type === 'string') {
    return { type: 'string', default: variable.default, maxLength: variable.maxLength }
  }
  return { type: variable.type, default: variable.default }
}

/** 重建为固定字段顺序的规范文档：变量按名字排序，保证字节稳定（hash 依赖它） */
export function toCanonicalDocument(document: BossbarDocument): BossbarDocument {
  const variables = Object.fromEntries(
    Object.keys(document.variables ?? {})
      .sort()
      .map((key) => [key, orderedVariable(document.variables[key])]),
  )
  const layout: BossbarLayout = {
    dock: document.layout?.dock ?? BOSSBAR_DEFAULTS.dock,
    scale: document.layout?.scale ?? BOSSBAR_DEFAULTS.scale,
    safeMargin: document.layout?.safeMargin ?? BOSSBAR_DEFAULTS.safeMargin,
  }
  return {
    format: BOSSBAR_FORMAT,
    version: BOSSBAR_VERSION,
    id: document.id,
    priority: document.priority ?? BOSSBAR_DEFAULTS.priority,
    texture: document.texture,
    layout,
    variables: variables as Record<string, BossbarVariable>,
    components: (document.components ?? []).map((component) => orderedComponent(component) as BossbarComponent),
  }
}

/** 规范序列化：两端 hash 只认这份字节，Java 不得重排 JSON 后自行算 hash */
export function stringifyBossbar(document: BossbarDocument): string {
  return JSON.stringify(toCanonicalDocument(document), null, 2) + '\n'
}

/** 新建空白 v2 文档：一个显示区域 + 一张透明 1×1 PNG */
export function createBossbar(id = ''): BossbarDocument {
  const trimmed = typeof id === 'string' ? id.trim() : ''
  return {
    format: BOSSBAR_FORMAT,
    version: BOSSBAR_VERSION,
    id: normalizeTemplateId(trimmed) ?? trimmed,
    priority: BOSSBAR_DEFAULTS.priority,
    texture: BOSSBAR_DEFAULT_TEXTURE,
    layout: defaultLayout(),
    variables: {},
    components: [
      {
        id: 'region',
        type: 'display_region',
        box: { ...BOSSBAR_DEFAULTS.displayRegion },
      },
    ],
  }
}

/** v1 → v2：保留 id，补默认显示区域与透明 1×1 PNG；只在用户显式点「升级」时使用 */
export function upgradeBossbarV1(document: BossbarDocumentV1): BossbarDocument {
  return { ...createBossbar(document.id), id: document.id }
}

export { defaultValueOf, normalizeName }
