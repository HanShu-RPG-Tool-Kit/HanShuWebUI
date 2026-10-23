/**
 * WebUI C 侧 Control 订阅端：自动轮询连接本机游戏开发服务器，
 * 接收 mod 的 request/notify，回 response；并向 UI 广播日志。
 *
 * 已知模组问题：部分版本对 `/ws/control?password=`（甚至带头鉴权）握手会挂起无
 * 101，HTTP `/health` / `/control/status` 仍正常。此时必须超时中止 CONNECTING，
 * 否则 UI 会永远停在「连接中」。
 */

import { handleItemControlMethod } from './itemApi'
import {
  loadGameDevServerPrefs,
  saveGameDevServerPrefs,
  type GameDevServerPrefs,
} from './prefs'
import {
  fetchControlStatus,
  fetchDevToolHealth,
  parseInbound,
  controlWsUrl,
  type ControlRequest,
  type ControlNotify,
  type ControlStatus,
  type DevToolHealth,
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
  health: DevToolHealth | null
  status: ControlStatus | null
  logs: ControlLogEntry[]
  handled: number
  failed: number
}

const POLL_MS = 2500
/** 握手超过此时长仍无 open → 判定挂起并断开，避免永远 CONNECTING */
const CONNECT_TIMEOUT_MS = 4000
const LOG_LIMIT = 200
const WS_HANG_HINT =
  '门户 HTTP 正常，但 /ws/control 握手无响应（常见于旧模组查询串/鉴权路径 bug）。请升级含「WS 前缀匹配」修复的客户端；连法本身应为 ws://…/ws/control?password=…'

type Snapshot = ControlHubSnapshot

