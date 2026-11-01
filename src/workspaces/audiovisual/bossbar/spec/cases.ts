import type { BossbarAnimation, BossbarUv, BossbarValue } from '../protocol'
import { BOSSBAR_DEFAULT_TEXTURE, BOSSBAR_SAMPLE_TEXTURE, BOSSBAR_TEST_TEXTURE_16 } from '../protocol'

/** 协议输入与固定期望：客户端接收服务端进度和原始文本，不重算数值范围。 */
export const DEMO_EMBER_GUARD = {
  format: 'hanshu.bossbar', version: 2, id: 'hanshu:ember_guard', priority: 0,
  texture: BOSSBAR_SAMPLE_TEXTURE,
  layout: { dock: 'top-center', scale: 0.5, safeMargin: 12 },
  variables: {
    healthProgress: { type: 'double', default: 0 },
    shieldProgress: { type: 'double', default: 0 },
    healthText: { type: 'string', default: '0（0%）', maxLength: 64 },
    bossName: { type: 'string', default: '首领', maxLength: 64 },
    targetName: { type: 'string', default: '无', maxLength: 64 },
    enraged: { type: 'bool', default: false },
    counter: { type: 'long', default: '9007199254740993' },
  },
  components: [
    { id: 'region', type: 'display_region', box: { x: -384, y: -36, width: 768, height: 72 } },
    { id: 'track', type: 'background', box: { x: -288, y: -8, width: 636, height: 20 },
      paint: { kind: 'texture', uv: { x: 0, y: 0, width: 1, height: 1 }, fit: 'stretch' } },
    { id: 'emblem', type: 'background', box: { x: -364, y: -32, width: 60, height: 60 },
      paint: { kind: 'texture', uv: { x: 3, y: 0, width: 1, height: 1 }, fit: 'contain' } },
    { id: 'health_fill', type: 'bar', box: { x: -284, y: -4, width: 628, height: 12 },
      progress: { var: 'healthProgress' },
      fill: { kind: 'texture', uv: { x: 1, y: 0, width: 1, height: 1 }, fit: 'stretch' },
      direction: 'left-to-right', smoothMs: 120,
      trail: { paint: { kind: 'texture', uv: { x: 2, y: 0, width: 1, height: 1 }, fit: 'stretch' }, delayMs: 250, durationMs: 350 } },
    { id: 'shield_fill', type: 'bar', box: { x: -284, y: 16, width: 628, height: 4 },
      progress: { var: 'shieldProgress' },
      fill: { kind: 'texture', uv: { x: 2, y: 1, width: 1, height: 1 }, fit: 'stretch' } },
    { id: 'title', type: 'text', box: { x: -284, y: -36, width: 628, height: 24 },
      fontSize: 18, color: '#FFFFFFFF', align: 'center', verticalAlign: 'middle', shadow: true,
      runs: [{ var: 'bossName' }, { text: '  目标：' }, { var: 'targetName' }] },
    { id: 'health_text', type: 'text', box: { x: -284, y: -9, width: 628, height: 22 },
      fontSize: 14, color: '#FFFFFFFF', align: 'center', verticalAlign: 'middle', shadow: true,
      runs: [{ var: 'healthText' }] },
    { id: 'rage_flame', type: 'background', box: { x: -276, y: 23, width: 608, height: 8 }, visible: { var: 'enraged' },
      paint: { kind: 'texture', uv: { x: 0, y: 1, width: 1, height: 1 }, fit: 'stretch',
        animation: { mode: 'loop', phaseMs: 0, frames: [
          { uv: { x: 0, y: 1, width: 1, height: 1 }, durationMs: 100 },
          { uv: { x: 1, y: 1, width: 1, height: 1 }, durationMs: 100 },
        ] } } },
  ],
} as const

export const MINIMAL_V2 = {
  format: 'hanshu.bossbar', version: 2, id: 'hanshu:minimal',
  texture: BOSSBAR_DEFAULT_TEXTURE, layout: { dock: 'top-center', scale: 1, safeMargin: 8 },
  variables: {}, components: [{ id: 'region', type: 'display_region', box: { x: 0, y: 0, width: 320, height: 40 } }],
}

