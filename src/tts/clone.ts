/**
 * 克隆 —— 上传样本换一个 `voice_id`,然后登记进 `cloneRegistry`。
 *
 * 规范 §5.6「克隆是一次性登记」。所以这里不是"合成的一部分",而是一个独立的动作:
 * 上传 → 拿到 id → 记下来。之后每次合成走普通端点。
 *
 * **克隆是**多步**的**(MiniMax 要两步),所以适配器不直接发请求,而是返回一串
 * **步骤**:每步说"要发什么、怎么读回值"。真正发出去仍然由注入的传输负责 ——
 * 多步不该成为适配器开始认识网络的借口,否则 CORS 那件事就要在两处各修一遍。
 *
 * 报文细节对着各家线上文档核对过:
 * - ElevenLabs:`POST /v1/voices/add`(multipart,`name` + 重复的 `files`),
 *   回 `{ voice_id, requires_verification }`
 * - MiniMax:`POST /v1/files/upload`(`purpose=voice_clone`)拿 `file_id`,
 *   再 `POST /v1/voice_clone` 提交 `{ file_id, voice_id }`。
 *   **注意它要我们自己给 `voice_id`,响应里不回传** —— 见 `minimaxVoiceId`
 */

import { decodeJson, joinUrl, type TtsHttpResponse, type TtsTransport } from './transport'
import { buildMultipart, uploadFileName, type MultipartField } from './multipart'
import { describeHttpFailure, requireApiKey, requireBaseUrl } from './protocols'
import type { ResolvedService } from './service'
import { isPlainObject, type ProtocolId, type TtsFailure } from './spec'
import {
  fingerprintBytes,
  fingerprintSamples,
  type CloneRegistry,
} from './cloneRegistry'

export type CloneSample = {
  /** 资源路径。只用来推扩展名与显示，**不当作上传文件名**（见 `uploadFileName`） */
  path: string
  bytes: Uint8Array
  /** 上传时声明的 content-type */
  contentType: string
}

export type CloneInput = {
  service: ResolvedService
  credential: (ref: string) => string | null
  samples: readonly CloneSample[]
  /** 厂商侧显示用的名字 */
  name: string
}

// ===== 步骤式计划 =====

export type StepParsed =
  | { ok: true; value: unknown }
  | { ok: false; failure: TtsFailure }

export type StepBuild =
  | {
      ok: true
      request: { url: string; headers: Record<string, string>; body: string | Uint8Array }
      parse: (response: TtsHttpResponse) => StepParsed
    }
  | { ok: false; failure: TtsFailure }

export type CloneStep = {
  /** 进度条上显示的一句话 */
  label: string
  /** `carried` 是上一步 parse 出来的值；第一步是 undefined */
  build: (carried: unknown) => StepBuild
}

export type ClonePlan =
  | { ok: true; steps: CloneStep[] }
  | { ok: false; failure: TtsFailure }

export type CloneAdapter = (input: CloneInput) => ClonePlan

// ===== 共用零件 =====

function httpFailure(provider: string, response: TtsHttpResponse): TtsFailure {
  return { kind: 'http', message: describeHttpFailure(provider, response) }
}

/** MiniMax 把业务错误也藏在 200 里，两个端点都是 */
function checkBaseResp(payload: unknown, provider: string): TtsFailure | null {
  if (!isPlainObject(payload)) {
    return { kind: 'decode', message: `${provider} 返回的不是 JSON` }
  }
  const baseResp = payload.base_resp
  if (isPlainObject(baseResp) && baseResp.status_code !== 0) {
    const detail = typeof baseResp.status_msg === 'string' ? baseResp.status_msg : ''
    return { kind: 'http', message: `${provider} 报错：${detail || baseResp.status_code}` }
  }
  return null
}

// ===== ElevenLabs =====

/**
 * `POST /v1/voices/add` —— multipart,一步到位。
 *
 * `files` 是**重复的同名字段**(每个样本一个),不是数组字段。
 * 不加 `remove_background_noise`:官方文档明说样本本身没底噪时开着反而更差,
 * 而这件事我们判断不了,交给用户先处理样本更合适。
 */
