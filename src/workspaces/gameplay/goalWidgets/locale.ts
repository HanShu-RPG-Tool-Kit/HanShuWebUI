export type GoalLocaleEntry = { name?: string; description?: string }

/** 按观看者语言取文案；缺省回退 zh_cn → en_us → 任意第一条。 */
export function pickGoalLocale<T>(
  map: Record<string, T> | undefined,
  locale: string,
): T | undefined {
  if (!map || typeof map !== 'object') return undefined
  const key = locale.trim().toLowerCase() || 'zh_cn'
  if (Object.hasOwn(map, key)) return map[key]
  if (Object.hasOwn(map, 'zh_cn')) return map.zh_cn
  if (Object.hasOwn(map, 'en_us')) return map.en_us
  return Object.values(map)[0]
}

export function pickGoalLocaleName(
  labels: Record<string, GoalLocaleEntry> | undefined,
  locale: string,
  fallback: string,
): string {
  const entry = pickGoalLocale(labels, locale)
  const name = entry?.name?.trim()
  return name || fallback
}

export function pickGoalLocaleDescription(
  labels: Record<string, GoalLocaleEntry> | undefined,
  locale: string,
): string | undefined {
  const description = pickGoalLocale(labels, locale)?.description?.trim()
  return description || undefined
}

/** WebUI 预览：把 `{key}` 换成当前 config；未知键留空占位。 */
export function renderGoalLocalizeTemplate(
  template: string,
  values: Record<string, unknown>,
): string {
  return template.replace(/\{([A-Za-z_][\w]*)\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) return '…'
    const value = values[key]
    if (value === undefined || value === null || value === '') return '…'
    return String(value)
  })
}
