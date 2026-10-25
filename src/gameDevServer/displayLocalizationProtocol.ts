/** Control wire contract. Project paths and file versions remain outside these messages. */
export const LOCALIZATION_PROTOCOL = 'hanshu-localization-v1'
export type LocalizationBinding = {
  bindingId: string; field: string; semanticKey: string; runtimeKey: string
  componentKind: 'translate'; translations: Record<string, string>
}
export type LocalizationOpen = {
  protocol: typeof LOCALIZATION_PROTOCOL; activeLocale: string; availableLocales: string[]
  bindings: LocalizationBinding[]
  /** Source structures are owned by WebUI; only their language values may be edited remotely. */
  readOnlyFields?: string[]
  freezeLore?: boolean
}
export async function supportsDisplayLocalization(request: (method: string, params: unknown, timeout?: number) => Promise<unknown>): Promise<boolean> {
  try {
    const result = await request('localization.capabilities', {}, 5000)
    return !!result && typeof result === 'object' && 'protocols' in result && Array.isArray(result.protocols) && result.protocols.includes(LOCALIZATION_PROTOCOL)
  } catch { return false }
}