/** 服务端已计算好的进度与文本；模拟数据只用于夹具与浏览器预览。 */
export const DEMO_SCENARIOS = [
  { name: 'full', values: {
    healthProgress: { type: 'double', value: 1 }, shieldProgress: { type: 'double', value: 0.4 },
    healthText: { type: 'string', value: '1.2M（100.0%）' }, bossName: { type: 'string', value: '赤焰守卫' },
    targetName: { type: 'string', value: '无' }, enraged: { type: 'bool', value: false }, counter: { type: 'long', value: '9007199254740993' },
  } },
  { name: 'injured', values: {
    healthProgress: { type: 'double', value: 0.35 }, shieldProgress: { type: 'double', value: 0.12 },
    healthText: { type: 'string', value: '420K（35.0%）' }, bossName: { type: 'string', value: '赤焰守卫' },
    targetName: { type: 'string', value: '史蒂夫' }, enraged: { type: 'bool', value: false }, counter: { type: 'long', value: '9007199254740993' },
  } },
  { name: 'enraged-long-extreme', values: {
    healthProgress: { type: 'double', value: 0.25 }, shieldProgress: { type: 'double', value: 1 },
    healthText: { type: 'string', value: '300K（25.0%）' }, bossName: { type: 'string', value: '赤焰守卫' },
    targetName: { type: 'string', value: '史蒂夫' }, enraged: { type: 'bool', value: true }, counter: { type: 'long', value: '9223372036854775807' },
  } },
  { name: 'empty', values: {
    healthProgress: { type: 'double', value: 0 }, shieldProgress: { type: 'double', value: 0 },
    healthText: { type: 'string', value: '0（0.0%）' }, bossName: { type: 'string', value: '赤焰守卫' },
    targetName: { type: 'string', value: '无' }, enraged: { type: 'bool', value: false }, counter: { type: 'long', value: '-9223372036854775808' },
  } },
] as const

/** 在合法 PNG 里插入带有效 CRC 的 acTL 块，验证 APNG 拒绝规则。 */
export function makeApngBase64(): string {
  const bytes = base64ToBytesUnsafe(BOSSBAR_DEFAULT_TEXTURE)
  const output: number[] = []
  for (let index = 0; index < bytes.length; index += 1) output.push(bytes[index])
  // IHDR 之后插入 acTL（长度 8，类型 acTL，数据 8 字节）。
  const insertAt = 8 + 4 + 4 + 13 + 4
  const chunk = [0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]
  let crc = 0xffffffff
  for (const byte of chunk.slice(4, 16)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  crc = (crc ^ 0xffffffff) >>> 0
  for (let index = 0; index < 4; index += 1) chunk[16 + index] = (crc >>> (24 - index * 8)) & 255
  output.splice(insertAt, 0, ...chunk)
  return encodeBase64Unsafe(new Uint8Array(output))
}

function base64ToBytesUnsafe(text: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = text.replace(/=+$/, '')
  const out: number[] = []
  let bits = 0
  let count = 0
  for (const char of clean) {
    const value = alphabet.indexOf(char)
    if (value < 0) continue
    bits = (bits << 6) | value
    count += 6
    if (count >= 8) {
      count -= 8
      out.push((bits >>> count) & 0xff)
    }
  }
  return new Uint8Array(out)
}

function encodeBase64Unsafe(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0
    const bits = (a << 16) | (b << 8) | c
    out += alphabet[(bits >>> 18) & 63]
    out += alphabet[(bits >>> 12) & 63]
    out += index + 1 < bytes.length ? alphabet[(bits >>> 6) & 63] : '='
    out += index + 2 < bytes.length ? alphabet[bits & 63] : '='
  }
  return out
}

const regionOnly = [{ id: 'region', type: 'display_region', box: { x: 0, y: 0, width: 100, height: 40 } }]

