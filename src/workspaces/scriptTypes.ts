export type ScriptChromeInfo = {
  titleName: string
  packageName: string
  projectFolderName: string | null
  projectBusy: boolean
}

export type ScriptWorkspaceHandle = {
  handleMenuAction: (item: string) => void
  /**
   * 读一个 `assets/` 资源的字节。
   *
   * 交给这里而不是让调用方自己去摸 IndexedDB：包 id、路径规范化、blob 取用
   * 都是这一层的知识，调用方只需要"路径 → 字节"（克隆要拿声音样本）。
   */
  readAssetBytes: (path: string) => Promise<Uint8Array | null>
}
