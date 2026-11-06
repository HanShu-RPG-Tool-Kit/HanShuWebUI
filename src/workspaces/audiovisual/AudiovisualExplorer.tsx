import { useMemo } from 'react'
import { CategoryExplorer, filesForCategories, type ExplorerDockProps } from '../../explorerShell'
import type { ExplorerOrganization } from '../../project/explorerOrganization'
import type { SourceFile } from '../../workspace'
import { AUDIOVISUAL_EXPLORER_CATEGORIES } from './explorerCategories'
import { AUDIOVISUAL_PACKAGE_SECTIONS } from './sections'

export function AudiovisualExplorer({
  files,
  organization,
  activeId,
  readOnly,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onOrganize,
  dock,
}: {
  files: readonly SourceFile[]
  organization: ExplorerOrganization | null
  activeId: string | null
  readOnly: boolean
  onOpen: (id: string) => void
  onCreate: (category: string, folderKey: string | null) => void
  onRename: (id: string, base: string) => string | null
  onDelete: (ids: string[]) => void
  onOrganize: (next: ExplorerOrganization, label: string) => void
  dock: ExplorerDockProps
}) {
  const shellFiles = useMemo(() => filesForCategories(files, AUDIOVISUAL_EXPLORER_CATEGORIES), [files])
  return (
    <CategoryExplorer
      label="视听效果资源管理器"
      categories={AUDIOVISUAL_EXPLORER_CATEGORIES}
      files={shellFiles}
      organization={organization}
      activeId={activeId}
      readOnly={readOnly}
      defaultOpen={['bossbar']}
      sections={AUDIOVISUAL_PACKAGE_SECTIONS}
      emptyHint={(category) =>
        category.createLabel ? `暂无资源。右键或点标题栏新建按钮${category.createLabel.replace(/^新建/, '创建')}。` : '暂无资源。'
      }
      onOpen={onOpen}
      onCreate={onCreate}
      onRename={onRename}
      onDelete={onDelete}
      onOrganize={onOrganize}
      dock={dock}
    />
  )
}
