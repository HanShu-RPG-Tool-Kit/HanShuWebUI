import { useEffect, useRef, useState } from 'react'
import { getControlHubSnapshot } from '../../gameDevServer/controlHub'
import { levelStreamChord, type LevelOnlineMeta, type NativeEditorAction } from './levelOnline'
import { loadStreamSettings, saveStreamSettings, streamStartBody, STREAM_WIDTHS, STREAM_RATES, type StreamSettings } from './streamSettings'

export type StreamEditorBridge = {
  /** Resolve before the picture session starts. Rejection skips /stream/start. */
  acquire: () => Promise<void>
  /** Idempotent. Called on stop, failure, and unmount. */
  release: () => Promise<void>
  /** Ctrl+S stays in the browser and reaches the existing project save path. */
  beforeSave?: () => void
  /** Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z edit the .level draft, not the game. */
  history?: (redo: boolean) => void
  /** Drop the in-game drag before the browser releases the pointer. */
  cancel?: () => void
  shortcut?: (action: NativeEditorAction) => Promise<void>
}
import {
  RPSF_HEADER_SIZE,
  RPIN_BUTTON_DOWN,
  RPIN_BUTTON_UP,
  RPIN_CHAR,
  RPIN_KEY_DOWN,
  RPIN_KEY_UP,
  RPIN_MOVE,
  RPIN_WHEEL,
  StreamInputBatch,
  charCodepoint,
  createLatestSlot,
  createSessionQueue,
  devtoolStreamEndpoints,
  drainLatestSlot,
  glfwKeyFromCode,
  glfwMods,
  confineStreamPointer,
  glfwMouseButton,
  isFormFieldTarget,
  pictureLetterbox,
  type StreamPointerAim,
  readInteractiveJpegFrame,
  readStreamScreen,
  wheelCenti,
} from './streamInput'

type StreamPhase = 'connecting' | 'live' | 'error'

const enqueueSession = createSessionQueue()

export function StreamViewport({ editor, meta }: { editor?: StreamEditorBridge; meta?: LevelOnlineMeta | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const editorRef = useRef(editor)
  editorRef.current = editor
  const [phase, setPhase] = useState<StreamPhase>('connecting')
  const [error, setError] = useState('')
  const [settings,setSettings]=useState(loadStreamSettings)
  const initialSettings=useRef(settings)
  const sessionRef=useRef<ReturnType<typeof openInteractiveSession>|null>(null)
  const [configuring,setConfiguring]=useState(false),[configError,setConfigError]=useState('')
  const [metrics,setMetrics]=useState({width:0,height:0,fps:0})

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return undefined
    const session = openInteractiveSession(host, canvas, () => editorRef.current, initialSettings.current, setMetrics, (next, message) => {
      setPhase(next)
      setError(message)
    })
    sessionRef.current=session
    return () => {sessionRef.current=null;session.stop()}
  }, [])

  return (
    <div className="level-stream-shell">
    <div className="level-stream-quality">
      <span role="status" aria-label="串流实际画质">{metrics.width?`${metrics.width} × ${metrics.height} · ${metrics.fps} FPS`:'等待画面'}</span>
      <details><summary>画质与帧率</summary><div className="level-stream-settings">
        <label>画面宽度<select aria-label="串流画面宽度" value={settings.maxWidth} disabled={configuring} onChange={e=>setSettings(v=>({...v,maxWidth:Number(e.target.value)}))}>{STREAM_WIDTHS.map(w=><option key={w} value={w}>{w===0?'原画 · 跟随游戏窗口':w+' 像素宽'}</option>)}</select></label>
        <label>目标帧率<select aria-label="串流目标帧率" value={settings.fps} disabled={configuring} onChange={e=>setSettings(v=>({...v,fps:Number(e.target.value)}))}>{STREAM_RATES.map(f=><option key={f} value={f}>{f} FPS</option>)}</select></label>
        <label>画面质量 <output>{Math.round(settings.jpegQuality*100)}%</output><input type="range" aria-label="串流画面质量" min="50" max="95" step="1" value={Math.round(settings.jpegQuality*100)} disabled={configuring} onChange={e=>setSettings(v=>({...v,jpegQuality:Number(e.target.value)/100}))}/></label>
        <p>保持游戏画面比例，不放大源画面。原画保留窗口的清晰度；降低宽度或质量可减少编码与传输开销。上方显示实际收到的帧率。</p>
        <button type="button" disabled={configuring||phase!=='live'} onClick={async()=>{const session=sessionRef.current;if(!session)return;setConfiguring(true);setConfigError('');try{await session.configure(settings);saveStreamSettings(settings)}catch(e){setConfigError(e instanceof Error?e.message:'设置未应用')}finally{setConfiguring(false)}}}>{configuring?'正在应用…':'应用串流设置'}</button>
        {configError&&<p role="alert">{configError}</p>}
      </div></details>
    </div>
    <div
      ref={hostRef}
      className="level-stream"
      tabIndex={0}
      aria-label="本地云游戏画面"
      data-state={phase}
      data-edit-session={meta?.sessionId || undefined}
      data-edit-document={meta?.documentId || undefined}
      data-edit-revision={meta ? String(meta.revision) : undefined}
      data-edit-handles={meta ? JSON.stringify(meta.handles) : undefined}
      data-edit-window={meta?.window ? JSON.stringify(meta.window) : undefined}
      data-edit-viewport={meta?.viewport ? JSON.stringify(meta.viewport) : undefined}
    >
      <canvas ref={canvasRef} />
      {phase === 'connecting' && <p className="level-stream-loading" role="status">正在等待游戏画面…</p>}
      {error && <p className="level-stream-error" role="status">{error}</p>}
    </div>
    </div>
  )
}

