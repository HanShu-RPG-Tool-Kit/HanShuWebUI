/** 游戏开发服务器（本机 Control 门户）连接偏好 — C 侧本地状态 */

export type GameDevServerPrefs = {
  host: string
  port: number
  password: string
  /** 为 false 时停止自动重连轮询 */
  autoConnect: boolean
}

export const DEFAULT_GAME_DEV_HOST = '127.0.0.1'
export const DEFAULT_GAME_DEV_PORT = 8765
export const DEFAULT_GAME_DEV_PASSWORD = 'mchhui'

const STORAGE_KEY = 'hanshu.gameDevServer.v1'

export const DEFAULT_GAME_DEV_PREFS: GameDevServerPrefs = {
  host: DEFAULT_GAME_DEV_HOST,
  port: DEFAULT_GAME_DEV_PORT,
  password: DEFAULT_GAME_DEV_PASSWORD,
  autoConnect: true,
}

function clampPort(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_GAME_DEV_PORT
  const p = Math.floor(n)
  if (p < 1 || p > 65535) return DEFAULT_GAME_DEV_PORT
  return p
}

export function loadGameDevServerPrefs(): GameDevServerPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_GAME_DEV_PREFS }
    const parsed = JSON.parse(raw) as Partial<GameDevServerPrefs>
    return {
      host:
        typeof parsed.host === 'string' && parsed.host.trim()
          ? parsed.host.trim()
          : DEFAULT_GAME_DEV_HOST,
      port: clampPort(Number(parsed.port)),
      password:
        typeof parsed.password === 'string' && parsed.password
          ? parsed.password
          : DEFAULT_GAME_DEV_PASSWORD,
      autoConnect: parsed.autoConnect !== false,
    }
  } catch {
    return { ...DEFAULT_GAME_DEV_PREFS }
  }
}

export function saveGameDevServerPrefs(prefs: GameDevServerPrefs): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        host: prefs.host.trim() || DEFAULT_GAME_DEV_HOST,
        port: clampPort(prefs.port),
        password: prefs.password || DEFAULT_GAME_DEV_PASSWORD,
        autoConnect: prefs.autoConnect !== false,
      }),
    )
  } catch {
    /* private mode */
  }
}
