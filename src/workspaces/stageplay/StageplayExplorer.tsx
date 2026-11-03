import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CategoryExplorer, type CreateAnchor, type ExplorerDockProps } from "../../explorerShell";
import { ExplorerTreeRow } from "../../explorerShell/ExplorerTreeRow";
import { endDrag, writeDragPayload, type DragSource } from "../../drag/dragPayload";
import { assetFileName } from "../../assets/paths";
import { ExplorerIcon, sourceIconKind } from "../../explorerIcons";
import type { NewFileType, NewFileTypeId } from "../../newFileTypes";
import type { NodeMenuItem } from "../../nodeEditor/ContextMenu";
import type { ExplorerOrganization } from "../../project/explorerOrganization";
import { openProjectUi } from "../../project/projectUi";
import { chooseDialog } from "../../ui/dialogs";
import { isVoiceMapFile, sourcePathOf, type Project } from "../../workspace";
import { StageplayAssetsAddon } from "./StageplayAssetsAddon";
import {
  STAGEPLAY_EXPLORER_CATEGORIES,
  stageplayLooseSources,
  stageplayShellFiles,
  stageplayTypesForCategory,
} from "./explorerCategories";
import {
  ExplorerContextMenu,
  NewFileTypeMenu,
  type ExplorerContextItem,
  type MenuAnchorBox,
} from "./explorerMenus";

type TypeMenu = {
  x: number;
  y: number;
  place: "below" | "beside";
  anchorBox: MenuAnchorBox | null;
  /** 打开菜单的按钮：同一触发器再点一次即收起 */
  trigger: HTMLElement | null;
  /** 分类入口只列该分类的类型；省略即全部剧本类型 */
  types?: readonly NewFileType[];
  folderKey: string | null;
};

/**
 * 剧本资源管理器：通用分类壳 + `+剧` 类型菜单 + `assets/` 真实目录附加件。
 *
 * 与游戏性 / 视听一样，树顶直接是分类，不挂工程名行（工程名在顶栏；重命名走「文件 → 重命名工程」）。
 * 分类下的文件夹是 `meta/explorer.json` 共享虚拟文件夹；磁盘路径不随文件夹变化。
 */
