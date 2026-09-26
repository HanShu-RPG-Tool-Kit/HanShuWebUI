/**
 * Offscreen skin thumbnail cache (no React).
 * Kept separate from SkinThumb.tsx so Fast Refresh can remount the component
 * without invalidating the whole skin workspace module graph.
 */

import * as skinview3d from 'skinview3d'
import { OrthographicCamera } from 'three'
import type { SkinModel } from '../contracts/types.ts'

export type ThumbType = 'avatar' | 'bust' | 'full' | 'flat'

const MAX_CONCURRENT = 1
const CACHE_LIMIT = 128
const RENDERER_VERSION = 'v4-bust-ortho'

const AVATAR_SIZE = 192
const BUST_SIZE = 256
const FULL_W = 240
const FULL_H = 320

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

async function renderAvatar(previewUrl: string): Promise<string | null> {
  const img = await loadImage(previewUrl)
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  const face = Math.round(AVATAR_SIZE * 0.75)
  const off = (AVATAR_SIZE - face) / 2
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
  const w = thumbType === 'bust' ? BUST_SIZE : FULL_W
  const h = thumbType === 'bust' ? BUST_SIZE : FULL_H
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
    viewer.adjustCameraDistance()
    if (thumbType === 'full') {
      viewer.playerObject.rotation.y = (20 * Math.PI) / 180
      viewer.render()
    } else {
      // Bust: true orthographic front view (no perspective foreshortening).
      viewer.playerObject.rotation.set(0, 0, 0)
      const lookY = 10
      // Keep perspective camera co-located so its attached light still works.
      viewer.camera.position.set(0, lookY, 64)
      viewer.camera.up.set(0, 1, 0)
      viewer.camera.lookAt(0, lookY, 0)
      viewer.camera.updateMatrixWorld()
      // Half-extent in model units — frames head + shoulders + upper torso.
      const half = 14
      const ortho = new OrthographicCamera(-half, half, half, -half, 0.1, 200)
      ortho.position.copy(viewer.camera.position)
      ortho.quaternion.copy(viewer.camera.quaternion)
      ortho.up.copy(viewer.camera.up)
      ortho.updateProjectionMatrix()
      viewer.renderer.render(viewer.scene, ortho)
    }
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
