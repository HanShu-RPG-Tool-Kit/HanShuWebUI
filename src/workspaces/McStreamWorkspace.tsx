import { useCallback, useEffect, useRef, useState } from 'react'
import {
  formatMonitorFps,
  MonitorFpsMeter,
} from './mcStream/fpsMeter.ts'
import { StreamGlPainter } from './mcStream/glPainter.ts'
import {
  clampRenderSize,
  DEFAULT_STREAM_HOST,
  DEFAULT_STREAM_PORT,
  fetchHealth,
  fetchStatus,
  parseFrameHeader,
  postStreamStart,
  postStreamStop,
  wsUrl,
  type StreamStatus,
} from './mcStream/protocol.ts'
import './McStreamWorkspace.css'

export interface McStreamWorkspaceProps {
  /** 工作区不可见时暂停收帧（不断开 HTTP streaming，仅关 WS）。 */
  active: boolean
}

type ConnState = 'idle' | 'starting' | 'live' | 'stopping'

/**
 * 源像素 → 视口映射：
 * - auto：等比自适应舞台（可分数倍，默认）
 * - device：1 源像素 = 1 设备像素
 * - css：1 源像素 = 1 CSS 像素
 * - fit：视口内最大整数倍（无分数倍）
 */
type ViewMode = 'auto' | 'device' | 'css' | 'fit'

type RenderPreset = {
  id: string
  label: string
  width: number
  height: number
}

const RENDER_PRESETS: readonly RenderPreset[] = [
  { id: 'keep', label: '不改窗口', width: 0, height: 0 },
  { id: '720p', label: '1280×720 (720p)', width: 1280, height: 720 },
  { id: '1080p', label: '1920×1080 (1080p)', width: 1920, height: 1080 },
  { id: '1440p', label: '2560×1440 (1440p)', width: 2560, height: 1440 },
  { id: '4k', label: '3840×2160 (4K)', width: 3840, height: 2160 },
  { id: '1080p-vert', label: '1080×1920 (竖屏)', width: 1080, height: 1920 },
  { id: 'custom', label: '自定义…', width: -1, height: -1 },
] as const

function matchRenderPreset(w: string, h: string): string {
  const rw = Number.parseInt(w, 10) || 0
  const rh = Number.parseInt(h, 10) || 0
  const hit = RENDER_PRESETS.find(
    (p) => p.id !== 'custom' && p.width === rw && p.height === rh,
  )
  return hit?.id ?? 'custom'
}

