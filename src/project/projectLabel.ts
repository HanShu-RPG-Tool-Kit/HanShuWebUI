/**
 * 工程位置的显示标签（资源管理器里包那一行的小灰字）。
 *
 * 刻意**不显示文件夹名/路径**：浏览器的 File System Access API 不暴露绝对路径
 * （`FileSystemDirectoryHandle` 只有 `name`），只显示文件夹名信息量有限、还得处理截断；
 * 所以这里只区分"这个包有没有落在本地工程文件夹上"：
 * - 绑定着工程文件夹 → `Local Mirror`（磁盘上那份是它的镜像）
 * - 否则（只存在于应用内的工作区模型 / IndexedDB）→ `Virtual Cache`
 *
 * 若将来桌面端改由 Tauri 选择目录（能拿到真实绝对路径），再在这里加"保留尾段 + 前置 ..."
 * 的截断显示即可。
 */

/** 绑定了本地工程文件夹的包 */
export const LOCAL_MIRROR_LABEL = 'Local Mirror'

/** 没有对应工程文件夹的包 */
export const VIRTUAL_PACKAGE_LABEL = 'Virtual Cache'

/**
 * 某个包这一行该显示什么：
 * - 就是绑定工程的那个包 → `Local Mirror`
 * - 否则 → `Virtual Cache`
 */
export function packageLocationLabel(options: {
  packageId: string
  boundPackageId: string | null
}): string {
  const { packageId, boundPackageId } = options
  return boundPackageId && packageId === boundPackageId
    ? LOCAL_MIRROR_LABEL
    : VIRTUAL_PACKAGE_LABEL
}

/** 标签的 tooltip 说明（悬停时补上具体文件夹名） */
export function packageLocationTitle(options: {
  packageId: string
  boundPackageId: string | null
  boundFolderName: string | null
}): string {
  const { packageId, boundPackageId, boundFolderName } = options
  if (!boundPackageId || packageId !== boundPackageId) {
    return '仅存在于应用内缓存（工作区模型 / IndexedDB），没有绑定工程文件夹'
  }
  return boundFolderName
    ? `已绑定本地工程文件夹：${boundFolderName}`
    : '已绑定本地工程文件夹'
}
