import { useEffect, useMemo, useState } from 'react'
import type { AssetFile, ScriptPackage, Workspace } from './workspace'
import { isVoiceMapFile } from './workspace'
import { packageLocationLabel, packageLocationTitle } from './project/projectLabel'
import {
  currentDrag,
  endDrag,
  hasExternalFiles,
  readDragPayload,
  resolveDropIntent,
  writeDragPayload,
  type DragSource,
} from './drag/dragPayload'
import {
  assetFileName,
  buildAssetTree,
  type AssetTreeDir,
  type AssetTreeNode,
} from './assets/paths'
import {
  SOURCE_KIND_DIRS,
  SOURCE_KIND_ORDER,
  getExtension,
} from './workspace'

/**
 * 目录行的投放接线（包行 / assets 目录行共用）：
 * - 外部文件 → 等价于复制粘贴导入
 * - 内部的脚本 / 资产 → 等价于剪切移动
 * 只有**支持**的载荷才 `preventDefault` 并加 `.is-drop-target`（框式高亮），
 * 其余一律不接管，保持浏览器默认。
 */
function useFolderDropTarget(options: {
  onFiles(files: File[]): void
  onPayload(source: DragSource): void
}) {
  const [active, setActive] = useState(false)
  const resolve = (event: React.DragEvent) =>
    resolveDropIntent({
      target: 'explorer-folder',
      source: currentDrag(),
      hasFiles: hasExternalFiles(event.dataTransfer),
    })

  return {
    active,
    handlers: {
      onDragOver: (event: React.DragEvent) => {
        const intent = resolve(event)
        if (!intent) {
          setActive(false)
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect =
            intent.action === 'move-into-folder' ? 'move' : 'copy'
        }
        setActive(true)
      },
      onDragLeave: (event: React.DragEvent) => {
        const next = event.relatedTarget as Node | null
        if (!next || !event.currentTarget.contains(next)) setActive(false)
      },
      onDrop: (event: React.DragEvent) => {
        const intent = resolve(event)
        setActive(false)
        if (!intent) return
        event.preventDefault()
        event.stopPropagation()
        const files = Array.from(event.dataTransfer?.files ?? [])
        const source = readDragPayload(event.dataTransfer)
        endDrag()
        if (intent.action === 'import-files') {
          options.onFiles(files)
          return
        }
        if (intent.action === 'move-into-folder' && source) {
          options.onPayload(source)
        }
      },
    },
  }
}

type ExplorerProps = {
  workspace: Workspace
  activeScriptId: string | null
  activeAssetId: string | null
  /** 绑定到本地工程文件夹的那个包 id（null = 没有绑定工程） */
  boundPackageId: string | null
  /** 该工程的本地位置（浏览器 API 只给得到文件夹名） */
  boundFolderName: string | null
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
  onGeneratePlaceholderVoice: (scriptId: string) => void
  /** 内部拖拽落到目录行：把载荷里的脚本 / 资产移动到该包该目录 */
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void
}

