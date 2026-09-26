/**
 * SkinApi 工厂：优先工程内 FSA（与剧本同构）。
 * 可选 VITE_SKIN_USE_TAURI=1 回退到 Tauri IPC（对照用）。
 */

import { subscribeProjectBinding } from '../../project'
import type { SkinApi } from './SkinApi.ts'
import { createFsaSkinApi, resetFsaSkinSession } from './fsaAdapter.ts'
import { createTauriSkinApi, type TauriDeps } from './tauriAdapter.ts'

let cached: SkinApi | null = null

subscribeProjectBinding(() => {
  resetFsaSkinSession()
  cached = null
})

export function resetSkinApiCache(): void {
  resetFsaSkinSession()
  cached = null
}

export async function getSkinApi(): Promise<SkinApi> {
  if (cached) return cached

  const forceTauri =
    import.meta.env.VITE_SKIN_USE_TAURI === '1' ||
    import.meta.env.VITE_SKIN_USE_TAURI === 'true'
  const hasTauri =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  if (forceTauri && hasTauri) {
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

  cached = createFsaSkinApi()
  return cached
}
