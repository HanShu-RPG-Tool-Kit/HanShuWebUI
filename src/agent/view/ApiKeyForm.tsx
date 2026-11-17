/**
 * API 设置表单（纯展示，不碰 localStorage）。
 *
 * 只做三件事：填 Key、填两档模型名、可选填网关地址。
 * 面向零基础用户：说明只保留「Key 只存在本浏览器」，不解释实现细节。
 */

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { AGENT_THINKING_LEVELS, type AgentModelIds, type AgentThinkingLevels } from '../config'

/** 思考强度的中文说明（选项值仍是 pi 的枚举） */
const THINKING_LABEL: Record<(typeof AGENT_THINKING_LEVELS)[number], string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高（默认）',
  xhigh: '很高',
  max: '最高',
}

export type ApiConfigDraft = {
  apiKey: string
  baseUrl: string
  modelIds: AgentModelIds
  thinkingLevels: AgentThinkingLevels
}

type Props = {
  /** 是否已保存过 Key */
  configured: boolean
  /** 已保存 Key 的掩码（如 `sk-…a1b2`），不会含明文 */
  maskedKey: string
  /** 已保存的网关地址；空串 = 厂商默认 */
  baseUrl: string
  /** 当前两档模型 id */
  modelIds: AgentModelIds
  /** 当前两档思考强度 */
  thinkingLevels: AgentThinkingLevels
  /** 未配置时不允许关掉表单（否则面板没有可用入口） */
  canClose: boolean
  /** 返回错误文案表示保存失败；返回 null 表示已保存 */
  onSave: (draft: ApiConfigDraft) => string | null
  onClear: () => void
  onClose: () => void
}

export function ApiKeyForm({
  configured,
  maskedKey,
  baseUrl,
  modelIds,
  thinkingLevels,
  canClose,
  onSave,
  onClear,
  onClose,
}: Props) {
  const [apiKey, setApiKey] = useState('')
  const [flash, setFlash] = useState(modelIds.flash)
  const [pro, setPro] = useState(modelIds.pro)
  const [gateway, setGateway] = useState(baseUrl)
  const [flashThinking, setFlashThinking] = useState(thinkingLevels.flash)
  const [proThinking, setProThinking] = useState(thinkingLevels.pro)
  const [error, setError] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  // 面板重新读到配置时（例如别处清空）同步输入框
  useEffect(() => {
    setGateway(baseUrl)
    setFlash(modelIds.flash)
    setPro(modelIds.pro)
    setFlashThinking(thinkingLevels.flash)
    setProThinking(thinkingLevels.pro)
  }, [baseUrl, modelIds.flash, modelIds.pro, thinkingLevels.flash, thinkingLevels.pro])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setError('')
    const message = onSave({
      apiKey,
      baseUrl: gateway,
      modelIds: { flash, pro },
      thinkingLevels: { flash: flashThinking, pro: proThinking },
    })
    if (message) {
      setError(message)
      return
    }
    setApiKey('')
  }

  return (
    <form className="agent-api-form" onSubmit={submit}>
      <div className="agent-api-head">
        <span className="agent-api-title">API 设置</span>
        <span className="agent-api-state">
          {configured ? `已配置：${maskedKey}` : '未配置'}
        </span>
        {canClose && (
          <button type="button" className="agent-api-close" onClick={onClose} title="关闭">
            ×
          </button>
        )}
      </div>

      <label className="agent-api-field">
        <span>API Key</span>
        <input
          type="password"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? '已配置，留空不修改' : '厂商 API Key'}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      <div className="agent-api-pair">
        <label className="agent-api-field">
          <span>Flash 模型</span>
          <input
            type="text"
            value={flash}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setFlash(event.target.value)}
          />
        </label>
        <label className="agent-api-field">
          <span>Pro 模型</span>
          <input
            type="text"
            value={pro}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setPro(event.target.value)}
          />
        </label>
      </div>

      <div className="agent-api-pair">
        <label className="agent-api-field">
          <span>Flash 思考</span>
          <select
            value={flashThinking}
            onChange={(event) =>
              setFlashThinking(event.target.value as AgentThinkingLevels['flash'])
            }
          >
            {AGENT_THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {THINKING_LABEL[level]}
              </option>
            ))}
          </select>
        </label>
        <label className="agent-api-field">
          <span>Pro 思考</span>
          <select
            value={proThinking}
            onChange={(event) => setProThinking(event.target.value as AgentThinkingLevels['pro'])}
          >
            {AGENT_THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {THINKING_LABEL[level]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="agent-api-field">
        <span>网关地址</span>
        <input
          type="text"
          value={gateway}
          autoComplete="off"
          spellCheck={false}
          placeholder="https://api.deepseek.com"
          onChange={(event) => setGateway(event.target.value)}
        />
      </label>

      {error && <div className="agent-api-error">{error}</div>}

      <div className="agent-api-actions">
        {configured && (
          confirmClear ? (
            <span className="agent-api-confirm">
              确认清除？
              <button
                type="button"
                onClick={() => {
                  onClear()
                  setApiKey('')
                  setConfirmClear(false)
                }}
              >
                清除
              </button>
              <button type="button" onClick={() => setConfirmClear(false)}>
                取消
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmClear(true)}>
              清除 Key
            </button>
          )
        )}
        <button type="submit">{configured ? '保存' : '保存并启用'}</button>
      </div>

      <div className="agent-api-hint">Key 只在本机浏览器保存，不会上传。思考强度默认 high。</div>
    </form>
  )
}
