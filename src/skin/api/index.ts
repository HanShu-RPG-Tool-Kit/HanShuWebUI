/**
 * SkinApi 工厂：通过统一工程服务（与剧本同构）。
 */

import { subscribeProjectBinding } from '../../project'
import type { SkinApi } from './SkinApi.ts'
import { createProjectSkinApi, resetProjectSkinSession } from './projectAdapter.ts'

let cached: SkinApi | null = null

subscribeProjectBinding(() => {
  resetProjectSkinSession()
  cached = null
})

export function resetSkinApiCache(): void {
  resetProjectSkinSession()
  cached = null
}

export async function getSkinApi(): Promise<SkinApi> {
  if (cached) return cached

  cached = createProjectSkinApi()
  return cached
}
