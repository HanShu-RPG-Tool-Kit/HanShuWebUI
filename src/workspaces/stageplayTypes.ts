export type StageplayChromeInfo = {
  titleName: string
  packageName: string
  projectFolderName: string | null
  projectBusy: boolean
}

export type StageplayWorkspaceHandle = {
  handleMenuAction: (item: string) => void
}