export function StageplayExplorer({
  project,
  organization,
  readOnly,
  activeScriptId,
  activeAssetId,
  newFileMenuRequest = 0,
  renameRequest,
  onOpenScript,
  onOpenAsset,
  onCreate,
  onRename,
  onDelete,
  onOrganize,
  onRenameProject,
  onToggleAssets,
  onDeleteAsset,
  onNewAssetFolder,
  onDeleteAssetFolder,
  onImportAssets,
  onGeneratePlaceholderVoice,
  onDropIntoFolder,
  dock,
}: {
  project: Project | null;
  /** null = 未打开工程，不能整理 */
  organization: ExplorerOrganization | null;
  readOnly: boolean;
  activeScriptId: string | null;
  activeAssetId: string | null;
  /** 应用菜单「新建剧本」：值变化即在 `+剧` 旁打开类型菜单（0 = 从未请求） */
  newFileMenuRequest?: number;
  renameRequest: { id: string; seq: number } | null;
  onOpenScript: (scriptId: string) => void;
  onOpenAsset: (assetId: string) => void;
  /** 选类型即创建；folderKey 非空时创建后登记到该共享文件夹。失败原因由工作区提示。 */
  onCreate: (typeId: NewFileTypeId, folderKey: string | null) => void;
  onRename: (scriptId: string, base: string) => string | null;
  onDelete: (scriptIds: string[]) => void;
  onOrganize: (next: ExplorerOrganization, label: string) => void;
  onRenameProject: (projectId: string) => void;
  onToggleAssets: (projectId: string) => void;
  onDeleteAsset: (assetId: string) => void;
  onNewAssetFolder: (packageId: string, parentPath: string) => void;
  onDeleteAssetFolder: (packageId: string, folderPath: string) => void;
  onImportAssets: (packageId: string, files: FileList | File[], targetDir?: string) => void;
  onGeneratePlaceholderVoice: (scriptId: string) => void;
  onDropIntoFolder: (targetPackageId: string, targetDir: string, source: DragSource) => void;
  dock: ExplorerDockProps;
}) {
  const [typeMenu, setTypeMenu] = useState<TypeMenu | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ExplorerContextItem[] } | null>(null);
  const headerButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importDirRef = useRef("assets");
  const handledRequestRef = useRef(newFileMenuRequest);
  const promptingProjectRef = useRef(false);

  const scripts = useMemo(() => project?.scripts ?? [], [project]);
  const files = useMemo(() => stageplayShellFiles(scripts), [scripts]);
  const looseFiles = useMemo(() => stageplayLooseSources(scripts), [scripts]);

  /** 没有工程时不能新建文件：提示去创建或导入，而不是把点击吃掉。 */
  const promptCreateOrImport = () => {
    if (promptingProjectRef.current) return;
    promptingProjectRef.current = true;
    void chooseDialog({
      title: "提示",
      message: "工程为空，请先创建或导入工程。",
      cancelLabel: "取消",
      options: [
        { id: "create", label: "创建工程" },
        { id: "import", label: "导入工程" },
      ],
    })
      .then((choice) => {
        if (choice === "create") openProjectUi("create");
        else if (choice === "import") openProjectUi("open");
      })
      .finally(() => {
        promptingProjectRef.current = false;
      });
  };

  const openTypeMenuBeside = (trigger: HTMLElement | null) => {
    const rect = trigger?.getBoundingClientRect();
    setContextMenu(null);
    setTypeMenu({
      x: rect ? rect.right + 4 : 8,
      y: rect ? rect.top : 8,
      place: "beside",
      anchorBox: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
      trigger,
      folderKey: null,
    });
  };

  const openTypeMenuAt = (anchor: CreateAnchor, types?: readonly NewFileType[], folderKey: string | null = null) => {
    setContextMenu(null);
    setTypeMenu({ x: anchor.x, y: anchor.y, place: "below", anchorBox: null, trigger: null, types, folderKey });
  };

  useEffect(() => {
    // 请求号没变 = 不是新的一次请求；工作区变化也会走到这里，那不该弹菜单
    if (newFileMenuRequest === handledRequestRef.current) return;
    handledRequestRef.current = newFileMenuRequest;
    // 响应外部请求（应用菜单）的一次性状态切换，不是从 props 派生渲染值
    // eslint-disable-next-line react/set-state-in-effect
    if (project && !readOnly) openTypeMenuBeside(headerButtonRef.current);
    else if (!project) promptCreateOrImport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newFileMenuRequest]);

  const pick = (type: NewFileType) => {
    const folderKey = typeMenu?.folderKey ?? null;
    setTypeMenu(null);
    onCreate(type.id, folderKey);
  };

  const showContext = (event: ReactMouseEvent, items: ExplorerContextItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setTypeMenu(null);
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  const requestImport = (dir: string) => {
    importDirRef.current = dir;
    const input = importInputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  };

  const createInCategory = (category: string, folderKey: string | null, anchor: CreateAnchor | null) => {
    const types = stageplayTypesForCategory(category);
    if (types.length === 1) onCreate(types[0]!.id, folderKey);
    else if (types.length > 1) openTypeMenuAt(anchor ?? { x: 8, y: 8 }, types, folderKey);
  };

  const blankMenuItems = (anchor: CreateAnchor): NodeMenuItem[] =>
    project
      ? [
          {
            label: "新建文件…",
            disabled: readOnly,
            hint: "选剧本类型后立即创建，落在对应分类根下",
            action: () => openTypeMenuAt(anchor),
          },
          { label: "导入资源…", disabled: readOnly, hint: "导入到 assets/", action: () => requestImport("assets") },
          {
            label: "重命名工程",
            disabled: readOnly,
            hint: "修改 project.json 里的工程名称；不改目录",
            action: () => onRenameProject(project.id),
          },
        ]
      : [
          { label: "创建工程…", action: () => openProjectUi("create") },
          { label: "打开工程…", action: () => openProjectUi("open") },
        ];

  const emptyProjectHint = !project ? (
    <p className="explorer-shell-empty stageplay-explorer-noproject" title="尚未打开工程，右键可创建或打开工程">
      尚未打开工程，右键可创建或打开工程
    </p>
  ) : null;

  const addons = project ? (
    <>
      {looseFiles.length > 0 && (
        <LooseFiles
          files={looseFiles}
          activeScriptId={activeScriptId}
          readOnly={readOnly}
          onOpen={onOpenScript}
          onDelete={(id) => onDelete([id])}
          onGeneratePlaceholderVoice={onGeneratePlaceholderVoice}
          showContext={showContext}
        />
      )}
      <div className="stageplay-explorer-assets">
        <StageplayAssetsAddon
          project={project}
          activeAssetId={activeAssetId}
          onToggleRoot={() => onToggleAssets(project.id)}
          onOpenAsset={onOpenAsset}
          onDeleteAsset={onDeleteAsset}
          onNewAssetFolder={onNewAssetFolder}
          onDeleteAssetFolder={onDeleteAssetFolder}
          onImportAssets={onImportAssets}
          onDropIntoFolder={onDropIntoFolder}
          onRequestImport={requestImport}
          showContext={showContext}
        />
      </div>
      <input
        ref={importInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const list = event.target.files;
          if (list?.length) onImportAssets(project.id, list, importDirRef.current);
          event.target.value = "";
        }}
      />
    </>
  ) : null;

  return (
    <>
      <CategoryExplorer
        label="剧本资源管理器"
        categories={STAGEPLAY_EXPLORER_CATEGORIES}
        files={files}
        organization={organization}
        activeId={activeScriptId}
        readOnly={readOnly}
        defaultOpen={["hanshu", "character", "meta"]}
        emptyHint={(category) => `暂无资源。右键或点 +剧 ${category.createLabel?.replace(/^新建/, "创建").replace(/…$/, "") ?? "新建"}。`}
        onOpen={onOpenScript}
        onCreate={createInCategory}
        onRename={onRename}
        onDelete={onDelete}
        onOrganize={onOrganize}
        onFileDragStart={(file, event) => {
          if (!project) return;
          writeDragPayload(event.dataTransfer, {
            kind: "script",
            packageId: project.id,
            scriptId: file.id,
            name: file.name,
          });
          event.currentTarget.addEventListener("dragend", () => endDrag(), { once: true });
        }}
        renameRequest={renameRequest}
        addons={addons}
        slots={{
          rootClass: "stageplay-explorer",
          prepend: emptyProjectHint,
          blankMenuItems,
          tools: (
            <button
              ref={headerButtonRef}
              type="button"
              className="stageplay-explorer-new"
              data-newfile-trigger
              title="新建文件…（选类型后立即创建，可再改名）"
              disabled={Boolean(project) && readOnly}
              onClick={(event) => {
                if (!project) {
                  promptCreateOrImport();
                  return;
                }
                // 菜单的"点外部关闭"会跳过触发器，所以开关只能由触发器自己管
                if (typeMenu && typeMenu.trigger === event.currentTarget) setTypeMenu(null);
                else openTypeMenuBeside(event.currentTarget);
              }}
            >
              +剧
            </button>
          ),
        }}
        dock={dock}
      />
      {typeMenu && (
        <NewFileTypeMenu
          x={typeMenu.x}
          y={typeMenu.y}
          place={typeMenu.place}
          anchorBox={typeMenu.anchorBox}
          types={typeMenu.types}
          onClose={() => setTypeMenu(null)}
          onPick={pick}
        />
      )}
      {contextMenu && (
        <ExplorerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

/** 不属于剧本分类、留在工程根的旧文件：只读列出，可打开 / 删除（配音映射可生成空白 ogg）。 */
function LooseFiles({
  files,
  activeScriptId,
  readOnly,
  onOpen,
  onDelete,
  onGeneratePlaceholderVoice,
  showContext,
}: {
  files: Project["scripts"];
  activeScriptId: string | null;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onGeneratePlaceholderVoice: (id: string) => void;
  showContext: (event: ReactMouseEvent, items: ExplorerContextItem[]) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div role="none" className="explorer-shell-category">
      <ExplorerTreeRow
        depth={0}
        expanded={open}
        classes={{ row: "explorer-shell-row is-category", twist: "explorer-shell-twist" }}
        icon={<ExplorerIcon kind="group" />}
        tabIndex={-1}
        title="工程根下不属于剧本分类的旧文件"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="explorer-shell-name">工程根（未归类）</span>
      </ExplorerTreeRow>
      {open &&
        files.map((script) => (
          <ExplorerTreeRow
            key={script.id}
            depth={1}
            classes={{ row: "explorer-shell-row", twist: "explorer-shell-twist" }}
            state={{ open: script.id === activeScriptId, detached: script.detached }}
            icon={<ExplorerIcon kind={sourceIconKind(script)} />}
            tabIndex={-1}
            title={sourcePathOf(script)}
            onClick={() => onOpen(script.id)}
            onContextMenu={(event) =>
              showContext(event, [
                { id: "open", label: "打开", hint: "在编辑器中显示", onSelect: () => onOpen(script.id) },
                ...(isVoiceMapFile(script.name)
                  ? [{ id: "ogg", label: "生成空白 ogg", disabled: readOnly, onSelect: () => onGeneratePlaceholderVoice(script.id) }]
                  : []),
                {
                  id: "delete",
                  label: "删除",
                  danger: true,
                  disabled: readOnly,
                  separatorBefore: true,
                  onSelect: () => onDelete(script.id),
                },
              ])
            }
          >
            <span className="explorer-shell-name">{assetFileName(script.name)}</span>
          </ExplorerTreeRow>
        ))}
    </div>
  );
}
