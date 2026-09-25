/**
 * SkinApi 工厂:桌面(Tauri runtime)用真实 adapter;普通浏览器页面
 * 明确抛错,不静默退回 localStorage 另存一份库。
 */

import type { SkinApi } from './SkinApi.ts'
import { createTauriSkinApi, type TauriDeps } from './tauriAdapter.ts'

let cached: SkinApi | null = null

export async function getSkinApi(): Promise<SkinApi> {
  if (cached) return cached
  const hasTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!hasTauri) {
    throw new Error('MC 皮肤管理需要桌面版(Tauri runtime);浏览器预览暂不支持。')
  }
  const [{ invoke }, { listen }, dialog] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
    import('@tauri-apps/plugin-dialog'),
  ])
  const deps: TauriDeps = {
    invoke: invoke as TauriDeps['invoke'],
    listen: listen as unknown as TauriDeps['listen'],
    saveDialog: (options) => dialog.save(options),
  }
  cached = createTauriSkinApi(deps)
  return cached
}
