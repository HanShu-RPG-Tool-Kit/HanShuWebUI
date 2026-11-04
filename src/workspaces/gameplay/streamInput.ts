import { httpBase } from '../../gameDevServer/protocol'
import { DEFAULT_STREAM_SETTINGS, streamStartBody } from './streamSettings'

/** RPSF。format=3 是交互 JPEG，不经过实体预览 format=2。 */
export const RPSF_MAGIC = 0x52505346
export const RPSF_HEADER_SIZE = 32
export const INTERACTIVE_JPEG_FORMAT = 3
export const INTERACTIVE_FRAME_MAX_BYTES = 2 * 1024 * 1024

export const RPIN_MAGIC = 0x4E495052
export const RPIN_VERSION = 1
export const RPIN_MAX_EVENTS = 256
export const RPIN_KEY_DOWN = 1
export const RPIN_KEY_UP = 2
export const RPIN_CHAR = 3
export const RPIN_BUTTON_DOWN = 4
export const RPIN_BUTTON_UP = 5
export const RPIN_WHEEL = 6
export const RPIN_MOVE = 7

export const GLFW_MOD_SHIFT = 0x0001
export const GLFW_MOD_CONTROL = 0x0002
export const GLFW_MOD_ALT = 0x0004
export const GLFW_MOD_SUPER = 0x0008
export const GLFW_MOD_CAPS_LOCK = 0x0010
export const GLFW_MOD_NUM_LOCK = 0x0020

export const INTERACTIVE_STREAM_BODY = streamStartBody(DEFAULT_STREAM_SETTINGS)

type RpinHead = { flags: number; mods: number; seq: number }

export type RpinEvent =
  | (RpinHead & { type: typeof RPIN_KEY_DOWN | typeof RPIN_KEY_UP; key: number; scancode: number })
  | (RpinHead & { type: typeof RPIN_CHAR; codepoint: number })
  | (RpinHead & { type: typeof RPIN_BUTTON_DOWN | typeof RPIN_BUTTON_UP; button: number; x: number; y: number })
  | (RpinHead & { type: typeof RPIN_WHEEL; dxCenti: number; dyCenti: number })
  | (RpinHead & { type: typeof RPIN_MOVE; x: number; y: number; dx: number; dy: number })

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type RpinDraft = DistributiveOmit<RpinEvent, 'seq'>

export type InteractiveJpegFrame = {
  width: number
  height: number
  frameId: number
  payload: Uint8Array
}

export type Letterbox = { x: number; y: number; width: number; height: number }

type KeyMapping = { key: number; scancode: number }

