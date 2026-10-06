/**
 * 工程位置的显示标签（资源管理器里工程那一行的小灰字）。
 *
 * 刻意**不显示文件夹名/路径**：浏览器的 File System Access API 不暴露绝对路径
 * （`FileSystemDirectoryHandle` 只有 `name`），只显示文件夹名信息量有限、还得处理截断。
 *
 * 正式工作流要求绑定本地工程目录；未绑定不作为可编辑工程展示。
 */

/** 已绑定本地工程文件夹 */
export const LOCAL_MIRROR_LABEL = '本地工程'

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
    return '尚未绑定工程文件夹；请「打开工程」或「新建工程」'
  }
  return boundFolderName
    ? `已绑定本地工程文件夹：${boundFolderName}`
    : '已绑定本地工程文件夹'
}
