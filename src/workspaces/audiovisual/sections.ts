import type { AudiovisualCategoryId } from '../../resourceTypes'

/** 视听顶层分类下的内置二级分类（稳定键、不可重命名/移动/删除）。 */
export type AudiovisualSectionDef = {
  id: string
  name: string
  /** 内置二级分类的父级；省略即挂在分类根 */
  parentId?: string
  /** 视图而非可整理父级：不进共享组织 sections */
  virtual?: boolean
}

/**
 * 占位分类的二级结构先只做资源树展示；接入原生格式后再决定是否登记为可整理父级。
 * 当前全部标 `virtual`，不写入 `meta/explorer.json`。
 */
export const AUDIOVISUAL_PACKAGE_SECTIONS: Partial<Record<AudiovisualCategoryId, AudiovisualSectionDef[]>> = {
  cutscene: [
    { id: 'realtime', name: '即时演算', virtual: true },
    { id: 'video', name: '视频播片', virtual: true },
  ],
  decoration: [
    { id: 'schematic', name: '原理图', virtual: true },
    { id: 'ornament', name: '装饰', virtual: true },
  ],
}

export const audiovisualSectionKey = (category: AudiovisualCategoryId, sectionId: string) =>
  `section:${category}:${sectionId}`
