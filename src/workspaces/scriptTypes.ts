export type ScriptChromeInfo = {
  titleName: string
  packageName: string
  projectFolderName: string | null
  projectBusy: boolean
}

export type ScriptWorkspaceHandle = {
  handleMenuAction: (item: string) => void
}
