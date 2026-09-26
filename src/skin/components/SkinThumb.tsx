/**
 * 网格缩略图(方案 §9):四种静态构图,全部走缓存。
 *   avatar — 2D 面部合成(不建 WebGL 上下文)
 *   bust   — 离屏 skinview3d 正视半身
 *   full   — 离屏 skinview3d 全身,偏航约 20°
 *   flat   — 直接使用 64×64 预览 PNG,不渲染
 * 缓存键:skinId:model:previewType:sizeBucket:outerLayer:rendererVersion。
 * 离屏渲染并发 1;失败回退 2D 预览图。列表模式不挂载本组件(无渲染任务)。
 */

import { useEffect, useState } from 'react'
import * as skinview3d from 'skinview3d'
import { Vector3 } from 'three'
import type { SkinModel } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

export type ThumbType = 'avatar' | 'bust' | 'full' | 'flat'

const MAX_CONCURRENT = 1
const CACHE_LIMIT = 128
const RENDERER_VERSION = 'v2'

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()
const listeners = new Set<() => void>()
let active = 0
const queue: Array<() => void> = []

function key(skinId: string, model: SkinModel, thumbType: ThumbType, outerLayer: boolean): string {
  return `${skinId}:${model}:${thumbType}:base:${outerLayer ? 'outer' : 'inner'}:${RENDERER_VERSION}`
}

function emit(): void {
  for (const fn of listeners) fn()
}

export function onThumbUpdate(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function peekThumb(
  skinId: string,
  model: SkinModel,
  thumbType: ThumbType,
  outerLayer: boolean,
): string | null {
  const k = key(skinId, model, thumbType, outerLayer)
  const hit = cache.get(k) ?? null
  if (hit) {
    cache.delete(k)
    cache.set(k, hit)
  }
  return hit
}

export function getThumb(
  skinId: string,
  model: SkinModel,
  thumbType: ThumbType,
  outerLayer: boolean,
  previewUrl: string,
): Promise<string | null> {
  const k = key(skinId, model, thumbType, outerLayer)
  const hit = cache.get(k)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(k)
  if (pending) return pending

  const task = new Promise<string | null>((resolve) => {
    const run = async () => {
      active++
      try {
        const url = await renderThumb(previewUrl, model, thumbType, outerLayer)
        if (url) {
          cache.set(k, url)
          while (cache.size > CACHE_LIMIT) {
            const oldest = cache.keys().next().value
            if (oldest === undefined) break
            cache.delete(oldest)
          }
        }
        resolve(url)
      } finally {
        active--
        inflight.delete(k)
        const next = queue.shift()
        if (next) next()
      }
    }
    if (active < MAX_CONCURRENT) {
      void run()
    } else {
      queue.push(() => void run())
    }
  })
  inflight.set(k, task)
  void task.then(emit)
  return task
}

/** 2D face composite from the flat 64×64 texture — no WebGL context. */
async function renderAvatar(previewUrl: string): Promise<string | null> {
  const img = await loadImage(previewUrl)
  const canvas = document.createElement('canvas')
  canvas.width = 96
  canvas.height = 96
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  // Head front face: (8,8,8×8); hat layer: (40,8,8×8). Fill ~75% of frame.
  const face = 72
  const off = (96 - face) / 2
  ctx.drawImage(img, 8, 8, 8, 8, off, off, face, face)
  ctx.drawImage(img, 40, 8, 8, 8, off, off, face, face)
  return canvas.toDataURL('image/png')
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('preview image failed to load'))
    img.src = src
  })
}

async function renderOffscreen(
  previewUrl: string,
  model: SkinModel,
  thumbType: 'bust' | 'full',
  outerLayer: boolean,
): Promise<string | null> {
  const canvas = document.createElement('canvas')
  const w = thumbType === 'bust' ? 120 : 120
  const h = thumbType === 'bust' ? 120 : 160
  canvas.width = w
  canvas.height = h
  const viewer = new skinview3d.SkinViewer({
    canvas,
    width: w,
    height: h,
    pixelRatio: 1,
  })
  try {
    const skinviewModel = model === 'classic' ? 'default' : 'slim'
    await viewer.loadSkin(previewUrl, { model: skinviewModel })
    if (!outerLayer) {
      const p = viewer.playerObject.skin
      for (const part of [p.head, p.body, p.leftArm, p.rightArm, p.leftLeg, p.rightLeg]) {
        part.outerLayer.visible = false
      }
    }
    // adjustCameraDistance frames the whole player from the default front
    // camera; never hand-set position/lookAt here (that was what pushed the
    // model out of frame and cropped the body).
    viewer.adjustCameraDistance()
    if (thumbType === 'full') {
      // Slight yaw (~20°) for depth after the camera is correctly framed.
      viewer.playerObject.rotation.y = (20 * Math.PI) / 180
    } else {
      // Bust: aim at the chest/head area and zoom in so head + shoulders fill
      // the square frame.
      viewer.camera.lookAt(new Vector3(0, 14, 0))
      viewer.zoom = 1.7
    }
    viewer.render()
    return canvas.toDataURL('image/png')
  } catch {
    return null
  } finally {
    viewer.dispose()
  }
}

async function renderThumb(
  previewUrl: string,
  model: SkinModel,
  thumbType: ThumbType,
  outerLayer: boolean,
): Promise<string | null> {
  if (thumbType === 'avatar') {
    try {
      return await renderAvatar(previewUrl)
    } catch {
      return null
    }
  }
  if (thumbType === 'flat') return previewUrl
  return renderOffscreen(previewUrl, model, thumbType, outerLayer)
}

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
