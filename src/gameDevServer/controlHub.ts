/**
 * WebUI C 侧 Control 订阅端：自动轮询连接本机游戏开发服务器，
 * 接收 mod 的 request/notify，回 response；并向 UI 广播日志。
 */

import { handleItemControlMethod } from './itemApi'
import {
  loadGameDevServerPrefs,
  saveGameDevServerPrefs,
  type GameDevServerPrefs,
} from './prefs'
import {
  fetchControlStatus,
  parseInbound,
  controlWsUrl,
  type ControlRequest,
  type ControlNotify,
  type ControlStatus,
} from './protocol'

export type ConnPhase =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'disabled'

export type ControlLogKind =
  | 'info'
  | 'error'
  | 'request'
  | 'response'
  | 'notify'

export type ControlLogEntry = {
  id: number
  at: number
  kind: ControlLogKind
  summary: string
  detail?: string
}

export type ControlHubSnapshot = {
  phase: ConnPhase
  prefs: GameDevServerPrefs
  lastError: string | null
  status: ControlStatus | null
  logs: ControlLogEntry[]
  handled: number
  failed: number
}

const POLL_MS = 2500
const LOG_LIMIT = 200

type Snapshot = ControlHubSnapshot

let prefs: GameDevServerPrefs = loadGameDevServerPrefs()
let phase: ConnPhase = prefs.autoConnect ? 'reconnecting' : 'disabled'
let lastError: string | null = null
let status: ControlStatus | null = null
let logs: ControlLogEntry[] = []
let handled = 0
let failed = 0
let logSeq = 0
let started = false
let ws: WebSocket | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let connectGeneration = 0

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function snapshot(): Snapshot {
  return {
    phase,
    prefs: { ...prefs },
    lastError,
    status,
    logs,
    handled,
    failed,
  }
}

let cached: Snapshot = snapshot()

function bump() {
  cached = snapshot()
  emit()
}

function pushLog(
  kind: ControlLogKind,
  summary: string,
  detail?: string,
): void {
  logSeq += 1
  logs = [
    { id: logSeq, at: Date.now(), kind, summary, detail },
    ...logs,
  ].slice(0, LOG_LIMIT)
}

function setPhase(next: ConnPhase) {
  if (phase === next) return
  phase = next
}

function closeSocket(reason?: string) {
  const sock = ws
  ws = null
  if (!sock) return
  try {
    sock.onopen = null
    sock.onclose = null
    sock.onerror = null
    sock.onmessage = null
    sock.close()
  } catch {
    /* ignore */
  }
  if (reason) {
    pushLog('info', reason)
  }
}

async function refreshStatus(): Promise<void> {
  try {
    status = await fetchControlStatus(prefs.host, prefs.port, prefs.password)
    lastError = null
  } catch (err) {
    status = null
    lastError = err instanceof Error ? err.message : String(err)
  }
}

function respond(id: string, ok: boolean, result?: unknown, error?: string) {
  const sock = ws
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  const frame = ok
    ? { type: 'response', id, ok: true, result }
    : { type: 'response', id, ok: false, error: error || 'remote_error' }
  const text = JSON.stringify(frame)
  sock.send(text)
  pushLog(
    'response',
    ok ? `← response #${id} ok` : `← response #${id} error=${frame.error}`,
    text,
  )
  if (ok) handled += 1
  else failed += 1
}

async function handleRequest(req: ControlRequest) {
  pushLog(
    'request',
    `→ request #${req.id} ${req.method}`,
    JSON.stringify(req),
  )
  try {
    const outcome = handleItemControlMethod(req.method, req.params)
    if (outcome.ok) respond(req.id, true, outcome.result)
    else respond(req.id, false, undefined, outcome.error)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    respond(req.id, false, undefined, message || 'handler_error')
  }
  bump()
}

function handleNotify(note: ControlNotify) {
  pushLog(
    'notify',
    `↪ notify ${note.method}`,
    JSON.stringify(note),
  )
  bump()
}

