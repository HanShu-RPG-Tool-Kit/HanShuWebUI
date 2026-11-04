import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readEntityStreamFrame } from '../src/workspaces/gameplay/entitySnapshot.ts'
import {
  GLFW_MOD_CONTROL,
  GLFW_MOD_SHIFT,
  INTERACTIVE_STREAM_BODY,
  RPIN_BUTTON_DOWN,
  RPIN_BUTTON_UP,
  RPIN_CHAR,
  RPIN_KEY_DOWN,
  RPIN_KEY_UP,
  RPIN_MAGIC,
  RPIN_MOVE,
  RPIN_VERSION,
  RPIN_WHEEL,
  StreamInputBatch,
  charCodepoint,
  coalesceRpin,
  createLatestSlot,
  createSessionQueue,
  decodeRpin,
  devtoolStreamEndpoints,
  drainLatestSlot,
  encodeRpin,
  glfwKeyFromCode,
  glfwMouseButton,
  isFormFieldTarget,
  confineStreamPointer,
  letterboxDelta,
  letterboxToScreen,
  readInteractiveJpegFrame,
  readStreamScreen,
  wheelCenti,
  type RpinEvent,
} from '../src/workspaces/gameplay/streamInput.ts'

const keys: Record<string, { key: number; scancode: number }> = {
  KeyA: { key: 65, scancode: 0x1e },
  ShiftLeft: { key: 340, scancode: 0x2a },
  ShiftRight: { key: 344, scancode: 0x36 },
  ControlLeft: { key: 341, scancode: 0x1d },
  Space: { key: 32, scancode: 0x39 },
  F1: { key: 290, scancode: 0x3b },
  F11: { key: 300, scancode: 0x57 },
  F12: { key: 301, scancode: 0x58 },
  F13: { key: 302, scancode: 0 },
  F25: { key: 314, scancode: 0 },
  ArrowUp: { key: 265, scancode: 0x0148 },
  Escape: { key: 256, scancode: 0x01 },
}
for (const [code, expected] of Object.entries(keys)) {
  assert.deepEqual(glfwKeyFromCode(code), expected, code)
}
assert.equal(glfwKeyFromCode('Unknown'), null)
assert.equal(glfwMouseButton(0), 0)
assert.equal(glfwMouseButton(2), 1)
assert.equal(glfwMouseButton(1), 2)
assert.equal(charCodepoint('a', false, 0), 97)
assert.equal(charCodepoint(' ', false, 0), 32)
assert.equal(charCodepoint('a', true, 0), null)
assert.equal(charCodepoint('a', false, GLFW_MOD_CONTROL), null)
assert.equal(charCodepoint('Enter', false, 0), null)
assert.equal(wheelCenti(1, 1), 100)
assert.equal(wheelCenti(100, 0), 100)
assert.equal(isFormFieldTarget({ closest: (selector) => selector === 'input, textarea, select' ? {} : null }), true)
assert.equal(isFormFieldTarget({ closest: () => null }), false)

const batch = new StreamInputBatch()
batch.push({ type: RPIN_MOVE, flags: 0, mods: 0, x: 10, y: 20, dx: 1, dy: 2 })
batch.push({ type: RPIN_KEY_UP, flags: 0, mods: GLFW_MOD_SHIFT, key: 65, scancode: 0x1e })
batch.push({ type: RPIN_MOVE, flags: 0, mods: 0, x: 12, y: 22, dx: 3, dy: 4 })
assert.equal(batch.pending.length, 3, '按键必须挡住两边的移动')
const blocked = decodeRpin(batch.take()!)
assert.equal(blocked.length, 3)
assert.equal(blocked[0]?.type, RPIN_MOVE)
assert.equal(blocked[1]?.type, RPIN_KEY_UP)
assert.equal(blocked[2]?.type, RPIN_MOVE)
assert.equal(blocked[0]?.seq, 1)
assert.equal(blocked[2]?.seq, 3)

const burst = new StreamInputBatch()
for (let index = 0; index < 300; index++) {
  burst.push({ type: index % 2 === 0 ? RPIN_KEY_DOWN : RPIN_KEY_UP, flags: 0, mods: 0, key: 87, scancode: 0 })
}
const firstChunk = decodeRpin(burst.take()!)
const lastChunk = decodeRpin(burst.take()!)
assert.equal(firstChunk.length, 256)
assert.equal(lastChunk.length, 44)
assert.deepEqual([...firstChunk, ...lastChunk].map(event => event.seq), Array.from({ length: 300 }, (_, index) => index + 1))
assert.equal(burst.take(), null)
assert.throws(() => encodeRpin([...firstChunk, ...lastChunk]), /批次过长/)

