import {
  createBossbar,
  parseBossbarDocument,
  stringifyBossbar,
  toCanonicalDocument,
  upgradeBossbarV1,
  validateBossbarSemantics,
} from '../parse'
import { BOSSBAR_V2_SCHEMA } from '../schema'
import { buildScene } from '../render/scene'
import { animationCycle, sampleAnimation } from '../rules/frames'
import { barSegment, layoutScale, mapBoxToScreen, nineSliceSprites, placeRegion } from '../rules/layout'
import { formatRunValue } from '../rules/formatRun'
import { clampProgress, resolveProgress } from '../rules/range'
import { resolveValues, estimateSnapshotBytes } from '../rules/values'
import { colorToArgbHex, parseColor } from '../rules/color'
import { splitGraphemes, truncateToWidth } from '../rules/text'
import { base64ToBytes, pngInfo } from '../png'
import {
  BOSSBAR_SAMPLE_TEXTURE,
  type BossbarAnimation,
  type BossbarDocument,
  type BossbarValueMap,
} from '../protocol'
import {
  BAR_SEGMENT_CASES,
  DEMO_EMBER_GUARD,
  DEMO_SCENARIOS,
  FRAME_CASES,
  INVALID_CASES,
  LAYOUT_CASES,
  NINE_SLICE_CASES,
  NORMALIZE_CASES,
  TEXT_VALUE_CASES,
  PROGRESS_CASES,
  TRUNCATE_CASES,
  UNSUPPORTED_VERSION,
  sequenceAnimation,
} from './cases'

/**
 * 生成协议夹具（schema + 冻结期望值）。
 *
 * 输入只有 `cases.ts` 里的声明；期望值由当前实现算出并冻在 JSON 里。
 * 生成与校验都走这个函数，因此 `npm run test:bossbar` 一变红就说明语义动了。
 */

const round = (value: number, digits = 12): number => {
  if (!Number.isFinite(value)) return 0
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

function parseExpectation(input: unknown): Record<string, unknown> {
  const source = typeof input === 'string' ? input : JSON.stringify(input)
  const result = parseBossbarDocument(source)
  if (!result.ok) {
    return {
      ok: false,
      paths: result.diagnostics.filter((entry) => entry.severity === 'error').map((entry) => entry.path),
      codes: result.diagnostics.filter((entry) => entry.severity === 'error').map((entry) => entry.code),
    }
  }
  return { ok: true, document: result.document, canonical: stringifyBossbar(result.document) }
}

function textureInfo(base64: string): { width: number; height: number; byteLength: number } {
  const bytes = base64ToBytes(base64)
  const info = bytes ? pngInfo(bytes) : null
  if (!bytes || !info) throw new Error('夹具图集无效')
  return { width: info.width, height: info.height, byteLength: bytes.length }
}

function roundCommand(command: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(command)) {
    if (typeof value === 'number') next[key] = round(value)
    else if (Array.isArray(value)) {
      next[key] = value.map((entry) =>
        entry && typeof entry === 'object' ? roundCommand(entry as Record<string, unknown>) : entry,
      )
    } else if (value && typeof value === 'object') {
      const nested: Record<string, unknown> = {}
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        nested[innerKey] = typeof innerValue === 'number' ? round(innerValue) : innerValue
      }
      next[key] = nested
    } else next[key] = value
  }
  return next
}

