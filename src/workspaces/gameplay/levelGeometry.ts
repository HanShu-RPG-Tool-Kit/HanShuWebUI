import type { LevelArea, LevelY } from './levelDoc'

/** 全高度只用于网格。水平编辑必须把作者值 `all` 原样写回。 */
export const DISPLAY_Y_MIN = -64
export const DISPLAY_Y_MAX = 320

/** 与 AuthorDraft 的作者坐标限幅一致。持久化的是作者值，不是外表面。 */
export const COORDINATE_LIMIT = 30_000_000

/** 圆中心、多边形顶点的世界 X/Z = 作者值 + 0.5。地标不做这个偏移。 */
export const BLOCK_CENTER_OFFSET = 0.5

/** 世界外表面的最小跨度。单格作者 min==max，对应世界跨度 1。 */
export const MIN_FACE_SPAN = 1

export type SnapStep = 1 | 0.1

export type ViewCommandKind = 'focus' | 'perspective' | 'top' | 'front' | 'side'

export type LevelViewCommand = { sequence: number; kind: ViewCommandKind }

export type WorldBox = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

type Dec = { neg: boolean; int: bigint; scale: number }

function zeroDec(): Dec {
  return { neg: false, int: 0n, scale: 0 }
}

function parseDec(text: string): Dec {
  let source = text.trim()
  let neg = false
  if (source.startsWith('-')) {
    neg = true
    source = source.slice(1)
  } else if (source.startsWith('+')) {
    source = source.slice(1)
  }
  const exponentIndex = source.search(/e/i)
  let exponent = 0
  if (exponentIndex >= 0) {
    exponent = Number(source.slice(exponentIndex + 1))
    source = source.slice(0, exponentIndex)
  }
  const dot = source.indexOf('.')
  let digits = dot < 0 ? source : source.slice(0, dot) + source.slice(dot + 1)
  let scale = dot < 0 ? 0 : source.length - dot - 1
  scale -= exponent
  if (scale < 0) {
    digits += '0'.repeat(-scale)
    scale = 0
  }
  digits = digits.replace(/^0+(?=\d)/, '')
  if (!digits || digits === '0' || !Number.isFinite(exponent)) return zeroDec()
  return { neg, int: BigInt(digits), scale }
}

function decFromNumber(value: number): Dec | null {
  if (!Number.isFinite(value)) return null
  if (value === 0) return zeroDec()
  return parseDec(value.toString())
}

function signed(value: Dec): bigint {
  return value.neg ? -value.int : value.int
}

function fromSigned(int: bigint, scale: number): Dec {
  if (int < 0n) return { neg: true, int: -int, scale }
  if (int === 0n) return zeroDec()
  return { neg: false, int, scale }
}

function decToNumber(value: Dec): number {
  if (value.int === 0n) return 0
  const digits = value.int.toString()
  const text = value.scale === 0
    ? digits
    : digits.length <= value.scale
      ? `0.${digits.padStart(value.scale, '0')}`
      : `${digits.slice(0, digits.length - value.scale)}.${digits.slice(digits.length - value.scale)}`
  const number = Number(value.neg ? `-${text}` : text)
  return Object.is(number, -0) ? 0 : number
}

function decSub(left: Dec, right: Dec): Dec {
  const scale = Math.max(left.scale, right.scale)
  const a = signed(left) * 10n ** BigInt(scale - left.scale)
  const b = signed(right) * 10n ** BigInt(scale - right.scale)
  return fromSigned(a - b, scale)
}

function decAdd(left: Dec, right: Dec): Dec {
  const scale = Math.max(left.scale, right.scale)
  const a = signed(left) * 10n ** BigInt(scale - left.scale)
  const b = signed(right) * 10n ** BigInt(scale - right.scale)
  return fromSigned(a + b, scale)
}

function decMul(left: Dec, right: Dec): Dec {
  return fromSigned(signed(left) * signed(right), left.scale + right.scale)
}

/** BigDecimal.divide(scale 0, HALF_UP)：对 5 远离 0。-1.5 → -2。 */
function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n)
  const left = numerator < 0n ? -numerator : numerator
  const right = denominator < 0n ? -denominator : denominator
  const quotient = left / right
  const remainder = left % right
  const rounded = remainder * 2n >= right ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

