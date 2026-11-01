import {
  BOSSBAR_ANIMATION_MODES,
  BOSSBAR_BAR_DIRECTIONS,
  BOSSBAR_COMPONENT_TYPES,
  BOSSBAR_DEFAULTS,
  BOSSBAR_DOCK,
  BOSSBAR_FITS,
  BOSSBAR_FORMAT,
  BOSSBAR_ID_MAX_LENGTH,
  BOSSBAR_LIMITS,
  BOSSBAR_LONG_PATTERN,
  BOSSBAR_NAME_PATTERN,
  BOSSBAR_TEXT_ALIGNS,
  BOSSBAR_TEXT_VERTICAL_ALIGNS,
  BOSSBAR_VARIABLE_TYPES,
  BOSSBAR_VERSION,
} from './protocol'

/**
 * 协议 v2 的机器可校验定义（JSON Schema 2020-12）。
 *
 * 它描述的是**规范文档**：解析器补齐默认值后、编译器写进 PAK 的那份 JSON。
 * 作者手写的文档可以省略带默认值的字段，解析器补齐后同样落在这份 schema 里，
 * 因此默认值字段也列为 required —— 两端不能再各写一套默认值。
 *
 * schema 只覆盖结构；显示区域唯一性、AABB 包含、UV 越界、PNG 结构、
 * long 默认值范围与进度变量类型等由 parse.ts 的语义校验负责。
 */

const namePattern = BOSSBAR_NAME_PATTERN.source
const longPattern = BOSSBAR_LONG_PATTERN.source

const box = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number', exclusiveMinimum: 0 },
    height: { type: 'number', exclusiveMinimum: 0 },
  },
} as const

const uv = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'integer', minimum: 0 },
    y: { type: 'integer', minimum: 0 },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
  },
} as const

const insets = {
  type: 'array',
  minItems: 4,
  maxItems: 4,
  items: { type: 'integer', minimum: 0 },
} as const

const animationFrame = {
  type: 'object',
  additionalProperties: false,
  required: ['uv', 'durationMs'],
  properties: {
    uv,
    durationMs: {
      type: 'integer',
      minimum: BOSSBAR_LIMITS.frameDurationMs.min,
      maximum: BOSSBAR_LIMITS.frameDurationMs.max,
    },
  },
} as const

const animation = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'phaseMs', 'frames'],
  properties: {
    mode: { enum: [...BOSSBAR_ANIMATION_MODES] },
    phaseMs: { type: 'integer', minimum: 0 },
    frames: {
      type: 'array',
      minItems: 1,
      maxItems: BOSSBAR_LIMITS.sequenceFrames,
      items: animationFrame,
    },
  },
} as const

const solidPaint = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'color'],
  properties: {
    kind: { const: 'solid' },
    color: { type: 'string', pattern: '^#[0-9A-Fa-f]{8}$' },
  },
} as const

const texturePaintBase = {
  kind: { const: 'texture' },
  uv,
  animation,
} as const

const texturePaint = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'uv', 'fit'],
      properties: {
        ...texturePaintBase,
        fit: { enum: ['stretch', 'contain', 'cover'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'uv', 'fit', 'insets'],
      properties: {
        ...texturePaintBase,
        fit: { const: 'nine-slice' },
        insets,
      },
    },
  ],
} as const

/** 背景组件可用的画笔 */
const anyPaint = { oneOf: [solidPaint, texturePaint] } as const
/** 条填充只允许 stretch */
const barPaint = {
  oneOf: [
    solidPaint,
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'uv', 'fit'],
      properties: { ...texturePaintBase, fit: { const: 'stretch' } },
    },
  ],
} as const

const variableOperand = {
  type: 'object',
  additionalProperties: false,
  required: ['var'],
  properties: { var: { type: 'string', pattern: namePattern } },
} as const

const progress = { oneOf: [{ type: 'number' }, variableOperand] } as const

const visibility = {
  oneOf: [
    { type: 'boolean' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['var'],
      properties: { var: { type: 'string', pattern: namePattern } },
    },
  ],
} as const