const KEYS: Record<string, KeyMapping> = {
  Space: { key: 32, scancode: 0x39 },
  Quote: { key: 39, scancode: 0x28 },
  Comma: { key: 44, scancode: 0x33 },
  Minus: { key: 45, scancode: 0x0c },
  Period: { key: 46, scancode: 0x34 },
  Slash: { key: 47, scancode: 0x35 },
  Digit0: { key: 48, scancode: 0x0b },
  Digit1: { key: 49, scancode: 0x02 },
  Digit2: { key: 50, scancode: 0x03 },
  Digit3: { key: 51, scancode: 0x04 },
  Digit4: { key: 52, scancode: 0x05 },
  Digit5: { key: 53, scancode: 0x06 },
  Digit6: { key: 54, scancode: 0x07 },
  Digit7: { key: 55, scancode: 0x08 },
  Digit8: { key: 56, scancode: 0x09 },
  Digit9: { key: 57, scancode: 0x0a },
  Semicolon: { key: 59, scancode: 0x27 },
  Equal: { key: 61, scancode: 0x0d },
  KeyA: { key: 65, scancode: 0x1e },
  KeyB: { key: 66, scancode: 0x30 },
  KeyC: { key: 67, scancode: 0x2e },
  KeyD: { key: 68, scancode: 0x20 },
  KeyE: { key: 69, scancode: 0x12 },
  KeyF: { key: 70, scancode: 0x21 },
  KeyG: { key: 71, scancode: 0x22 },
  KeyH: { key: 72, scancode: 0x23 },
  KeyI: { key: 73, scancode: 0x17 },
  KeyJ: { key: 74, scancode: 0x24 },
  KeyK: { key: 75, scancode: 0x25 },
  KeyL: { key: 76, scancode: 0x26 },
  KeyM: { key: 77, scancode: 0x32 },
  KeyN: { key: 78, scancode: 0x31 },
  KeyO: { key: 79, scancode: 0x18 },
  KeyP: { key: 80, scancode: 0x19 },
  KeyQ: { key: 81, scancode: 0x10 },
  KeyR: { key: 82, scancode: 0x13 },
  KeyS: { key: 83, scancode: 0x1f },
  KeyT: { key: 84, scancode: 0x14 },
  KeyU: { key: 85, scancode: 0x16 },
  KeyV: { key: 86, scancode: 0x2f },
  KeyW: { key: 87, scancode: 0x11 },
  KeyX: { key: 88, scancode: 0x2d },
  KeyY: { key: 89, scancode: 0x15 },
  KeyZ: { key: 90, scancode: 0x2c },
  BracketLeft: { key: 91, scancode: 0x1a },
  Backslash: { key: 92, scancode: 0x2b },
  BracketRight: { key: 93, scancode: 0x1b },
  Backquote: { key: 96, scancode: 0x29 },
  Escape: { key: 256, scancode: 0x01 },
  Enter: { key: 257, scancode: 0x1c },
  Tab: { key: 258, scancode: 0x0f },
  Backspace: { key: 259, scancode: 0x0e },
  Insert: { key: 260, scancode: 0x0152 },
  Delete: { key: 261, scancode: 0x0153 },
  ArrowRight: { key: 262, scancode: 0x014d },
  ArrowLeft: { key: 263, scancode: 0x014b },
  ArrowDown: { key: 264, scancode: 0x0150 },
  ArrowUp: { key: 265, scancode: 0x0148 },
  PageUp: { key: 266, scancode: 0x0149 },
  PageDown: { key: 267, scancode: 0x0151 },
  Home: { key: 268, scancode: 0x0147 },
  End: { key: 269, scancode: 0x014f },
  CapsLock: { key: 280, scancode: 0x3a },
  ScrollLock: { key: 281, scancode: 0x46 },
  NumLock: { key: 282, scancode: 0x45 },
  PrintScreen: { key: 283, scancode: 0x0137 },
  Pause: { key: 284, scancode: 0x45 },
  F1: { key: 290, scancode: 0x3b },
  F2: { key: 291, scancode: 0x3c },
  F3: { key: 292, scancode: 0x3d },
  F4: { key: 293, scancode: 0x3e },
  F5: { key: 294, scancode: 0x3f },
  F6: { key: 295, scancode: 0x40 },
  F7: { key: 296, scancode: 0x41 },
  F8: { key: 297, scancode: 0x42 },
  F9: { key: 298, scancode: 0x43 },
  F10: { key: 299, scancode: 0x44 },
  F11: { key: 300, scancode: 0x57 },
  F12: { key: 301, scancode: 0x58 },
  Numpad0: { key: 320, scancode: 0x52 },
  Numpad1: { key: 321, scancode: 0x4f },
  Numpad2: { key: 322, scancode: 0x50 },
  Numpad3: { key: 323, scancode: 0x51 },
  Numpad4: { key: 324, scancode: 0x4b },
  Numpad5: { key: 325, scancode: 0x4c },
  Numpad6: { key: 326, scancode: 0x4d },
  Numpad7: { key: 327, scancode: 0x47 },
  Numpad8: { key: 328, scancode: 0x48 },
  Numpad9: { key: 329, scancode: 0x49 },
  NumpadDecimal: { key: 330, scancode: 0x53 },
  NumpadDivide: { key: 331, scancode: 0x0135 },
  NumpadMultiply: { key: 332, scancode: 0x37 },
  NumpadSubtract: { key: 333, scancode: 0x4a },
  NumpadAdd: { key: 334, scancode: 0x4e },
  NumpadEnter: { key: 335, scancode: 0x011c },
  NumpadEqual: { key: 336, scancode: 0x59 },
  ShiftLeft: { key: 340, scancode: 0x2a },
  ControlLeft: { key: 341, scancode: 0x1d },
  AltLeft: { key: 342, scancode: 0x38 },
  MetaLeft: { key: 343, scancode: 0x015b },
  ShiftRight: { key: 344, scancode: 0x36 },
  ControlRight: { key: 345, scancode: 0x011d },
  AltRight: { key: 346, scancode: 0x0138 },
  MetaRight: { key: 347, scancode: 0x015c },
  ContextMenu: { key: 348, scancode: 0x015d },
}

