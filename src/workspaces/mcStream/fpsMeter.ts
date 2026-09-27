/**
 * 监视端帧时间统计（基于实际呈现时刻）。
 * 1% / 0.1% low：最慢那部分帧的平均帧时间 → 换算成 FPS（CapFrameX 风格）。
 */

export type MonitorFpsSnapshot = {
  /** 最近一帧瞬时 FPS */
  instant: number
  /** 窗口内平均 FPS */
  avg: number
  /** 1% low FPS */
  low1: number
  /** 0.1% low FPS */
  low01: number
  /** 窗口内样本数 */
  samples: number
}

const MAX_SAMPLES = 600
const MIN_SAMPLES_FOR_LOW = 50

export class MonitorFpsMeter {
  private times: number[] = []
  private lastTs = 0
  private head = 0
  private count = 0
  private readonly capacity: number

  constructor(capacity = MAX_SAMPLES) {
    this.capacity = capacity
    this.times = new Array(capacity)
  }

  reset() {
    this.head = 0
    this.count = 0
    this.lastTs = 0
  }

  /** @param nowMs performance.now() */
  push(nowMs: number): MonitorFpsSnapshot | null {
    if (this.lastTs > 0) {
      const dt = nowMs - this.lastTs
      // 忽略异常间隔（切后台、暂停）
      if (dt > 0 && dt < 1000) {
        this.times[this.head] = dt
        this.head = (this.head + 1) % this.capacity
        if (this.count < this.capacity) this.count++
      }
    }
    this.lastTs = nowMs
    if (this.count < 2) return null
    return this.snapshot()
  }

  snapshot(): MonitorFpsSnapshot | null {
    if (this.count < 2) return null
    const n = this.count
    const buf = new Array<number>(n)
    const start = this.count < this.capacity ? 0 : this.head
    for (let i = 0; i < n; i++) {
      buf[i] = this.times[(start + i) % this.capacity]!
    }

    let sum = 0
    for (let i = 0; i < n; i++) sum += buf[i]!
    const avgMs = sum / n
    const last = buf[n - 1]!
    const instant = 1000 / last
    const avg = 1000 / avgMs

    // 帧时间从大到小（最慢在前）
    buf.sort((a, b) => b - a)

    const low1 = percentileLowFps(buf, 0.01)
    const low01 = percentileLowFps(buf, 0.001)

    return {
      instant,
      avg,
      low1,
      low01,
      samples: n,
    }
  }
}

function percentileLowFps(sortedWorstFirst: number[], fraction: number): number {
  const n = sortedWorstFirst.length
  if (n < MIN_SAMPLES_FOR_LOW) {
    // 样本不足时用最慢帧近似
    return 1000 / sortedWorstFirst[0]!
  }
  const k = Math.max(1, Math.ceil(n * fraction))
  let sum = 0
  for (let i = 0; i < k; i++) sum += sortedWorstFirst[i]!
  return 1000 / (sum / k)
}

export function formatMonitorFps(s: MonitorFpsSnapshot): string {
  const f = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))
  return `监视 ${f(s.avg)} fps · 即时 ${f(s.instant)} · 1% low ${f(s.low1)} · 0.1% low ${f(s.low01)}`
}
