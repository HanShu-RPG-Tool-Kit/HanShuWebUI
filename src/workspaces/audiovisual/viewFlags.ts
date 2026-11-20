import { createViewFlags } from '../../ui/viewFlags'

/** 视听效果工作区的查看开关。别的工作区不要写这份，各自 createViewFlags。 */
export type AudiovisualViewFlags = {
  assetManager: boolean
}

export const audiovisualViewFlags = createViewFlags<AudiovisualViewFlags>(
  'hanshu.view.audiovisual',
  { assetManager: false },
)
