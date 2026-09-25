/**
 * 网格缩略图:离屏 skinview3d 渲染 3D 静帧,失败时回退 2D 预览图。
 * 迁移调整:离屏渲染并发从 4 降到 1,缓存加 LRU 上限(评审 §3.4)。
 */

import { useEffect, useState } from 'react'
import * as skinview3d from 'skinview3d'
import type { SkinModel } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

const MAX_CONCURRENT = 1
const CACHE_LIMIT = 128

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()
const listeners = new Set<() => void>()
let active = 0
const queue: Array<() => void> = []

function key(skinId: string, model: SkinModel): string {
  return `${skinId}:${model}`
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

export function peekThumb(skinId: string, model: SkinModel): string | null {
  const k = key(skinId, model)
  const hit = cache.get(k) ?? null
  if (hit) {
    // LRU touch
    cache.delete(k)
    cache.set(k, hit)
  }
  return hit
}

export function getThumb(
  skinId: string,
  model: SkinModel,
  previewUrl: string,
): Promise<string | null> {
  const k = key(skinId, model)
  const hit = cache.get(k)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(k)
  if (pending) return pending

  const task = new Promise<string | null>((resolve) => {
    const run = async () => {
      active++
      try {
        const url = await renderOffscreen(previewUrl, model)
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

async function renderOffscreen(previewUrl: string, model: SkinModel): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = 120
  canvas.height = 160
  const viewer = new skinview3d.SkinViewer({
    canvas,
    width: 120,
    height: 160,
    pixelRatio: 1,
    // zoom=1.0 puts the head's top edge flush with the canvas top; 0.95 leaves
    // a small margin so head and feet don't touch the frame.
    zoom: 0.95,
  })
  try {
    const skinviewModel = model === 'classic' ? 'default' : 'slim'
    await viewer.loadSkin(previewUrl, { model: skinviewModel })
    viewer.adjustCameraDistance()
    viewer.render()
    return canvas.toDataURL('image/png')
  } catch {
    return null // caller falls back to the 2D preview
  } finally {
    viewer.dispose()
  }
}

interface Props {
  skinId: string
  model: SkinModel
  previewUrl: string
  alt: string
}

export function SkinThumb({ skinId, model, previewUrl, alt }: Props) {
  const [thumb, setThumb] = useState<string | null>(() => peekThumb(skinId, model))

  useEffect(() => {
    let cancelled = false
    const hit = peekThumb(skinId, model)
    if (hit) {
      setThumb(hit)
      return
    }
    void getThumb(skinId, model, previewUrl)
    const off = onThumbUpdate(() => {
      if (cancelled) return
      const url = peekThumb(skinId, model)
      if (url) setThumb(url)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [skinId, model, previewUrl])

  return (
    <img
      src={thumb ?? previewUrl}
      alt={alt}
      loading="lazy"
      className={thumb ? `${styles.thumb} ${styles.thumb3d}` : `${styles.thumb} ${styles.thumb2d}`}
    />
  )
}
