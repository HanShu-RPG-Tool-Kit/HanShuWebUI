import { StatusBarSlots } from '../chrome'
import { SkinWorkspace } from '../skin/SkinWorkspace.tsx'

export interface McSkinWorkspaceProps {
  /** 工作区可见性:隐藏时停用 3D 渲染与动画(状态保留)。 */
  active: boolean
}

export function McSkinWorkspace({ active }: McSkinWorkspaceProps) {
  return (
    <>
      <SkinWorkspace active={active} />
      <StatusBarSlots
        active={active}
        left={<span>皮肤管理器</span>}
      />
    </>
  )
}
