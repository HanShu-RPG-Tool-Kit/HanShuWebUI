import { SCRIPT_TYPES, SCRIPT_TYPE_NAMES, scriptSection } from '../../scriptResources/types'
import type { FlowPackageId } from './storage'

export type FlowSectionDef = {
  id: string
  name: string
  /** 内置二级分类的父级；省略即挂在分类根 */
  parentId?: string
  /** 视图而非目录：不落 state.folders，也不可创建/移动/删除 */
  virtual?: boolean
}

/** 顶层分类下的内置二级分类（稳定键、不可重命名/移动/删除）。任务的单/多进度是视图，不走这里。 */
export const FLOW_PACKAGE_SECTIONS: Partial<Record<FlowPackageId, FlowSectionDef[]>> = {
  script: SCRIPT_TYPES.map(type=>({id:scriptSection(type),name:SCRIPT_TYPE_NAMES[type]})),
  level: [
    { id: 'templates', name: '地图模板' },
    { id: 'navigator', name: '导航器' },
    { id: 'static-nav', name: '静态导航器', parentId: 'navigator', virtual: true },
    { id: 'dynamic-nav', name: '动态导航器', parentId: 'navigator' },
  ],
}
