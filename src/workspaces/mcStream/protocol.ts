/** mchhui.streaming — 本机 Raw RGBA8 帧协议（过场编辑器用） */

export const STREAM_MAGIC = 0x52505346 // 'RPSF'
export const STREAM_HEADER_SIZE = 32
export const STREAM_FORMAT_RGBA8 = 1

export const DEFAULT_STREAM_HOST = '127.0.0.1'
export const DEFAULT_STREAM_PORT = 8765

export const RENDER_SIZE_MIN = 320
export const RENDER_SIZE_MAX = 7680

export type StreamHealth = {
  ok: boolean
  streaming: boolean
}

export type StreamStatus = {
  ok: boolean
  streaming: boolean
  host?: string
  port?: number
  format?: string
  formatId?: number
  width?: number
  height?: number
  strideBytes?: number
  fps?: number
  maxWidth?: number
  renderWidth?: number
  renderHeight?: number
  hideWindow?: boolean
  frameId?: number
  framesPushed?: number
  framesDropped?: number
  subscribers?: number
  capturePending?: boolean
}

export type StreamStartOptions = {
  fps?: number
  maxWidth?: number
  /** 与 renderHeight 都 >0 时生效；0 = 不改窗口 */
  renderWidth?: number
  renderHeight?: number
  /**
   * 省略时：若两维都 >0 则服务端默认 true，否则 false。
   * 显式传入则覆盖。
   */
  hideWindow?: boolean
}

export type ParsedFrame = {
  width: number
  height: number
  strideBytes: number
  frameId: number
  timestampNs: bigint
  /** 紧密 RGBA，长度 width*height*4 */
  pixels: Uint8ClampedArray
}

export function httpBase(host: string, port: number): string {
  return `http://${host}:${port}`
}

export function wsUrl(host: string, port: number): string {
  return `ws://${host}:${port}/ws/stream`
}

/** 将用户输入规范为协议范围；无效 / 0 → 0（不改窗口）。 */
export function clampRenderSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(RENDER_SIZE_MAX, Math.max(RENDER_SIZE_MIN, Math.round(n)))
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export async function fetchHealth(
  host: string,
  port: number,
): Promise<StreamHealth> {
  const res = await fetch(`${httpBase(host, port)}/health`)
  return readJson(res)
}

export async function fetchStatus(
  host: string,
  port: number,
): Promise<StreamStatus> {
  const res = await fetch(`${httpBase(host, port)}/status`)
  return readJson(res)
}

export async function postStreamStart(
  host: string,
  port: number,
  opts: StreamStartOptions = {},
): Promise<StreamStatus> {
  const body: Record<string, number | boolean> = {
    fps: opts.fps ?? 30,
    maxWidth: opts.maxWidth ?? 0,
    renderWidth: opts.renderWidth ?? 0,
    renderHeight: opts.renderHeight ?? 0,
  }
  if (opts.hideWindow !== undefined) {
    body.hideWindow = opts.hideWindow
  }
  const res = await fetch(`${httpBase(host, port)}/stream/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readJson(res)
}

export async function postStreamStop(
  host: string,
  port: number,
): Promise<StreamStatus> {
  const res = await fetch(`${httpBase(host, port)}/stream/stop`, {
    method: 'POST',
  })
  return readJson(res)
}

export type FrameHeader = {
  headerSize: number
  width: number
  height: number
  strideBytes: number
  frameId: number
  timestampNs: bigint
}

/** 只解析头；非法帧返回 null。画布侧可复用像素缓冲，避免每帧分配。 */
export function parseFrameHeader(buffer: ArrayBuffer): FrameHeader | null {
  if (buffer.byteLength < STREAM_HEADER_SIZE) return null
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== STREAM_MAGIC) return null
  const headerSize = view.getUint16(4, true)
  const format = view.getUint16(6, true)
  if (headerSize !== STREAM_HEADER_SIZE || format !== STREAM_FORMAT_RGBA8) {
    return null
  }
  const width = view.getUint32(8, true)
  const height = view.getUint32(12, true)
  const strideBytes = view.getUint32(16, true)
  const frameId = view.getUint32(20, true)
  const timestampNs = view.getBigUint64(24, true)
  const expected = headerSize + height * strideBytes
  if (buffer.byteLength !== expected || width === 0 || height === 0) return null
  return { headerSize, width, height, strideBytes, frameId, timestampNs }
}

/** 解析一条 binary WebSocket 消息；非法帧返回 null。 */
export function parseFrame(buffer: ArrayBuffer): ParsedFrame | null {
  const header = parseFrameHeader(buffer)
  if (!header) return null
  const { width, height, strideBytes, frameId, timestampNs, headerSize } =
    header
  const rowBytes = width * 4
  const src = new Uint8Array(buffer, headerSize, height * strideBytes)
  let pixels: Uint8ClampedArray
  if (strideBytes === rowBytes) {
    pixels = new Uint8ClampedArray(src.slice(0, width * height * 4))
  } else {
    pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      pixels.set(
        src.subarray(y * strideBytes, y * strideBytes + rowBytes),
        y * rowBytes,
      )
    }
  }
  return { width, height, strideBytes, frameId, timestampNs, pixels }
}
