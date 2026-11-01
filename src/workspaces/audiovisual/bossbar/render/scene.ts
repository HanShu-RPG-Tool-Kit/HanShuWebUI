import {
  isPaintable,
  type BossbarDiagnostic,
  type BossbarDocument,
  type BossbarPaint,
  type BossbarTextComponent,
  type BossbarValueMap,
} from '../protocol'
import { bossbarDiagnostic } from '../protocol'
import { parseColor } from '../rules/color'
import { formatRunValue } from '../rules/formatRun'
import { resolveProgress } from '../rules/range'
import { sampleAnimation } from '../rules/frames'
import { barSegment, fitSprite, intersectRect, nineSliceSprites, type Rect } from '../rules/layout'
import { singleLine } from '../rules/text'

/**
 * 场景构建：把「文档 + 类型化变量值 + 时间」变成一串纯几何绘制命令。
 *
 * 这一层不碰 DOM、不碰纹理，因此可以脱离浏览器比较布局与裁切命令（协议夹具拿它当期望值）。
 * 文字只算位置与内容；字宽、基线、截断留给渲染器用真实字体处理。
 * 图像命令只给**图集内的源矩形**，因为整份文档只有一张 PNG。
 */

export type BossbarSceneFill = { kind: 'fill'; rect: Rect; color: string; opacity: number }

export type BossbarSceneImage = {
  kind: 'image'
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
  opacity: number
  clip: Rect
}

export type BossbarSceneTextRun = { text: string; color: string }

export type BossbarSceneText = {
  kind: 'text'
  componentId: string
  box: Rect
  opacity: number
  text: string
  runs: BossbarSceneTextRun[]
  color: string
  fontSize: number
  align: BossbarTextComponent['align']
  verticalAlign: BossbarTextComponent['verticalAlign']
  shadow: boolean
}

export type BossbarSceneCommand = BossbarSceneFill | BossbarSceneImage | BossbarSceneText

export type BossbarTextureSize = { width: number; height: number }

export type BossbarBarView = { value: number; trail: number }

export type BossbarSceneInput = {
  document: BossbarDocument
  values: BossbarValueMap
  /** 实例时间（毫秒）；动画相位在 sampleAnimation 内部加 */
  timeMs: number
  texture: BossbarTextureSize
  /** 平滑与尾条之后的条比例；缺省用真实比例 */
  bars?: Record<string, BossbarBarView>
  /** 设计像素 → 输出像素 */
  scale?: number
  /** 设计坐标 × scale + origin = 输出坐标 */
  origin?: { x: number; y: number }
}

export type BossbarScene = {
  commands: BossbarSceneCommand[]
  issues: BossbarDiagnostic[]
  texture: BossbarTextureSize
}

function scaledRect(rect: Rect, scale: number, origin: { x: number; y: number }): Rect {
  return {
    x: origin.x + rect.x * scale,
    y: origin.y + rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  }
}

export function buildScene(input: BossbarSceneInput): BossbarScene {
  const { document, values, timeMs, texture } = input
  const scale = input.scale ?? 1
  const origin = input.origin ?? { x: 0, y: 0 }
  const commands: BossbarSceneCommand[] = []
  const issues: BossbarDiagnostic[] = []

  const emitPaint = (
    paint: BossbarPaint | undefined,
    box: Rect,
    clip: Rect,
    opacity: number,
    path: string,
  ) => {
    if (!paint) return
    if (paint.kind === 'solid') {
      const visible = intersectRect(box, clip)
      if (!visible) return
      const alpha = (parseColor(paint.color).a / 255) * opacity
      if (alpha <= 0) return
      commands.push({ kind: 'fill', rect: scaledRect(visible, scale, origin), color: paint.color, opacity })
      return
    }
    const frame = sampleAnimation(paint.animation, paint.uv, timeMs)
    const uv = frame.uv
    if (
      uv.x < 0 || uv.y < 0 || uv.width <= 0 || uv.height <= 0 ||
      uv.x + uv.width > texture.width || uv.y + uv.height > texture.height
    ) {
      issues.push(bossbarDiagnostic('uv_out_of_bounds', path, 'UV 超出图集', 'warning'))
      return
    }
    const push = (piece: {
      sx: number
      sy: number
      sw: number
      sh: number
      dx: number
      dy: number
      dw: number
      dh: number
    }) => {
      const target: Rect = { x: piece.dx, y: piece.dy, width: piece.dw, height: piece.dh }
      const visible = intersectRect(target, clip)
      if (!visible) return
      const destination = scaledRect(target, scale, origin)
      commands.push({
        kind: 'image',
        sx: uv.x + piece.sx,
        sy: uv.y + piece.sy,
        sw: piece.sw,
        sh: piece.sh,
        dx: destination.x,
        dy: destination.y,
        dw: destination.width,
        dh: destination.height,
        opacity,
        clip: scaledRect(visible, scale, origin),
      })
    }
    if (paint.fit === 'nine-slice') {
      for (const piece of nineSliceSprites(
        { width: uv.width, height: uv.height },
        box,
        paint.insets ?? [8, 8, 8, 8],
      )) {
        push(piece)
      }
      return
    }
    const sprite = fitSprite({ width: uv.width, height: uv.height }, box, paint.fit)
    if (!sprite) return
    push(sprite)
  }

  document.components.forEach((component, index) => {
    if (!isPaintable(component)) return
    const base = 'components[' + index + ']'
    if (component.visible === false) return
    if (typeof component.visible === 'object' && values[component.visible.var]?.value !== true) return
    const opacity = Math.max(0, Math.min(1, component.opacity ?? 1))
    if (opacity <= 0) return
    const box: Rect = {
      x: component.box.x,
      y: component.box.y,
      width: component.box.width,
      height: component.box.height,
    }

    if (component.type === 'background') {
      emitPaint(component.paint, box, box, opacity, base + '.paint')
      return
    }

    if (component.type === 'bar') {
      const progress = resolveProgress(component.progress, document.variables, values)
      const view = input.bars?.[component.id]
      const fillRatio = view ? view.value : progress
      const trailRatio = view ? view.trail : progress
      if (component.trail && trailRatio > fillRatio) {
        const segment = barSegment(box, fillRatio, trailRatio, component.direction)
        if (segment) {
          emitPaint(component.trail.paint, box, intersectRect(box, segment) ?? segment, opacity, base + '.trail.paint')
        }
      }
      const segment = barSegment(box, 0, fillRatio, component.direction)
      if (segment) {
        emitPaint(component.fill, box, intersectRect(box, segment) ?? segment, opacity, base + '.fill')
      }
      return
    }

    const runs: BossbarSceneTextRun[] = []
    component.runs.forEach((run, runIndex) => {
      if ('text' in run) {
        runs.push({ text: singleLine(run.text), color: run.color ?? component.color })
        return
      }
      if ('var' in run) {
        const text = formatRunValue(values[run.var])
        if (text === null) {
          issues.push(
            bossbarDiagnostic('run_value', base + '.runs[' + runIndex + ']', '缺少有效变量 ' + run.var, 'warning'),
          )
          return
        }
        runs.push({ text, color: run.color ?? component.color })
        return
      }
    })

    commands.push({
      kind: 'text',
      componentId: component.id,
      box: scaledRect(box, scale, origin),
      opacity,
      text: runs.map((run) => run.text).join(''),
      runs,
      color: component.color,
      fontSize: component.fontSize * scale,
      align: component.align,
      verticalAlign: component.verticalAlign,
      shadow: component.shadow,
    })
  })

  return { commands, issues, texture }
}