export function Explorer({
  workspace,
  activeScriptId,
  activeAssetId,
  boundPackageId,
  boundFolderName,
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
  onGeneratePlaceholderVoice,
  onDropIntoFolder,
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
            locationLabel={packageLocationLabel({
              packageId: pkg.id,
              boundPackageId,
            })}
            locationTitle={packageLocationTitle({
              packageId: pkg.id,
              boundPackageId,
              boundFolderName,
            })}
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
            onGeneratePlaceholderVoice={onGeneratePlaceholderVoice}
            onDropIntoFolder={onDropIntoFolder}
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
  locationLabel,
  locationTitle,
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
  onGeneratePlaceholderVoice,
  onDropIntoFolder,
}: {
  pkg: ScriptPackage
  activeScriptId: string | null
  activeAssetId: string | null
  /** 这个包的本地位置标签（小灰字：Local Mirror / Virtual Cache） */
  locationLabel: string
  /** 标签的说明（tooltip） */
  locationTitle: string
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
  onGeneratePlaceholderVoice: (scriptId: string) => void
  /** 内部拖拽落到目录行 */
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void
}) {
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

  // 包行本身也是投放目标：外部文件进 `assets/`，内部脚本 / 资产移进本包
  const pkgDrop = useFolderDropTarget({
    onFiles: (files) => onImportAssets(pkg.id, files, 'assets'),
    onPayload: (source) => onDropIntoFolder(pkg.id, 'assets', source),
  })

  // 源文件按 `src/<kind>/` 分组展示；其余（`.md`、旧 `*.voice`）留在包根
  const grouped = useMemo(() => {
    const byKind = new Map<string, Array<(typeof pkg.scripts)[number]>>(
      SOURCE_KIND_ORDER.map((kind) => [kind, []]),
    )
    const root: Array<(typeof pkg.scripts)[number]> = []
    for (const script of pkg.scripts) {
      const kind = SOURCE_KIND_DIRS[getExtension(script.name)]
      const bucket = kind ? byKind.get(kind) : null
      if (bucket) bucket.push(script)
      else root.push(script)
    }
    return { byKind, root }
  }, [pkg.scripts])

  const renderScriptRow = (script: (typeof pkg.scripts)[number]) => (
    <li key={script.id}>
      <div
        className={`explorer-row explorer-file-row${
          script.id === activeScriptId ? ' active' : ''
        }`}
        draggable
        onDragStart={(e) => {
          writeDragPayload(e.dataTransfer, {
            kind: 'script',
            packageId: pkg.id,
            scriptId: script.id,
            name: script.name,
          })
        }}
        onDragEnd={() => endDrag()}
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
            isVoiceMapFile(script.name) ? '右键：生成空白 ogg' : '双击重命名'
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
  )

  return (
    <div
      className={`explorer-pkg${pkgDrop.active ? ' is-drop-target' : ''}`}
      {...pkgDrop.handlers}
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
          <span className="explorer-pkg-name">{pkg.name}</span>
          {/* 本地位置：小灰字。Local Mirror = 绑定了磁盘上的工程文件夹 */}
          <span className="explorer-pkg-path" title={locationTitle}>
            {locationLabel}
          </span>
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
            {SOURCE_KIND_ORDER.map((kind) => {
              const items = grouped.byKind.get(kind) ?? []
              if (items.length === 0) return null
              return (
                <li key={`kind-${kind}`} className="explorer-kind">
                  <div className="explorer-kind-row">src/{kind}</div>
                  <ul className="explorer-files nested">
                    {items.map(renderScriptRow)}
                  </ul>
                </li>
              )
            })}
            {grouped.root.map(renderScriptRow)}
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
                    onGeneratePlaceholderVoice(id)
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
            onDropIntoFolder={onDropIntoFolder}
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
  onDropIntoFolder,
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
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void
}) {
  const isRoot = dir.path === 'assets'
  const collapsed = isRoot ? rootCollapsed : isDirCollapsed(dir.path)
  // 目录行就是"拖到哪个文件夹"的判定框：外部文件导入、内部载荷移动
  const dirDrop = useFolderDropTarget({
    onFiles: (files) => onImportAssets(pkgId, files, dir.path),
    onPayload: (source) => onDropIntoFolder(pkgId, dir.path, source),
  })

  return (
    <div
      className={`explorer-assets${dirDrop.active ? ' is-drop-target' : ''}`}
      style={{ paddingLeft: depth === 0 ? undefined : 8 }}
      {...dirDrop.handlers}
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
                  onDropIntoFolder={onDropIntoFolder}
                />
              </li>
            ) : (
              <AssetRow
                key={node.asset.id}
                packageId={pkgId}
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
  packageId,
  asset,
  active,
  onOpen,
  onDelete,
}: {
  packageId: string
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
        draggable
        onDragStart={(e) => {
          writeDragPayload(e.dataTransfer, {
            kind: 'asset',
            packageId,
            assetId: asset.id,
            path: asset.path,
          })
        }}
        onDragEnd={() => endDrag()}
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
