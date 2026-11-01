/**
 * BossBar v2 协议：纯数据模型、限制与默认值。
 *
 * 本轮约定（见 src/help/docs/bossbar-design.md）：
 * - 变量来自服务端数据包，类型为 long/double/bool/string；
 * - 条只接收 double 进度，文本只接收原值，不在客户端计算范围或格式化数字；
 * - 每份文档必须且只能内嵌一张 Base64 PNG 图集，组件用 UV 指定区域，动画只切换 UV；
 * - 编辑画布无限，输出由唯一的 `display_region` 组件（AABB）决定；
 * - JSON 里的 long 一律用十进制字符串，禁止先过 Number。
 *
 * 这里是协议的唯一定义处；schema.ts 是它的机器可校验形式，
 * 两者由 scripts/generate-bossbar-spec.ts 与 scripts/verify-bossbar.ts 对拍。
 */

export const BOSSBAR_FORMAT = 'hanshu.bossbar' as const
export const BOSSBAR_VERSION = 2 as const
export const BOSSBAR_V1_VERSION = 1 as const

/** 变量名与组件 ID：单段标识符 */
export const BOSSBAR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
/** 模板 ID：区分大小写，禁止首尾空白与控制字符，最长 128 字符 */
export const BOSSBAR_ID_MAX_LENGTH = 128
/** 颜色统一写作 #RRGGBBAA */
export const BOSSBAR_COLOR_PATTERN = /^#[0-9A-Fa-f]{8}$/

/** long 的十进制表示：可带负号，不允许前导零 */
export const BOSSBAR_LONG_PATTERN = /^(?:0|-?[1-9][0-9]*)$/
export const BOSSBAR_LONG_MIN = -(BigInt(2) ** BigInt(63))
export const BOSSBAR_LONG_MAX = BigInt(2) ** BigInt(63) - BigInt(1)

/** 新建空文档使用的透明 1×1 PNG（68 字节） */
export const BOSSBAR_DEFAULT_TEXTURE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

/** 16×16 透明 PNG：九宫格默认边距需要至少 16×16 的 UV 区域 */
export const BOSSBAR_TEST_TEXTURE_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEklEQVR42mNgGAWjYBSMAggAAAQQAAGvRYgsAAAAAElFTkSuQmCC'

/** 设计文档第 6 节的 4×2 示例图集，用于夹具与自检 */
export const BOSSBAR_SAMPLE_TEXTURE =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAJ0lEQVR4nGNQFhD7/1ZF5///zZ7/t0yL+s/wP4Dh//8TQAwEDEAAADbPEjL7vUAnAAAAAElFTkSuQmCC'

/** 预算与几何限制（设计文档 9.5 节）；超限必须给诊断，不能静默裁剪 */
export const BOSSBAR_LIMITS = {
  layout: {
    defaultScale: 0.5,
    minScale: 0.1,
    maxScale: 4,
    defaultSafeMargin: 12,
    minSafeMargin: 0,
    maxSafeMargin: 1024,
  },
  displayRegion: { maxWidth: 4096, maxHeight: 1024 },
  components: 128,
  variables: 64,
  sequenceFrames: 256,
  frameDurationMs: { min: 16, max: 60000 },
  texture: {
    maxSide: 4096,
    maxBytes: 4 * 1024 * 1024,
    /** 单图集解码内存：宽 × 高 × 4 */
    decodeBytes: 64 * 1024 * 1024,
  },
  documentBytes: 6 * 1024 * 1024,
  /** 不含 texture 的元数据上限 */
  metadataBytes: 256 * 1024,
  upsertBytes: 32 * 1024,
  upsertBudgetBytes: 30 * 1024,
  instancesPerPlayer: 16,
  replaceAllBytes: 512 * 1024,
  replaceAllPartBytes: 32 * 1024,
  replaceAllParts: 32,
  smoothMs: { min: 0, max: 1000 },
  trailDelayMs: { min: 0, max: 60000 },
  trailDurationMs: { min: 0, max: 60000 },
  fontSize: { min: 4, max: 512 },
  stringMaxLength: 256,
  opacity: { min: 0, max: 1 },
  /** 顶部留白与行间距（游戏 GUI 逻辑像素） */
  rowTopMargin: 12,
  rowGap: 6,
  maxVisibleRows: 3,
  priority: { min: -2147483648, max: 2147483647 },
  upsertsPerSecond: 10,
  replaceAllIntervalMs: 2000,
  batchTimeoutMs: 2000,
} as const

export const BOSSBAR_DOCK = ['top-center'] as const
export type BossbarDock = (typeof BOSSBAR_DOCK)[number]

export const BOSSBAR_COMPONENT_TYPES = ['display_region', 'background', 'bar', 'text'] as const
export type BossbarComponentType = (typeof BOSSBAR_COMPONENT_TYPES)[number]

export const BOSSBAR_FITS = ['stretch', 'contain', 'cover', 'nine-slice'] as const
export type BossbarFit = (typeof BOSSBAR_FITS)[number]
/** 条填充只允许 stretch */
export const BOSSBAR_BAR_FITS = ['stretch'] as const

