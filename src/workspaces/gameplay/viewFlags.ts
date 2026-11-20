import { createViewFlags } from '../../ui/viewFlags'

/** 游戏性工作区的查看开关。别的工作区不要写这份，各自 createViewFlags。 */
export type GameplayViewFlags = {
  assetManager: boolean
}

export const gameplayViewFlags = createViewFlags<GameplayViewFlags>(
  'hanshu.view.gameplay',
  { assetManager: false },
)