export function glfwKeyFromCode(code: string): KeyMapping | null {
  const extendedFunction = /^F(1[3-9]|2[0-5])$/.exec(code)
  if (extendedFunction) return { key: 289 + Number(extendedFunction[1]), scancode: 0 }
  return KEYS[code] ?? null
}

/** 浏览器 button：0 左、1 中、2 右。GLFW：0 左、1 右、2 中。 */
export function glfwMouseButton(button: number): number {
  if (button === 2) return 1
  if (button === 1) return 2
  return button
}

export function glfwMods(source: {
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  capsLock?: boolean
  numLock?: boolean
}): number {
  let mods = 0
  if (source.shiftKey) mods |= GLFW_MOD_SHIFT
  if (source.ctrlKey) mods |= GLFW_MOD_CONTROL
  if (source.altKey) mods |= GLFW_MOD_ALT
  if (source.metaKey) mods |= GLFW_MOD_SUPER
  if (source.capsLock) mods |= GLFW_MOD_CAPS_LOCK
  if (source.numLock) mods |= GLFW_MOD_NUM_LOCK
  return mods
}

export function isFormFieldTarget(target: { closest?: (selector: string) => unknown } | null): boolean {
  return !!target?.closest?.('input, textarea, select')
}

export function charCodepoint(key: string, composing: boolean, mods: number): number | null {
  if (composing) return null
  if (mods & (GLFW_MOD_CONTROL | GLFW_MOD_ALT | GLFW_MOD_SUPER)) return null
  if ([...key].length !== 1) return null
  const point = key.codePointAt(0)
  if (point === undefined || point < 32 || point === 127) return null
  return point
}

export function clampI16(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-32768, Math.min(32767, Math.round(value)))
}

/** DOM_DELTA_PIXEL 约 100 像素一格；行/页模式按一格 = 100。 */
export function wheelCenti(delta: number, deltaMode: number): number {
  if (!Number.isFinite(delta)) return 0
  if (deltaMode === 1 || deltaMode === 2) return clampI16(delta * 100)
  return clampI16(delta)
}

export function pictureLetterbox(viewWidth: number, viewHeight: number, frameWidth: number, frameHeight: number): Letterbox {
  if (viewWidth <= 0 || viewHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(viewWidth, 0), height: Math.max(viewHeight, 0) }
  }
  const viewAspect = viewWidth / viewHeight
  const frameAspect = frameWidth / frameHeight
  if (viewAspect > frameAspect) {
    const width = viewHeight * frameAspect
    return { x: (viewWidth - width) / 2, y: 0, width, height: viewHeight }
  }
  const height = viewWidth / frameAspect
  return { x: 0, y: (viewHeight - height) / 2, width: viewWidth, height }
}

/**
 * CSS 像素先落到 letterbox 里的 UV，再乘窗口屏幕像素。
 * 不用 JPEG 帧缓冲尺寸，也不直接送 CSS 像素。
 */
