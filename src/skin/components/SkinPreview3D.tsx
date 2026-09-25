/**
 * 3D 预览(skinview3d)。清理时 dispose;快速切换皮肤时用序号防止旧异步
 * 加载覆盖新选择。隐藏工作区时由父组件卸载本组件(相机选项保存在上层)。
 */

import { useEffect, useRef } from 'react'
import * as skinview3d from 'skinview3d'
import type { SkinModel } from '../contracts/types.ts'

interface Props {
  previewUrl: string
  model: SkinModel
  showOuterLayers: boolean
  walking: boolean
}

export function SkinPreview3D({ previewUrl, model, showOuterLayers, walking }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<skinview3d.SkinViewer | null>(null)
  const loadSeq = useRef(0)

  useEffect(() => {
    if (!canvasRef.current) return
    const viewer = new skinview3d.SkinViewer({
      canvas: canvasRef.current,
      width: 280,
      height: 360,
    })
    viewerRef.current = viewer
    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const seq = ++loadSeq.current
    // skinview3d uses "default" for the classic 4px-arm model.
    const skinviewModel = model === 'classic' ? 'default' : 'slim'
    void viewer.loadSkin(previewUrl, { model: skinviewModel }).then(
      () => {
        // A newer selection arrived while this load was in flight — drop it.
        if (seq !== loadSeq.current) return
      },
      () => {
        // Preview failure must not crash the pane; the 2D PNG is still available.
      },
    )
  }, [previewUrl, model])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer?.playerObject) return
    const p = viewer.playerObject.skin
    p.head.outerLayer.visible = showOuterLayers
    p.body.outerLayer.visible = showOuterLayers
    p.leftArm.outerLayer.visible = showOuterLayers
    p.rightArm.outerLayer.visible = showOuterLayers
    p.leftLeg.outerLayer.visible = showOuterLayers
    p.rightLeg.outerLayer.visible = showOuterLayers
  }, [showOuterLayers])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.animation = walking ? new skinview3d.WalkingAnimation() : null
  }, [walking])

  return <canvas ref={canvasRef} width={280} height={360} aria-label="3D 皮肤预览" />
}