function decDivHalfUp(left: Dec, right: Dec): Dec | null {
  if (right.int === 0n) return null
  const numerator = signed(left) * 10n ** BigInt(right.scale)
  const denominator = signed(right) * 10n ** BigInt(left.scale)
  return fromSigned(divHalfUp(numerator, denominator), 0)
}

/** 作者偏移和逆变换走十进制，避免 0.1+0.2、1.1-1 变成二进制噪声后进入历史。 */
export function decimalAdd(left: number, right: number): number {
  const a = decFromNumber(left)
  const b = decFromNumber(right)
  if (!a || !b) return left + right
  return decToNumber(decAdd(a, b))
}

export function decimalSub(left: number, right: number): number {
  const a = decFromNumber(left)
  const b = decFromNumber(right)
  if (!a || !b) return left - right
  return decToNumber(decSub(a, b))
}

export function withinCoordinateLimit(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT
}

/**
 * 相对原点的步进。raw === origin 时结果就是 origin，小数原样留下。
 * 非有限值返回 origin。
 */
export function snapFromOrigin(origin: number, raw: number, step: SnapStep = 1): number {
  if (!Number.isFinite(origin)) return origin
  if (!Number.isFinite(raw)) return origin
  if (raw === origin) return origin
  const originDec = decFromNumber(origin)
  const rawDec = decFromNumber(raw)
  const stepDec = decFromNumber(step)
  if (!originDec || !rawDec || !stepDec) return origin
  const steps = decDivHalfUp(decSub(rawDec, originDec), stepDec)
  if (!steps || steps.int === 0n) return origin
  return decToNumber(decAdd(originDec, decMul(steps, stepDec)))
}

/**
 * 步长 1 用 floor（向 -∞），与 AuthorDraft.snapAbsolute 的 Math.floor 一致。
 * 步长 0.1 从 0 做 HALF_UP。
 */
export function snapAbsolute(world: number, step: SnapStep = 1): number {
  if (!Number.isFinite(world)) return world
  if (step === 0.1) return snapFromOrigin(0, world, 0.1)
  const floored = Math.floor(world)
  return Object.is(floored, -0) ? 0 : floored
}

export function authorPair(pair: readonly [number, number]): [number, number] {
  return pair[0] <= pair[1] ? [pair[0], pair[1]] : [pair[1], pair[0]]
}

export function worldYSpan(y: LevelY, display: readonly [number, number] = [DISPLAY_Y_MIN, DISPLAY_Y_MAX]): [number, number] {
  if (y === 'all') return [display[0], display[1]]
  const [minY, maxY] = authorPair(y)
  return [minY, decimalAdd(maxY, 1)]
}

/** 矩形外表面。有限高度是 [minY, maxY+1]；all 只用显示带，不代表作者值。 */
export function rectWorldBox(
  x: readonly [number, number],
  z: readonly [number, number],
  y: LevelY,
  display: readonly [number, number] = [DISPLAY_Y_MIN, DISPLAY_Y_MAX],
): WorldBox {
  const [minX, maxX] = authorPair(x)
  const [minZ, maxZ] = authorPair(z)
  const [minY, maxY] = worldYSpan(y, display)
  return { minX, maxX: decimalAdd(maxX, 1), minY, maxY, minZ, maxZ: decimalAdd(maxZ, 1) }
}

export function circleWorldCenter(authorX: number, authorZ: number): [number, number] {
  return [decimalAdd(authorX, BLOCK_CENTER_OFFSET), decimalAdd(authorZ, BLOCK_CENTER_OFFSET)]
}

export function polygonWorldPoint(authorX: number, authorZ: number): [number, number] {
  return [decimalAdd(authorX, BLOCK_CENTER_OFFSET), decimalAdd(authorZ, BLOCK_CENTER_OFFSET)]
}

/**
 * 世界外表面拖成作者矩形。跨度不足 1 时把 max 延到 min+1，再减 1，
 * 所以点在 10,10 得到作者 [10,10]，而不是把相等边再加 1。
 */
