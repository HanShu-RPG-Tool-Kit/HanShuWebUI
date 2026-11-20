/** EditorDock 页签 id：与源文件 key 区分，避免撞上游戏性文档 / 视听文件 id。 */
export const ASSET_PAGE_PREFIX = 'asset:'

export function assetPageKey(assetId: string): string {
  return `${ASSET_PAGE_PREFIX}${assetId}`
}

export function parseAssetPageKey(key: string): string | null {
  return key.startsWith(ASSET_PAGE_PREFIX) ? key.slice(ASSET_PAGE_PREFIX.length) : null
}
