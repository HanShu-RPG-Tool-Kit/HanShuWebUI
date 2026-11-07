/**
 * DeepSeek / Agent 连接配置。
 *
 * 按架构文档 §2：**LLM 密钥由用户在界面填入，存浏览器本地**，不进构建产物。
 * 因此这里不读 `VITE_DEEPSEEK_API_KEY`。
 *
 * localStorage：
 *   hanshu.agent.apiKey        —— 厂商 API Key（用户在 Agent 面板里填）
 *   hanshu.agent.baseUrl       —— 自建网关地址（可选，空 = 厂商默认）
 *   hanshu.agent.usePro        —— Pro / Flash 开关（默认 Pro）
 *   hanshu.agent.model.pro     —— Pro 档位对应的模型 id
 *   hanshu.agent.model.flash   —— Flash 档位对应的模型 id
 */

/** 默认模型：pi-ai 内置 catalog 里就有的两个 DeepSeek 档位 */
const MODEL_PRO = 'deepseek-v4-pro'
const MODEL_FLASH = 'deepseek-flash'

const PRO_KEY = 'hanshu.agent.usePro'
const API_KEY_STORAGE = 'hanshu.agent.apiKey'
const BASE_URL_STORAGE = 'hanshu.agent.baseUrl'
const PRO_MODEL_STORAGE = 'hanshu.agent.model.pro'
const FLASH_MODEL_STORAGE = 'hanshu.agent.model.flash'
const PRO_THINKING_STORAGE = 'hanshu.agent.thinking.pro'
const FLASH_THINKING_STORAGE = 'hanshu.agent.thinking.flash'
/** 旧版单一模型设置：只作迁移读取 */
const LEGACY_MODEL_STORAGE = 'hanshu.agent.model'

/** 厂商默认网关：界面上作为默认值，也是 provider 的回落地址 */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

export type AgentModelIds = { pro: string; flash: string }

/** 思考强度（pi-ai 的 ModelThinkingLevel；`off` 不提供，关掉思考请用 minimal） */
export const AGENT_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number]
export type AgentThinkingLevels = { pro: AgentThinkingLevel; flash: AgentThinkingLevel }
export const DEFAULT_THINKING_LEVEL: AgentThinkingLevel = 'high'

export type AgentConfig = {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  usePro: boolean
}

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key)?.trim() ?? ''
  } catch {
    return ''
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* 隐私模式等场景下静默失败 */
  }
}

/** 模型 id 的宽松校验：字母数字与 `._:-`，避免把 URL 之类误填进来 */
export function isValidModelId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,80}$/.test(value.trim())
}

export function getUsePro(): boolean {
  return readStorage(PRO_KEY) !== '0'
}

export function setUsePro(on: boolean): void {
  writeStorage(PRO_KEY, on ? '1' : '0')
}

/** 用户在界面填写的 API Key；只存浏览器本地 */
export function getAgentApiKey(): string {
  return readStorage(API_KEY_STORAGE)
}

export function setAgentApiKey(key: string): void {
  writeStorage(API_KEY_STORAGE, key.trim())
}

export function clearAgentApiKey(): void {
  writeStorage(API_KEY_STORAGE, '')
}

export function hasAgentApiKey(): boolean {
  return Boolean(getAgentApiKey())
}

/** 网关地址；未设置时就是厂商默认地址（界面与 provider 用同一个默认值） */
export function getAgentBaseUrl(): string {
  return readStorage(BASE_URL_STORAGE).replace(/\/+$/, '') || DEFAULT_BASE_URL
}

/** 用户是否显式改过网关（用于「恢复默认」） */
export function hasCustomBaseUrl(): boolean {
  return Boolean(readStorage(BASE_URL_STORAGE))
}

export function setAgentBaseUrl(url: string): void {
  writeStorage(BASE_URL_STORAGE, url.trim().replace(/\/+$/, ''))
}

/** 两档模型 id；空/非法回落默认值 */
export function getAgentModelIds(): AgentModelIds {
  const pro = readStorage(PRO_MODEL_STORAGE)
  const flash = readStorage(FLASH_MODEL_STORAGE)
  const legacy = readStorage(LEGACY_MODEL_STORAGE)
  return {
    pro: isValidModelId(pro) ? pro : isValidModelId(legacy) ? legacy : MODEL_PRO,
    flash: isValidModelId(flash) ? flash : isValidModelId(legacy) ? legacy : MODEL_FLASH,
  }
}

export function setAgentModelIds(ids: Partial<AgentModelIds>): void {
  if (ids.pro !== undefined) {
    writeStorage(PRO_MODEL_STORAGE, isValidModelId(ids.pro) ? ids.pro.trim() : '')
  }
  if (ids.flash !== undefined) {
    writeStorage(FLASH_MODEL_STORAGE, isValidModelId(ids.flash) ? ids.flash.trim() : '')
  }
  // 迁移完成后不再用旧键，避免两处设置互相打架
  writeStorage(LEGACY_MODEL_STORAGE, '')
}

export function isValidThinkingLevel(value: string): value is AgentThinkingLevel {
  return (AGENT_THINKING_LEVELS as readonly string[]).includes(value)
}

/** 两档思考强度；空/非法回落 high */
export function getAgentThinkingLevels(): AgentThinkingLevels {
  const pro = readStorage(PRO_THINKING_STORAGE)
  const flash = readStorage(FLASH_THINKING_STORAGE)
  return {
    pro: isValidThinkingLevel(pro) ? pro : DEFAULT_THINKING_LEVEL,
    flash: isValidThinkingLevel(flash) ? flash : DEFAULT_THINKING_LEVEL,
  }
}

export function setAgentThinkingLevels(levels: Partial<AgentThinkingLevels>): void {
  if (levels.pro !== undefined) {
    writeStorage(PRO_THINKING_STORAGE, isValidThinkingLevel(levels.pro) ? levels.pro : '')
  }
  if (levels.flash !== undefined) {
    writeStorage(FLASH_THINKING_STORAGE, isValidThinkingLevel(levels.flash) ? levels.flash : '')
  }
}

/** 当前档位实际使用的思考强度 */
export function getAgentThinkingLevel(): AgentThinkingLevel {
  const levels = getAgentThinkingLevels()
  return getUsePro() ? levels.pro : levels.flash
}

/** 当前档位实际使用的模型 id */
export function getAgentModelId(): string {
  const ids = getAgentModelIds()
  return getUsePro() ? ids.pro : ids.flash
}

export function getAgentConfig(): AgentConfig {
  return {
    apiKey: getAgentApiKey(),
    baseUrl: getAgentBaseUrl(),
    model: getAgentModelId(),
    temperature: 0.3,
    usePro: getUsePro(),
  }
}

export { MODEL_FLASH, MODEL_PRO }
