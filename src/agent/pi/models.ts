/**
 * pi-ai 模型层：把用户填在浏览器本地的 API Key 接进 pi 的 `Models`。
 *
 * **只有 `src/agent/pi/**` 允许 import `@earendil-works/*`**（文档 §11 不变量 7 的隔离要求：
 * facade 收窄 PI 的 API 面，UI 与业务不直接依赖 PI）。
 *
 * DeepSeek 是 pi-ai 的一等公民（内置 `deepseekProvider()`，目录里有 deepseek-flash / deepseek-v4-pro）。
 * 这里用 `createProvider` 重建一个等价 provider：唯一目的是把「用户本机密钥」和「可选自建网关地址」
 * 注入进去，而不依赖进程环境变量（浏览器里没有 env）。
 */

import {
  createModels,
  createProvider,
  type ApiKeyAuth,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type Models,
} from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

const PROVIDER_ID = 'deepseek'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** 模型目录（deepseek-flash / deepseek-v4-pro）；不认识的 id 回落到 Pro */
export const AGENT_MODEL_IDS = ['deepseek-v4-pro', 'deepseek-flash'] as const
const MODEL_FALLBACK_ID = AGENT_MODEL_IDS[0]

/**
 * 浏览器本地凭据存储：pi 的 `Models` 会在每次请求前 resolve 一次。
 * 只读写 localStorage，**不落任何构建产物**（文档 §2：密钥由用户在界面填入）。
 */
class LocalCredentialStore implements CredentialStore {
  private readonly readKey: () => string

  constructor(readKey: () => string) {
    this.readKey = readKey
  }

  async read(): Promise<Credential | undefined> {
    const key = this.readKey().trim()
    // 空 key 视为未配置：pi 会把请求失败归到 `no_model`，而不是发一个空 Bearer
    return key ? { type: 'api_key', key } : undefined
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.readKey().trim() ? [{ providerId: PROVIDER_ID, type: 'api_key' }] : []
  }

  async modify(
    _providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    // 本应用不通过 pi 登录流程写凭据（密钥是 UI 填的），modify 只读转发
    return fn(await this.read())
  }

  async delete(): Promise<void> {
    // 密钥的清除由 config.ts 负责；这里不重复实现
  }
}

function apiKeyAuth(readKey: () => string): ApiKeyAuth {
  return {
    name: 'DeepSeek API key',
    resolve: async ({ credential }) => {
      const key = credential?.type === 'api_key' ? credential.key : readKey()
      if (!key) return undefined
      return { auth: { apiKey: key }, source: 'hanshu-ui' }
    },
  }
}

/**
 * 建一个只服务 DeepSeek 兼容端点的 `Models`：
 * - 静态模型目录来自 pi-ai 自带的 deepseek catalog（版本 1.5.0，锁精确版本）；
 * - baseUrl 可被用户的自建网关覆盖；
 * - 密钥每次请求现读 localStorage，用户在面板里改 Key 不需要重启 Harness。
 */
export function buildModels(input: {
  readKey: () => string
  baseUrl?: string
  /** 用户在设置里填写的两档模型 id（目录外的会克隆 catalog 里的模型补进去） */
  modelIds?: readonly string[]
}): Models {
  const catalog = deepseekProvider().getModels() as readonly Model<'openai-completions'>[]
  const provider = createProvider<'openai-completions'>({
    id: PROVIDER_ID,
    name: 'DeepSeek',
    baseUrl: input.baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL,
    auth: { apiKey: apiKeyAuth(input.readKey) },
    models: withCustomModels(catalog, input.modelIds),
    api: { stream, streamSimple },
  })

  const models = createModels({ credentials: new LocalCredentialStore(input.readKey) })
  models.setProvider(provider)
  return models
}

/**
 * 目录 + 用户自填模型 id。
 * 自建网关常常是同一协议的另一个模型名，所以按 catalog 里最近的一档克隆一份、只换 id/名字：
 * 采样参数、compat、上下文窗口跟着走，比凭空造一个 `Model` 安全。
 */
function withCustomModels(
  catalog: readonly Model<'openai-completions'>[],
  modelIds: readonly string[] | undefined,
): readonly Model<'openai-completions'>[] {
  const extra = (modelIds ?? [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && !catalog.some((model) => model.id === id))
  if (extra.length === 0) return catalog
  const base = catalog.find((model) => model.id === MODEL_FALLBACK_ID) ?? catalog[0]
  if (!base) return catalog
  const clones = extra.map((id) => ({ ...base, id, name: id }))
  return [...catalog, ...clones]
}

/** 归一化模型 id：空值回落到 Pro，避免 `no_model` 死路 */
export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim()
  return trimmed.length > 0 ? trimmed : AGENT_MODEL_IDS[0]
}
