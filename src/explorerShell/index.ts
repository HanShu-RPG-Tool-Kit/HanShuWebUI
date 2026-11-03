export { CategoryExplorer, type CategoryExplorerSlots, type CreateAnchor } from './CategoryExplorer'
export { ExplorerShellFrame, type ExplorerShellClasses } from './ExplorerShellFrame'
export { ExplorerTreeRow } from './ExplorerTreeRow'
export { dockTitleHint, explorerRowClassName, type ExplorerDockProps, type ExplorerRowState } from './shellModel'
export {
  categoriesFromTable,
  filesForCategories,
  type CategoryTable,
  type ShellCategory,
  type ShellFile,
} from './categoryAdapter'
export {
  addVirtualFolder,
  folderSubtree,
  moveVirtualFolder,
  placeSource,
  removeVirtualFolder,
  renameVirtualFolder,
} from './virtualFolders'
export { commitOrganization } from './commitOrganization'
export { organizationEdits, relocatedExplorer, withExplorer } from './relocation'