/** 非法输入须在准确字段处拒绝；旧草案 v2 的数值范围与格式字段不做迁移。 */
const background = { id: 'bg', type: 'background', box: { x: 0, y: 0, width: 10, height: 10 }, paint: { kind: 'solid', color: '#FFFFFFFF' } }
const bar = { id: 'bar', type: 'bar', box: { x: 0, y: 0, width: 10, height: 10 }, progress: 0.5, fill: { kind: 'solid', color: '#FFFFFFFF' } }
const text = { id: 'text', type: 'text', box: { x: 0, y: 0, width: 10, height: 10 }, runs: [{ text: 'x' }] }
const withComponents = (...components: unknown[]) => ({ ...MINIMAL_V2, components: [...regionOnly, ...components] })
export const INVALID_CASES: { name: string, path: string, input: unknown }[] = [
  { name: 'unknown-field', path: 'extra', input: { ...MINIMAL_V2, extra: 1 } },
  { name: 'missing-texture', path: 'texture', input: (() => { const { texture: _texture, ...rest } = MINIMAL_V2; void _texture; return rest })() },
  { name: 'bad-base64', path: 'texture', input: { ...MINIMAL_V2, texture: 'not a png' } },
  { name: 'not-png', path: 'texture', input: { ...MINIMAL_V2, texture: 'aGVsbG8gd29ybGQ=' } },
  { name: 'png-no-idat', path: 'texture', input: { ...MINIMAL_V2, texture: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAElFTkSuQmCC' } },
  { name: 'apng', path: 'texture', input: { ...MINIMAL_V2, texture: makeApngBase64() } },
  { name: 'no-display-region', path: 'components', input: { ...MINIMAL_V2, components: [background] } },
  { name: 'duplicate-display-region', path: 'components[1].type', input: { ...MINIMAL_V2, components: [...regionOnly, { ...regionOnly[0], id: 'region2' }] } },
  { name: 'id-leading-space', path: 'id', input: { ...MINIMAL_V2, id: ' hanshu:x' } },
  { name: 'dock-unsupported', path: 'layout.dock', input: { ...MINIMAL_V2, layout: { ...MINIMAL_V2.layout, dock: 'bottom-left' } } },
  { name: 'scale-over', path: 'layout.scale', input: { ...MINIMAL_V2, layout: { ...MINIMAL_V2.layout, scale: 4.5 } } },
  { name: 'priority-overflow', path: 'priority', input: { ...MINIMAL_V2, priority: 2147483648 } },
  { name: 'priority-fraction', path: 'priority', input: { ...MINIMAL_V2, priority: 0.5 } },
  { name: 'component-zero-width', path: 'components[1].box.width', input: withComponents({ ...background, box: { ...background.box, width: 0 } }) },
  { name: 'component-outside-region', path: 'components[1].box', input: withComponents({ ...background, box: { x: 90, y: 0, width: 20, height: 10 } }) },
  { name: 'hidden-component-outside-region', path: 'components[1].box', input: withComponents({ ...background, visible: false, box: { x: 0, y: 30, width: 20, height: 20 } }) },
  { name: 'component-duplicate-id', path: 'components[2].id', input: withComponents(background, background) },
  { name: 'uv-out-of-bounds', path: 'components[1].paint.uv', input: withComponents({ ...background, paint: { kind: 'texture', uv: { x: 1, y: 0, width: 1, height: 1 } } }) },
  { name: 'animation-first-frame-mismatch', path: 'components[1].paint.animation.frames[0].uv', input: {
    ...withComponents({ ...background, paint: { kind: 'texture', uv: { x: 0, y: 0, width: 1, height: 1 },
      animation: { frames: [{ uv: { x: 1, y: 0, width: 1, height: 1 }, durationMs: 100 }] } } }), texture: BOSSBAR_SAMPLE_TEXTURE,
  } },
  { name: 'animation-frame-size-mismatch', path: 'components[1].paint.animation.frames[1].uv', input: {
    ...withComponents({ ...background, paint: { kind: 'texture', uv: { x: 0, y: 0, width: 1, height: 1 },
      animation: { frames: [{ uv: { x: 0, y: 0, width: 1, height: 1 }, durationMs: 100 }, { uv: { x: 1, y: 0, width: 2, height: 1 }, durationMs: 100 }] } } }), texture: BOSSBAR_SAMPLE_TEXTURE,
  } },
  { name: 'animation-frame-out-of-bounds', path: 'components[1].paint.animation.frames[1].uv', input: {
    ...withComponents({ ...background, paint: { kind: 'texture', uv: { x: 0, y: 0, width: 1, height: 1 },
      animation: { frames: [{ uv: { x: 0, y: 0, width: 1, height: 1 }, durationMs: 100 }, { uv: { x: 4, y: 0, width: 1, height: 1 }, durationMs: 100 }] } } }), texture: BOSSBAR_SAMPLE_TEXTURE,
  } },
  { name: 'nine-slice-insets-overflow', path: 'components[1].paint.insets', input: withComponents({ ...background, paint: {
    kind: 'texture', fit: 'nine-slice', uv: { x: 0, y: 0, width: 1, height: 1 }, insets: [1, 0, 1, 0],
  } }) },
  { name: 'bar-non-stretch', path: 'components[1].fill.fit', input: withComponents({ ...bar, fill: { kind: 'texture', fit: 'contain', uv: { x: 0, y: 0, width: 1, height: 1 } } }) },
  { name: 'progress-reference-missing', path: 'components[1].progress.var', input: withComponents({ ...bar, progress: { var: 'nope' } }) },
  { name: 'progress-long-reference', path: 'components[1].progress.var', input: { ...withComponents({ ...bar, progress: { var: 'big' } }), variables: { big: { type: 'long', default: '1' } } } },
  { name: 'progress-typed-literal', path: 'components[1].progress', input: withComponents({ ...bar, progress: { type: 'double', value: 0.5 } }) },
  { name: 'legacy-range', path: 'components[1].range', input: withComponents({ ...bar, range: { value: { type: 'double', value: 50 }, min: { type: 'double', value: 0 }, max: { type: 'double', value: 100 } } }) },
  { name: 'legacy-ratio-run', path: 'components[1].runs[0].ratio', input: withComponents({ ...text, runs: [{ ratio: {} }] }) },
  { name: 'legacy-text-format', path: 'components[1].runs[0].format', input: withComponents({ ...text, runs: [{ text: 'x', format: 'compact' }] }) },
  { name: 'legacy-text-digits', path: 'components[1].runs[0].digits', input: withComponents({ ...text, runs: [{ text: 'x', digits: 2 }] }) },
  { name: 'text-reference-missing', path: 'components[1].runs[0].var', input: withComponents({ ...text, runs: [{ var: 'nope' }] }) },
  { name: 'visibility-type', path: 'components[1].visible.var', input: { ...withComponents({ ...background, visible: { var: 'name' } }), variables: { name: { type: 'string', default: '' } } } },
  { name: 'long-default-out-of-range', path: 'variables.big.default', input: { ...MINIMAL_V2, variables: { big: { type: 'long', default: '9223372036854775808' } } } },
  { name: 'long-default-leading-zero', path: 'variables.big.default', input: { ...MINIMAL_V2, variables: { big: { type: 'long', default: '007' } } } },
  { name: 'string-default-too-long', path: 'variables.short.default', input: { ...MINIMAL_V2, variables: { short: { type: 'string', default: 'abcdef', maxLength: 3 } } } },
  { name: 'legacy-variable-key', path: 'variables.big.key', input: { ...MINIMAL_V2, variables: { big: { type: 'long', default: '0', key: 'old_map_key' } } } },
  { name: 'snapshot-budget-overflow', path: 'variables', input: { ...MINIMAL_V2, variables: Object.fromEntries(Array.from({ length: 64 }, (_, index) => ['v' + index, { type: 'string', default: '', maxLength: 256 }])) } },
  { name: 'bad-color', path: 'components[1].paint.color', input: withComponents({ ...background, paint: { kind: 'solid', color: '#FFF' } }) },
  { name: 'missing-runs', path: 'components[1].runs', input: withComponents({ id: 't', type: 'text', box: text.box }) },
  { name: 'display-region-with-visible', path: 'components[0].visible', input: { ...MINIMAL_V2, components: [{ ...regionOnly[0], visible: true }] } },
]

export const UNSUPPORTED_VERSION = { format: 'hanshu.bossbar', version: 3, id: 'x' }

export const PROGRESS_CASES = [
  { input: -1, expect: 0 }, { input: 0, expect: 0 }, { input: 0.35, expect: 0.35 },
  { input: 1, expect: 1 }, { input: 2, expect: 1 },
  { input: Number.MAX_VALUE, expect: 1 }, { input: -Number.MAX_VALUE, expect: 0 },
]

export const TEXT_VALUE_CASES: { value: BossbarValue; expect: string }[] = [
  { value: { type: 'long', value: '9007199254740993' }, expect: '9007199254740993' },
  { value: { type: 'long', value: '-9223372036854775808' }, expect: '-9223372036854775808' },
  { value: { type: 'long', value: '9223372036854775807' }, expect: '9223372036854775807' },
  { value: { type: 'double', value: 0.35 }, expect: '0.35' },
  { value: { type: 'bool', value: true }, expect: 'true' },
  { value: { type: 'string', value: '服务端已本地化：1.2M（35%）' }, expect: '服务端已本地化：1.2M（35%）' },
]

/** 取帧表：设计文档 10.1 节的例子 */
export const FRAME_CASES: {
  mode: 'loop' | 'once' | 'pingpong'
  durations: number[]
  phaseMs: number
  samples: { timeMs: number, index: number }[]
}[] = [
  {
    mode: 'loop',
    durations: [100, 100, 100, 100],
    phaseMs: 0,
    samples: [0, 99, 100, 399, 400].map((timeMs, index) => ({
      timeMs,
      index: [0, 0, 1, 3, 0][index],
    })),
  },
  {
    mode: 'pingpong',
    durations: [100, 100, 100, 100],
    phaseMs: 0,
    samples: [0, 100, 200, 300, 400, 500, 599, 600].map((timeMs, index) => ({
      timeMs,
      index: [0, 1, 2, 3, 2, 1, 1, 0][index],
    })),
  },
  {
    mode: 'once',
    durations: [100, 100],
    phaseMs: 50,
    samples: [0, 49, 50, 149, 150, 10000].map((timeMs, index) => ({
      timeMs,
      index: [0, 0, 1, 1, 1, 1][index],
    })),
  },
  {
    mode: 'pingpong',
    durations: [40, 120, 60],
    phaseMs: 0,
    samples: [0, 39, 40, 159, 160, 219, 220, 339, 340].map((timeMs, index) => ({
      timeMs,
      index: [0, 0, 1, 1, 2, 2, 1, 1, 0][index],
    })),
  },
]

/** 九宫格（源坐标相对 UV 原点） */
export const NINE_SLICE_CASES: {
  name: string
  src: [number, number]
  dst: { x: number, y: number, width: number, height: number }
  insets: [number, number, number, number]
}[] = [
  { name: 'normal', src: [64, 32], dst: { x: 0, y: 0, width: 200, height: 40 }, insets: [8, 8, 8, 8] },
  { name: 'too-small', src: [64, 32], dst: { x: 4, y: 4, width: 8, height: 6 }, insets: [8, 8, 8, 8] },
  { name: 'zero-center', src: [64, 32], dst: { x: 0, y: 0, width: 16, height: 16 }, insets: [8, 8, 8, 8] },
]

export const BAR_SEGMENT_CASES: {
  box: { x: number, y: number, width: number, height: number }
  from: number
  to: number
  direction: 'left-to-right' | 'right-to-left' | 'bottom-to-top' | 'top-to-bottom'
}[] = [
  { box: { x: 100, y: 32, width: 628, height: 12 }, from: 0, to: 0.25, direction: 'left-to-right' },
  { box: { x: 100, y: 32, width: 628, height: 12 }, from: 0.5, to: 0.8, direction: 'right-to-left' },
  { box: { x: 0, y: 0, width: 10, height: 100 }, from: 0, to: 0.35, direction: 'bottom-to-top' },
  { box: { x: 0, y: 0, width: 10, height: 100 }, from: 0.2, to: 0.9, direction: 'top-to-bottom' },
  { box: { x: 0, y: 0, width: 10, height: 100 }, from: 0.3, to: 0.3, direction: 'top-to-bottom' },
]

/** 文本截断：每个字形按固定宽度计，两端可复现 */
export const TRUNCATE_CASES: { text: string, maxWidth: number }[] = [
  { text: '赤焰守卫', maxWidth: 1000 },
  { text: '赤焰守卫', maxWidth: 45 },
  { text: '目标：史蒂夫（35.0%）', maxWidth: 120 },
  { text: '😀😀😀😀😀', maxWidth: 45 },
  { text: 'abcdef', maxWidth: 5 },
]

/** 布局表：显示区域可能位于负坐标，GUI 宽度不同时按显示区域宽度缩放 */
export const LAYOUT_CASES: {
  guiWidth: number
  layout: { dock: 'top-center', scale: number, safeMargin: number }
  region: { x: number, y: number, width: number, height: number }
  rowY: number
  boxes: { x: number, y: number, width: number, height: number }[]
}[] = [
  {
    guiWidth: 320,
    layout: { dock: 'top-center', scale: 0.5, safeMargin: 12 },
    region: { x: -384, y: -36, width: 768, height: 72 },
    rowY: 12,
    boxes: [
      { x: -384, y: -36, width: 768, height: 72 },
      { x: -288, y: -8, width: 636, height: 20 },
    ],
  },
  {
    guiWidth: 1920,
    layout: { dock: 'top-center', scale: 0.5, safeMargin: 12 },
    region: { x: -384, y: -36, width: 768, height: 72 },
    rowY: 12,
    boxes: [{ x: -364, y: -32, width: 60, height: 60 }],
  },
  {
    guiWidth: 20,
    layout: { dock: 'top-center', scale: 0.5, safeMargin: 12 },
    region: { x: 0, y: 0, width: 768, height: 72 },
    rowY: 12,
    boxes: [{ x: 0, y: 0, width: 10, height: 10 }],
  },
]

/** 作者可省略默认优先级和可选属性；规范文档显式写入。 */
export const NORMALIZE_CASES: { name: string, input: unknown }[] = [
  { name: 'minimal-v2', input: MINIMAL_V2 }, { name: 'demo-ember-guard', input: DEMO_EMBER_GUARD },
  { name: 'defaults-filled', input: {
    format: 'hanshu.bossbar', version: 2, id: 'hanshu:defaults', texture: ' ' + BOSSBAR_TEST_TEXTURE_16 + '\n', layout: {},
    variables: { note: { type: 'string', default: 'x' }, big: { type: 'long', default: '0' } },
    components: [
      { id: 'region', type: 'display_region', box: { x: -10, y: -10, width: 100, height: 40 } },
      { ...background, paint: { kind: 'solid', color: '#11223344' } },
      { id: 'nine', type: 'background', box: { x: 0, y: 0, width: 10, height: 10 }, paint: { kind: 'texture', uv: { x: 0, y: 0, width: 16, height: 16 }, fit: 'nine-slice' } },
      { ...bar, progress: 0.25 }, { ...text, runs: [{ text: 'a' }, { var: 'note' }] },
    ],
  } },
]

/** 紧凑动画构造：4 帧各 100ms，UV 横向排布 */
export function sequenceAnimation(mode: BossbarAnimation['mode'], durations: number[], phaseMs: number): BossbarAnimation {
  return {
    mode,
    phaseMs,
    frames: durations.map((durationMs, index) => ({
      uv: { x: index, y: 0, width: 1, height: 1 } as BossbarUv,
      durationMs,
    })),
  }
}