export function McStreamWorkspace({ active }: McStreamWorkspaceProps) {
  const [host, setHost] = useState(DEFAULT_STREAM_HOST)
  const [port, setPort] = useState(String(DEFAULT_STREAM_PORT))
  /** 0 = 无限制（按协议上限发 120） */
  const [fps, setFps] = useState('0')
  const [maxWidth, setMaxWidth] = useState('0')
  /** 与 renderHeight 都 >0 时改游戏窗口；默认 1080p 过场 */
  const [renderWidth, setRenderWidth] = useState('1920')
  const [renderHeight, setRenderHeight] = useState('1080')
  const [renderPresetId, setRenderPresetId] = useState('1080p')
  /** 显式传给模组；双维 >0 时协议默认也会隐藏 */
  const [hideWindow, setHideWindow] = useState(true)
  const [conn, setConn] = useState<ConnState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<StreamStatus | null>(null)
  const [hasFrame, setHasFrame] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('auto')
  /** 1 = 原样；>1 压暗（偏亮发灰时可调） */
  const [gamma, setGamma] = useState(1)
  const [viewScaleLabel, setViewScaleLabel] = useState('')

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const painterRef = useRef<StreamGlPainter | null>(null)
  const frameInfoRef = useRef<HTMLSpanElement>(null)
  const fpsInfoRef = useRef<HTMLSpanElement>(null)
  const fpsMeterRef = useRef(new MonitorFpsMeter())
  const hintRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const wantLiveRef = useRef(false)
  const gammaRef = useRef(gamma)
  gammaRef.current = gamma
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const frameSizeRef = useRef<{ w: number; h: number } | null>(null)
  const hostPortRef = useRef({
    host: DEFAULT_STREAM_HOST,
    port: DEFAULT_STREAM_PORT,
  })
  const pixelBufRef = useRef<Uint8Array | null>(null)
  const rafPendingRef = useRef(false)
  const latestBufRef = useRef<ArrayBuffer | null>(null)

  const applyViewport = useCallback((fw: number, fh: number, mode: ViewMode) => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || fw <= 0 || fh <= 0) return

    let cssW = fw
    let cssH = fh
    let label = ''

    if (mode === 'device') {
      const dpr = window.devicePixelRatio || 1
      cssW = fw / dpr
      cssH = fh / dpr
      label = `视口 ${cssW.toFixed(0)}×${cssH.toFixed(0)} CSS · 1源=${dpr.toFixed(2)}设备px`
    } else if (mode === 'css') {
      label = `视口 ${fw}×${fh} CSS · 1源=1CSS（DPR 可能再放大）`
    } else if (mode === 'auto') {
      const pad = 24
      const sw = Math.max(1, (stage?.clientWidth ?? fw) - pad)
      const sh = Math.max(1, (stage?.clientHeight ?? fh) - pad)
      const scale = Math.min(sw / fw, sh / fh)
      cssW = Math.max(1, fw * scale)
      cssH = Math.max(1, fh * scale)
      label = `视口自适应 ${cssW.toFixed(0)}×${cssH.toFixed(0)} · ${scale.toFixed(2)}×`
    } else {
      const pad = 24
      const sw = Math.max(1, (stage?.clientWidth ?? fw) - pad)
      const sh = Math.max(1, (stage?.clientHeight ?? fh) - pad)
      const scale = Math.max(1, Math.floor(Math.min(sw / fw, sh / fh)))
      cssW = fw * scale
      cssH = fh * scale
      label = `视口 ${cssW}×${cssH} · 整数 ${scale}×`
    }

    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    setViewScaleLabel(label)
  }, [])

  const parsedPort = () => {
    const n = Number.parseInt(port, 10)
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULT_STREAM_PORT
  }

  const closeWs = useCallback(() => {
    const ws = wsRef.current
    wsRef.current = null
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close(1000)
    }
  }, [])

  const paintBuffer = useCallback((buffer: ArrayBuffer) => {
    const header = parseFrameHeader(buffer)
    if (!header) return
    const { width, height, strideBytes, frameId, headerSize } = header
    const canvas = canvasRef.current
    if (!canvas) return

    if (!painterRef.current) {
      painterRef.current = new StreamGlPainter(canvas)
    }

    const rowBytes = width * 4
    const needed = width * height * 4
    let pixels = pixelBufRef.current
    if (!pixels || pixels.length !== needed) {
      pixels = new Uint8Array(needed)
      pixelBufRef.current = pixels
    }

    const src = new Uint8Array(buffer, headerSize, height * strideBytes)
    if (strideBytes === rowBytes) {
      pixels.set(src.subarray(0, needed))
    } else {
      for (let y = 0; y < height; y++) {
        pixels.set(
          src.subarray(y * strideBytes, y * strideBytes + rowBytes),
          y * rowBytes,
        )
      }
    }

    if (!painterRef.current.draw(pixels, width, height, { gamma: gammaRef.current })) {
      setError('WebGL 不可用，无法绘制串流帧')
      return
    }

    const snap = fpsMeterRef.current.push(performance.now())
    if (snap && fpsInfoRef.current) {
      fpsInfoRef.current.textContent = formatMonitorFps(snap)
    }

    const sizeChanged =
      !frameSizeRef.current ||
      frameSizeRef.current.w !== width ||
      frameSizeRef.current.h !== height
    frameSizeRef.current = { w: width, h: height }
    if (sizeChanged) {
      applyViewport(width, height, viewModeRef.current)
    }

    if (!hintRef.current) {
      hintRef.current = true
      setHasFrame(true)
    }
    const info = frameInfoRef.current
    if (info) {
      info.textContent = `帧 #${frameId} ${width}×${height}`
    }
  }, [applyViewport])

  /** 同屏多帧只画最新一帧，对齐服务端背压。 */
  const schedulePaint = useCallback(
    (buffer: ArrayBuffer) => {
      latestBufRef.current = buffer
      if (rafPendingRef.current) return
      rafPendingRef.current = true
      requestAnimationFrame(() => {
        rafPendingRef.current = false
        const buf = latestBufRef.current
        latestBufRef.current = null
        if (buf) paintBuffer(buf)
      })
    },
    [paintBuffer],
  )

  const openWs = useCallback(
    (h: string, p: number) => {
      closeWs()
      const ws = new WebSocket(wsUrl(h, p))
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as {
              message?: string
              error?: string
            }
            setError(msg.message || msg.error || ev.data)
          } catch {
            setError(ev.data)
          }
          return
        }
        schedulePaint(ev.data as ArrayBuffer)
      }

      ws.onerror = () => {
        setError('WebSocket 连接失败')
      }

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null
        if (wantLiveRef.current) {
          setConn('idle')
          setError((prev) => prev ?? 'WebSocket 已断开')
        }
      }
    },
    [closeWs, schedulePaint],
  )

  const refreshStatus = useCallback(async () => {
    const h = host.trim() || DEFAULT_STREAM_HOST
    const p = parsedPort()
    try {
      const s = await fetchStatus(h, p)
      setStatus(s)
      setError(null)
      return s
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [host, port])

  const applyStart = async (reconnectWs: boolean) => {
    const h = host.trim() || DEFAULT_STREAM_HOST
    const p = parsedPort()
    const fpsRaw = Number.parseInt(fps, 10)
    // 协议允许 1–120；0 / 空 / 非法 → 无限制（上限 120）
    const fpsN =
      !Number.isFinite(fpsRaw) || fpsRaw <= 0
        ? 120
        : Math.min(120, Math.max(1, fpsRaw))
    const maxW = Math.max(0, Number.parseInt(maxWidth, 10) || 0)
    let rw = clampRenderSize(Number.parseInt(renderWidth, 10))
    let rh = clampRenderSize(Number.parseInt(renderHeight, 10))
    // 必须两维都 >0 才改窗口；只填一侧则两侧都不发（保持 0）
    if (rw <= 0 || rh <= 0) {
      rw = 0
      rh = 0
    }
    hostPortRef.current = { host: h, port: p }
    setError(null)
    setConn('starting')
    wantLiveRef.current = true
    try {
      await fetchHealth(h, p)
      const started = await postStreamStart(h, p, {
        fps: fpsN,
        maxWidth: maxW,
        renderWidth: rw,
        renderHeight: rh,
        hideWindow,
      })
      setStatus(started)
      if (reconnectWs && active) openWs(h, p)
      setConn('live')
    } catch (e) {
      wantLiveRef.current = false
      closeWs()
      setConn('idle')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleStart = () => {
    fpsMeterRef.current.reset()
    if (fpsInfoRef.current) fpsInfoRef.current.textContent = ''
    void applyStart(true)
  }

  /** 已在推流时更新参数，不重连 WS。 */
  const handleApplyParams = () => void applyStart(false)

  const handleStop = async () => {
    const { host: h, port: p } = hostPortRef.current
    wantLiveRef.current = false
    setConn('stopping')
    setError(null)
    closeWs()
    fpsMeterRef.current.reset()
    try {
      const stopped = await postStreamStop(h, p)
      setStatus(stopped)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setConn('idle')
    }
  }

  useEffect(() => {
    if (!active) {
      closeWs()
      return
    }
    if (wantLiveRef.current && conn === 'live' && !wsRef.current) {
      const { host: h, port: p } = hostPortRef.current
      openWs(h, p)
    }
  }, [active, closeWs, conn, openWs])

  useEffect(() => {
    return () => {
      wantLiveRef.current = false
      closeWs()
      painterRef.current?.dispose()
      painterRef.current = null
    }
  }, [closeWs])

  useEffect(() => {
    if (!active || conn !== 'live') return
    const tick = () => {
      void fetchStatus(hostPortRef.current.host, hostPortRef.current.port)
        .then(setStatus)
        .catch(() => {})
    }
    tick()
    const id = window.setInterval(tick, 2000)
    return () => window.clearInterval(id)
  }, [active, conn])

  // 视口模式 / DPR / 舞台尺寸变化时重算 CSS 尺寸（不改帧缓冲）
  useEffect(() => {
    const size = frameSizeRef.current
    if (size) applyViewport(size.w, size.h, viewMode)

    const onDpr = () => {
      const s = frameSizeRef.current
      if (s) applyViewport(s.w, s.h, viewModeRef.current)
    }
    const mq = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    )
    mq.addEventListener?.('change', onDpr)
    window.addEventListener('resize', onDpr)

    const stage = stageRef.current
    let ro: ResizeObserver | null = null
    if (stage && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        const mode = viewModeRef.current
        if (mode !== 'fit' && mode !== 'auto') return
        const s = frameSizeRef.current
        if (s) applyViewport(s.w, s.h, mode)
      })
      ro.observe(stage)
    }
    return () => {
      mq.removeEventListener?.('change', onDpr)
      window.removeEventListener('resize', onDpr)
      ro?.disconnect()
    }
  }, [applyViewport, viewMode, hasFrame])

  const busy = conn === 'starting' || conn === 'stopping'
  const live = conn === 'live'

  return (
    <div className="mc-stream-workspace">
      <div className="mc-stream-toolbar">
        <label className="mc-stream-field">
          Host
          <input
            className="wide"
            value={host}
            disabled={live || busy}
            onChange={(e) => setHost(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="mc-stream-field">
          Port
          <input
            value={port}
            disabled={live || busy}
            onChange={(e) => setPort(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="mc-stream-field">
          FPS
          <input
            value={fps}
            disabled={busy}
            onChange={(e) => setFps(e.target.value)}
            title="0 = 无限制（协议上限 120）；否则 1–120"
          />
        </label>
        <label className="mc-stream-field">
          maxWidth
          <input
            value={maxWidth}
            disabled={busy}
            onChange={(e) => setMaxWidth(e.target.value)}
            title="0 = 不降采样；>0 捕获宽度上限"
          />
        </label>
        <label className="mc-stream-field">
          渲染
          <select
            value={renderPresetId}
            disabled={busy}
            onChange={(e) => {
              const id = e.target.value
              setRenderPresetId(id)
              const preset = RENDER_PRESETS.find((p) => p.id === id)
              if (!preset || preset.id === 'custom') return
              setRenderWidth(String(preset.width))
              setRenderHeight(String(preset.height))
              if (preset.width > 0 && preset.height > 0) {
                setHideWindow(true)
              }
            }}
            title="游戏窗口 / framebuffer 目标尺寸"
          >
            {RENDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {renderPresetId === 'custom' && (
          <label className="mc-stream-field">
            自定义
            <input
              value={renderWidth}
              disabled={busy}
              onChange={(e) => {
                setRenderWidth(e.target.value)
                setRenderPresetId(
                  matchRenderPreset(e.target.value, renderHeight),
                )
              }}
              title="宽 320–7680；0=不改（需与高同时为 0）"
              spellCheck={false}
            />
            ×
            <input
              value={renderHeight}
              disabled={busy}
              onChange={(e) => {
                setRenderHeight(e.target.value)
                setRenderPresetId(
                  matchRenderPreset(renderWidth, e.target.value),
                )
              }}
              title="高 320–7680"
              spellCheck={false}
            />
          </label>
        )}
        <label className="mc-stream-field">
          <input
            type="checkbox"
            checked={hideWindow}
            disabled={busy}
            onChange={(e) => setHideWindow(e.target.checked)}
            title="start 时隐藏 MC 窗口（stop 恢复）；指定渲染分辨率时建议开启"
          />
          隐藏窗口
        </label>
        <label className="mc-stream-field" title="1=原样；偏亮发灰时增大">
          伽马
          <input
            type="range"
            min={0.8}
            max={1.6}
            step={0.05}
            value={gamma}
            onChange={(e) => setGamma(Number(e.target.value))}
          />
          <span className="mc-stream-gamma-val">{gamma.toFixed(2)}</span>
        </label>
        <label className="mc-stream-field">
          视口
          <select
            value={viewMode}
            onChange={(e) => setViewMode(e.target.value as ViewMode)}
            title="源分辨率→显示尺寸映射"
          >
            <option value="auto">自适应</option>
            <option value="device">设备像素 1:1</option>
            <option value="css">CSS 像素 1:1</option>
            <option value="fit">整数倍适应</option>
          </select>
        </label>
        <div className="mc-stream-actions">
          <button
            type="button"
            className="mc-stream-btn"
            disabled={busy}
            onClick={() => void refreshStatus()}
          >
            状态
          </button>
          {!live ? (
            <button
              type="button"
              className="mc-stream-btn primary"
              disabled={busy}
              onClick={handleStart}
            >
              {conn === 'starting' ? '启动中…' : '开始串流'}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="mc-stream-btn primary"
                disabled={busy}
                onClick={handleApplyParams}
                title="把当前 FPS / maxWidth 发给模组（无需重连）"
              >
                应用参数
              </button>
              <button
                type="button"
                className="mc-stream-btn"
                disabled={busy}
                onClick={() => void handleStop()}
              >
                {conn === 'stopping' ? '停止中…' : '停止'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mc-stream-status">
        <span>
          连接：
          <strong>
            {live ? (active ? '收帧中' : '已暂停（切回继续）') : '空闲'}
          </strong>
        </span>
        {status && (
          <>
            <span>
              模组：
              <strong>{status.streaming ? 'streaming' : 'idle'}</strong>
            </span>
            {typeof status.fps === 'number' && (
              <span>
                目标 <strong>{status.fps}</strong> fps
              </span>
            )}
            <span
              ref={fpsInfoRef}
              className="mc-stream-fps"
              title="基于本机实际呈现间隔；1%/0.1% low 为最慢帧平均换算"
            />
            {typeof status.width === 'number' && status.width > 0 && (
              <span>
                帧{' '}
                <strong>
                  {status.width}×{status.height ?? '?'}
                </strong>
              </span>
            )}
            {typeof status.renderWidth === 'number' &&
              status.renderWidth > 0 && (
                <span>
                  渲染{' '}
                  <strong>
                    {status.renderWidth}×{status.renderHeight ?? '?'}
                  </strong>
                </span>
              )}
            {typeof status.hideWindow === 'boolean' && (
              <span>
                窗口{' '}
                <strong>{status.hideWindow ? '已隐藏' : '可见'}</strong>
              </span>
            )}
            {typeof status.framesDropped === 'number' && (
              <span>
                dropped <strong>{status.framesDropped}</strong>
              </span>
            )}
            {typeof status.subscribers === 'number' && (
              <span>
                subs <strong>{status.subscribers}</strong>
              </span>
            )}
          </>
        )}
        <span ref={frameInfoRef} />
        {viewScaleLabel && <span>{viewScaleLabel}</span>}
        {error && <span className="err">{error}</span>}
      </div>

      <div
        ref={stageRef}
        className={`mc-stream-stage${
          viewMode === 'fit' || viewMode === 'auto' ? ' fit' : ''
        }${viewMode === 'auto' ? ' adapt' : ''}`}
      >
        <canvas
          ref={canvasRef}
          style={{ display: hasFrame ? 'block' : 'none' }}
        />
        {!hasFrame && (
          <p className="mc-stream-hint">
            连接本机 <code>mchhui.streaming</code>（默认 127.0.0.1:8765）。
            <br />
            默认请求渲染 <strong>1920×1080</strong> 并隐藏 MC 窗口；stop 后窗口恢复。
            <br />
            视口默认「自适应」等比铺满舞台；要像素级对齐可选设备/CSS 1:1。
          </p>
        )}
      </div>
    </div>
  )
}
