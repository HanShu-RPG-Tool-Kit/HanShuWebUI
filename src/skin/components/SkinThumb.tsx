/**
 * 网格缩略图(方案 §9):四种静态构图,全部走缓存。
 *   avatar — 2D 面部合成(不建 WebGL 上下文)
 *   bust   — 离屏 skinview3d 正交正视半身
 *   full   — 离屏 skinview3d 全身,偏航约 20°
 *   flat   — 直接使用 64×64 预览 PNG,不渲染
 */

import { useEffect, useState } from 'react'
import type { SkinModel } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'
import {
  getThumb,
  onThumbUpdate,
  peekThumb,
  type ThumbType,
} from './thumbCache.ts'

export type { ThumbType } from './thumbCache.ts'

interface Props {
  skinId: string
  model: SkinModel
  previewUrl: string
  alt: string
  thumbType: ThumbType
  outerLayer?: boolean
}

export function SkinThumb({ skinId, model, previewUrl, alt, thumbType, outerLayer = true }: Props) {
  const [thumb, setThumb] = useState<string | null>(() =>
    peekThumb(skinId, model, thumbType, outerLayer),
  )

  useEffect(() => {
    let cancelled = false
    const hit = peekThumb(skinId, model, thumbType, outerLayer)
    if (hit) {
      setThumb(hit)
      return
    }
    if (thumbType === 'flat') {
      setThumb(previewUrl)
      return
    }
    void getThumb(skinId, model, thumbType, outerLayer, previewUrl)
    const off = onThumbUpdate(() => {
      if (cancelled) return
      const url = peekThumb(skinId, model, thumbType, outerLayer)
      if (url) setThumb(url)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [skinId, model, thumbType, outerLayer, previewUrl])

  return (
    <img
      src={thumb ?? previewUrl}
      alt={alt}
      loading="lazy"
      className={thumb ? `${styles.thumb} ${styles.thumb3d}` : `${styles.thumb} ${styles.thumb2d}`}
    />
  )
}