export function buildBossbarFixtures(): Record<string, unknown> {
  const perGrapheme = (value: string) => splitGraphemes(value).length * 10

  const normalize = NORMALIZE_CASES.map((entry) => ({
    name: entry.name,
    input: entry.input,
    expect: parseExpectation(entry.input),
  }))

  const invalid = INVALID_CASES.map((entry) => ({
    name: entry.name,
    expectedPath: entry.path,
    input: entry.input,
    expect: parseExpectation(entry.input),
  }))

  const frames = FRAME_CASES.map((entry) => {
    const animation: BossbarAnimation = sequenceAnimation(entry.mode, entry.durations, entry.phaseMs)
    return {
      mode: entry.mode,
      durations: entry.durations,
      phaseMs: entry.phaseMs,
      cycle: animationCycle(animation),
      samples: [...new Set(entry.samples.map((sample) => sample.timeMs))].map((timeMs) => {
        const sample = sampleAnimation(animation, animation.frames[0].uv, timeMs)
        const declared = entry.samples.find((item) => item.timeMs === timeMs)!
        return { timeMs, index: sample.index, uv: sample.uv, expect: declared.index }
      }),
    }
  })

  const progress = PROGRESS_CASES.map((entry) => ({
    input: entry.input,
    result: clampProgress(entry.input),
    expect: entry.expect,
  }))
  const textValues = TEXT_VALUE_CASES.map((entry) => ({
    value: entry.value,
    text: formatRunValue(entry.value),
    expect: entry.expect,
  }))

  const nineSlice = NINE_SLICE_CASES.map((entry) => ({
    name: entry.name,
    src: entry.src,
    dst: entry.dst,
    insets: entry.insets,
    pieces: nineSliceSprites({ width: entry.src[0], height: entry.src[1] }, entry.dst, entry.insets).map((piece) => ({
      sx: round(piece.sx),
      sy: round(piece.sy),
      sw: round(piece.sw),
      sh: round(piece.sh),
      dx: round(piece.dx),
      dy: round(piece.dy),
      dw: round(piece.dw),
      dh: round(piece.dh),
    })),
  }))

  const barSegments = BAR_SEGMENT_CASES.map((entry) => {
    const segment = barSegment(entry.box, entry.from, entry.to, entry.direction)
    return {
      box: entry.box,
      from: entry.from,
      to: entry.to,
      direction: entry.direction,
      segment: segment
        ? { x: round(segment.x), y: round(segment.y), width: round(segment.width), height: round(segment.height) }
        : null,
    }
  })

  const truncate = TRUNCATE_CASES.map((entry) => ({
    text: entry.text,
    maxWidth: entry.maxWidth,
    measure: { kind: 'perGrapheme', unit: 10 },
    result: truncateToWidth(entry.text, entry.maxWidth, perGrapheme),
  }))

  const layout = LAYOUT_CASES.map((entry) => {
    const placement = placeRegion(entry.layout, entry.region, entry.guiWidth, entry.rowY)
    return {
      guiWidth: entry.guiWidth,
      layout: entry.layout,
      region: entry.region,
      rowY: entry.rowY,
      scale: round(layoutScale(entry.layout, entry.region.width, entry.guiWidth)),
      placement: placement
        ? {
            x: round(placement.x),
            y: round(placement.y),
            width: round(placement.width),
            height: round(placement.height),
            scale: round(placement.scale),
          }
        : null,
      boxes: entry.boxes.map((box) => ({
        box,
        screen: placement
          ? (() => {
              const rect = mapBoxToScreen(box, entry.region, placement)
              return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }
            })()
          : null,
      })),
    }
  })

  const demoParsed = parseBossbarDocument(JSON.stringify(DEMO_EMBER_GUARD))
  if (!demoParsed.ok) throw new Error('演示文档应能解析：' + JSON.stringify(demoParsed.diagnostics))
  const demo = demoParsed.document
  const demoTexture = textureInfo(demo.texture)

  const scenes = DEMO_SCENARIOS.map((scenario) => {
    const resolved = resolveValues(demo, scenario.values as Record<string, unknown>)
    const scene = buildScene({
      document: demo,
      values: resolved.values,
      timeMs: 250,
      texture: demoTexture,
    })
    return {
      name: scenario.name,
      values: scenario.values,
      issues: scene.issues.map((entry) => entry.code + ':' + entry.path),
      commands: scene.commands.map((command) => roundCommand(command as unknown as Record<string, unknown>)),
    }
  })

  const longExtreme: BossbarValueMap = {
    ...resolveValues(demo, DEMO_SCENARIOS[2].values as Record<string, unknown>).values,
  }
  const longScene = buildScene({ document: demo, values: longExtreme, timeMs: 250, texture: demoTexture })

  const shieldBar = demo.components.find((component) => component.id === 'shield_fill')
  const shieldProgress =
    shieldBar && shieldBar.type === 'bar'
      ? resolveProgress(shieldBar.progress, demo.variables, longExtreme)
      : null

  return {
    format: 'hanshu.bossbar.fixtures',
    specVersion: 2,
    protocolVersion: 2,
    note:
      '期望值由 WebUI 实现冻结；Java 解析器对拍同一份数据。' +
      '改实现必须重新生成并 review diff。long 在 JSON 里一律是十进制字符串。',
    normalize,
    invalid,
    unsupportedVersion: parseExpectation(UNSUPPORTED_VERSION),
    v1: {
      input: { format: 'hanshu.bossbar', version: 1, id: 'legacy' },
      parse: parseExpectation({ format: 'hanshu.bossbar', version: 1, id: 'legacy' }),
      upgrade: upgradeBossbarV1({ format: 'hanshu.bossbar', version: 1, id: 'legacy' }),
    },
    newDocument: { id: 'hanshu:new', document: createBossbar('hanshu:new') },
    demo: {
      document: demo,
      texture: demoTexture,
      canonical: stringifyBossbar(demo),
      hints: validateBossbarSemantics(demo, demoTexture),
      snapshot: estimateSnapshotBytes(demo),
      shieldProgress,
      longSceneCommands: longScene.commands.length,
    },
    textureProbe: (() => {
      const bytes = base64ToBytes(BOSSBAR_SAMPLE_TEXTURE)
      const info = bytes ? pngInfo(bytes) : null
      return { source: 'BOSSBAR_SAMPLE_TEXTURE', bytes: bytes?.length ?? 0, info }
    })(),
    textValues,
    frames,
    progress,
    nineSlice,
    barSegment: barSegments,
    truncate,
    layout,
    scenes,
    colors: ['#ED242CFF', '#231016FF', '#00000000', '#FFFFFFFF'].map((input) => ({
      input,
      argbHex: colorToArgbHex(input),
      rgba: parseColor(input),
    })),
    canonicalFieldOrder: (() => {
      const parsed = parseBossbarDocument(JSON.stringify(DEMO_EMBER_GUARD))
      if (!parsed.ok) throw new Error('演示文档应能解析')
      return Object.keys(toCanonicalDocument(parsed.document))
    })(),
    typecheck: {
      sample: 'BossbarDocument 的 components 里必须恰好一个 display_region',
      componentTypes: demo.components.map((component) => component.type),
    },
  }
}

/** 磁盘上的 schema 文件内容 */
export function bossbarSchemaFile(): string {
  return JSON.stringify(BOSSBAR_V2_SCHEMA, null, 2) + '\n'
}

/** 磁盘上的夹具文件内容 */
export function bossbarFixtureFile(): string {
  return JSON.stringify(buildBossbarFixtures(), null, 2) + '\n'
}

export type { BossbarDocument }