function attachSocket(sock: WebSocket, generation: number) {
  sock.onopen = () => {
    if (generation !== connectGeneration || ws !== sock) return
    setPhase('open')
    lastError = null
    pushLog('info', `已连接 ${controlWsUrl(prefs.host, prefs.port, '***')}`)
    void refreshStatus().then(bump)
    bump()
  }
  sock.onmessage = (event) => {
    if (generation !== connectGeneration || ws !== sock) return
    if (typeof event.data !== 'string') return
    const frame = parseInbound(event.data)
    if (!frame) return
    if (frame.type === 'request') void handleRequest(frame)
    else if (frame.type === 'notify') handleNotify(frame)
  }
  sock.onerror = () => {
    if (generation !== connectGeneration || ws !== sock) return
    lastError = 'WebSocket 错误'
  }
  sock.onclose = () => {
    if (generation !== connectGeneration) return
    if (ws === sock) ws = null
    if (!prefs.autoConnect) {
      setPhase('disabled')
      pushLog('info', '连接已关闭（自动连接已关闭）')
    } else {
      setPhase('reconnecting')
      pushLog('info', '连接断开，将自动重试…')
    }
    bump()
  }
}

function tryConnect() {
  if (!prefs.autoConnect) {
    setPhase('disabled')
    bump()
    return
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }
  connectGeneration += 1
  const generation = connectGeneration
  setPhase(phase === 'open' ? 'reconnecting' : 'connecting')
  bump()
  const url = controlWsUrl(prefs.host, prefs.port, prefs.password)
  try {
    const sock = new WebSocket(url)
    ws = sock
    attachSocket(sock, generation)
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    setPhase('reconnecting')
    pushLog('error', `连接失败：${lastError}`)
    bump()
  }
}

async function pollTick() {
  if (!prefs.autoConnect) {
    if (phase !== 'disabled') {
      closeSocket()
      setPhase('disabled')
      bump()
    }
    return
  }
  await refreshStatus()
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    tryConnect()
  } else {
    bump()
  }
}

export function getControlHubSnapshot(): ControlHubSnapshot {
  return cached
}

export function subscribeControlHub(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** App 挂载时调用一次；之后靠轮询维持连接。 */
export function ensureGameDevControlStarted(): void {
  if (started) return
  started = true
  prefs = loadGameDevServerPrefs()
  if (prefs.autoConnect) {
    setPhase('connecting')
    tryConnect()
  } else {
    setPhase('disabled')
  }
  pollTimer = setInterval(() => {
    void pollTick()
  }, POLL_MS)
  bump()
}

export function updateGameDevServerPrefs(
  patch: Partial<GameDevServerPrefs>,
): void {
  const next: GameDevServerPrefs = {
    ...prefs,
    ...patch,
    host: (patch.host ?? prefs.host).trim() || prefs.host,
    port: patch.port ?? prefs.port,
    password: patch.password ?? prefs.password,
    autoConnect: patch.autoConnect ?? prefs.autoConnect,
  }
  const endpointChanged =
    next.host !== prefs.host ||
    next.port !== prefs.port ||
    next.password !== prefs.password
  prefs = next
  saveGameDevServerPrefs(prefs)
  pushLog('info', '已更新连接配置')
  if (!prefs.autoConnect) {
    closeSocket('已停止自动连接')
    setPhase('disabled')
    bump()
    return
  }
  if (endpointChanged || !ws || ws.readyState !== WebSocket.OPEN) {
    closeSocket(endpointChanged ? '配置变更，重新连接…' : undefined)
    tryConnect()
  }
  bump()
}

export function reconnectGameDevControlNow(): void {
  if (!prefs.autoConnect) {
    prefs = { ...prefs, autoConnect: true }
    saveGameDevServerPrefs(prefs)
  }
  closeSocket('手动重连…')
  tryConnect()
  bump()
}

export function clearControlLogs(): void {
  logs = []
  bump()
}

export function disconnectGameDevControl(): void {
  prefs = { ...prefs, autoConnect: false }
  saveGameDevServerPrefs(prefs)
  closeSocket('已断开')
  setPhase('disabled')
  bump()
}
