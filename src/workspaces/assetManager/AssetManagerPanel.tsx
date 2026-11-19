import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  assetFileName,
  buildAssetTree,
  formatBytes,
  isImageAsset,
  type AssetTreeDir,
} from "../../assets/paths";
import { getAssetBlob } from "../../assets/idb";
import { endDrag, writeDragPayload, type DragSource } from "../../drag/dragPayload";
import { useFolderDropTarget } from "../../drag/useFolderDropTarget";
import { ExplorerIcon, fileIconKind } from "../../explorerIcons";
import type { ExplorerContextItem } from "../stageplay/explorerMenus";
import { ExplorerContextMenu } from "../stageplay/explorerMenus";
import { dockTitleHint, type ExplorerDockProps } from "../../explorerShell";
import type { AssetFile, Project } from "../../workspace";
import { alertDialog } from '../../ui/dialogs';
import type { AssetActions } from './assetActions';
import { getProjectSession } from '../../project/projectSession';
import "./assetManager.css";

const TransferContext = createContext<{ menu: (path: string, directory?: boolean) => ExplorerContextItem[]; select: (path: string) => void } | null>(null);


type BrowserView = "list" | "icons";
const VIEW_STORAGE_KEY = "hanshu.assetManager.view.v1";

function loadBrowserView(): BrowserView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "icons" ? "icons" : "list";
  } catch {
    return "list";
  }
}

function saveBrowserView(view: BrowserView) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    /* 无痕模式只留内存 */
  }
}

/**
 * `assets/` 真实目录管理面板：左栏文件夹树，右栏当前目录浏览器。
 *
 * 通用资源管理器底座只认「分类 → 共享虚拟文件夹 → 源文件」；`assets/` 是磁盘上的真实目录树，
 * 新建 / 删除文件夹会改工程路径，不能按共享虚拟文件夹处理，也不进入底座核心。
 * 与分类资源树分离；物理目录操作仍由工作区经 ProjectClient 事务执行。
 */