const paintableCommon = {
  box,
  visible: visibility,
  opacity: {
    type: 'number',
    minimum: BOSSBAR_LIMITS.opacity.min,
    maximum: BOSSBAR_LIMITS.opacity.max,
  },
} as const

const displayRegionComponent = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'box'],
  properties: {
    id: { type: 'string', pattern: namePattern },
    type: { const: BOSSBAR_COMPONENT_TYPES[0] },
    box,
  },
} as const

const backgroundComponent = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'box', 'visible', 'opacity', 'paint'],
  properties: {
    id: { type: 'string', pattern: namePattern },
    type: { const: BOSSBAR_COMPONENT_TYPES[1] },
    ...paintableCommon,
    paint: anyPaint,
  },
} as const

const barComponent = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'box', 'visible', 'opacity', 'progress', 'direction', 'fill', 'smoothMs'],
  properties: {
    id: { type: 'string', pattern: namePattern },
    type: { const: BOSSBAR_COMPONENT_TYPES[2] },
    ...paintableCommon,
    progress,
    direction: { enum: [...BOSSBAR_BAR_DIRECTIONS] },
    fill: barPaint,
    trail: {
      type: 'object',
      additionalProperties: false,
      required: ['paint', 'delayMs', 'durationMs'],
      properties: {
        paint: barPaint,
        delayMs: {
          type: 'integer',
          minimum: BOSSBAR_LIMITS.trailDelayMs.min,
          maximum: BOSSBAR_LIMITS.trailDelayMs.max,
        },
        durationMs: {
          type: 'integer',
          minimum: BOSSBAR_LIMITS.trailDurationMs.min,
          maximum: BOSSBAR_LIMITS.trailDurationMs.max,
        },
      },
    },
    smoothMs: {
      type: 'number',
      minimum: BOSSBAR_LIMITS.smoothMs.min,
      maximum: BOSSBAR_LIMITS.smoothMs.max,
    },
  },
} as const

const colorProperty = { type: 'string', pattern: '^#[0-9A-Fa-f]{8}$' } as const

const literalRun = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', maxLength: BOSSBAR_LIMITS.stringMaxLength * 4 },
    color: colorProperty,
  },
} as const

const variableRun = {
  type: 'object',
  additionalProperties: false,
  required: ['var'],
  properties: {
    var: { type: 'string', pattern: namePattern },
    color: colorProperty,
  },
} as const

const textComponent = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'type',
    'box',
    'visible',
    'opacity',
    'runs',
    'fontSize',
    'color',
    'align',
    'verticalAlign',
    'shadow',
  ],
  properties: {
    id: { type: 'string', pattern: namePattern },
    type: { const: BOSSBAR_COMPONENT_TYPES[3] },
    ...paintableCommon,
    runs: {
      type: 'array',
      maxItems: 64,
      items: { oneOf: [literalRun, variableRun] },
    },
    fontSize: {
      type: 'number',
      minimum: BOSSBAR_LIMITS.fontSize.min,
      maximum: BOSSBAR_LIMITS.fontSize.max,
    },
    color: colorProperty,
    align: { enum: [...BOSSBAR_TEXT_ALIGNS] },
    verticalAlign: { enum: [...BOSSBAR_TEXT_VERTICAL_ALIGNS] },
    shadow: { type: 'boolean' },
  },
} as const

const longVariable = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'default'],
  properties: {
    type: { const: BOSSBAR_VARIABLE_TYPES[0] },
    default: { type: 'string', pattern: longPattern },
  },
} as const

const doubleVariable = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'default'],
  properties: {
    type: { const: BOSSBAR_VARIABLE_TYPES[1] },
    default: { type: 'number' },
  },
} as const

const boolVariable = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'default'],
  properties: {
    type: { const: BOSSBAR_VARIABLE_TYPES[2] },
    default: { type: 'boolean' },
  },
} as const