const elevenLabsClone: CloneAdapter = (input) => {
  const baseUrl = requireBaseUrl(input.service)
  if (!baseUrl.ok) return baseUrl
  const apiKey = requireApiKey(input)
  if (!apiKey.ok) return apiKey
  if (input.samples.length === 0) {
    return { ok: false, failure: { kind: 'config', message: '没有样本可上传' } }
  }

  const fields: MultipartField[] = [{ name: 'name', value: input.name }]
  input.samples.forEach((sample, index) => {
    fields.push({
      name: 'files',
      filename: uploadFileName(sample.path, index),
      contentType: sample.contentType,
      bytes: sample.bytes,
    })
  })
  const form = buildMultipart(fields)

  return {
    ok: true,
    steps: [
      {
        label: '上传样本并创建音色',
        build: () => ({
          ok: true,
          request: {
            url: joinUrl(baseUrl.value, '/v1/voices/add'),
            headers: {
              'xi-api-key': apiKey.value,
              'Content-Type': form.contentType,
            },
            body: form.body,
          },
          parse: (response) => {
            if (!response.ok) {
              return { ok: false, failure: httpFailure('ElevenLabs', response) }
            }
            const payload = decodeJson(response.bytes)
            if (
              !isPlainObject(payload) ||
              typeof payload.voice_id !== 'string' ||
              !payload.voice_id
            ) {
              return {
                ok: false,
                failure: { kind: 'decode', message: 'ElevenLabs 没有返回 voice_id' },
              }
            }
            return { ok: true, value: { voiceId: payload.voice_id } }
          },
        }),
      },
    ],
  }
}

// ===== MiniMax =====

/**
 * MiniMax 要**我们自己给** `voice_id`,响应里不回传。
 *
 * 它的格式约束是硬的:至少 8 个字符、以字母开头、**必须含数字**。所以这里从样本指纹
 * 派生一个:`hs1` 前缀一次满足"字母开头"和"含数字",再接指纹。好处是**可复现** ——
 * 同一批样本重新克隆会得到同一个 id,不会在厂商侧堆一堆重复音色。
 */
export function minimaxVoiceId(fingerprints: readonly string[]): string {
  const cleaned = fingerprintSamples(fingerprints).replace(/[^a-z0-9]/gi, '')
  return `hs1${cleaned}`.slice(0, 32)
}

/**
 * 两步:上传样本 → 提交克隆。
 *
 * 国际端点(`api.minimax.io`)按官方文档**不带 `GroupId`**;国内端点
 * (`api.minimaxi.chat`)要带 —— 那条路要用的话,`baseUrl` 之外还得再补一个参数,
 * 现在不做,免得为一个不常用端点在适配器里长出分支。
 */