const merged = new StreamInputBatch()
merged.push({ type: RPIN_MOVE, flags: 0, mods: 0, x: 1, y: 2, dx: 3, dy: 4 })
merged.push({ type: RPIN_MOVE, flags: 0, mods: GLFW_MOD_CONTROL, x: 8, y: 9, dx: 1, dy: -2 })
merged.push({ type: RPIN_CHAR, flags: 0, mods: 0, codepoint: 0x4e2d })
merged.push({ type: RPIN_BUTTON_DOWN, flags: 0, mods: 0, button: 1, x: -4, y: 5 })
merged.push({ type: RPIN_WHEEL, flags: 0, mods: 0, dxCenti: -100, dyCenti: 100 })
merged.push({ type: RPIN_BUTTON_UP, flags: 0, mods: 0, button: 1, x: -4, y: 6 })
merged.push({ type: RPIN_KEY_DOWN, flags: 1, mods: GLFW_MOD_SHIFT | GLFW_MOD_CONTROL, key: 300, scancode: 0x57 })
const encoded = merged.take()!
const bytes = new Uint8Array(encoded)
assert.equal(bytes[0], 0x52)
assert.equal(bytes[1], 0x50)
assert.equal(bytes[2], 0x49)
assert.equal(bytes[3], 0x4e)
const view = new DataView(encoded)
assert.equal(view.getUint32(0, true), RPIN_MAGIC)
assert.equal(view.getUint16(4, true), RPIN_VERSION)
const events = decodeRpin(encoded)
assert.equal(events.length, 6)
assert.deepEqual(events[0], { type: RPIN_MOVE, flags: 0, mods: GLFW_MOD_CONTROL, seq: 2, x: 8, y: 9, dx: 4, dy: 2 })
assert.equal(events[1]?.type, RPIN_CHAR)
assert.equal(events[1] && events[1].type === RPIN_CHAR && events[1].codepoint, 0x4e2d)
assert.equal(events[2]?.type, RPIN_BUTTON_DOWN)
assert.equal(events[2] && events[2].type === RPIN_BUTTON_DOWN && events[2].button, 1)
assert.equal(events[2] && events[2].type === RPIN_BUTTON_DOWN && events[2].x, -4)
assert.equal(events[3]?.type, RPIN_WHEEL)
assert.equal(events[3] && events[3].type === RPIN_WHEEL && events[3].dyCenti, 100)
assert.equal(events[5]?.type, RPIN_KEY_DOWN)
assert.equal(events[5] && events[5].type === RPIN_KEY_DOWN && events[5].flags, 1)
assert.deepEqual(decodeRpin(encodeRpin(events)), events)

const alone: RpinEvent[] = []
const firstMove: RpinEvent = { type: RPIN_MOVE, flags: 0, mods: 0, seq: 1, x: 1, y: 1, dx: 1, dy: 1 }
const secondMove: RpinEvent = { type: RPIN_MOVE, flags: 0, mods: 0, seq: 4, x: 3, y: 5, dx: 2, dy: 2 }
assert.equal(coalesceRpin(coalesceRpin(alone, firstMove), secondMove)[0]?.seq, 4)

assert.throws(() => decodeRpin(new ArrayBuffer(8)), /输入批次头无效/)
const badType = encodeRpin([])
new DataView(badType).setUint16(6, 1, true)
assert.throws(() => decodeRpin(badType), /截断|长度/)

assert.deepEqual(letterboxToScreen(500, 250, 1000, 500, 1280, 720, 854, 480), { x: 427, y: 240 })
assert.equal(letterboxToScreen(0, 250, 1000, 500, 1280, 720, 854, 480).x, 0)
assert.notDeepEqual(letterboxToScreen(500, 250, 1000, 500, 1280, 720, 854, 480), { x: 640, y: 360 })
assert.notDeepEqual(letterboxToScreen(500, 250, 1000, 500, 1280, 720, 854, 480), { x: 500, y: 250 })
assert.deepEqual(letterboxDelta(10, 0, 1000, 500, 1280, 720, 854, 480), { dx: Math.round(10 / (500 * 1280 / 720) * 854), dy: 0 })

const picture = { viewW: 1000, viewH: 500, frameW: 1280, frameH: 720, screenW: 854, screenH: 480 }
const outside = confineStreamPointer(null, { localX: -40, localY: 250, cssDx: 12, cssDy: -3, locked: false }, picture.viewW, picture.viewH, picture.frameW, picture.frameH, picture.screenW, picture.screenH)
assert.equal(outside?.point.x, 0)
assert.ok(outside && outside.aim.x > 0)
const held = confineStreamPointer(outside!.aim, { localX: 0, localY: 0, cssDx: -30, cssDy: 0, locked: true }, picture.viewW, picture.viewH, picture.frameW, picture.frameH, picture.screenW, picture.screenH)
assert.equal(held?.point.x, 0)
assert.equal(held?.aim.x, outside!.aim.x)
assert.ok(held && held.delta.dx < 0)
const edge = confineStreamPointer({ x: 1000, y: 250 }, { localX: 0, localY: 0, cssDx: 40, cssDy: 5, locked: true }, picture.viewW, picture.viewH, picture.frameW, picture.frameH, picture.screenW, picture.screenH)
assert.equal(edge?.point.x, picture.screenW)
assert.equal(edge?.point.y <= picture.screenH && edge.point.y >= 0, true)
assert.ok(edge && edge.delta.dx > 0 && edge.aim.x < 1000)

