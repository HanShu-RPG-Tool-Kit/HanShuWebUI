import { useEffect, useMemo, useRef, useState } from 'react'
import { getAssetBlob } from '../../../../assets/idb'
import { loadBossbarTexture, releaseBossbarTexture, textureSizeOf, type BossbarTexture } from '../render/texture'

/** 唯一图集：先同步拿到尺寸，再异步解码位图 */
export type BossbarTextureLookup = {
  image: CanvasImageSource | null
  size: { width: number; height: number }
  loading: boolean
  error: string | null
  version: number
}

const EMPTY_SIZE = { width: 1, height: 1 }

export function useBossbarTexture(base64: string, contextKey = ''): BossbarTextureLookup {
  const [state, setState] = useState<{
    base64: string
    contextKey: string
    entry: BossbarTexture | null
    loading: boolean
    error: string | null
    version: number
  }>(() => ({ base64, contextKey, entry: null, loading: Boolean(base64), error: null, version: 0 }))
  const requestRef = useRef(0)

  const size = useMemo(() => textureSizeOf(base64) ?? EMPTY_SIZE, [base64])

  useEffect(() => {
    const request = ++requestRef.current
    let retained: BossbarTexture | null = null
    let cancelled = false
    setState((previous) => ({
      base64, contextKey, entry: null, loading: Boolean(base64), error: null, version: previous.version,
    }))
    if (base64) {
      void loadBossbarTexture(base64).then((result) => {
        if (cancelled || requestRef.current !== request) {
          if (result) releaseBossbarTexture(result)
          return
        }
        retained = result
        setState((previous) => ({
          base64, contextKey, entry: result, loading: false,
          error: result ? null : 'PNG 无法解码', version: previous.version + 1,
        }))
      }).catch((cause: unknown) => {
        if (cancelled || requestRef.current !== request) return
        setState((previous) => ({
          base64, contextKey, entry: null, loading: false,
          error: cause instanceof Error ? cause.message : 'PNG 无法解码', version: previous.version,
        }))
      })
    }
    return () => {
      cancelled = true
      requestRef.current += 1
      if (retained) releaseBossbarTexture(retained)
      retained = null
    }
  }, [base64, contextKey])

  // A source/context change must hide the previous image before its new effect runs.
  const current = state.base64 === base64 && state.contextKey === contextKey ? state : null
  const entry = current?.entry ?? null

  return {
    image: entry?.image ?? null,
    size: entry ? { width: entry.width, height: entry.height } : size,
    loading: current?.loading ?? Boolean(base64),
    error: current?.error ?? null,
    version: state.version,
  }
}

/** 参考底图：从工程 assets/ 里挑一张 PNG，仅本机预览用 */
export function useReferenceImage(
  packageId: string | null,
  assetPath: string | null,
  contextKey = '',
): HTMLImageElement | null {
  const [state, setState] = useState<{
    packageId: string | null
    assetPath: string | null
    contextKey: string
    image: HTMLImageElement | null
  }>(() => ({ packageId, assetPath, contextKey, image: null }))
  useEffect(() => {
    setState({ packageId, assetPath, contextKey, image: null })
    if (!packageId || !assetPath) {
      return
    }
    let cancelled = false
    let url: string | null = null
    let element: HTMLImageElement | null = null
    void getAssetBlob(packageId, assetPath).then((blob) => {
      if (!blob || cancelled) return
      url = URL.createObjectURL(blob)
      element = new Image()
      element.onload = () => {
        if (cancelled) return
        setState({ packageId, assetPath, contextKey, image: element })
      }
      element.src = url
    }).catch(() => {
      // Reference assets are optional; a failed/removed asset leaves the canvas clear.
    })
    return () => {
      cancelled = true
      if (element) {
        element.onload = null
        element.onerror = null
        element.src = ''
      }
      if (url) URL.revokeObjectURL(url)
    }
  }, [assetPath, contextKey, packageId])
  return state.packageId === packageId && state.assetPath === assetPath && state.contextKey === contextKey
    ? state.image : null
}

/** 文本测量：只在浏览器里用 */
export function createTextMeasurer(): (text: string, font: string) => number {
  let canvas: HTMLCanvasElement | null = null
  let context: CanvasRenderingContext2D | null = null
  let lastFont = ''
  return (text: string, font: string) => {
    if (!canvas) {
      canvas = document.createElement('canvas')
      context = canvas.getContext('2d')
    }
    if (!context) return text.length * 8
    if (font !== lastFont) {
      context.font = font
      lastFont = font
    }
    return context.measureText(text).width
  }
}