export function authorRectFromWorldFaces(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  step: SnapStep = 1,
): { x: [number, number]; z: [number, number] } | null {
  let minX = Math.min(snapAbsolute(ax, step), snapAbsolute(bx, step))
  let maxX = Math.max(snapAbsolute(ax, step), snapAbsolute(bx, step))
  let minZ = Math.min(snapAbsolute(az, step), snapAbsolute(bz, step))
  let maxZ = Math.max(snapAbsolute(az, step), snapAbsolute(bz, step))
  if (decimalSub(maxX, minX) < MIN_FACE_SPAN) maxX = decimalAdd(minX, MIN_FACE_SPAN)
  if (decimalSub(maxZ, minZ) < MIN_FACE_SPAN) maxZ = decimalAdd(minZ, MIN_FACE_SPAN)
  const authorMaxX = decimalSub(maxX, 1)
  const authorMaxZ = decimalSub(maxZ, 1)
  if (![minX, authorMaxX, minZ, authorMaxZ].every(withinCoordinateLimit)) return null
  return { x: [minX, authorMaxX], z: [minZ, authorMaxZ] }
}

export function authorCircleFromWorld(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  step: SnapStep = 1,
): { center: [number, number]; radius: number } | null {
  const centerX = snapAbsolute(decimalSub(x0, BLOCK_CENTER_OFFSET), step)
  const centerZ = snapAbsolute(decimalSub(z0, BLOCK_CENTER_OFFSET), step)
  let radius = snapAbsolute(Math.hypot(x1 - x0, z1 - z0), step)
  if (!(radius > 0)) radius = step
  if (![centerX, centerZ, radius].every(withinCoordinateLimit)) return null
  return { center: [centerX, centerZ], radius }
}

export function authorPointFromWorld(x: number, z: number, step: SnapStep = 1): [number, number] | null {
  const authorX = snapAbsolute(decimalSub(x, BLOCK_CENTER_OFFSET), step)
  const authorZ = snapAbsolute(decimalSub(z, BLOCK_CENTER_OFFSET), step)
  if (!withinCoordinateLimit(authorX) || !withinCoordinateLimit(authorZ)) return null
  return [authorX, authorZ]
}

/**
 * 手柄命中偏移。current === grab 时直接返回 anchor，哪怕 grab 不在 anchor 上，
 * 这样零位移点击不会改小数，也不会进历史。
 */
export function anchoredPoint(anchor: number, grab: number, current: number, step: SnapStep = 1): number {
  if (current === grab) return anchor
  return snapFromOrigin(anchor, decimalAdd(anchor, decimalSub(current, grab)), step)
}

/** 整体平移的增量从 0 吸附，原有小数加上同一个增量。 */
export function translateDelta(grab: number, current: number, step: SnapStep = 1): number {
  if (current === grab) return 0
  return snapFromOrigin(0, decimalSub(current, grab), step)
}

/**
 * 拖一根世界外表面。movingMax 时返回作者 max（表面 - 1），否则返回作者 min。
 * 跨度保持 ≥ 1，反向拖夹住，不交换两端。越界返回 null。
 */
export function moveAuthoredFace(
  originFace: number,
  rawFace: number,
  otherFace: number,
  movingMax: boolean,
  step: SnapStep = 1,
): number | null {
  const snapped = snapFromOrigin(originFace, rawFace, step)
  if (movingMax) {
    const face = Math.max(snapped, decimalAdd(otherFace, MIN_FACE_SPAN))
    const author = decimalSub(face, 1)
    return withinCoordinateLimit(author) ? author : null
  }
  const face = Math.min(snapped, decimalSub(otherFace, MIN_FACE_SPAN))
  return withinCoordinateLimit(face) ? face : null
}

export function areaWithinLimit(area: LevelArea): boolean {
  const numbers: number[] = []
  if (area.y !== 'all') numbers.push(area.y[0], area.y[1])
  if (area.kind === 'rect') numbers.push(area.x[0], area.x[1], area.z[0], area.z[1])
  else if (area.kind === 'circle') numbers.push(area.center[0], area.center[1], area.radius)
  else for (const [x, z] of area.points) numbers.push(x, z)
  return numbers.every(withinCoordinateLimit)
}