export function letterboxToScreen(
  localX: number,
  localY: number,
  viewWidth: number,
  viewHeight: number,
  frameWidth: number,
  frameHeight: number,
  screenWidth: number,
  screenHeight: number,
): { x: number; y: number } {
  const box = pictureLetterbox(viewWidth, viewHeight, frameWidth, frameHeight)
  const u = box.width > 0 ? (localX - box.x) / box.width : 0
  const v = box.height > 0 ? (localY - box.y) / box.height : 0
  const clampedU = Math.min(1, Math.max(0, u))
  const clampedV = Math.min(1, Math.max(0, v))
  return {
    x: Math.round(clampedU * screenWidth),
    y: Math.round(clampedV * screenHeight),
  }
}

export function letterboxDelta(
  cssDx: number,
  cssDy: number,
  viewWidth: number,
  viewHeight: number,
  frameWidth: number,
  frameHeight: number,
  screenWidth: number,
  screenHeight: number,
): { dx: number; dy: number } {
  const box = pictureLetterbox(viewWidth, viewHeight, frameWidth, frameHeight)
  return {
    dx: box.width > 0 ? Math.round(cssDx / box.width * screenWidth) : 0,
    dy: box.height > 0 ? Math.round(cssDy / box.height * screenHeight) : 0,
  }
}

export type StreamPointerAim = { x: number; y: number }

/**
 * 锁指针之后 clientX 停在锁定点，位置只能累加 movement。
 * 绝对坐标夹在画面里，供界面光标和选区；dx/dy 保留整段位移，供抓鼠标后的转向。
 */
export function confineStreamPointer(
  aim: StreamPointerAim | null,
  sample: { localX: number; localY: number; cssDx: number; cssDy: number; locked: boolean },
  viewWidth: number,
  viewHeight: number,
  frameWidth: number,
  frameHeight: number,
  screenWidth: number,
  screenHeight: number,
): { aim: StreamPointerAim; point: { x: number; y: number }; delta: { dx: number; dy: number } } | null {
  if (viewWidth <= 0 || viewHeight <= 0 || frameWidth <= 0 || frameHeight <= 0 || screenWidth <= 0 || screenHeight <= 0) return null
  const box = pictureLetterbox(viewWidth, viewHeight, frameWidth, frameHeight)
  const origin = sample.locked
    ? aim ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    : { x: sample.localX, y: sample.localY }
  const rawX = sample.locked ? origin.x + sample.cssDx : origin.x
  const rawY = sample.locked ? origin.y + sample.cssDy : origin.y
  const next = {
    x: Math.min(box.x + box.width, Math.max(box.x, rawX)),
    y: Math.min(box.y + box.height, Math.max(box.y, rawY)),
  }
  return {
    aim: next,
    point: letterboxToScreen(next.x, next.y, viewWidth, viewHeight, frameWidth, frameHeight, screenWidth, screenHeight),
    delta: letterboxDelta(sample.cssDx, sample.cssDy, viewWidth, viewHeight, frameWidth, frameHeight, screenWidth, screenHeight),
  }
}

export function coalesceRpin(events: readonly RpinEvent[], next: RpinEvent): RpinEvent[] {
  if (next.type === RPIN_MOVE) {
    const last = events.at(-1)
    if (last?.type === RPIN_MOVE) {
      return [...events.slice(0, -1), {
        type: RPIN_MOVE,
        flags: next.flags,
        mods: next.mods,
        seq: next.seq,
        x: next.x,
        y: next.y,
        dx: last.dx + next.dx,
        dy: last.dy + next.dy,
      }]
    }
  }
  return [...events, next]
}

export class StreamInputBatch {
  private events: RpinEvent[] = []
  private nextSeq = 1

  get pending(): readonly RpinEvent[] {
    return this.events
  }

  push(draft: RpinDraft): void {
    const seq = this.nextSeq
    this.nextSeq += 1
    this.events = coalesceRpin(this.events, { ...draft, seq } as RpinEvent)
  }

  take(): ArrayBuffer | null {
    if (!this.events.length) return null
    const encoded = encodeRpin(this.events.slice(0, RPIN_MAX_EVENTS))
    this.events = this.events.slice(RPIN_MAX_EVENTS)
    return encoded
  }
}

