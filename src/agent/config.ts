/**
 * DeepSeek / Agent 连接配置
 *
 * 【填 API】项目根目录 `.env`（密钥仍要重启 dev）：
 *   VITE_DEEPSEEK_API_KEY=sk-...
 *   VITE_DEEPSEEK_BASE_URL=https://api.deepseek.com
 *   VITE_DEEPSEEK_TEMPERATURE=0.3
 *
 * 模型可在网页 Agent 顶栏用 Pro 开关切换（写入 localStorage，即时生效）：
 *   Pro 开  → deepseek-v4-pro
 *   Pro 关  → deepseek-flash
 */

const MODEL_PRO = 'deepseek-v4-pro'
const MODEL_FLASH = 'deepseek-flash'
const PRO_KEY = 'hanshu.agent.usePro'

export type AgentConfig = {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  usePro: boolean
}

export function getUsePro(): boolean {
  const saved = localStorage.getItem(PRO_KEY)
  if (saved === '0') return false
  if (saved === '1') return true
  // 默认跟随 .env；未写则默认 Pro
  const envModel =
    (import.meta.env.VITE_DEEPSEEK_MODEL as string | undefined)?.trim() || ''
  if (envModel === MODEL_FLASH) return false
  return true
}

export function setUsePro(on: boolean): void {
  localStorage.setItem(PRO_KEY, on ? '1' : '0')
}

export function getAgentConfig(): AgentConfig {
  const apiKey =
    (import.meta.env.VITE_DEEPSEEK_API_KEY as string | undefined)?.trim() ?? ''
  const baseUrl = (
    (import.meta.env.VITE_DEEPSEEK_BASE_URL as string | undefined)?.trim() ||
    'https://api.deepseek.com'
  ).replace(/\/$/, '')

  const usePro = getUsePro()
  const model = usePro ? MODEL_PRO : MODEL_FLASH

  const rawTemp = Number(
    (import.meta.env.VITE_DEEPSEEK_TEMPERATURE as string | undefined)?.trim(),
  )
  const temperature = Number.isFinite(rawTemp)
    ? Math.min(2, Math.max(0, rawTemp))
    : 0.3

  return { apiKey, baseUrl, model, temperature, usePro }
}

export function hasAgentApiKey(): boolean {
  return Boolean(getAgentConfig().apiKey)
}

export { MODEL_FLASH, MODEL_PRO }
