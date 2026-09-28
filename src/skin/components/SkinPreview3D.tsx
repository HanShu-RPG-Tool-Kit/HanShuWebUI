/**
 * 详情 3D 预览(skinview3d,方案 §10):
 *   - ResizeObserver 自适应容器尺寸,devicePixelRatio 上限 2
 *   - 行走默认开启;自动转动 ~0.21 rad/s(约 30 秒一圈),800ms 内平滑加速
 *   - 拖拽接管:手动拖动时转速归零,松手约 2 秒后缓慢恢复
 *   - 纹理串行化提交:快速切换时旧加载结果绝不覆盖新纹理
 *   - 工作区隐藏时由父组件卸载(动画与渲染全部停止)
 */

import { useEffect, useRef } from 'react'
import * as skinview3d from 'skinview3d'
import type { SkinModel } from '../contracts/types.ts'
import styles from '../styles/workspace.module.css'

const AUTO_ROTATE_SPEED = 0.21 // rad/s ≈ 30s per revolution
const RAMP_MS = 800
const RESUME_DELAY_MS = 2000

interface Props {
  previewUrl: string
  model: SkinModel
  showOuterLayers: boolean
  walking: boolean
  autoRotate: boolean
  /** Workspace visible; false pauses all animation. */
  active: boolean
  viewMode?: 'model' | 'flat'
  onViewModeChange?: (mode: 'model' | 'flat') => void
  onToggleOuter?: (v: boolean) => void
  onToggleWalking?: (v: boolean) => void
  onToggleAutoRotate?: (v: boolean) => void
}

export function SkinPreview3D({
  previewUrl,
  model,
  showOuterLayers,
  walking,
  autoRotate,
  active,
  viewMode = 'model',
  onViewModeChange,
  onToggleOuter,
  onToggleWalking,
  onToggleAutoRotate,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<skinview3d.SkinViewer | null>(null)
  const loadSeq = useRef(0)
  const loadChain = useRef(Promise.resolve())
  const dragState = useRef({ dragging: false, resumeAt: 0 })
  const autoRotateRef = useRef(autoRotate)
  const activeRef = useRef(active)

  autoRotateRef.current = autoRotate
  activeRef.current = active

  /* ---------- viewer lifecycle + adaptive size ---------- */
  useEffect(() => {
    if (!canvasRef.current || !wrapRef.current) return
    const viewer = new skinview3d.SkinViewer({
      canvas: canvasRef.current,
      width: wrapRef.current.clientWidth || 280,
      height: wrapRef.current.clientHeight || 360,
    })
    viewerRef.current = viewer

    const applySize = () => {
      const el = wrapRef.current
      if (!el) return
      // skinview3d multiplies by pixelRatio itself; width/height are CSS
      // pixels. Multiplying dpr in here double-scales the drawing buffer and
      // pushes the model out of the visible area.
      viewer.pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      viewer.width = Math.max(1, Math.round(el.clientWidth))
      viewer.height = Math.max(1, Math.round(el.clientHeight))
      // Re-frame for the new aspect; the distance computed for the old size
      // leaves the model off-centre after the canvas changes.
      if (viewer.playerObject) viewer.adjustCameraDistance()
    }
    applySize()
    const ro = new ResizeObserver(applySize)
    ro.observe(wrapRef.current)

    // Drag takeover: while the user drags, auto-rotation yields.
    const onPointerDown = () => {
      dragState.current.dragging = true
      viewer.autoRotate = false
    }
    const onPointerUp = () => {
      if (!dragState.current.dragging) return
      dragState.current.dragging = false
      dragState.current.resumeAt = performance.now() + RESUME_DELAY_MS
    }
    viewer.canvas.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)

    return () => {
      ro.disconnect()
      viewer.canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  /* ---------- eased auto-rotation ---------- */
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    let raf = 0
    let current = viewer.autoRotate ? AUTO_ROTATE_SPEED : 0
    let last = performance.now()

    const tick = (now: number) => {
      const v = viewerRef.current
      if (!v) return
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      let target = 0
      if (autoRotateRef.current && activeRef.current && !dragState.current.dragging) {
        if (!dragState.current.dragging && now >= dragState.current.resumeAt) {
          target = AUTO_ROTATE_SPEED
        }
      }
      // Smooth ramp toward the target speed (~800ms full ramp).
      const step = (AUTO_ROTATE_SPEED * dt) / (RAMP_MS / 1000)
      if (current < target) current = Math.min(target, current + step)
      else if (current > target) current = Math.max(target, current - step)
      v.autoRotateSpeed = current
      v.autoRotate = current > 0
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  /* ---------- serialized texture commits ---------- */
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const seq = ++loadSeq.current
    const skinviewModel = model === 'classic' ? 'default' : 'slim'
    // Serialize loads: each new request waits for the previous load to settle
    // before touching the viewer, so an in-flight old texture can never land
    // after a newer one.
    loadChain.current = loadChain.current
      .then(async () => {
        const v = viewerRef.current
        if (!v || seq !== loadSeq.current) return
        await v.loadSkin(previewUrl, { model: skinviewModel })
        // A newer request arrived while this one was in flight — drop it.
        if (seq !== loadSeq.current) return
        // Frame the whole player from the front; autoRotate orbits around the
        // lookAt point skinview3d maintains. Do not override lookAt here.
        v.adjustCameraDistance()
        // Re-apply outer-layer visibility after a texture swap.
        applyOuter(v, showOuterLayers)
      })
      .catch(() => {
        // Preview failure must not crash the pane; the 2D PNG is the fallback.
      })
  }, [previewUrl, model, showOuterLayers])

  /* ---------- outer layer visibility ---------- */
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer) applyOuter(viewer, showOuterLayers)
  }, [showOuterLayers])

  /* ---------- walking ---------- */
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.animation = walking && active ? new skinview3d.WalkingAnimation() : null
  }, [walking, active])

  return (
    <div className={styles.previewWrap} ref={wrapRef}>
      <canvas ref={canvasRef} className={styles.previewCanvas} aria-label="3D 皮肤预览" />
      <div className={styles.previewHoverBar}>
        {onViewModeChange && (
          <div className={styles.previewModeSeg} role="tablist" aria-label="预览方式">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'model'}
              className={viewMode === 'model' ? styles.active : undefined}
              onClick={() => onViewModeChange('model')}
            >
              模型
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'flat'}
              className={viewMode === 'flat' ? styles.active : undefined}
              onClick={() => onViewModeChange('flat')}
            >
              展开图
            </button>
          </div>
        )}
        <div className={styles.previewHoverRight}>
          <button
            type="button"
            className={showOuterLayers ? styles.previewToggleOn : styles.previewToggleOff}
            aria-pressed={showOuterLayers}
            onClick={() => onToggleOuter?.(!showOuterLayers)}
          >
            外层
          </button>
          <button
            type="button"
            className={walking ? styles.previewToggleOn : styles.previewToggleOff}
            aria-pressed={walking}
            onClick={() => onToggleWalking?.(!walking)}
          >
            行走
          </button>
          <button
            type="button"
            className={autoRotate ? styles.previewToggleOn : styles.previewToggleOff}
            aria-pressed={autoRotate}
            onClick={() => onToggleAutoRotate?.(!autoRotate)}
          >
            转动
          </button>
        </div>
      </div>
    </div>
  )
}

function applyOuter(viewer: skinview3d.SkinViewer, show: boolean) {
  const p = viewer.playerObject?.skin
  if (!p) return
  for (const part of [p.head, p.body, p.leftArm, p.rightArm, p.leftLeg, p.rightLeg]) {
    part.outerLayer.visible = show
  }
}