const stringVariable = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'default', 'maxLength'],
  properties: {
    type: { const: BOSSBAR_VARIABLE_TYPES[3] },
    default: { type: 'string', maxLength: BOSSBAR_LIMITS.stringMaxLength },
    maxLength: {
      type: 'integer',
      minimum: 1,
      maximum: BOSSBAR_LIMITS.stringMaxLength,
    },
  },
} as const

export const BOSSBAR_V2_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'hanshu:bossbar/v2',
  title: '汉数 BossBar v2 规范文档',
  description:
    '规范形式：解析器补齐默认值后的 v2 文档。单文件自包含——唯一 Base64 PNG 图集、' +
    '唯一 display_region，全部组件的 box 位于显示区域内。',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'version', 'id', 'priority', 'texture', 'layout', 'variables', 'components'],
  properties: {
    format: { const: BOSSBAR_FORMAT },
    version: { const: BOSSBAR_VERSION },
    priority: { type: 'integer', minimum: BOSSBAR_LIMITS.priority.min, maximum: BOSSBAR_LIMITS.priority.max },
    id: {
      type: 'string',
      minLength: 1,
      maxLength: BOSSBAR_ID_MAX_LENGTH,
      allOf: [
        { pattern: '^[^\\s](?:[\\s\\S]*[^\\s])?$' },
        { pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' },
      ],
    },
    texture: {
      type: 'string',
      minLength: 4,
      maxLength: Math.ceil((BOSSBAR_LIMITS.texture.maxBytes / 3) * 4) + 4,
      pattern: '^[A-Za-z0-9+/]+={0,2}$',
    },
    layout: {
      type: 'object',
      additionalProperties: false,
      required: ['dock', 'scale', 'safeMargin'],
      properties: {
        dock: { enum: [...BOSSBAR_DOCK] },
        scale: {
          type: 'number',
          minimum: BOSSBAR_LIMITS.layout.minScale,
          maximum: BOSSBAR_LIMITS.layout.maxScale,
        },
        safeMargin: {
          type: 'number',
          minimum: BOSSBAR_LIMITS.layout.minSafeMargin,
          maximum: BOSSBAR_LIMITS.layout.maxSafeMargin,
        },
      },
    },
    variables: {
      type: 'object',
      maxProperties: BOSSBAR_LIMITS.variables,
      propertyNames: { pattern: namePattern },
      additionalProperties: { oneOf: [longVariable, doubleVariable, boolVariable, stringVariable] },
    },
    components: {
      type: 'array',
      minItems: 1,
      maxItems: BOSSBAR_LIMITS.components,
      items: { oneOf: [displayRegionComponent, backgroundComponent, barComponent, textComponent] },
    },
  },
} as const

/** 默认值摘要，供编辑器新建组件与两端对拍 */
export const BOSSBAR_SCHEMA_DEFAULTS = {
  dock: BOSSBAR_DEFAULTS.dock,
  scale: BOSSBAR_DEFAULTS.scale,
  safeMargin: BOSSBAR_DEFAULTS.safeMargin,
  displayRegion: BOSSBAR_DEFAULTS.displayRegion,
  visible: BOSSBAR_DEFAULTS.visible,
  opacity: BOSSBAR_DEFAULTS.opacity,
  fit: BOSSBAR_DEFAULTS.fit,
  nineSliceInsets: BOSSBAR_DEFAULTS.nineSliceInsets,
  direction: BOSSBAR_DEFAULTS.direction,
  smoothMs: BOSSBAR_DEFAULTS.smoothMs,
  animationMode: BOSSBAR_DEFAULTS.animationMode,
  phaseMs: BOSSBAR_DEFAULTS.phaseMs,
  fontSize: BOSSBAR_DEFAULTS.fontSize,
  textColor: BOSSBAR_DEFAULTS.textColor,
  align: BOSSBAR_DEFAULTS.align,
  verticalAlign: BOSSBAR_DEFAULTS.verticalAlign,
  shadow: BOSSBAR_DEFAULTS.shadow,
  priority: BOSSBAR_DEFAULTS.priority,
  fits: [...BOSSBAR_FITS],
} as const
