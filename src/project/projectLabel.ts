/** Resource-tree location label. C knows the connected project, not a writable OS directory. */

/** 已连接服务端工程 */
export const LOCAL_MIRROR_LABEL = '服务端工程'

/**
 * @deprecated Virtual Cache 已不再作为正式工作流；未绑定工程不应出现在资源树。
 * 保留常量以免旧调用方立刻炸掉。
 */
export const VIRTUAL_PACKAGE_LABEL = '未绑定'

/**
 * 某个工程这一行该显示什么。未绑定返回空串（调用方应隐藏或显示占位）。
 */
export function packageLocationLabel(options: {
  packageId: string
  boundPackageId: string | null
}): string {
  const { packageId, boundPackageId } = options
  return boundPackageId && packageId === boundPackageId ? LOCAL_MIRROR_LABEL : ''
}

/** 标签的 tooltip 说明（悬停时补上具体文件夹名） */
export function packageLocationTitle(options: {
  packageId: string
  boundPackageId: string | null
  boundFolderName: string | null
}): string {
  const { packageId, boundPackageId, boundFolderName } = options
  if (!boundPackageId || packageId !== boundPackageId) {
    return '尚未连接工程服务；请「打开工程」或「新建工程」'
  }
  return boundFolderName
    ? `已连接服务端工程：${boundFolderName}`
    : '已连接服务端工程'
}