function rpsf(format: number, width: number, height: number, payload: Uint8Array, stride = 0) {
  const buffer = new ArrayBuffer(32 + payload.byteLength)
  const header = new DataView(buffer)
  header.setUint32(0, 0x52505346, true)
  header.setUint16(4, 32, true)
  header.setUint16(6, format, true)
  header.setUint32(8, width, true)
  header.setUint32(12, height, true)
  header.setUint32(16, stride, true)
  header.setUint32(20, 9, true)
  new Uint8Array(buffer).set(payload, 32)
  return buffer
}

const interactive = rpsf(3, 8, 8, new Uint8Array([1, 2, 3, 4]))
const parsed = readInteractiveJpegFrame(interactive)
assert.equal(parsed.width, 8)
assert.equal(parsed.frameId, 9)
assert.deepEqual([...parsed.payload], [1, 2, 3, 4])
assert.throws(() => readEntityStreamFrame(interactive), /预览压缩帧无效|预览帧格式无效/)
assert.throws(() => readInteractiveJpegFrame(rpsf(2, 8, 8, new Uint8Array([1]))))
assert.throws(() => readInteractiveJpegFrame(rpsf(3, 8, 8, new Uint8Array([1]), 32)))
assert.equal(readInteractiveJpegFrame(rpsf(3, 8, 8, new Uint8Array(2 * 1024 * 1024))).payload.byteLength, 2 * 1024 * 1024)
assert.throws(() => readInteractiveJpegFrame(rpsf(3, 8, 8, new Uint8Array(2 * 1024 * 1024 + 1))))
assert.deepEqual(readStreamScreen({ screenWidth: 854, screenHeight: 480 }), { screenWidth: 854, screenHeight: 480 })
assert.throws(() => readStreamScreen({}))
assert.deepEqual(INTERACTIVE_STREAM_BODY, {
  mode: 'interactive',
  picture: 'jpeg',
  maxWidth: 1280,
  fps: 30,
  jpegQuality: 0.62,
})

const endpoints = devtoolStreamEndpoints({ host: '127.0.0.1', port: 9, password: 'unit-test-secret' })
assert.equal(endpoints.start, 'http://127.0.0.1:9/stream/start')
assert.equal(endpoints.stop, 'http://127.0.0.1:9/stream/stop')
assert.equal(endpoints.status, 'http://127.0.0.1:9/status')
assert.equal(endpoints.frames, 'ws://127.0.0.1:9/ws/stream?password=unit-test-secret')
assert.equal(endpoints.input, 'ws://127.0.0.1:9/ws/stream-input?password=unit-test-secret')

const slot = createLatestSlot<string>()
const closed: string[] = []
const drawn: string[] = []
slot.put('old')
const drained = await drainLatestSlot(slot, {
  alive: () => true,
  decode: async (item) => {
    if (item === 'old') slot.put('new')
    return { id: item, close: () => closed.push(item) }
  },
  draw: (image) => drawn.push((image as { id: string }).id),
})
assert.deepEqual(drawn, ['old', 'new'])
assert.deepEqual(closed, [])
assert.equal(drained.dropped, 0)
assert.equal(drained.drawn, 2)

// A producer faster than decoding must still display completed frames, with one pending slot.
const busySlot = createLatestSlot<number>()
const visibleFrames: number[] = []
let produced = 1
busySlot.put(0)
await drainLatestSlot(busySlot, {
  alive: () => true,
  decode: async (item) => {
    if (produced < 60) {
      busySlot.put(produced++)
      busySlot.put(produced++)
    }
    return { id: item, close() {} }
  },
  draw: image => visibleFrames.push((image as { id: number }).id),
})
assert.ok(visibleFrames.length >= 20, 'continuous producer cannot starve presentation')
assert.equal(visibleFrames[0], 0)
assert.equal(visibleFrames.at(-1), produced - 1)

const order: string[] = []
const enqueue = createSessionQueue()
const first = enqueue(async () => {
  order.push('begin')
  await new Promise((resolve) => setTimeout(resolve, 20))
  order.push('began')
})
enqueue(async () => { order.push('stop') })
await enqueue(async () => { order.push('next') })
await first
assert.deepEqual(order, ['begin', 'began', 'stop', 'next'])
const again = createSessionQueue()
const rejected = again(async () => { throw new Error('offline') })
await again(async () => { order.push('after-error') })
await rejected.catch(() => undefined)
assert.equal(order.at(-1), 'after-error')

const viewport = readFileSync(new URL('../src/workspaces/gameplay/streamViewport.tsx', import.meta.url), 'utf8')
const volume = readFileSync(new URL('../src/workspaces/gameplay/levelVolumeView.tsx', import.meta.url), 'utf8')
assert.equal(viewport.includes('readEntityStreamFrame'), false)
assert.equal(viewport.includes('mchhui'), false)
assert.equal(volume.includes('readEntityStreamFrame'), false)

console.log('PASS stream input: mapping, RPIN barriers, letterbox, format 3')
