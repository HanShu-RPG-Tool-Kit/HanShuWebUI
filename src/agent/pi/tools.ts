/**
 * 领域工具 → pi-durable `defineTool` 的适配层。
 *
 * 业务工具的定义（JSON Schema、read/lock/write 分类、严格模式拒绝逻辑）全在 `src/agent/tools.ts`；
 * 这里只做两件事：把 OpenAI function 形状包成 pi 的 `ToolRegistration`，以及把结果分流到
 * `output`（给模型）/ `isError`（让模型看到失败而不是异常）。
 */

import { defineTool } from '@earendil-works/pi-durable'
import { AGENT_TOOLS, AGENT_TOOL_KINDS, executeAgentTool } from '../tools'
import type { AgentToolTarget } from '../tools'

/**
 * 工具的 `replay` 保持 `unsafe`（默认）：中断的工具调用**不重跑**，这是文档 §7 明确要求的
 * （与 pi-durable 默认一致，但写出来是为了防止以后有人为了"恢复"随手改成 safe）。
 *
 * `executionMode: 'sequential'`：同一轮的多个工具调用按顺序执行。锁协议本身不等待，
 * 但并行派发会让「读版本 → 加锁」的窗口在同轮工具之间交错，顺序执行能让日志与锁归属可解释。
 */
export function buildAgentTools(target: AgentToolTarget) {
  return AGENT_TOOLS.map((definition) => {
    const name = definition.function.name
    return defineTool<object>({
      name,
      description: definition.function.description,
      parameters: definition.function.parameters as object,
      replay: 'unsafe',
      executionMode: 'sequential',
      execute: async (args) => {
        const call = {
          id: name,
          type: 'function' as const,
          function: { name, arguments: JSON.stringify(args ?? {}) },
        }
        const text = await executeAgentTool(target, call)
        // `output` 的类型是 ToolResultMessage 的内容块数组，不是裸字符串
        return { output: [{ type: 'text', text }], isError: !succeeded(text) }
      },
    })
  })
}

/** 工具失败一律走 `isError`，不要抛：抛出去模型看不到可执行的下一步（文档 §8「失败也回传内容」） */
function succeeded(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; locked?: boolean }
    // lock 失败体没有 `ok` 字段（LockDenial 原样透出），必须单独判 locked === false
    return parsed.ok !== false && parsed.locked !== false
  } catch {
    return false
  }
}

/** 供验收与 UI 展示：工具名 → 三语义分类 */
export function agentToolKinds(): Readonly<Record<string, string>> {
  return AGENT_TOOL_KINDS
}
