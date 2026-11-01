import type { BossbarProgress, BossbarValueMap, BossbarVariable } from '../protocol'

/** 服务端提供的进度直接夹紧到 [0,1]，不在客户端计算 value/min/max。 */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/** 进度引用必须声明为 double；缺失或类型错误时使用同类型的声明默认值。 */
export function resolveProgress(
  progress: BossbarProgress,
  variables: Record<string, BossbarVariable>,
  values: BossbarValueMap,
): number {
  if (typeof progress === 'number') return clampProgress(progress)
  const variable = variables[progress.var]
  if (!variable || variable.type !== 'double') return 0
  const value = values[progress.var]
  return clampProgress(value?.type === 'double' && Number.isFinite(value.value) ? value.value : variable.default)
}
