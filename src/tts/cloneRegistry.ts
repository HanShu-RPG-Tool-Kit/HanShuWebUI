/**
 * 克隆登记 —— `服务id + 样本内容指纹` → provider `voice_id`。
 *
 * 规范 §5.6:「克隆是**一次性登记**」。上传样本换一个 id,之后合成走普通端点。
 * 关键性质:**`.tts` 里存的是样本,不是 id** —— 所以换账号、换机器、厂商重置之后
 * 重新克隆并更新登记表即可,**不需要改任何工程文件**。
 *
 * 登记表住**应用级存储,不进工程**:它是"你这台机器和这个账号之间"的事实。
 * 换个人打开同一个工程,该拿到的是他自己的登记(或者发现还没有)。
 *
 * 指纹算的是**样本内容**,所以换了样本文件就会重新克隆一次。代价是多读一遍文件,
 * 换来的是"改了样本却还在用旧音色"这种最难查的错不会发生。
 */

import { createAppStorage, type StorageLike } from './appStore'

/** 克隆登记在 `localStorage` 里的键（沿用 `hanshu.*` 命名） */
export const CLONE_REGISTRY_KEY = 'hanshu.tts.clones.v1'

/**
 * 样本内容指纹：FNV-1a 32 位 → 8 位小写十六进制。
 *
 * 与 `i18n/textMap` 的 `hashLocaleKey` 是同一族算法,只是**输入域不同** ——
 * 那边喂文本的 UTF-16 码元,这边喂文件字节。不要为了"复用"把字节转成字符串:
 * 二进制转字符串会因编码丢字节,指纹就不再是内容的函数了。
 */
export function fingerprintBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 一批样本的指纹。**先排序** —— 同一组样本换个顺序还是同一批,
 * 不该因此重新克隆一次。
 */
export function fingerprintSamples(fingerprints: readonly string[]): string {
  return [...fingerprints].sort().join('-')
}

/** 登记键：服务 + 样本指纹。带服务前缀,因为同一份样本在不同账号下是不同 id */
export function cloneKeyOf(serviceId: string, fingerprints: readonly string[]): string {
  return `${serviceId}#${fingerprintSamples(fingerprints)}`
}

export type CloneEntry = {
  serviceId: string
  /** 样本内容指纹 —— 用来判断"还是不是同一批样本" */
  fingerprint: string
  voiceId: string
  /** 登记时间(毫秒) */
  at: number
}

export type CloneRegistry = {
  lookup(serviceId: string, fingerprints: readonly string[]): CloneEntry | null
  record(
    serviceId: string,
    fingerprints: readonly string[],
    voiceId: string,
    now?: number,
  ): CloneEntry
  /** 厂商重置 / 换账号后清掉某个服务的登记；返回清掉的条数 */
  forget(serviceId: string): number
  all(): CloneEntry[]
}

function toEntry(value: unknown): CloneEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.serviceId !== 'string' || typeof raw.voiceId !== 'string') return null
  if (typeof raw.fingerprint !== 'string') return null
  return {
    serviceId: raw.serviceId,
    fingerprint: raw.fingerprint,
    voiceId: raw.voiceId,
    at: typeof raw.at === 'number' ? raw.at : 0,
  }
}

export function createCloneRegistry(storage?: StorageLike): CloneRegistry {
  const store = createAppStorage(CLONE_REGISTRY_KEY, storage)
  const read = (): Record<string, CloneEntry> => {
    const out: Record<string, CloneEntry> = {}
    for (const [key, value] of Object.entries(store.read())) {
      const entry = toEntry(value)
      if (entry) out[key] = entry
    }
    return out
  }

  return {
    lookup: (serviceId, fingerprints) => read()[cloneKeyOf(serviceId, fingerprints)] ?? null,
    record: (serviceId, fingerprints, voiceId, now = Date.now()) => {
      const entry: CloneEntry = {
        serviceId,
        fingerprint: fingerprintSamples(fingerprints),
        voiceId,
        at: now,
      }
      const table = read()
      table[cloneKeyOf(serviceId, fingerprints)] = entry
      store.write(table)
      return entry
    },
    forget: (serviceId) => {
      const table = read()
      let removed = 0
      for (const key of Object.keys(table)) {
        if (table[key].serviceId === serviceId) {
          delete table[key]
          removed += 1
        }
      }
      if (removed) store.write(table)
      return removed
    },
    all: () => Object.values(read()),
  }
}

// ===== 与样本文件接上 =====

/** 读一个样本文件的字节；读不到返回 null */
export type SampleReader = (path: string) => Promise<Uint8Array | null>

async function fingerprintsOf(
  samples: readonly string[],
  readSample: SampleReader,
): Promise<string[] | null> {
  const fingerprints: string[] = []
  for (const path of samples) {
    const bytes = await readSample(path)
    // 样本读不到时**不登记也不查表** —— 拿一个缺文件的指纹去查,
    // 只会把"文件没了"变成"音色登记丢了",更难查
    if (!bytes) return null
    fingerprints.push(fingerprintBytes(bytes))
  }
  return fingerprints
}

export type SampleLookupInput = {
  serviceId: string
  samples: readonly string[]
}

/**
 * 由样本**路径**查已登记的 `voice_id`。
 *
 * 返回 null 有两种可能:没登记过,或样本读不到。两者对合成的下一步是一样的
 * (都该走克隆),所以这里不细分;要区分的话调用方自己读一遍样本。
 */
export async function lookupClonedVoice(options: {
  registry: CloneRegistry
  readSample: SampleReader
  input: SampleLookupInput
}): Promise<string | null> {
  const { registry, readSample, input } = options
  const fingerprints = await fingerprintsOf(input.samples, readSample)
  if (!fingerprints) return null
  return registry.lookup(input.serviceId, fingerprints)?.voiceId ?? null
}

/** 克隆成功后落登记 —— 下次合成就直接命中 */
export async function recordClonedVoice(options: {
  registry: CloneRegistry
  readSample: SampleReader
  input: SampleLookupInput
  voiceId: string
}): Promise<CloneEntry | null> {
  const { registry, readSample, input, voiceId } = options
  const fingerprints = await fingerprintsOf(input.samples, readSample)
  if (!fingerprints) return null
  return registry.record(input.serviceId, fingerprints, voiceId)
}
