import type { BossbarScene, BossbarSceneCommand } from './scene'
import { parseColor } from '../rules/color'
import { truncateToWidth } from '../rules/text'

/**
 * Canvas 2D 渲染。
 *
 * 只负责把 scene 的命令画出来：不读文档、不算布局、不加载纹理。
 * 调用方负责设置 canvas 尺寸、设备像素比与清屏。
 */

export type BossbarCanvasDrawOptions = {
  /** 唯一图集的位图；缺失时图像命令被跳过 */
  texture: CanvasImageSource | null
  measure(text: string, font: string): number
  /** 字体族；默认贴近游戏字体的无衬线栈 */
  fontFamily?: string
  debugBounds?: boolean
}

export const BOSSBAR_FONT_FAMILY =
  '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif'

export function bossbarFont(fontSize: number, family = BOSSBAR_FONT_FAMILY): string {
  return Math.max(1, fontSize) + 'px ' + family
}

function fillStyleOf(color: string, opacity: number): string {
  const rgba = parseColor(color)
  const alpha = Math.max(0, Math.min(1, (rgba.a / 255) * opacity))
  return 'rgba(' + rgba.r + ',' + rgba.g + ',' + rgba.b + ',' + alpha + ')'
}

function drawImageCommand(
  ctx: CanvasRenderingContext2D,
  command: Extract<BossbarSceneCommand, { kind: 'image' }>,
  options: BossbarCanvasDrawOptions,
) {
  const texture = options.texture
  if (!texture) {
    if (options.debugBounds) {
      ctx.save()
      ctx.strokeStyle = 'rgba(255,120,120,0.7)'
      ctx.setLineDash([4, 3])
      ctx.strokeRect(command.clip.x, command.clip.y, command.clip.width, command.clip.height)
      ctx.restore()
    }
    return
  }
  ctx.save()
  ctx.globalAlpha = command.opacity
  ctx.beginPath()
  ctx.rect(command.clip.x, command.clip.y, command.clip.width, command.clip.height)
  ctx.clip()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(
    texture,
    command.sx,
    command.sy,
    command.sw,
    command.sh,
    command.dx,
    command.dy,
    command.dw,
    command.dh,
  )
  ctx.restore()
  if (options.debugBounds) {
    ctx.save()
    ctx.strokeStyle = 'rgba(80,180,255,0.8)'
    ctx.strokeRect(command.dx + 0.5, command.dy + 0.5, command.dw - 1, command.dh - 1)
    ctx.restore()
  }
}

function drawTextCommand(
  ctx: CanvasRenderingContext2D,
  command: Extract<BossbarSceneCommand, { kind: 'text' }>,
  options: BossbarCanvasDrawOptions,
) {
  const font = bossbarFont(command.fontSize, options.fontFamily)
  const box = command.box
  const available = Math.max(0, box.width)
  const widths = command.runs.map((run) => options.measure(run.text, font))
  const total = widths.reduce((sum, width) => sum + width, 0)
  const ellipsis = '…'
  const ellipsisWidth = options.measure(ellipsis, font)

  const pieces: { text: string; color: string; width: number }[] = []
  if (total <= available) {
    command.runs.forEach((run, index) => {
      pieces.push({ text: run.text, color: run.color, width: widths[index] })
    })
  } else {
    let budget = Math.max(0, available - ellipsisWidth)
    for (const run of command.runs) {
      if (budget <= 0) break
      const width = options.measure(run.text, font)
      if (width <= budget) {
        pieces.push({ text: run.text, color: run.color, width })
        budget -= width
        continue
      }
      const clipped = truncateToWidth(run.text, budget, (value) => options.measure(value, font), '')
      if (clipped) {
        pieces.push({ text: clipped, color: run.color, width: options.measure(clipped, font) })
      }
      budget = 0
      break
    }
    if (options.measure(ellipsis, font) <= available) {
      pieces.push({ text: ellipsis, color: command.color, width: ellipsisWidth })
    }
  }

  const drawnWidth = pieces.reduce((sum, piece) => sum + piece.width, 0)
  let x = box.x
  if (command.align === 'center') x = box.x + (box.width - drawnWidth) / 2
  else if (command.align === 'right') x = box.x + box.width - drawnWidth
  const y =
    command.verticalAlign === 'top'
      ? box.y
      : command.verticalAlign === 'bottom'
        ? box.y + box.height
        : box.y + box.height / 2

  ctx.save()
  ctx.beginPath()
  ctx.rect(box.x, box.y, box.width, box.height)
  ctx.clip()
  ctx.globalAlpha = command.opacity
  ctx.font = font
  ctx.textAlign = 'left'
  ctx.textBaseline =
    command.verticalAlign === 'top' ? 'top' : command.verticalAlign === 'bottom' ? 'bottom' : 'middle'
  if (command.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.85)'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = Math.max(1, Math.round(command.fontSize / 16))
    ctx.shadowOffsetY = Math.max(1, Math.round(command.fontSize / 16))
  }
  for (const piece of pieces) {
    ctx.fillStyle = fillStyleOf(piece.color, 1)
    ctx.fillText(piece.text, x, y)
    x += piece.width
  }
  ctx.restore()
}

export function drawBossbarScene(
  ctx: CanvasRenderingContext2D,
  scene: BossbarScene,
  options: BossbarCanvasDrawOptions,
): void {
  for (const command of scene.commands) {
    if (command.kind === 'fill') {
      ctx.save()
      ctx.globalAlpha = command.opacity
      ctx.fillStyle = fillStyleOf(command.color, 1)
      ctx.fillRect(command.rect.x, command.rect.y, command.rect.width, command.rect.height)
      ctx.restore()
      continue
    }
    if (command.kind === 'image') {
      drawImageCommand(ctx, command, options)
      continue
    }
    drawTextCommand(ctx, command, options)
  }
}