let prefs: GameDevServerPrefs = loadGameDevServerPrefs()
let phase: ConnPhase = prefs.autoConnect ? 'reconnecting' : 'disabled'
let lastError: string | null = null
let health: DevToolHealth | null = null
let status: ControlStatus | null = null
let logs: ControlLogEntry[] = []
let handled = 0
let failed = 0
let logSeq = 0
let started = false
let ws: WebSocket | null = null
let connectGeneration = 0
let connectTimer: ReturnType<typeof setTimeout> | null = null
/** 冷却：握手挂起后稍后再试，避免狂打 */
let nextConnectAt = 0
let outboundSeq = 0
type PendingOutbound = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const notifyListeners = new Set<(note: ControlNotify) => void>()
const pendingOutbound = new Map<string, PendingOutbound>()

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function snapshot(): Snapshot {
  return {
    phase,
    prefs: { ...prefs },
    lastError,
    health,
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

/** 导出当前内存日志为文本（新→旧），便于粘贴排查 */
export function formatControlLogsForClipboard(): string {
  if (logs.length === 0) return ''
  const lines: string[] = [
    `# HanShu Control 日志 ${new Date().toISOString()} · ${logs.length} 条`,
    '',
  ]
  for (const entry of logs) {
    lines.push(
      `[${new Date(entry.at).toISOString()}] ${entry.kind} ${entry.summary}`,
    )
    if (entry.detail) {
      lines.push(entry.detail)
      lines.push('')
    }
  }
  return lines.join('\n')
}

export async function copyControlLogsToClipboard(): Promise<boolean> {
  const text = formatControlLogsForClipboard()
  if (!text) return false
  await navigator.clipboard.writeText(text)
  return true
}

function setPhase(next: ConnPhase) {
  if (phase === next) return
  phase = next
}

function clearConnectTimer() {
  if (connectTimer) {
    clearTimeout(connectTimer)
    connectTimer = null
  }
}

function rejectAllOutbound(message: string) {
  for (const [id, pending] of pendingOutbound) {
    clearTimeout(pending.timer)
    pending.reject(new Error(message))
    pendingOutbound.delete(id)
  }
}

function closeSocket(reason?: string) {
  clearConnectTimer()
  const sock = ws
  ws = null
  rejectAllOutbound('disconnected')
  void import('./itemSnapshotRefresh').then((m) => m.onControlConnectionChange(false))
  if (!sock) return
  try {
    sock.onopen = null
    sock.onclose = null
    sock.onerror = null
    sock.onmessage = null
    if (
      sock.readyState === WebSocket.CONNECTING ||
      sock.readyState === WebSocket.OPEN
    ) {
      sock.close()
    }
  } catch {
    /* ignore */
  }
  if (reason) {
    pushLog('info', reason)
  }
}

async function refreshPortal(): Promise<void> {
  try {
    health = await fetchDevToolHealth(prefs.host, prefs.port, prefs.password)
    status = await fetchControlStatus(prefs.host, prefs.port, prefs.password)
    if (!lastError?.includes('握手')) lastError = null
  } catch (err) {
    health = null
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
  for (const listener of notifyListeners) {
    try {
      listener(note)
    } catch (err) {
      console.error('control notify listener failed', err)
    }
  }
  bump()
}

/** 订阅 mod → WebUI 的 notify（如 `items.edit.done`） */
export function subscribeControlNotify(
  listener: (note: ControlNotify) => void,
): () => void {
  notifyListeners.add(listener)
  return () => {
    notifyListeners.delete(listener)
  }
}

function attachSocket(sock: WebSocket, generation: number) {
  sock.onopen = () => {
    if (generation !== connectGeneration || ws !== sock) return
    clearConnectTimer()
    setPhase('open')
    lastError = null
    nextConnectAt = 0
    pushLog('info', `已连接 ${controlWsUrl(prefs.host, prefs.port, '***')}`)
    void refreshPortal().then(bump)
    bump()
    void import('./itemSnapshotRefresh').then((m) => m.onControlConnectionChange(true))
  }
  sock.onmessage = (event) => {
    if (generation !== connectGeneration || ws !== sock) return
    if (typeof event.data !== 'string') return
    const frame = parseInbound(event.data)
    if (!frame) return
    if (frame.type === 'request') void handleRequest(frame)
    else if (frame.type === 'notify') handleNotify(frame)
    else if (frame.type === 'response') {
      const pending = pendingOutbound.get(frame.id)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingOutbound.delete(frame.id)
      pushLog(
        'response',
        frame.ok === false
          ? `→ response #${frame.id} error=${frame.error || 'remote_error'}`
          : `→ response #${frame.id} ok`,
        JSON.stringify(frame),
      )
      if (frame.ok === false) {
        pending.reject(new Error(frame.error || 'remote_error'))
      } else {
        pending.resolve(frame.result)
      }
      bump()
    }
  }
  sock.onerror = () => {
    if (generation !== connectGeneration || ws !== sock) return
    // 浏览器对 WS 错误几乎不给细节；握手挂起时往往只有随后的 close/timeout
    if (!lastError) lastError = 'WebSocket 错误'
  }
  sock.onclose = (event) => {
    if (generation !== connectGeneration) return
    clearConnectTimer()
    if (ws === sock) ws = null
    if (!prefs.autoConnect) {
      setPhase('disabled')
      pushLog('info', '连接已关闭（自动连接已关闭）')
    } else {
      setPhase('reconnecting')
      const detail = event.reason || `code=${event.code}`
      if (!lastError?.includes('握手')) {
        pushLog('info', `连接断开，将自动重试…（${detail}）`)
      }
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
  if (Date.now() < nextConnectAt) {
    setPhase('reconnecting')
    bump()
    return
  }
  if (ws?.readyState === WebSocket.OPEN) return
  // 卡住的 CONNECTING 必须先掐掉，否则永远不重试
  if (ws?.readyState === WebSocket.CONNECTING) {
    closeSocket()
  }

  connectGeneration += 1
  const generation = connectGeneration
  setPhase('connecting')
  bump()
  const url = controlWsUrl(prefs.host, prefs.port, prefs.password)
  try {
    const sock = new WebSocket(url)
    ws = sock
    attachSocket(sock, generation)
    clearConnectTimer()
    connectTimer = setTimeout(() => {
      connectTimer = null
      if (generation !== connectGeneration || ws !== sock) return
      if (sock.readyState !== WebSocket.CONNECTING) return
      lastError = WS_HANG_HINT
      nextConnectAt = Date.now() + 8000
      pushLog('error', 'Control WebSocket 握手超时', WS_HANG_HINT)
      closeSocket('已中止挂起的握手')
      setPhase('reconnecting')
      bump()
    }, CONNECT_TIMEOUT_MS)
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
  await refreshPortal()
  if (ws?.readyState === WebSocket.OPEN) {
    bump()
    return
  }
  if (ws?.readyState === WebSocket.CONNECTING) {
    // 交给 connectTimer 处理挂起
    bump()
    return
  }
  tryConnect()
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

/**
 * WebUI → mod 出站 RPC。连接未就绪时立即失败 `control_not_connected`。
 */
export function controlRequest(
  method: string,
  params: unknown = null,
  timeoutMs = 12000,
): Promise<unknown> {
  const sock = ws
  if (!sock || sock.readyState !== WebSocket.OPEN || phase !== 'open') {
    return Promise.reject(new Error('control_not_connected'))
  }
  if (!method) return Promise.reject(new Error('missing_method'))
  outboundSeq += 1
  const id = String(outboundSeq)
  const frame = { type: 'request' as const, id, method, params: params ?? null }
  const text = JSON.stringify(frame)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOutbound.delete(id)
      reject(new Error('timeout'))
      bump()
    }, timeoutMs)
    pendingOutbound.set(id, { resolve, reject, timer })
    try {
      sock.send(text)
      pushLog('request', `← request #${id} ${method}`, text)
      bump()
    } catch (err) {
      clearTimeout(timer)
      pendingOutbound.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

export function isControlConnected(): boolean {
  return phase === 'open' && !!ws && ws.readyState === WebSocket.OPEN
}

/** App 挂载时调用一次；之后靠轮询维持连接。 */
export function ensureGameDevControlStarted(): void {
  if (started) return
  started = true
  prefs = loadGameDevServerPrefs()
  void import('./itemSnapshotRefresh').then((m) => m.ensureItemSnapshotRefreshStarted())
  void import('./itemEdit').then((m) => m.ensureItemEditNotifyStarted())
  if (prefs.autoConnect) {
    setPhase('connecting')
    void refreshPortal().then(() => {
      tryConnect()
      bump()
    })
  } else {
    setPhase('disabled')
  }
  setInterval(() => {
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
  nextConnectAt = 0
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
  nextConnectAt = 0
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
