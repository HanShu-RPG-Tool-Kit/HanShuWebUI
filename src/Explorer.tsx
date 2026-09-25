import { useEffect, useMemo, useState } from 'react'
import type { AssetFile, ScriptPackage, Workspace } from './workspace'
import { isVoiceMapFile } from './workspace'
import {
  assetFileName,
  buildAssetTree,
  type AssetTreeDir,
  type AssetTreeNode,
} from './assets/paths'

type ExplorerProps = {
  workspace: Workspace
  activeScriptId: string | null
  activeAssetId: string | null
  onOpenScript: (scriptId: string) => void
  onOpenAsset: (assetId: string) => void
  onTogglePackage: (packageId: string) => void
  onToggleAssets: (packageId: string) => void
  onNewPackage: () => void
  onNewScript: (packageId: string) => void
  onRenamePackage: (packageId: string) => void
  onRenameScript: (scriptId: string) => void
  onDeletePackage: (packageId: string) => void
  onDeleteScript: (scriptId: string) => void
  onDeleteAsset: (assetId: string) => void
  onNewAssetFolder: (packageId: string, parentPath: string) => void
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void
  onPullVoice: (scriptId: string) => void
  onGenerateBlankVoiceOggs: (scriptId: string) => void
}

export function Explorer({
  workspace,
  activeScriptId,
  activeAssetId,
  onOpenScript,
  onOpenAsset,
  onTogglePackage,
  onToggleAssets,
  onNewPackage,
  onNewScript,
  onRenamePackage,
  onRenameScript,
  onDeletePackage,
  onDeleteScript,
  onDeleteAsset,
  onNewAssetFolder,
  onDeleteAssetFolder,
  onImportAssets,
  onPullVoice,
  onGenerateBlankVoiceOggs,
}: ExplorerProps) {
  return (
    <aside className="explorer" aria-label="资源管理器">
      <div className="explorer-header">
        <span>资源管理器</span>
        <div className="explorer-actions">
          <button
            type="button"
            title="新建剧本"
            onClick={() => {
              const target =
                workspace.packages.find(
                  (pkg) =>
                    pkg.scripts.some((s) => s.id === activeScriptId) ||
                    pkg.assets.some((a) => a.id === activeAssetId),
                ) ?? workspace.packages[0]
              if (target) onNewScript(target.id)
            }}
          >
            +剧
          </button>
          <button type="button" title="新建包" onClick={onNewPackage}>
            +包
          </button>
        </div>
      </div>

      <div className="explorer-tree">
        {workspace.packages.map((pkg) => (
          <PackageNode
            key={pkg.id}
            pkg={pkg}
            activeScriptId={activeScriptId}
            activeAssetId={activeAssetId}
            onOpenScript={onOpenScript}
            onOpenAsset={onOpenAsset}
            onTogglePackage={onTogglePackage}
            onToggleAssets={onToggleAssets}
            onNewScript={onNewScript}
            onRenamePackage={onRenamePackage}
            onRenameScript={onRenameScript}
            onDeletePackage={onDeletePackage}
            onDeleteScript={onDeleteScript}
            onDeleteAsset={onDeleteAsset}
            onNewAssetFolder={onNewAssetFolder}
            onDeleteAssetFolder={onDeleteAssetFolder}
            onImportAssets={onImportAssets}
            onPullVoice={onPullVoice}
            onGenerateBlankVoiceOggs={onGenerateBlankVoiceOggs}
          />
        ))}
        {workspace.packages.length === 0 && (
          <div className="explorer-empty">暂无资源，点击 +包 开始</div>
        )}
      </div>
    </aside>
  )
}