function payloadBytes(type: number): number {
  if (type === RPIN_BUTTON_DOWN || type === RPIN_BUTTON_UP) return 9
  if (type === RPIN_MOVE) return 16
  if (type === RPIN_KEY_DOWN || type === RPIN_KEY_UP || type === RPIN_CHAR || type === RPIN_WHEEL) return 4
  throw new Error(`未知输入类型 ${type}`)
}

export function encodeRpin(events: readonly RpinEvent[]): ArrayBuffer {
  if (events.length > RPIN_MAX_EVENTS) throw new Error('输入批次过长')
  let size = 8
  for (const event of events) size += 8 + payloadBytes(event.type)
  const buffer = new ArrayBuffer(size)
  const view = new DataView(buffer)
  view.setUint32(0, RPIN_MAGIC, true)
  view.setUint16(4, RPIN_VERSION, true)
  view.setUint16(6, events.length, true)
  let offset = 8
  for (const event of events) {
    view.setUint8(offset, event.type)
    view.setUint8(offset + 1, event.flags & 0xff)
    view.setUint16(offset + 2, event.mods, true)
    view.setUint32(offset + 4, event.seq >>> 0, true)
    offset += 8
    if (event.type === RPIN_KEY_DOWN || event.type === RPIN_KEY_UP) {
      view.setUint16(offset, event.key, true)
      view.setUint16(offset + 2, event.scancode, true)
      offset += 4
    } else if (event.type === RPIN_CHAR) {
      view.setUint32(offset, event.codepoint >>> 0, true)
      offset += 4
    } else if (event.type === RPIN_BUTTON_DOWN || event.type === RPIN_BUTTON_UP) {
      view.setUint8(offset, event.button & 0xff)
      view.setInt32(offset + 1, event.x | 0, true)
      view.setInt32(offset + 5, event.y | 0, true)
      offset += 9
    } else if (event.type === RPIN_WHEEL) {
      view.setInt16(offset, clampI16(event.dxCenti), true)
      view.setInt16(offset + 2, clampI16(event.dyCenti), true)
      offset += 4
    } else if (event.type === RPIN_MOVE) {
      view.setInt32(offset, event.x | 0, true)
      view.setInt32(offset + 4, event.y | 0, true)
      view.setInt32(offset + 8, event.dx | 0, true)
      view.setInt32(offset + 12, event.dy | 0, true)
      offset += 16
    }
  }
  return buffer
}

export function decodeRpin(buffer: ArrayBuffer): RpinEvent[] {
  const view = new DataView(buffer)
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== RPIN_MAGIC || view.getUint16(4, true) !== RPIN_VERSION) {
    throw new Error('输入批次头无效')
  }
  const count = view.getUint16(6, true)
  const events: RpinEvent[] = []
  let offset = 8
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > buffer.byteLength) throw new Error('输入事件被截断')
    const type = view.getUint8(offset)
    const flags = view.getUint8(offset + 1)
    const mods = view.getUint16(offset + 2, true)
    const seq = view.getUint32(offset + 4, true)
    offset += 8
    const head = { flags, mods, seq }
    if (type === RPIN_KEY_DOWN || type === RPIN_KEY_UP) {
      events.push({ ...head, type, key: view.getUint16(offset, true), scancode: view.getUint16(offset + 2, true) })
      offset += 4
    } else if (type === RPIN_CHAR) {
      events.push({ ...head, type, codepoint: view.getUint32(offset, true) })
      offset += 4
    } else if (type === RPIN_BUTTON_DOWN || type === RPIN_BUTTON_UP) {
      events.push({
        ...head,
        type,
        button: view.getUint8(offset),
        x: view.getInt32(offset + 1, true),
        y: view.getInt32(offset + 5, true),
      })
      offset += 9
    } else if (type === RPIN_WHEEL) {
      events.push({ ...head, type, dxCenti: view.getInt16(offset, true), dyCenti: view.getInt16(offset + 2, true) })
      offset += 4
    } else if (type === RPIN_MOVE) {
      events.push({
        ...head,
        type,
        x: view.getInt32(offset, true),
        y: view.getInt32(offset + 4, true),
        dx: view.getInt32(offset + 8, true),
        dy: view.getInt32(offset + 12, true),
      })
      offset += 16
    } else {
      throw new Error(`未知输入类型 ${type}`)
    }
  }
  if (offset !== buffer.byteLength || events.length !== count) throw new Error('输入批次长度不符')
  return events
}

