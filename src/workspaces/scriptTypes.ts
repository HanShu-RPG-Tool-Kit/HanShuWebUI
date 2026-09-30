export type ScriptChromeInfo = {
  titleName: string
  packageName: string
  projectFolderName: string | null
  projectBusy: boolean
}

export type ScriptWorkspaceHandle = {
  handleMenuAction: (item: string) => void
  /** 包内全部文本文件的逻辑名（与资源树同源） */
  listPackageFiles: () => string[]
  /** 读一个包内文本文件；不在包里返回 null */
  readPackageText: (name: string) => string | null
  /**
   * 覆盖或新建一个包内文本文件，成功返回 true。
   *
   * **工具工作区必须走这条路,不能直接写盘。** 工程的内存包才是真相,而保存时会清掉
   * "不在包里的文本文件" —— 绕过它写盘的文件会在下一次保存时被删掉,
   * 而且正在编辑器里打开时还会被旧正文覆盖回去。
   */
  writePackageText: (name: string, content: string) => boolean
  /**
   * 读一个 `assets/` 资源的字节。
   *
   * 交给这里而不是让工作区自己去摸 IndexedDB：包 id、路径规范化、blob 取用
   * 都是这一层的知识，工作区只需要"路径 → 字节"。
   */
  readAssetBytes: (path: string) => Promise<Uint8Array | null>
}
