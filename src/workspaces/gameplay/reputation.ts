import { parseJsonValue } from '../../utils/strictJson'
import { parseFlatResourceId } from './actor'
import { isObject } from './model'

export const REPUTATION_MAX_BANNER_BYTES = 256 * 1024
export type ReputationStanding = 'hostile' | 'neutral' | 'friendly'
export type ReputationDocument = {
  format: 'rpgtoolkit:reputation-faction'
  version: 1
  defaultPoints: number
  neutralPoints: number
  friendlyPoints: number
  hostile: string[]
  hidden: boolean
  attackedByMobs: boolean
  banner?: string | null
}

const REQUIRED_KEYS = [
  'format', 'version', 'defaultPoints', 'neutralPoints', 'friendlyPoints', 'hostile', 'hidden', 'attackedByMobs',
] as const
const OPTIONAL_KEYS = ['banner'] as const
const ALL_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS])

export const createReputation = (): ReputationDocument => ({
  format: 'rpgtoolkit:reputation-faction',
  version: 1,
  defaultPoints: 0,
  neutralPoints: 0,
  friendlyPoints: 1,
  hostile: [],
  hidden: false,
  attackedByMobs: false,
})

export function stringifyReputation(doc: ReputationDocument): string {
  const out: Record<string, unknown> = {
    format: 'rpgtoolkit:reputation-faction',
    version: 1,
    defaultPoints: doc.defaultPoints,
    neutralPoints: doc.neutralPoints,
    friendlyPoints: doc.friendlyPoints,
    hostile: doc.hostile,
    hidden: doc.hidden,
    attackedByMobs: doc.attackedByMobs,
  }
  if (doc.banner != null && doc.banner !== '') out.banner = doc.banner
  return JSON.stringify(out, null, 2)
}

function requireInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} 必须是整数`)
  if (value < -2147483648 || value > 2147483647) throw new Error(`${label} 超出 int 范围`)
  return value
}

function requireBool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`)
  return value
}

/** PNG signature check + Base64 decode size limit, matching Mod. */
export function validateReputationBanner(base64: string): string {
  const trimmed = base64.trim()
  if (!trimmed) return ''
  let decoded: Uint8Array
  try {
    const binary = atob(trimmed)
    decoded = Uint8Array.from(binary, char => char.charCodeAt(0))
  } catch {
    throw new Error('banner 必须是 Base64 PNG')
  }
  if (!decoded.length || decoded.length > REPUTATION_MAX_BANNER_BYTES) throw new Error('banner 大小超出范围')
  if (decoded.length < 8 || decoded[0] !== 0x89 || decoded[1] !== 0x50 || decoded[2] !== 0x4e || decoded[3] !== 0x47) {
    throw new Error('banner 必须是 PNG')
  }
  return trimmed
}

export function reputationStanding(doc: Pick<ReputationDocument, 'neutralPoints' | 'friendlyPoints'>, points: number): ReputationStanding {
  if (points < doc.neutralPoints) return 'hostile'
  if (points >= doc.friendlyPoints) return 'friendly'
  return 'neutral'
}

/** Client standings bar: mid span between thresholds, outer = mid/2, neutral@25%, friendly@75%. */
export function reputationBarRatio(doc: Pick<ReputationDocument, 'neutralPoints' | 'friendlyPoints'>, points: number): number {
  const { neutralPoints, friendlyPoints } = doc
  if (neutralPoints === friendlyPoints) return points >= friendlyPoints ? 1 : 0
  const mid = friendlyPoints - neutralPoints
  const outer = Math.max(1, Math.trunc(mid / 2))
  const min = neutralPoints - outer
  const max = friendlyPoints + outer
  if (points <= min) return 0
  if (points >= max) return 1
  if (points === neutralPoints) return 0.25
  if (points === friendlyPoints) return 0.75
  if (points < neutralPoints) return 0.25 * (points - min) / (neutralPoints - min)
  if (points < friendlyPoints) return 0.25 + 0.5 * (points - neutralPoints) / (friendlyPoints - neutralPoints)
  return 0.75 + 0.25 * (points - friendlyPoints) / (max - friendlyPoints)
}

export function parseReputation(source: string): ReputationDocument {
  const raw = parseJsonValue(source)
  if (!isObject(raw) || raw.format !== 'rpgtoolkit:reputation-faction' || raw.version !== 1) {
    throw new Error('需要 rpgtoolkit:reputation-faction version 1 声誉阵营')
  }
  for (const key of REQUIRED_KEYS) if (!(key in raw)) throw new Error(`声誉阵营缺少字段：${key}`)
  for (const key of Object.keys(raw)) if (!ALL_KEYS.has(key)) throw new Error(`未知声誉阵营字段：${key}`)
  const defaultPoints = requireInt(raw.defaultPoints, 'defaultPoints')
  const neutralPoints = requireInt(raw.neutralPoints, 'neutralPoints')
  const friendlyPoints = requireInt(raw.friendlyPoints, 'friendlyPoints')
  if (neutralPoints > friendlyPoints) throw new Error('neutralPoints 不能大于 friendlyPoints')
  if (!Array.isArray(raw.hostile) || raw.hostile.some(id => typeof id !== 'string')) throw new Error('hostile 必须是字符串列表')
  const hostile: string[] = []
  const seen = new Set<string>()
  for (const entry of raw.hostile as string[]) {
    const id = parseFlatResourceId(entry, '敌对阵营')
    if (seen.has(id)) throw new Error(`重复的敌对阵营：${id}`)
    seen.add(id)
    hostile.push(id)
  }
  let banner: string | null | undefined
  if ('banner' in raw) {
    if (raw.banner == null) banner = null
    else {
      if (typeof raw.banner !== 'string') throw new Error('banner 必须是字符串')
      banner = validateReputationBanner(raw.banner)
    }
  }
  return {
    format: 'rpgtoolkit:reputation-faction',
    version: 1,
    defaultPoints,
    neutralPoints,
    friendlyPoints,
    hostile,
    hidden: requireBool(raw.hidden, 'hidden'),
    attackedByMobs: requireBool(raw.attackedByMobs, 'attackedByMobs'),
    banner,
  }
}