export const BOSSBAR_BAR_DIRECTIONS = [
  'left-to-right',
  'right-to-left',
  'bottom-to-top',
  'top-to-bottom',
] as const
export type BossbarBarDirection = (typeof BOSSBAR_BAR_DIRECTIONS)[number]

export const BOSSBAR_ANIMATION_MODES = ['loop', 'once', 'pingpong'] as const
export type BossbarAnimationMode = (typeof BOSSBAR_ANIMATION_MODES)[number]

export const BOSSBAR_TEXT_ALIGNS = ['left', 'center', 'right'] as const
export type BossbarTextAlign = (typeof BOSSBAR_TEXT_ALIGNS)[number]

export const BOSSBAR_TEXT_VERTICAL_ALIGNS = ['top', 'middle', 'bottom'] as const
export type BossbarTextVerticalAlign = (typeof BOSSBAR_TEXT_VERTICAL_ALIGNS)[number]

export const BOSSBAR_VARIABLE_TYPES = ['long', 'double', 'bool', 'string'] as const
export type BossbarVariableType = (typeof BOSSBAR_VARIABLE_TYPES)[number]

/** 默认值表：解析补齐、保存显式输出都由它驱动 */
export const BOSSBAR_DEFAULTS = {
  dock: 'top-center' as BossbarDock,
  scale: 0.5,
  safeMargin: 12,
  displayRegion: { x: 0, y: 0, width: 768, height: 72 },
  visible: true,
  opacity: 1,
  fit: 'stretch' as BossbarFit,
  nineSliceInsets: [8, 8, 8, 8] as [number, number, number, number],
  direction: 'left-to-right' as BossbarBarDirection,
  smoothMs: 120,
  trailDelayMs: 250,
  trailDurationMs: 350,
  animationMode: 'loop' as BossbarAnimationMode,
  phaseMs: 0,
  fontSize: 16,
  textColor: '#FFFFFFFF',
  align: 'left' as BossbarTextAlign,
  verticalAlign: 'middle' as BossbarTextVerticalAlign,
  shadow: false,
  priority: 0,
  stringMaxLength: 256,
} as const

export type BossbarBox = { x: number; y: number; width: number; height: number }

/** 图集内的整数像素区域：左上角起点，[x,x+width) × [y,y+height) */
export type BossbarUv = { x: number; y: number; width: number; height: number }

export type BossbarLayout = {
  dock: BossbarDock
  scale: number
  safeMargin: number
}

/** 值携带明确类型标签；JSON 里的 long 是十进制字符串 */
export type BossbarLongValue = { type: 'long'; value: string }
export type BossbarDoubleValue = { type: 'double'; value: number }
export type BossbarBoolValue = { type: 'bool'; value: boolean }
export type BossbarStringValue = { type: 'string'; value: string }
export type BossbarValue =
  | BossbarLongValue
  | BossbarDoubleValue
  | BossbarBoolValue
  | BossbarStringValue
export type BossbarValueMap = Record<string, BossbarValue>

export type BossbarVariable =
  | { type: 'long'; default: string }
  | { type: 'double'; default: number }
  | { type: 'bool'; default: boolean }
  | { type: 'string'; default: string; maxLength: number }

/** 服务端计算好的进度；引用仅可指向 double 变量，绘制时夹紧到 [0,1]。 */
export type BossbarProgress = number | { var: string }

export type BossbarSolidPaint = { kind: 'solid'; color: string }

export type BossbarAnimationFrame = { uv: BossbarUv; durationMs: number }
export type BossbarAnimation = {
  mode: BossbarAnimationMode
  phaseMs: number
  frames: BossbarAnimationFrame[]
}

export type BossbarTexturePaint = {
  kind: 'texture'
  uv: BossbarUv
  fit: BossbarFit
  /** 仅九宫格：左、上、右、下（相对 uv 区域的像素） */
  insets?: [number, number, number, number]
  animation?: BossbarAnimation
}

export type BossbarPaint = BossbarSolidPaint | BossbarTexturePaint

export type BossbarVisibility = boolean | { var: string }

/** 显示区域：唯一，定义整个 BossBar 的 AABB，不绘制图像也不参与层级 */
export type BossbarDisplayRegionComponent = {
  id: string
  type: 'display_region'
  box: BossbarBox
}

type BossbarPaintableCommon = {
  id: string
  box: BossbarBox
  visible: BossbarVisibility
  opacity: number
}

export type BossbarBackgroundComponent = BossbarPaintableCommon & {
  type: 'background'
  paint: BossbarPaint
}

export type BossbarTrail = {
  paint: BossbarPaint
  delayMs: number
  durationMs: number
}

export type BossbarBarComponent = BossbarPaintableCommon & {
  type: 'bar'
  progress: BossbarProgress
  direction: BossbarBarDirection
  fill: BossbarPaint
  /** 缺省 = 关闭 */
  trail?: BossbarTrail
  smoothMs: number
}

/** 字面文本片段 */
export type BossbarLiteralRun = { text: string; color?: string }
/** 变量片段 */
export type BossbarVariableRun = {
  var: string
  color?: string
}
export type BossbarTextRun = BossbarLiteralRun | BossbarVariableRun