export function readInteractiveJpegFrame(buffer: ArrayBuffer): InteractiveJpegFrame {
  if (buffer.byteLength < RPSF_HEADER_SIZE || buffer.byteLength > RPSF_HEADER_SIZE + INTERACTIVE_FRAME_MAX_BYTES) {
    throw new Error('交互帧尺寸无效')
  }
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== RPSF_MAGIC || view.getUint16(4, true) !== RPSF_HEADER_SIZE) {
    throw new Error('交互帧头无效')
  }
  if (view.getUint16(6, true) !== INTERACTIVE_JPEG_FORMAT) throw new Error('交互帧格式无效')
  const width = view.getUint32(8, true)
  const height = view.getUint32(12, true)
  const stride = view.getUint32(16, true)
  const frameId = view.getUint32(20, true)
  if (!width || !height || width > 7680 || height > 7680 || stride !== 0 || buffer.byteLength <= RPSF_HEADER_SIZE) {
    throw new Error('交互压缩帧无效')
  }
  return { width, height, frameId, payload: new Uint8Array(buffer.slice(RPSF_HEADER_SIZE)) }
}

export function readStreamScreen(body: unknown): { screenWidth: number; screenHeight: number } {
  if (!body || typeof body !== 'object') throw new Error('状态无效')
  const record = body as Record<string, unknown>
  const screenWidth = record.screenWidth
  const screenHeight = record.screenHeight
  if (!Number.isInteger(screenWidth) || !Number.isInteger(screenHeight) || (screenWidth as number) <= 0 || (screenHeight as number) <= 0) {
    throw new Error('缺少窗口屏幕尺寸')
  }
  return { screenWidth: screenWidth as number, screenHeight: screenHeight as number }
}

export function devtoolStreamEndpoints(prefs: { host: string; port: number; password: string }) {
  const base = httpBase(prefs.host, prefs.port)
  const query = new URLSearchParams({ password: prefs.password })
  return {
    start: `${base}/stream/start`,
    configure: `${base}/stream/configure`,
    stop: `${base}/stream/stop`,
    status: `${base}/status`,
    frames: `ws://${prefs.host}:${prefs.port}/ws/stream?${query}`,
    input: `ws://${prefs.host}:${prefs.port}/ws/stream-input?${query}`,
  }
}

export type LatestSlot<T> = {
  put: (item: T) => void
  peek: () => T | null
  take: () => T | null
}

export function createLatestSlot<T>(): LatestSlot<T> {
  let value: T | null = null
  return {
    put(item) { value = item },
    peek() { return value },
    take() {
      const current = value
      value = null
      return current
    },
  }
}

/** Display each newest completed decode, then take the latest queued packet. Never starve when decode is slower than capture. */
export async function drainLatestSlot<T>(slot: LatestSlot<T>, options: {
  decode: (item: T) => Promise<{ close: () => void } | null>
  draw: (image: { close: () => void }) => void
  alive: () => boolean
}): Promise<{ drawn: number; dropped: number }> {
  let drawn = 0
  let dropped = 0
  while (options.alive()) {
    const item = slot.take()
    if (item === null) break
    const image = await options.decode(item)
    if (!options.alive()) {
      image?.close()
      break
    }
    if (!image) continue
    options.draw(image)
    drawn += 1
  }
  return { drawn, dropped }
}

/** 串起云游戏的开始和停止，避免严格模式的第一次卸载把后一次会话停掉。 */
export function createSessionQueue(): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}
