/**
 * SkinApi 工厂:桌面(Tauri runtime)用真实 adapter;普通浏览器页面
 * 通过同源 HTTP 服务访问,不静默退回 localStorage 另存一份库。
 */

import type { SkinApi } from './SkinApi.ts'
import { createTauriSkinApi, type TauriDeps } from './tauriAdapter.ts'
import { createHttpSkinApi } from './httpAdapter.ts'

let cached: SkinApi | null = null

export async function getSkinApi(): Promise<SkinApi> {
  if (cached) return cached
  const hasTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (hasTauri) {
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
  // Browser mode: same-origin HTTP service.
  cached = createHttpSkinApi()
  return cached
}