export type BossbarTextComponent = BossbarPaintableCommon & {
  type: 'text'
  runs: BossbarTextRun[]
  fontSize: number
  color: string
  align: BossbarTextAlign
  verticalAlign: BossbarTextVerticalAlign
  shadow: boolean
}

export type BossbarPaintableComponent =
  | BossbarBackgroundComponent
  | BossbarBarComponent
  | BossbarTextComponent

export type BossbarComponent = BossbarDisplayRegionComponent | BossbarPaintableComponent

export type BossbarDocument = {
  format: typeof BOSSBAR_FORMAT
  version: typeof BOSSBAR_VERSION
  id: string
  /** int32；较大值优先显示，缺省 0。 */
  priority: number
  /** 纯 Base64 PNG（无前缀、无空白） */
  texture: string
  layout: BossbarLayout
  variables: Record<string, BossbarVariable>
  components: BossbarComponent[]
}

/** v1：只有骨架，打开后显式升级为 v2 */
export type BossbarDocumentV1 = {
  format: typeof BOSSBAR_FORMAT
  version: typeof BOSSBAR_V1_VERSION
  id: string
}

export type BossbarDiagnosticSeverity = 'error' | 'warning'

export type BossbarDiagnostic = {
  severity: BossbarDiagnosticSeverity
  code: string
  /** 文档内字段路径，例如 components[2].box.width */
  path: string
  message: string
}

export function bossbarDiagnostic(
  code: string,
  path: string,
  message: string,
  severity: BossbarDiagnosticSeverity = 'error',
): BossbarDiagnostic {
  return { severity, code, path, message }
}

export function isDisplayRegion(
  component: BossbarComponent,
): component is BossbarDisplayRegionComponent {
  return component.type === 'display_region'
}

export function isPaintable(
  component: BossbarComponent,
): component is BossbarPaintableComponent {
  return component.type !== 'display_region'
}

export function defaultLayout(): BossbarLayout {
  return {
    dock: BOSSBAR_DEFAULTS.dock,
    scale: BOSSBAR_LIMITS.layout.defaultScale,
    safeMargin: BOSSBAR_LIMITS.layout.defaultSafeMargin,
  }
}

// ------------------------------------------------------------------ long 支持

/** 解析十进制 long；超出 int64 或不规范返回 null */
export function parseLong(text: unknown): bigint | null {
  if (typeof text !== 'string') return null
  if (!BOSSBAR_LONG_PATTERN.test(text)) return null
  let value: bigint
  try {
    value = BigInt(text)
  } catch {
    return null
  }
  if (value < BOSSBAR_LONG_MIN || value > BOSSBAR_LONG_MAX) return null
  return value
}

/** 规范十进制表示（去掉 "-0"、前导零由解析规则排除） */
export function canonicalLong(value: bigint): string {
  return value.toString(10)
}

export function longValue(value: string | bigint): BossbarLongValue {
  const parsed = typeof value === 'bigint' ? value : parseLong(value)
  if (parsed === null || parsed < BOSSBAR_LONG_MIN || parsed > BOSSBAR_LONG_MAX) throw new Error('非法 long：' + String(value))
  return { type: 'long', value: canonicalLong(parsed) }
}

export function doubleValue(value: number): BossbarDoubleValue {
  if (!Number.isFinite(value)) throw new Error('非法 double：' + String(value))
  return { type: 'double', value }
}

export function boolValue(value: boolean): BossbarBoolValue {
  return { type: 'bool', value: value === true }
}

export function stringValue(value: string): BossbarStringValue {
  return { type: 'string', value }
}

/** 声明的默认值，以带类型标签的值表示 */
export function defaultValueOf(variable: BossbarVariable): BossbarValue {
  switch (variable.type) {
    case 'long':
      return longValue(variable.default)
    case 'double':
      return doubleValue(variable.default)
    case 'bool':
      return boolValue(variable.default === true)
    default:
      return stringValue(variable.default)
  }
}

/** 类型化值是否符合声明类型与长度限制（同时检查模板 maxLength） */
export function isValueCompatible(variable: BossbarVariable, value: BossbarValue): boolean {
  if (variable.type !== value.type) return false
  if (variable.type === 'long') return parseLong(value.value) !== null
  if (variable.type === 'double') return Number.isFinite(value.value)
  if (variable.type === 'bool') return typeof value.value === 'boolean'
  const text = (value as BossbarStringValue).value
  return typeof text === 'string' && [...text].length <= Math.min(variable.maxLength, BOSSBAR_LIMITS.stringMaxLength)
}

/** 去掉首尾空白校验模板 ID；不合法返回 null */
export function normalizeTemplateId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw !== raw.trim() || !raw) return null
  if ([...raw].length > BOSSBAR_ID_MAX_LENGTH) return null
  // eslint-disable-next-line no-control-regex -- 这里就是要拒绝控制字符
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) return null
  return raw
}

/** 名称键（变量名、组件 ID）规范化；不合法返回 null */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return BOSSBAR_NAME_PATTERN.test(raw) ? raw : null
}