const minimaxClone: CloneAdapter = (input) => {
  const baseUrl = requireBaseUrl(input.service)
  if (!baseUrl.ok) return baseUrl
  const apiKey = requireApiKey(input)
  if (!apiKey.ok) return apiKey
  if (input.samples.length === 0) {
    return { ok: false, failure: { kind: 'config', message: '没有样本可上传' } }
  }

  // 只上传第一个样本:MiniMax 的 `voice_clone` 收一个文件。
  // 多给几个样本不是"更准",而是会被忽略 —— 不如明确只用第一个。
  const sample = input.samples[0]
  const form = buildMultipart([
    { name: 'purpose', value: 'voice_clone' },
    {
      name: 'file',
      filename: uploadFileName(sample.path, 0),
      contentType: sample.contentType,
      bytes: sample.bytes,
    },
  ])

  const voiceId = minimaxVoiceId(input.samples.map((item) => fingerprintBytes(item.bytes)))

  return {
    ok: true,
    steps: [
      {
        label: '上传样本',
        build: () => ({
          ok: true,
          request: {
            url: joinUrl(baseUrl.value, '/files/upload'),
            headers: {
              Authorization: `Bearer ${apiKey.value}`,
              'Content-Type': form.contentType,
            },
            body: form.body,
          },
          parse: (response) => {
            if (!response.ok) return { ok: false, failure: httpFailure('MiniMax', response) }
            const payload = decodeJson(response.bytes)
            const problem = checkBaseResp(payload, 'MiniMax')
            if (problem) return { ok: false, failure: problem }
            const file = isPlainObject(payload) ? payload.file : null
            if (!isPlainObject(file) || typeof file.file_id !== 'string' || !file.file_id) {
              return {
                ok: false,
                failure: { kind: 'decode', message: 'MiniMax 没有返回 file_id' },
              }
            }
            return { ok: true, value: { fileId: file.file_id } }
          },
        }),
      },
      {
        label: '创建克隆音色',
        build: (carried) => {
          const fileId =
            isPlainObject(carried) && typeof carried.fileId === 'string' ? carried.fileId : ''
          if (!fileId) {
            return {
              ok: false,
              failure: { kind: 'decode', message: '上一步没有拿到 file_id' },
            }
          }
          return {
            ok: true,
            request: {
              url: joinUrl(baseUrl.value, '/voice_clone'),
              headers: {
                Authorization: `Bearer ${apiKey.value}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ file_id: fileId, voice_id: voiceId }),
            },
            parse: (response) => {
              if (!response.ok) return { ok: false, failure: httpFailure('MiniMax', response) }
              const payload = decodeJson(response.bytes)
              const problem = checkBaseResp(payload, 'MiniMax')
              if (problem) return { ok: false, failure: problem }
              // 回传的是我们自己给的那个 id —— 响应里确实没有 voice_id
              return { ok: true, value: { voiceId } }
            },
          }
        },
      },
    ],
  }
}

// ===== 分派 =====

/** 协议 → 克隆适配器。**没有条目就是这个协议还不支持克隆** */
export const CLONE_ADAPTERS: Partial<Record<ProtocolId, CloneAdapter>> = {
  elevenlabs: elevenLabsClone,
  minimax: minimaxClone,
}

export function clonePlanFor(input: CloneInput): ClonePlan {
  const protocol = input.service.protocol
  if (!protocol) {
    return {
      ok: false,
      failure: { kind: 'config', message: `服务「${input.service.id}」没有可用的协议` },
    }
  }
  const adapter = CLONE_ADAPTERS[protocol]
  if (!adapter) {
    return {
      ok: false,
      failure: {
        kind: 'unsupported',
        message: `协议「${protocol}」还没实现克隆上传`,
        hint:
          protocol === 'azure' || protocol === 'openai-compatible'
            ? '这两家的克隆要人工审批（Limited Access / sales 审批），拿到之后在厂商控制台建音色'
            : 'ElevenLabs 与 MiniMax 已经能直接用',
      },
    }
  }
  return adapter(input)
}

// ===== 跑一个计划 =====

export type CloneResult =
  | { ok: true; voiceId: string }
  | { ok: false; failure: TtsFailure }

export type CloneRunContext = {
  transport: TtsTransport
  signal?: AbortSignal
  /** 多步时按步报进度 */
  onStep?: (label: string, index: number, total: number) => void
}

/** 按顺序跑完所有步骤,取**最后一步**的值。任何一步失败就整体失败 */
export async function runClone(
  plan: ClonePlan,
  context: CloneRunContext,
): Promise<CloneResult> {
  if (!plan.ok) return { ok: false, failure: plan.failure }

  let carried: unknown
  for (const [index, step] of plan.steps.entries()) {
    if (context.signal?.aborted) {
      return { ok: false, failure: { kind: 'transport', message: '克隆已取消' } }
    }

    context.onStep?.(step.label, index + 1, plan.steps.length)

    const built = step.build(carried)
    if (!built.ok) return { ok: false, failure: built.failure }

    let response: TtsHttpResponse
    try {
      response = await context.transport({ ...built.request, signal: context.signal })
    } catch (error) {
      // 与合成一致：CORS / 断网这类"没拿到响应"必须与"厂商拒绝"分开
      const message = error instanceof Error ? error.message : String(error)
      const hint =
        error instanceof Error && 'hint' in error && typeof error.hint === 'string'
          ? error.hint
          : undefined
      return { ok: false, failure: { kind: 'transport', message, hint } }
    }

    const parsed = built.parse(response)
    if (!parsed.ok) return { ok: false, failure: parsed.failure }
    carried = parsed.value
  }

  if (!isPlainObject(carried) || typeof carried.voiceId !== 'string' || !carried.voiceId) {
    return {
      ok: false,
      failure: { kind: 'decode', message: '克隆流程结束了，但没拿到 voice_id' },
    }
  }

  return { ok: true, voiceId: carried.voiceId }
}

// ===== 一步到位：查登记 → 该克隆就克隆 → 落登记 =====

export type EnsureCloneResult =
  | { ok: true; voiceId: string; cloned: boolean }
  | { ok: false; failure: TtsFailure }

/**
 * 录音棚该调的就是这个:登记表里有就不重复上传(克隆是**要花钱**的),
 * 没有才跑一遍,拿到 id 立刻记下来。
 *
 * 样本字节由调用方给 —— 它本来就要从 assets 读,这里不再自己去摸工程。
 */
export async function ensureClonedVoice(
  input: {
    service: ResolvedService
    credential: (ref: string) => string | null
    name: string
    samples: readonly CloneSample[]
    registry: CloneRegistry
  },
  context: CloneRunContext,
): Promise<EnsureCloneResult> {
  if (input.samples.length === 0) {
    return { ok: false, failure: { kind: 'config', message: '克隆至少要一个样本' } }
  }

  const fingerprints = input.samples.map((sample) => fingerprintBytes(sample.bytes))
  const known = input.registry.lookup(input.service.id, fingerprints)
  if (known) return { ok: true, voiceId: known.voiceId, cloned: false }

  const result = await runClone(clonePlanFor(input), context)
  if (!result.ok) return result

  input.registry.record(input.service.id, fingerprints, result.voiceId)
  return { ok: true, voiceId: result.voiceId, cloned: true }
}