function PackageNode({
  pkg,
  activeScriptId,
  activeAssetId,
  onOpenScript,
  onOpenAsset,
  onTogglePackage,
  onToggleAssets,
  onNewScript,
  onRenamePackage,
  onRenameScript,
  onDeletePackage,
  onDeleteScript,
  onDeleteAsset,
  onNewAssetFolder,
  onDeleteAssetFolder,
  onImportAssets,
  onPullVoice,
  onGenerateBlankVoiceOggs,
}: {
  pkg: ScriptPackage
  activeScriptId: string | null
  activeAssetId: string | null
  onOpenScript: (scriptId: string) => void
  onOpenAsset: (assetId: string) => void
  onTogglePackage: (packageId: string) => void
  onToggleAssets: (packageId: string) => void
  onNewScript: (packageId: string) => void
  onRenamePackage: (packageId: string) => void
  onRenameScript: (scriptId: string) => void
  onDeletePackage: (packageId: string) => void
  onDeleteScript: (scriptId: string) => void
  onDeleteAsset: (assetId: string) => void
  onNewAssetFolder: (packageId: string, parentPath: string) => void
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void
  onPullVoice: (scriptId: string) => void
  onGenerateBlankVoiceOggs: (scriptId: string) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>(
    {},
  )
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    scriptId: string
  } | null>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  const tree = useMemo(
    () => buildAssetTree(pkg.assets, pkg.assetFolders ?? []),
    [pkg.assets, pkg.assetFolders],
  )

  const toggleDir = (path: string) => {
    setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  const isDirCollapsed = (path: string) => Boolean(collapsedDirs[path])

  return (
    <div
      className={`explorer-pkg${dragOver ? ' drag-over' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false)
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        if (e.dataTransfer.files?.length) {
          onImportAssets(pkg.id, e.dataTransfer.files, 'assets')
        }
      }}
    >
      <div className="explorer-row explorer-pkg-row">
        <button
          type="button"
          className="explorer-twist"
          onClick={() => onTogglePackage(pkg.id)}
          aria-label={pkg.collapsed ? '展开' : '折叠'}
        >
          {pkg.collapsed ? '▸' : '▾'}
        </button>
        <button
          type="button"
          className="explorer-label"
          onClick={() => onTogglePackage(pkg.id)}
          onDoubleClick={() => onRenamePackage(pkg.id)}
          title="双击重命名；可拖入文件到包内 assets/"
        >
          <span className="explorer-icon pkg" aria-hidden />
          {pkg.name}
        </button>
        <div className="explorer-row-actions">
          <button
            type="button"
            title="在此包新建剧本"
            onClick={() => onNewScript(pkg.id)}
          >
            +
          </button>
          <button
            type="button"
            title="删除包"
            onClick={() => onDeletePackage(pkg.id)}
          >
            ×
          </button>
        </div>
      </div>

      {!pkg.collapsed && (
        <>
          <ul className="explorer-files">
            {pkg.scripts.map((script) => (
              <li key={script.id}>
                <div
                  className={`explorer-row explorer-file-row${
                    script.id === activeScriptId ? ' active' : ''
                  }`}
                  onContextMenu={
                    isVoiceMapFile(script.name)
                      ? (e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            scriptId: script.id,
                          })
                        }
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="explorer-label"
                    onClick={() => onOpenScript(script.id)}
                    onDoubleClick={() => onRenameScript(script.id)}
                    title={
                      isVoiceMapFile(script.name)
                        ? '右键：拉取新配音 / 生成空白 ogg'
                        : '双击重命名'
                    }
                  >
                    <span className="explorer-icon file" aria-hidden />
                    {script.name}
                  </button>
                  <div className="explorer-row-actions">
                    <button
                      type="button"
                      title="删除剧本"
                      onClick={() => onDeleteScript(script.id)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              </li>
            ))}
            {pkg.scripts.length === 0 && (
              <li className="explorer-empty nested">空包</li>
            )}
          </ul>

          {ctxMenu && (
            <ul
              className="explorer-context-menu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              role="menu"
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const id = ctxMenu.scriptId
                    setCtxMenu(null)
                    onPullVoice(id)
                  }}
                >
                  拉取新配音
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const id = ctxMenu.scriptId
                    setCtxMenu(null)
                    onGenerateBlankVoiceOggs(id)
                  }}
                >
                  生成空白 ogg
                </button>
              </li>
            </ul>
          )}

          <AssetFolderBlock
            pkgId={pkg.id}
            dir={tree}
            depth={0}
            rootCollapsed={pkg.assetsCollapsed}
            activeAssetId={activeAssetId}
            isDirCollapsed={isDirCollapsed}
            onToggleRoot={() => onToggleAssets(pkg.id)}
            onToggleDir={toggleDir}
            onOpenAsset={onOpenAsset}
            onDeleteAsset={onDeleteAsset}
            onNewAssetFolder={onNewAssetFolder}
            onDeleteAssetFolder={onDeleteAssetFolder}
            onImportAssets={onImportAssets}
          />
        </>
      )}
    </div>
  )
}

function AssetFolderBlock({
  pkgId,
  dir,
  depth,
  rootCollapsed,
  activeAssetId,
  isDirCollapsed,
  onToggleRoot,
  onToggleDir,
  onOpenAsset,
  onDeleteAsset,
  onNewAssetFolder,
  onDeleteAssetFolder,
  onImportAssets,
}: {
  pkgId: string
  dir: AssetTreeDir
  depth: number
  rootCollapsed: boolean
  activeAssetId: string | null
  isDirCollapsed: (path: string) => boolean
  onToggleRoot: () => void
  onToggleDir: (path: string) => void
  onOpenAsset: (assetId: string) => void
  onDeleteAsset: (assetId: string) => void
  onNewAssetFolder: (packageId: string, parentPath: string) => void
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void
}) {
  const isRoot = dir.path === 'assets'
  const collapsed = isRoot ? rootCollapsed : isDirCollapsed(dir.path)
  const [dragOver, setDragOver] = useState(false)

  return (
    <div
      className={`explorer-assets${dragOver ? ' drag-over' : ''}`}
      style={{ paddingLeft: depth === 0 ? undefined : 8 }}
      onDragEnter={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false)
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        if (e.dataTransfer.files?.length) {
          onImportAssets(pkgId, e.dataTransfer.files, dir.path)
        }
      }}
    >
      <div
        className={`explorer-row explorer-assets-row${
          isRoot ? '' : ' explorer-subdir-row'
        }`}
      >
        <button
          type="button"
          className="explorer-twist"
          onClick={() => (isRoot ? onToggleRoot() : onToggleDir(dir.path))}
          aria-label={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <button
          type="button"
          className="explorer-label"
          onClick={() => (isRoot ? onToggleRoot() : onToggleDir(dir.path))}
          title={`${dir.path} — 拖入文件到此文件夹`}
        >
          <span className="explorer-icon folder" aria-hidden />
          {dir.name}
          {isRoot && (
            <span className="explorer-count">
              {countFiles(dir)}
            </span>
          )}
        </button>
        <div className="explorer-row-actions">
          <button
            type="button"
            title="新建子文件夹"
            onClick={() => onNewAssetFolder(pkgId, dir.path)}
          >
            +夹
          </button>
          <label className="explorer-upload" title="导入到此文件夹">
            ↑
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) {
                  onImportAssets(pkgId, e.target.files, dir.path)
                  e.target.value = ''
                }
              }}
            />
          </label>
          {!isRoot && (
            <button
              type="button"
              title="删除文件夹"
              onClick={() => onDeleteAssetFolder(pkgId, dir.path)}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <ul className="explorer-files explorer-asset-files">
          {dir.children.map((node) =>
            node.kind === 'dir' ? (
              <li key={`dir:${node.path}`}>
                <AssetFolderBlock
                  pkgId={pkgId}
                  dir={node}
                  depth={depth + 1}
                  rootCollapsed={false}
                  activeAssetId={activeAssetId}
                  isDirCollapsed={isDirCollapsed}
                  onToggleRoot={onToggleRoot}
                  onToggleDir={onToggleDir}
                  onOpenAsset={onOpenAsset}
                  onDeleteAsset={onDeleteAsset}
                  onNewAssetFolder={onNewAssetFolder}
                  onDeleteAssetFolder={onDeleteAssetFolder}
                  onImportAssets={onImportAssets}
                />
              </li>
            ) : (
              <AssetRow
                key={node.asset.id}
                asset={node.asset as AssetFile}
                active={node.asset.id === activeAssetId}
                onOpen={() => onOpenAsset(node.asset.id)}
                onDelete={() => onDeleteAsset(node.asset.id)}
              />
            ),
          )}
          {dir.children.length === 0 && (
            <li className="explorer-empty nested">空文件夹 · 拖入或 +夹</li>
          )}
        </ul>
      )}
    </div>
  )
}

function countFiles(node: AssetTreeNode): number {
  if (node.kind === 'file') return 1
  return node.children.reduce((n, c) => n + countFiles(c), 0)
}

function AssetRow({
  asset,
  active,
  onOpen,
  onDelete,
}: {
  asset: AssetFile
  active: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <li>
      <div
        className={`explorer-row explorer-file-row explorer-asset-row${
          active ? ' active' : ''
        }`}
      >
        <button
          type="button"
          className="explorer-label"
          onClick={onOpen}
          title={asset.path}
        >
          <span className="explorer-icon asset" aria-hidden />
          {assetFileName(asset.path)}
        </button>
        <div className="explorer-row-actions">
          <button type="button" title="删除资产" onClick={onDelete}>
            ×
          </button>
        </div>
      </div>
    </li>
  )
}