function openInteractiveSession(
  host: HTMLDivElement,
  canvas: HTMLCanvasElement,
  editorOf: () => StreamEditorBridge | undefined,
  settings: StreamSettings,
  onMetrics: (metrics:{width:number;height:number;fps:number})=>void,
  onPhase: (phase: StreamPhase, message: string) => void,
) {
  const prefs = getControlHubSnapshot().prefs
  const endpoints = devtoolStreamEndpoints(prefs)
  const secret = prefs.password
  const abort = new AbortController()
  const batch = new StreamInputBatch()
  const slot = createLatestSlot<ArrayBuffer>()
  const pressed = new Map<string, { key: number; scancode: number }>()
  const buttons = new Map<number, { x: number; y: number }>()
  let alive = true
  let ended = false
  let started = false
  let screen: { screenWidth: number; screenHeight: number } | null = null
  let frameSize: { width: number; height: number } | null = null
  let bitmap: ImageBitmap | null = null
  let input: WebSocket | null = null
  let frames: WebSocket | null = null
  let raf = 0
  let painting = false
  let statusTimer = 0
  let metricsTimer = 0
  let editorHeld = false
  let aim: StreamPointerAim | null = null
  let seenPointer: Event | null = null
  let measuredAt=performance.now(),drawn=0,firstFrame=true
  const context=canvas.getContext('2d',{alpha:false,desynchronized:true})

  const report = (phase: StreamPhase, message: string) => {
    if (alive) onPhase(phase, message)
  }

  function flushNow(all = false) {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    if (!input || input.readyState !== WebSocket.OPEN) return
    do {
      const payload = batch.take()
      if (payload) input.send(payload)
    } while (all && batch.pending.length > 0)
    if (batch.pending.length > 0) scheduleFlush()
  }

  function scheduleFlush() {
    if (raf || !alive) return
    raf = requestAnimationFrame(() => flushNow())
  }

  function releaseInputs(now: boolean) {
    for (const [code, mapping] of pressed) {
      pressed.delete(code)
      batch.push({ type: RPIN_KEY_UP, flags: 0, mods: 0, key: mapping.key, scancode: mapping.scancode })
    }
    for (const [button, point] of buttons) {
      buttons.delete(button)
      batch.push({ type: RPIN_BUTTON_UP, flags: 0, mods: 0, button, x: point.x, y: point.y })
    }
    if (now) flushNow(true)
    else scheduleFlush()
  }

  function authHeaders(json: boolean): HeadersInit {
    return json
      ? { 'X-DevTool-Password': secret, 'Content-Type': 'application/json' }
      : { 'X-DevTool-Password': secret }
  }

  async function postStop() {
    if (!started) return
    started = false
    try {
      await fetch(endpoints.stop, { method: 'POST', headers: authHeaders(false), keepalive: true, signal: AbortSignal.timeout(6000) })
    } catch {
      /* 门户已经不在时，停止请求到不了。 */
    }
  }

  function paint(image: ImageBitmap) {
    const width = host.clientWidth
    const height = host.clientHeight
    if (width < 2 || height < 2) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pixelWidth = Math.max(1, Math.round(width * dpr))
    const pixelHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.fillStyle = '#121314'
    context.fillRect(0, 0, width, height)
    const box = pictureLetterbox(width, height, image.width, image.height)
    context.imageSmoothingEnabled = false
    context.drawImage(image, box.x, box.y, box.width, box.height)
  }

  async function pump() {
    if (painting) return
    painting = true
    try {
      await drainLatestSlot(slot, {
        alive: () => alive,
        decode: async (buffer) => {
          let parsed: ReturnType<typeof readInteractiveJpegFrame>
          try {
            parsed = readInteractiveJpegFrame(buffer)
          } catch (error) {
            report('error', publicError(error, secret))
            return null
          }
          const jpeg = new Uint8Array(buffer,RPSF_HEADER_SIZE,parsed.payload.byteLength)
          const image = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
          if (image.width !== parsed.width || image.height !== parsed.height) {
            image.close()
            report('error', '画面尺寸不匹配')
            return null
          }
          frameSize = { width: parsed.width, height: parsed.height }
          return image
        },
        draw: (image) => {
          const next = image as ImageBitmap
          bitmap?.close()
          bitmap = next
          paint(next)
          host.dataset.frame = '1'
          host.dataset.frameWidth=String(next.width);host.dataset.frameHeight=String(next.height)
          drawn++
          if(firstFrame){onMetrics({width:next.width,height:next.height,fps:0});firstFrame=false;drawn=0;measuredAt=performance.now()}
          report('live', '')
        },
      })
    } catch (error) {
      report('error', publicError(error, secret))
    } finally {
      painting = false
      if (alive && slot.peek()) void pump()
    }
  }

  function viewBox() {
    const rect = host.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }

  function pointerLocked() {
    return document.pointerLockElement === host
  }

  function samplePointer(event: PointerEvent, locked: boolean) {
    if (!screen || !frameSize) return null
    const box = viewBox()
    const confined = confineStreamPointer(
      aim,
      {
        localX: event.clientX - box.left,
        localY: event.clientY - box.top,
        cssDx: event.movementX,
        cssDy: event.movementY,
        locked,
      },
      box.width,
      box.height,
      frameSize.width,
      frameSize.height,
      screen.screenWidth,
      screen.screenHeight,
    )
    if (!confined) return null
    aim = confined.aim
    return confined
  }

  function lockPointer() {
    if (pointerLocked()) return
    const request = host.requestPointerLock?.bind(host)
    if (!request) return
    let pending: unknown
    try {
      pending = request({ unadjustedMovement: false })
    } catch {
      try { pending = request() } catch { return }
    }
    if (pending && typeof (pending as Promise<void>).catch === 'function') {
      ;(pending as Promise<void>).catch(() => undefined)
    }
  }

  function unlockPointer() {
    if (pointerLocked()) document.exitPointerLock()
    host.classList.remove('is-locked')
  }

  function ownsPointer(event: PointerEvent) {
    if (pointerLocked()) return true
    if (host.hasPointerCapture(event.pointerId)) return true
    const target = event.target
    return target instanceof Node && host.contains(target)
  }

  function oncePointer(event: Event) {
    if (seenPointer === event) return false
    seenPointer = event
    return true
  }

  function eventMods(event: KeyboardEvent | MouseEvent | WheelEvent) {
    return glfwMods({
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      capsLock: event.getModifierState('CapsLock'),
      numLock: event.getModifierState('NumLock'),
    })
  }

  async function releaseEditor() {
    if (!editorHeld) return
    editorHeld = false
    try { await editorOf()?.release() } catch { /* 会话已经结束。 */ }
  }

  function focused() {
    return document.activeElement === host
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!alive) return
    const chord = levelStreamChord(event)
    if (chord && editorOf()?.shortcut) {
      event.preventDefault(); event.stopPropagation()
      if (!event.repeat) void editorOf()?.shortcut?.(chord === 'save' ? 'save' : chord === 'redo' ? 'redo' : 'undo').catch(error => report('error', publicError(error, secret)))
      return
    }
    if (chord === 'save') {
      editorOf()?.beforeSave?.()
      return
    }
    const target = event.target
    if (isFormFieldTarget(target instanceof Element ? target : null)) return
    if (chord === 'undo' || chord === 'redo') {
      editorOf()?.history?.(chord === 'redo')
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!focused()) return
    if (ended) return
    if (event.isComposing) {
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const mapping = glfwKeyFromCode(event.code)
    if (!mapping) return
    const mods = eventMods(event)
    batch.push({
      type: RPIN_KEY_DOWN,
      flags: event.repeat ? 1 : 0,
      mods,
      key: mapping.key,
      scancode: mapping.scancode,
    })
    pressed.set(event.code, mapping)
    const codepoint = charCodepoint(event.key, false, mods)
    if (codepoint !== null) batch.push({ type: RPIN_CHAR, flags: 0, mods, codepoint })
    scheduleFlush()
  }

  function onKeyUp(event: KeyboardEvent) {
    if (!alive) return
    const chord = levelStreamChord(event)
    if (chord === 'save') return
    if (chord) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!focused() && !pressed.has(event.code)) return
    if (ended) return
    const target = event.target
    if (isFormFieldTarget(target instanceof Element ? target : null)) return
    event.preventDefault()
    event.stopPropagation()
    const mapping = glfwKeyFromCode(event.code)
    if (!mapping) return
    pressed.delete(event.code)
    batch.push({ type: RPIN_KEY_UP, flags: 0, mods: eventMods(event), key: mapping.key, scancode: mapping.scancode })
    scheduleFlush()
  }

  function onPointerDown(event: PointerEvent) {
    if (!oncePointer(event) || !alive || ended) return
    const target = event.target
    if (!pointerLocked() && isFormFieldTarget(target instanceof Element ? target : null)) return
    host.focus({ preventScroll: true })
    try { host.setPointerCapture(event.pointerId) } catch { /* 指针可能已经松开。 */ }
    const locked = pointerLocked()
    if (event.button === 1 || event.button === 2) lockPointer()
    event.preventDefault()
    event.stopPropagation()
    const sample = samplePointer(event, locked)
    if (!sample) return
    const button = glfwMouseButton(event.button)
    buttons.set(button, sample.point)
    batch.push({ type: RPIN_BUTTON_DOWN, flags: 0, mods: eventMods(event), button, x: sample.point.x, y: sample.point.y })
    scheduleFlush()
  }

  function onPointerMove(event: PointerEvent) {
    if (!oncePointer(event) || !alive || ended || !ownsPointer(event)) return
    const target = event.target
    if (!pointerLocked() && isFormFieldTarget(target instanceof Element ? target : null)) return
    event.preventDefault()
    event.stopPropagation()
    const sample = samplePointer(event, pointerLocked())
    if (!sample) return
    for (const button of buttons.keys()) buttons.set(button, sample.point)
    batch.push({
      type: RPIN_MOVE,
      flags: 0,
      mods: eventMods(event),
      x: sample.point.x,
      y: sample.point.y,
      dx: sample.delta.dx,
      dy: sample.delta.dy,
    })
    scheduleFlush()
  }

  function onPointerUp(event: PointerEvent) {
    if (!oncePointer(event) || !alive || ended || !ownsPointer(event)) return
    const target = event.target
    if (!pointerLocked() && isFormFieldTarget(target instanceof Element ? target : null)) return
    event.preventDefault()
    event.stopPropagation()
    const button = glfwMouseButton(event.button)
    const sample = samplePointer(event, pointerLocked())
    const point = sample?.point ?? buttons.get(button)
    if (!point || !buttons.has(button)) return
    buttons.delete(button)
    batch.push({ type: RPIN_BUTTON_UP, flags: 0, mods: eventMods(event), button, x: point.x, y: point.y })
    flushNow(true)
    if (buttons.size === 0) unlockPointer()
  }

  function releaseHeldButtons() {
    if (buttons.size === 0) return
    editorOf()?.cancel?.()
    for (const [button, point] of buttons) {
      buttons.delete(button)
      batch.push({ type: RPIN_BUTTON_UP, flags: 0, mods: 0, button, x: point.x, y: point.y })
    }
    flushNow(true)
  }

  function onLostPointerCapture() {
    // Pointer lock keeps the drag after capture ends. A normal pointerup already sent BUTTON_UP.
    if (pointerLocked()) return
    releaseHeldButtons()
  }

  function onPointerCancel(event: PointerEvent) {
    if (!oncePointer(event)) return
    event.preventDefault()
    event.stopPropagation()
    releaseHeldButtons()
  }

  function onPointerLockChange() {
    const locked = pointerLocked()
    host.classList.toggle('is-locked', locked)
    if (!locked) releaseHeldButtons()
  }

  function onWheel(event: WheelEvent) {
    if (!alive || ended) return
    const target = event.target
    if (isFormFieldTarget(target instanceof Element ? target : null)) return
    event.preventDefault()
    event.stopPropagation()
    batch.push({
      type: RPIN_WHEEL,
      flags: 0,
      mods: eventMods(event),
      dxCenti: -wheelCenti(event.deltaX, event.deltaMode),
      dyCenti: -wheelCenti(event.deltaY, event.deltaMode),
    })
    scheduleFlush()
  }

  function onContextMenu(event: Event) {
    event.preventDefault()
    event.stopPropagation()
  }

  function onBlur() {
    editorOf()?.cancel?.()
    releaseInputs(true)
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      editorOf()?.cancel?.()
      releaseInputs(true)
    }
  }

  function failSocket() {
    if (!alive || ended) return
    report('error', '云游戏会话失败')
    stop()
  }

  async function begin() {
    const editor = editorOf()
    if (editor) {
      await editor.acquire()
      editorHeld = true
      if (!alive) {
        await releaseEditor()
        return
      }
    }
    let response: Response
    try {
      response = await fetch(endpoints.start, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(streamStartBody(settings)),
        // Keep the start acknowledgement observable after unmount, so an accepted start is stopped.
        signal: AbortSignal.timeout(6000),
      })
    } catch (error) {
      if (!alive) return
      throw error
    }
    if (!alive) {
      if (response.ok) {
        started = true
        await postStop()
      }
      return
    }
    if (!response.ok) throw new Error('云游戏会话失败')
    started = true
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      const status = await fetch(endpoints.status, { headers: authHeaders(false), signal: abort.signal })
      if (!status.ok) throw new Error('云游戏会话失败')
      try {
        screen = readStreamScreen(await status.json())
        break
      } catch (error) {
        if (attempt === 19) throw error
        await new Promise(resolve => window.setTimeout(resolve, 50))
      }
    }
    if (!alive) {
      await postStop()
      return
    }
    if (!screen) throw new Error('缺少窗口屏幕尺寸')
    frames = new WebSocket(endpoints.frames)
    frames.binaryType = 'arraybuffer'
    frames.onmessage = (event) => {
      if (!alive || !(event.data instanceof ArrayBuffer)) return
      slot.put(event.data)
      void pump()
    }
    frames.onerror = () => { if (alive && !ended) report('error', '云游戏会话失败') }
    frames.onclose = failSocket
    input = new WebSocket(endpoints.input)
    input.onerror = () => { if (alive && !ended) report('error', '云游戏会话失败') }
    input.onclose = failSocket
    input.onopen = () => flushNow(true)
    metricsTimer=window.setInterval(()=>{
      if(!alive||!frameSize)return
      const now=performance.now(),fps=Math.round(drawn*1000/Math.max(1,now-measuredAt))
      onMetrics({...frameSize,fps});host.dataset.fps=String(fps);drawn=0;measuredAt=now
    },1000)
    statusTimer = window.setInterval(() => {
      void fetch(endpoints.status, { headers: authHeaders(false), signal: AbortSignal.timeout(2000) })
        .then((item) => item.ok ? item.json() : null)
        .then((body) => {
          if (alive && body) screen = readStreamScreen(body)
        })
        .catch(() => undefined)
    }, 2000)
    report('connecting', '')
  }

  async function end() {
    if (ended) return
    ended = true
    window.clearInterval(statusTimer)
    window.clearInterval(metricsTimer)
    releaseInputs(true)
    unlockPointer()
    frames?.close()
    input?.close()
    frames = null
    input = null
    bitmap?.close()
    bitmap = null
    await postStop()
    await releaseEditor()
  }

  function stop() {
    if (!alive) return
    alive = false
    abort.abort()
    void enqueueSession(() => end())
  }

  const observer = new ResizeObserver(() => { if (bitmap) paint(bitmap) })
  host.addEventListener('keydown', onKeyDown)
  host.addEventListener('keyup', onKeyUp)
  host.addEventListener('pointerdown', onPointerDown)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerup', onPointerUp)
  host.addEventListener('pointercancel', onPointerCancel)
  host.addEventListener('lostpointercapture', onLostPointerCapture)
  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('pointerup', onPointerUp, true)
  document.addEventListener('pointercancel', onPointerCancel, true)
  document.addEventListener('pointerlockchange', onPointerLockChange)
  host.addEventListener('wheel', onWheel, { passive: false })
  host.addEventListener('contextmenu', onContextMenu)
  host.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  observer.observe(host)

  void enqueueSession(async () => {
    if (!alive) return
    try {
      await begin()
    } catch (error) {
      if (alive) report('error', publicError(error, secret))
      await end()
    }
    if (!alive) await end()
  })

  return {
    configure(next: StreamSettings) {
      return enqueueSession(async()=>{
        if(!alive||ended||!started)throw Error('请先连接游戏串流')
        releaseInputs(true);editorOf()?.cancel?.()
        const response=await fetch(endpoints.configure,{method:'POST',headers:authHeaders(true),body:JSON.stringify(next),signal:AbortSignal.timeout(6000)})
        if(response.status===404)throw Error('当前模组不支持实时画质设置，请更新模组；当前画面仍可使用')
        if(!response.ok)throw Error('串流设置未应用，保留当前画面')
        if(!alive||ended)return
        slot.take();drawn=0;measuredAt=performance.now()
      })
    },
    stop() {
      host.removeEventListener('keydown', onKeyDown)
      host.removeEventListener('keyup', onKeyUp)
      host.removeEventListener('pointerdown', onPointerDown)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerup', onPointerUp)
      host.removeEventListener('pointercancel', onPointerCancel)
      host.removeEventListener('lostpointercapture', onLostPointerCapture)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      unlockPointer()
      host.removeEventListener('wheel', onWheel)
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      observer.disconnect()
      stop()
    },
  }
}

function publicError(error: unknown, secret: string): string {
  if (error instanceof DOMException && error.name === 'AbortError') return ''
  if (error instanceof TypeError) return '游戏开发服务器未连接'
  const message = error instanceof Error ? error.message : ''
  if (message === 'control_not_connected') return '游戏开发服务器未连接'
  if (message === 'edit_busy') return '已有地图编辑会话'
  if (message === 'edit_stale') return '地图编辑已过期'
  if (message === 'edit_invalid') return '地图编辑无效'
  if (message === 'edit_unavailable') return '地图编辑不可用'
  if (message === 'timeout') return '地图编辑无响应'
  if (!message || message.includes('://') || (secret.length > 0 && message.includes(secret))) return '云游戏会话失败'
  return message
}