export function AssetManagerPanel({
  project,
  onTransfer,
  activeAssetId,
  onOpenAsset,
  onDeleteAsset,
  onNewAssetFolder,
  onDeleteAssetFolder,
  onImportAssets,
  onDropIntoFolder,
  dock,
}: {
  onTransfer: AssetActions["transfer"];
  project: Project;
  activeAssetId?: string | null;
  /** 点开资产：剧本 / 游戏性 / 视听都接到主编辑区的 AssetPreview。 */
  onOpenAsset?: (assetId: string) => void;
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
  dock: ExplorerDockProps;
}) {
  const [clipboard, setClipboard] = useState<{ path: string; cut: boolean; projectId: string } | null>(null);
  const selected = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await task(); } catch (error) { await alertDialog(String(error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const paste = (dir: string) => run(async () => {
    const item = clipboard;
    if (!item || item.projectId !== project.id) return;
    await onTransfer(project.id, item.path, dir, item.cut);
    if (item.cut) setClipboard(current => current === item ? null : current);
  });
  const transferMenu = (path: string, directory = false): ExplorerContextItem[] => [
    ...(path !== 'assets' ? [
      { id: 'copy', label: '复制', hint: 'Ctrl+C', onSelect: () => { setClipboard({ path, cut: false, projectId: project.id }); } },
      { id: 'cut', label: '剪切', hint: 'Ctrl+X', onSelect: () => { setClipboard({ path, cut: true, projectId: project.id }); } },
    ] : []),
    ...(directory ? [{ id: 'paste', label: '粘贴到这里', hint: 'Ctrl+V', disabled: busy || clipboard?.projectId !== project.id, onSelect: () => { void paste(path); } }] : []),
  ];
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ExplorerContextItem[] } | null>(null);
  const showContext = (event: ReactMouseEvent, items: ExplorerContextItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget as HTMLElement;
    const path = element.closest<HTMLElement>('[data-asset-path]')?.dataset.assetPath ?? selectedDir.path;
    selected.current = path;
    setContextMenu({ x: event.clientX, y: event.clientY, items: [...transferMenu(path, element.closest<HTMLElement>('[data-asset-path]')?.dataset.assetDirectory === 'true' || !element.closest('[data-asset-path]')), ...items] });
  };
  const importInputRef = useRef<HTMLInputElement>(null);
  const importDirRef = useRef("assets");
  const [selectedPath, setSelectedPath] = useState("assets");
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [browserView, setBrowserView] = useState<BrowserView>(loadBrowserView);
  const tree = useMemo(
    () => buildAssetTree(project.assets, project.assetFolders ?? []),
    [project.assets, project.assetFolders],
  );
  const selectedDir = useMemo(
    () => findDir(tree, selectedPath) ?? tree,
    [tree, selectedPath],
  );

  useEffect(() => {
    if (!findDir(tree, selectedPath)) setSelectedPath("assets");
  }, [tree, selectedPath]);

  useEffect(() => { setClipboard(null); selected.current = null; }, [project.id]);

  const requestImport = (dir: string) => {
    importDirRef.current = dir;
    if (!importInputRef.current) return;
    importInputRef.current.value = "";
    importInputRef.current.click();
  };

  const toggleDir = (path: string) => {
    setCollapsedDirs((previous) => ({ ...previous, [path]: !previous[path] }));
  };

  const setView = (view: BrowserView) => {
    setBrowserView(view);
    saveBrowserView(view);
  };

  const crumbs = selectedDir.path.split("/");

  return (
    <TransferContext.Provider value={{ menu: transferMenu, select: path => { selected.current = path; } }}>
    <section className="asset-manager" tabIndex={0} aria-busy={busy}
      onDropCapture={event => {
        if (!event.ctrlKey) return;
        const raw = event.dataTransfer.getData('application/x-hanshu-drag');
        if (!raw) return;
        try {
          const source = JSON.parse(raw) as DragSource;
          if (source.kind !== 'asset' || source.packageId !== project.id) return;
          const folder = (event.target as Element).closest<HTMLElement>('[data-asset-directory=true]')?.dataset.assetPath ?? selectedDir.path;
          event.preventDefault(); event.stopPropagation(); endDrag();
          void run(() => onTransfer(project.id, source.path, folder, false));
        } catch { /* unrelated external drag */ }
      }}
      onCopy={event => {
        const path = selected.current;
        if (!path || path === 'assets' || (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true]'))) return;
        event.preventDefault(); setClipboard({ path, cut: false, projectId: project.id });
        event.clipboardData.setData('application/x-hanshu-asset', JSON.stringify({path, projectId: project.id}));
      }}
      onCut={event => {
        const path = selected.current;
        if (!path || path === 'assets' || (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true]'))) return;
        event.preventDefault(); setClipboard({ path, cut: true, projectId: project.id });
        event.clipboardData.setData('application/x-hanshu-asset', JSON.stringify({path, projectId: project.id}));
      }}
      onPaste={event => {
        if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true]')) return;
        const files = Array.from(event.clipboardData.files);
        if (files.length) { event.preventDefault(); onImportAssets(project.id, files, selectedDir.path); }
        else if ((event.clipboardData.types.includes('application/x-hanshu-asset') || !event.clipboardData.types.length) && clipboard?.projectId === project.id) { event.preventDefault(); void paste(selectedDir.path); }
      }}>

      <header className={`asset-manager-heading${dock.onTitlePointerDown ? " is-draggable" : ""}`}>
        <div className="asset-manager-heading-sources">
          <strong
            title={dockTitleHint(dock)}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              if (event.target instanceof Element && event.target.closest("button, input")) return;
              dock.onTitlePointerDown?.(event);
            }}
          >
            资产管理器
          </strong>
          {dock.onRedock && (
            <button type="button" title="停靠回上次位置" onClick={dock.onRedock}>
              停靠
            </button>
          )}
        </div>
        <div className="asset-manager-heading-browser">
          <nav className="asset-manager-crumbs" aria-label="当前路径">
            {crumbs.map((part, index) => {
              const path = crumbs.slice(0, index + 1).join("/");
              const current = path === selectedDir.path;
              return (
                <span key={path} className="asset-manager-crumb">
                  {index > 0 && <span className="asset-manager-crumb-sep" aria-hidden="true">/</span>}
                  <button
                    type="button"
                    className={current ? "is-current" : undefined}
                    disabled={current}
                    onClick={() => setSelectedPath(path)}
                  >
                    {part}
                  </button>
                </span>
              );
            })}
          </nav>
          <button type="button" disabled={busy || clipboard?.projectId !== project.id} onClick={() => { void paste(selectedDir.path); }}>粘贴</button>
          <div className="asset-manager-view-toggle" role="group" aria-label="浏览视图">
            <button
              type="button"
              title="列表视图"
              aria-pressed={browserView === "list"}
              className={browserView === "list" ? "is-active" : undefined}
              onClick={() => setView("list")}
            >
              列表
            </button>
            <button
              type="button"
              title="图标视图"
              aria-pressed={browserView === "icons"}
              className={browserView === "icons" ? "is-active" : undefined}
              onClick={() => setView("icons")}
            >
              图标
            </button>
          </div>
        </div>
      </header>

      <div className="asset-manager-body">
        <aside className="asset-manager-sources" aria-label="资产文件夹">
          <FolderTree
            pkgId={project.id}
            dir={tree}
            depth={0}
            selectedPath={selectedDir.path}
            isDirCollapsed={(path) => Boolean(collapsedDirs[path])}
            onSelect={(path) => { selected.current = path; setSelectedPath(path); }}
            onToggleDir={toggleDir}
            onNewAssetFolder={onNewAssetFolder}
            onDeleteAssetFolder={onDeleteAssetFolder}
            onImportAssets={onImportAssets}
            onDropIntoFolder={onDropIntoFolder}
            onRequestImport={requestImport}
            showContext={showContext}
          />
        </aside>

        <div className="asset-manager-browser" aria-label="资产浏览器">
          <AssetBrowser
            pkgId={project.id}
            dir={selectedDir}
            view={browserView}
            activeAssetId={activeAssetId ?? null}
            onSelectFolder={(path) => { selected.current = path; setSelectedPath(path); }}
            onOpenAsset={onOpenAsset}
            onDeleteAsset={onDeleteAsset}
            onDeleteAssetFolder={onDeleteAssetFolder}
            onImportAssets={onImportAssets}
            onDropIntoFolder={onDropIntoFolder}
            onRequestImport={requestImport}
            onNewAssetFolder={onNewAssetFolder}
            showContext={showContext}
          />
        </div>
      </div>

      <input
        ref={importInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = event.currentTarget.files;
          if (files?.length) onImportAssets(project.id, files, importDirRef.current);
          event.currentTarget.value = "";
        }}
      />
      {contextMenu && (
        <ExplorerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </section>
    </TransferContext.Provider>
  );
}

function findDir(root: AssetTreeDir, path: string): AssetTreeDir | null {
  if (root.path === path) return root;
  for (const child of root.children) {
    if (child.kind === "dir") {
      const hit = findDir(child, path);
      if (hit) return hit;
    }
  }
  return null;
}

function FolderTree({
  pkgId,
  dir,
  depth,
  selectedPath,
  isDirCollapsed,
  onSelect,
  onToggleDir,
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
  selectedPath: string;
  isDirCollapsed: (path: string) => boolean;
  onSelect: (path: string) => void;
  onToggleDir: (path: string) => void;
  onNewAssetFolder: (packageId: string, parentPath: string) => void;
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void;
  onImportAssets: (packageId: string, files: FileList | File[], targetDir?: string) => void;
  onDropIntoFolder: (targetPackageId: string, targetDir: string, source: DragSource) => void;
  onRequestImport: (dir: string) => void;
  showContext: (event: ReactMouseEvent, items: ExplorerContextItem[]) => void;
}) {
  const isRoot = dir.path === "assets";
  const childDirs = dir.children.filter((node): node is AssetTreeDir => node.kind === "dir");
  const collapsed = !isRoot && isDirCollapsed(dir.path);
  const selected = dir.path === selectedPath;
  const dirDrop = useFolderDropTarget({
    onFiles: (files) => onImportAssets(pkgId, files, dir.path),
    onPayload: (source) => onDropIntoFolder(pkgId, dir.path, source),
  });

  const openFolderMenu = (event: ReactMouseEvent) => {
    showContext(event, [
      {
        id: "open",
        label: "在浏览器中打开",
        onSelect: () => onSelect(dir.path),
      },
      ...(!isRoot && childDirs.length > 0
        ? [
            {
              id: "toggle",
              label: collapsed ? "展开" : "折叠",
              onSelect: () => onToggleDir(dir.path),
            },
          ]
        : []),
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
      data-asset-path={dir.path}
      data-asset-directory="true"
      className={`asset-manager-folder${dirDrop.active ? " is-drop-target" : ""}`}
      style={{ paddingLeft: depth === 0 ? undefined : 10 }}
      {...dirDrop.handlers}
    >
      <div
        className={`explorer-row asset-manager-folder-row${selected ? " is-selected" : ""}`}
        onContextMenu={openFolderMenu}
      >
        {childDirs.length > 0 && !isRoot ? (
          <button
            type="button"
            className="explorer-twist"
            onClick={() => onToggleDir(dir.path)}
            aria-label={collapsed ? "展开" : "折叠"}
          >
            {collapsed ? "▸" : "▾"}
          </button>
        ) : (
          <span className="explorer-twist is-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className="explorer-label"
          onClick={() => onSelect(dir.path)}
          title={dir.path}
        >
          <ExplorerIcon kind="folder" />
          <span className="explorer-name">{dir.name}</span>
        </button>
      </div>
      {!collapsed &&
        childDirs.map((child) => (
          <FolderTree
            key={child.path}
            pkgId={pkgId}
            dir={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            isDirCollapsed={isDirCollapsed}
            onSelect={onSelect}
            onToggleDir={onToggleDir}
            onNewAssetFolder={onNewAssetFolder}
            onDeleteAssetFolder={onDeleteAssetFolder}
            onImportAssets={onImportAssets}
            onDropIntoFolder={onDropIntoFolder}
            onRequestImport={onRequestImport}
            showContext={showContext}
          />
        ))}
    </div>
  );
}

function folderMenuItems(
  pkgId: string,
  folder: AssetTreeDir,
  onSelectFolder: (path: string) => void,
  onNewAssetFolder: (packageId: string, parentPath: string) => void,
  onRequestImport: (dir: string) => void,
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void,
): ExplorerContextItem[] {
  return [
    {
      id: "open",
      label: "打开文件夹",
      onSelect: () => onSelectFolder(folder.path),
    },
    {
      id: "new-folder",
      label: "新建子文件夹",
      separatorBefore: true,
      onSelect: () => onNewAssetFolder(pkgId, folder.path),
    },
    {
      id: "import",
      label: "导入到这里",
      onSelect: () => onRequestImport(folder.path),
    },
    {
      id: "delete",
      label: "删除",
      danger: true,
      separatorBefore: true,
      onSelect: () => onDeleteAssetFolder(pkgId, folder.path),
    },
  ];
}

function AssetBrowser({
  pkgId,
  dir,
  view,
  activeAssetId,
  onSelectFolder,
  onOpenAsset,
  onDeleteAsset,
  onDeleteAssetFolder,
  onImportAssets,
  onDropIntoFolder,
  onRequestImport,
  onNewAssetFolder,
  showContext,
}: {
  pkgId: string;
  dir: AssetTreeDir;
  view: BrowserView;
  activeAssetId: string | null;
  onSelectFolder: (path: string) => void;
  onOpenAsset?: (assetId: string) => void;
  onDeleteAsset: (assetId: string) => void;
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void;
  onImportAssets: (packageId: string, files: FileList | File[], targetDir?: string) => void;
  onDropIntoFolder: (targetPackageId: string, targetDir: string, source: DragSource) => void;
  onRequestImport: (dir: string) => void;
  onNewAssetFolder: (packageId: string, parentPath: string) => void;
  showContext: (event: ReactMouseEvent, items: ExplorerContextItem[]) => void;
}) {
  const childDirs = dir.children.filter((node): node is AssetTreeDir => node.kind === "dir");
  const files = dir.children.filter((node) => node.kind === "file");
  const dirDrop = useFolderDropTarget({
    onFiles: (dropped) => onImportAssets(pkgId, dropped, dir.path),
    onPayload: (source) => onDropIntoFolder(pkgId, dir.path, source),
  });
  const icons = view === "icons";

  const openBlankMenu = (event: ReactMouseEvent) => {
    showContext(event, [
      {
        id: "new-folder",
        label: "新建子文件夹",
        onSelect: () => onNewAssetFolder(pkgId, dir.path),
      },
      {
        id: "import",
        label: "导入到这里",
        onSelect: () => onRequestImport(dir.path),
      },
    ]);
  };

  return (
    <div
      className={`asset-manager-view${dirDrop.active ? " is-drop-target" : ""}`}
      {...dirDrop.handlers}
      onContextMenu={openBlankMenu}
    >
      {childDirs.length === 0 && files.length === 0 ? (
        <p className="explorer-empty">空文件夹，右键可新建或导入</p>
      ) : (
        <ul className={`asset-manager-entries${icons ? " is-icons" : " is-list"}`}>
          {childDirs.map((child) => (
            <li key={`dir:${child.path}`}>
              <div
                data-asset-path={child.path}
                data-asset-directory="true"
                className={`asset-manager-entry is-folder${icons ? " is-tile" : " explorer-row explorer-file-row"}`}
                onContextMenu={(event) => {
                  showContext(
                    event,
                    folderMenuItems(
                      pkgId,
                      child,
                      onSelectFolder,
                      onNewAssetFolder,
                      onRequestImport,
                      onDeleteAssetFolder,
                    ),
                  );
                }}
              >
                <button
                  type="button"
                  className={icons ? "asset-manager-tile" : "explorer-label"}
                  onDoubleClick={() => onSelectFolder(child.path)}
                  onClick={() => onSelectFolder(child.path)}
                  title={child.path}
                >
                  <span className="asset-manager-tile-preview" aria-hidden="true">
                    <ExplorerIcon kind="folder" />
                  </span>
                  <span className="explorer-name">{child.name}</span>
                </button>
                {!icons && <span className="asset-manager-entry-meta">文件夹</span>}
              </div>
            </li>
          ))}
          {files.map((node) => {
            if (node.kind !== "file") return null;
            return (
              <AssetRow
                key={node.asset.id}
                packageId={pkgId}
                asset={node.asset as AssetFile}
                view={view}
                active={node.asset.id === activeAssetId}
                onOpen={onOpenAsset ? () => onOpenAsset(node.asset.id) : undefined}
                onDelete={() => onDeleteAsset(node.asset.id)}
                showContext={showContext}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AssetThumb({
  packageId,
  asset,
}: {
  packageId: string;
  asset: AssetFile;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const image = isImageAsset(asset.path, asset.mime);

  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void getAssetBlob(packageId, asset.path).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image, packageId, asset.path, asset.updatedAt]);

  if (url) {
    return <img className="asset-manager-thumb" src={url} alt="" draggable={false} />;
  }
  return <ExplorerIcon kind={fileIconKind(asset.path)} />;
}

function AssetRow({
  packageId,
  asset,
  view,
  active,
  onOpen,
  onDelete,
  showContext,
}: {
  packageId: string;
  asset: AssetFile;
  view: BrowserView;
  active: boolean;
  onOpen?: () => void;
  onDelete: () => void;
  showContext: (event: ReactMouseEvent, items: ExplorerContextItem[]) => void;
}) {
  const transfer = useContext(TransferContext);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let url: string | undefined;
    const client = getProjectSession().binding?.handle.client;
    void (async () => {
      const blob = await getAssetBlob(packageId, asset.path) ?? (client?.entry(asset.path) ? await client.read(asset.path) : null);
      if (disposed || !blob) return;
      url = URL.createObjectURL(blob); setDownloadUrl(url);
    })().catch(() => {});
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [packageId, asset.path, asset.updatedAt]);
  const icons = view === "icons";
  const name = assetFileName(asset.path);
  const openMenu = (event: ReactMouseEvent) => {
    showContext(event, [
      { id: 'download', label: '下载', disabled: !downloadUrl, onSelect: () => {
        if (!downloadUrl) return;
        const link = document.createElement('a'); link.href = downloadUrl; link.download = name; link.click();
      } },
      ...(onOpen
        ? [
            {
              id: "open",
              label: "打开",
              hint: "在编辑器中显示",
              onSelect: onOpen,
            },
          ]
        : []),
      {
        id: "delete",
        label: "删除",
        danger: true,
        separatorBefore: true,
        onSelect: onDelete,
      },
    ]);
  };

  return (
    <li>
      <div
        data-asset-path={asset.path}
        onClick={() => { transfer?.select(asset.path); }}
        className={`asset-manager-entry${icons ? " is-tile" : " explorer-row explorer-file-row explorer-asset-row"}${
          active ? " active" : ""
        }`}
        draggable
        onContextMenu={openMenu}
        onDragStart={(e) => {
          transfer?.select(asset.path);
          writeDragPayload(e.dataTransfer, {
            kind: "asset",
            packageId,
            assetId: asset.id,
            path: asset.path,
          });
          if (downloadUrl) e.dataTransfer.setData('DownloadURL', `${asset.mime || 'application/octet-stream'}:${name}:${downloadUrl}`);
        }}
        onDragEnd={() => endDrag()}
      >
        {onOpen ? (
          <button
            type="button"
            className={icons ? "asset-manager-tile" : "explorer-label"}
            onClick={onOpen}
            onDoubleClick={onOpen}
            title={asset.path}
          >
            <span className="asset-manager-tile-preview" aria-hidden="true">
              <AssetThumb packageId={packageId} asset={asset} />
            </span>
            <span className="explorer-name">{name}</span>
          </button>
        ) : (
          <span className={icons ? "asset-manager-tile" : "explorer-label"} title={asset.path}>
            <span className="asset-manager-tile-preview" aria-hidden="true">
              <AssetThumb packageId={packageId} asset={asset} />
            </span>
            <span className="explorer-name">{name}</span>
          </span>
        )}
        {!icons && <span className="asset-manager-entry-meta">{formatBytes(asset.size)}</span>}
        {!icons && (
          <div className="explorer-row-actions">
            <button type="button" title="删除资产" onClick={onDelete}>
              ×
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
