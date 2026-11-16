import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  assetFileName,
  buildAssetTree,
  type AssetTreeDir,
  type AssetTreeNode,
} from "../../assets/paths";
import { endDrag, writeDragPayload, type DragSource } from "../../drag/dragPayload";
import { useFolderDropTarget } from "../../drag/useFolderDropTarget";
import { ExplorerIcon, fileIconKind } from "../../explorerIcons";
import type { ExplorerContextItem } from "./explorerMenus";
import { ExplorerContextMenu } from "./explorerMenus";
import type { AssetFile, Project } from "../../workspace";

/**
 * `assets/` 真实目录管理面板。
 *
 * 通用资源管理器底座只认「分类 → 共享虚拟文件夹 → 源文件」；`assets/` 是磁盘上的真实目录树，
 * 新建 / 删除文件夹会改工程路径，不能按共享虚拟文件夹处理，也不进入底座核心。
 * 与分类资源树分离；物理目录操作仍由工作区经 ProjectClient 事务执行。
 */
export function AssetManagerPanel({
  project,
  activeAssetId,
  onToggleRoot,
  onOpenAsset,
  onDeleteAsset,
  onNewAssetFolder,
  onDeleteAssetFolder,
  onImportAssets,
  onDropIntoFolder,
  dock,
}: {
  project: Project;
  activeAssetId: string | null;
  onToggleRoot: () => void;
  onOpenAsset: (assetId: string) => void;
  onDeleteAsset: (assetId: string) => void;
  onNewAssetFolder: (projectId: string, parentPath: string) => void;
  onDeleteAssetFolder: (projectId: string, folderPath: string) => void;
  onImportAssets: (
    projectId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void;
  onDropIntoFolder: (
    targetProjectId: string,
    targetDir: string,
    source: DragSource,
  ) => void;
  dock: import('../../explorerShell').ExplorerDockProps;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ExplorerContextItem[] } | null>(null);
  const showContext = (event: ReactMouseEvent, items: ExplorerContextItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };
  const importInputRef = useRef<HTMLInputElement>(null);
  const importDirRef = useRef('assets');
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>(
    {},
  );
  const tree = useMemo(
    () => buildAssetTree(project.assets, project.assetFolders ?? []),
    [project.assets, project.assetFolders],
  );
  const requestImport = (dir: string) => {
    importDirRef.current = dir;
    if (!importInputRef.current) return;
    importInputRef.current.value = '';
    importInputRef.current.click();
  };
  return (
    <section className="stageplay-asset-manager stageplay-explorer-assets">
      <header className="stageplay-asset-manager-heading">
        <strong
          title="资产管理器"
          onPointerDown={(event) => {
            if (event.target instanceof Element && event.target.closest('button, input')) return;
            dock.onTitlePointerDown?.(event);
          }}
        >资产管理器</strong>
        <button type="button" title="导入到 assets/" onClick={() => requestImport('assets')}>导入</button>
        {dock.onRedock && <button type="button" title="停靠回上次位置" onClick={dock.onRedock}>停靠</button>}
      </header>
      <AssetFolderBlock
      pkgId={project.id}
      dir={tree}
      depth={0}
      rootCollapsed={project.assetsCollapsed}
      activeAssetId={activeAssetId}
      isDirCollapsed={(path) => Boolean(collapsedDirs[path])}
      onToggleRoot={onToggleRoot}
      onToggleDir={(path) =>
        setCollapsedDirs((previous) => ({ ...previous, [path]: !previous[path] }))
      }
      onOpenAsset={onOpenAsset}
      onDeleteAsset={onDeleteAsset}
      onNewAssetFolder={onNewAssetFolder}
      onDeleteAssetFolder={onDeleteAssetFolder}
      onImportAssets={onImportAssets}
      onDropIntoFolder={onDropIntoFolder}
      onRequestImport={requestImport}
      showContext={showContext}
      />
      <input ref={importInputRef} type="file" multiple hidden onChange={(event) => {
        const files = event.currentTarget.files;
        if (files?.length) onImportAssets(project.id, files, importDirRef.current);
        event.currentTarget.value = '';
      }} />
      {contextMenu && <ExplorerContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
    </section>
  );
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
  onRequestImport,
  showContext,
}: {
  pkgId: string;
  dir: AssetTreeDir;
  depth: number;
  rootCollapsed: boolean;
  activeAssetId: string | null;
  isDirCollapsed: (path: string) => boolean;
  onToggleRoot: () => void;
  onToggleDir: (path: string) => void;
  onOpenAsset: (assetId: string) => void;
  onDeleteAsset: (assetId: string) => void;
  onNewAssetFolder: (packageId: string, parentPath: string) => void;
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void;
  onImportAssets: (
    packageId: string,
    files: FileList | File[],
    targetDir?: string,
  ) => void;
  onDropIntoFolder: (
    targetPackageId: string,
    targetDir: string,
    source: DragSource,
  ) => void;
  onRequestImport: (dir: string) => void;
  showContext: (event: ReactMouseEvent, items: ExplorerContextItem[]) => void;
}) {
  const isRoot = dir.path === "assets";
  const collapsed = isRoot ? rootCollapsed : isDirCollapsed(dir.path);
  // 目录行就是"拖到哪个文件夹"的判定框：外部文件导入、内部载荷移动
  const dirDrop = useFolderDropTarget({
    onFiles: (files) => onImportAssets(pkgId, files, dir.path),
    onPayload: (source) => onDropIntoFolder(pkgId, dir.path, source),
  });

  const openFolderMenu = (event: ReactMouseEvent) => {
    showContext(event, [
      {
        id: "toggle",
        label: collapsed ? "展开" : "折叠",
        onSelect: () => (isRoot ? onToggleRoot() : onToggleDir(dir.path)),
      },
      {
        id: "new-folder",
        label: "新建子文件夹",
        separatorBefore: true,
        onSelect: () => onNewAssetFolder(pkgId, dir.path),
      },
      {
        id: "import",
        label: "导入到这里",
        hint: "选择文件导入到此文件夹",
        onSelect: () => onRequestImport(dir.path),
      },
      ...(isRoot
        ? []
        : [
            {
              id: "delete",
              label: "删除",
              danger: true,
              separatorBefore: true,
              onSelect: () => onDeleteAssetFolder(pkgId, dir.path),
            },
          ]),
    ]);
  };

  return (
    <div
      className={`explorer-assets${dirDrop.active ? " is-drop-target" : ""}`}
      style={{ paddingLeft: depth === 0 ? undefined : 8 }}
      {...dirDrop.handlers}
      onContextMenu={openFolderMenu}
    >
      <div
        className={`explorer-row explorer-assets-row${
          isRoot ? "" : " explorer-subdir-row"
        }`}
      >
        <button
          type="button"
          className="explorer-twist"
          onClick={() => (isRoot ? onToggleRoot() : onToggleDir(dir.path))}
          aria-label={collapsed ? "展开" : "折叠"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button
          type="button"
          className="explorer-label"
          onClick={() => (isRoot ? onToggleRoot() : onToggleDir(dir.path))}
          title={`${dir.path} — 右键可展开、新建、导入${isRoot ? "" : "或删除"}`}
        >
          <ExplorerIcon kind="folder" />
          <span className="explorer-name">{dir.name}</span>
          {isRoot && <span className="explorer-count">{countFiles(dir)}</span>}
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
                  onImportAssets(pkgId, e.target.files, dir.path);
                  e.target.value = "";
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
            node.kind === "dir" ? (
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
                  onRequestImport={onRequestImport}
                  showContext={showContext}
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
                showContext={showContext}
              />
            ),
          )}
          {dir.children.length === 0 && (
            <li className="explorer-empty nested" title="空文件夹，右键可新建">
              空文件夹，右键可新建
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function countFiles(node: AssetTreeNode): number {
  if (node.kind === "file") return 1;
  return node.children.reduce((n, c) => n + countFiles(c), 0);
}

function AssetRow({
  packageId,
  asset,
  active,
  onOpen,
  onDelete,
  showContext,
}: {
  packageId: string;
  asset: AssetFile;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
  showContext: (event: ReactMouseEvent, items: ExplorerContextItem[]) => void;
}) {
  return (
    <li>
      <div
        className={`explorer-row explorer-file-row explorer-asset-row${
          active ? " active" : ""
        }`}
        draggable
        onContextMenu={(event) => {
          showContext(event, [
            {
              id: "open",
              label: "打开",
              hint: "在编辑器中显示",
              onSelect: onOpen,
            },
            {
              id: "delete",
              label: "删除",
              danger: true,
              separatorBefore: true,
              onSelect: onDelete,
            },
          ]);
        }}
        onDragStart={(e) => {
          writeDragPayload(e.dataTransfer, {
            kind: "asset",
            packageId,
            assetId: asset.id,
            path: asset.path,
          });
        }}
        onDragEnd={() => endDrag()}
      >
        <button
          type="button"
          className="explorer-label"
          onClick={onOpen}
          title={`${asset.path}\n右键：打开或删除`}
        >
          <ExplorerIcon kind={fileIconKind(asset.path)} />
          <span className="explorer-name">{assetFileName(asset.path)}</span>
        </button>
        <div className="explorer-row-actions">
          <button type="button" title="删除资产" onClick={onDelete}>
            ×
          </button>
        </div>
      </div>
    </li>
  );
}
