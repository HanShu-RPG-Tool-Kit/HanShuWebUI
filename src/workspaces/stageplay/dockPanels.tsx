import type { ReactNode } from 'react'
import type { AgentHost } from '../../agent/tools'
import { AgentPanel } from '../../AgentPanel'
import { AssetManagerPanel } from './AssetManagerPanel'
import { emptyOrganization } from '../../project/explorerOrganization'
import type { ExplorerOrganization } from '../../project/explorerOrganization'
import { StageplayExplorer } from './StageplayExplorer'
import type { NewFileTypeId } from '../../newFileTypes'
import { RecordingStudio, type StudioMode, type StudioSourceMode } from '../../studio/RecordingStudio'
import type { VoiceLibrary } from '../../i18n/voiceLibrary'
import type { DockPanelSpec } from '../../ui/PanelDock'
import { DockPanelTitle } from '../../ui/DockPanelTitle'
import { SPEAKER_SLOT_COUNT, numpadHint, numpadLabel } from '../../monaco/speakerInsert'
import type { Project } from '../../workspace'
import type { ScriptViewFlags } from '../scriptView'

/**
 * 剧本工作区的停靠面板声明。**这里不持有任何状态**：面板要用的东西全部由
 * 工作区通过 {@link StageplayDockHost} 传进来。
 *
 * 为什么值得单独一层：面板此前是四千年组件里的闭包，读的是组件内部变量，所以
 * 只能由这个工作区自己 mount 一份 PanelDock（见 help「面板与布局」）。把依赖显式
 * 写成 host，面板才可能在别的宿主（未来的应用级 Layout）里被复用。
 */
export type StageplayDockHost = {
  view: Pick<ScriptViewFlags, 'explorer' | 'assetManager' | 'roles'>
  project: Project | null
  readOnly: boolean
  explorer: {
    activeScriptId: string | null
    newFileMenuRequest: number
    renameRequest: { id: string; seq: number } | null
    onOpenScript: (scriptId: string) => void
    onCreate: (typeId: NewFileTypeId, folderKey: string | null) => void
    onRename: (scriptId: string, base: string) => string | null
    onDelete: (scriptIds: string[]) => void
    /** 已包好错误提示的组织提交；这里只负责把结果交给它。 */
    onOrganize: (next: ExplorerOrganization, label: string) => void
    onGeneratePlaceholderVoice: (scriptId: string) => void
  }
  assets: {
    activeAssetId: string | null
    onToggleRoot: (projectId: string) => void
    onOpen: (assetId: string) => void
    onDelete: (assetId: string) => void
    onNewFolder: (projectId: string, parentPath: string) => void
    onDeleteFolder: (projectId: string, folderPath: string) => void
    onImport: (projectId: string, files: FileList | File[], targetDir?: string) => void
    onDropIntoFolder: (targetProjectId: string, targetDir: string, source: import('../../drag/dragPayload').DragSource) => void
  }
  agent: {
    open: boolean
    host: AgentHost
    packageName: string
    fileName: string
    content: () => string
    /** 编辑器里选中的文本；没有选区时返回空串（`AgentContext.selection`）。 */
    selection: () => string
    onClose: () => void
  }
  roles: {
    values: string[]
    /** 只有汉书正文才挂这一栏 */
    enabled: boolean
    onInsert: (index: number) => void
    onChange: (index: number, value: string) => void
  }
  studio: {
    open: boolean
    mode: StudioMode
    sourceMode: StudioSourceMode
    selectedKeys: string[]
    /** 当前文件有没有可配音文本；没有时录音棚只读 */
    librable: boolean
    library: VoiceLibrary | null
    textFor: (key: string) => string | null
    tts: Parameters<typeof RecordingStudio>[0]['tts']
    onClose: () => void
    onModeChange: (mode: StudioMode) => void
    onSourceModeChange: (mode: StudioSourceMode) => void
    onClearSelection: () => void
    onClearVoice: (keys: string[]) => void
    onImport: Parameters<typeof RecordingStudio>[0]['onImport']
    onReference: Parameters<typeof RecordingStudio>[0]['onReference']
  }
}

/** 录音棚宽度：沿用本机记住的旧键，不并进 PanelDock 的布局记录。 */
function studioDefaultWidth(): number {
  try {
    const saved = Number(localStorage.getItem('hanshu.studioWidth'))
    if (Number.isFinite(saved) && saved >= 280 && saved <= 760) return saved
  } catch {
    /* keep the built-in width */
  }
  return 420
}

export function stageplayDockPanels(host: StageplayDockHost): DockPanelSpec[] {
  const project = host.project
  const organization = project ? (project.explorer ?? emptyOrganization()) : null
  const renderExplorer = (
    dock: Parameters<DockPanelSpec['render']>[0],
  ): ReactNode => (
    <StageplayExplorer
      project={project}
      organization={organization}
      readOnly={host.readOnly}
      activeScriptId={host.explorer.activeScriptId}
      newFileMenuRequest={host.explorer.newFileMenuRequest}
      renameRequest={host.explorer.renameRequest}
      onOpenScript={host.explorer.onOpenScript}
      onCreate={host.explorer.onCreate}
      onRename={host.explorer.onRename}
      onDelete={host.explorer.onDelete}
      onOrganize={host.explorer.onOrganize}
      onGeneratePlaceholderVoice={host.explorer.onGeneratePlaceholderVoice}
      dock={dock}
    />
  )

  return [
    {
      id: 'explorer',
      title: '资源管理器',
      visible: host.view.explorer,
      defaultPlacement: 'left',
      defaultSize: 280,
      render: (dock) => renderExplorer(dock),
    },
    {
      id: 'asset-manager',
      title: '资产管理器',
      visible: host.view.assetManager,
      defaultPlacement: 'left',
      defaultSize: 300,
      minSize: 220,
      render: (dock) =>
        project ? (
          <AssetManagerPanel
            project={project}
            activeAssetId={host.assets.activeAssetId}
            onToggleRoot={() => host.assets.onToggleRoot(project.id)}
            onOpenAsset={host.assets.onOpen}
            onDeleteAsset={host.assets.onDelete}
            onNewAssetFolder={host.assets.onNewFolder}
            onDeleteAssetFolder={host.assets.onDeleteFolder}
            onImportAssets={host.assets.onImport}
            onDropIntoFolder={host.assets.onDropIntoFolder}
            dock={dock}
          />
        ) : (
          <div className="stageplay-asset-manager-empty">请先打开工程</div>
        ),
    },
    {
      id: 'agent',
      title: 'Agent',
      visible: host.agent.open,
      defaultPlacement: 'left',
      defaultSize: 360,
      minSize: 220,
      render: (dock) => (
        <AgentPanel
          open={host.agent.open}
          host={host.agent.host}
          onClose={host.agent.onClose}
          placement={dock.placement}
          onTitlePointerDown={dock.onTitlePointerDown}
          onRedock={dock.onRedock}
          getContext={() => ({
            packageName: host.agent.packageName,
            fileName: host.agent.fileName,
            content: host.agent.content(),
            selection: host.agent.selection(),
          })}
        />
      ),
    },
    {
      id: 'roles',
      title: '备选角色',
      visible: host.view.roles && host.roles.enabled,
      defaultPlacement: 'right',
      defaultSize: 190,
      minSize: 140,
      maxSize: 420,
      render: (dock) => (
        <aside className="role-panel" aria-label="备选角色栏">
          <DockPanelTitle
            title="备选角色"
            placement={dock.placement}
            onTitlePointerDown={dock.onTitlePointerDown}
            onRedock={dock.onRedock}
          />
          <ul className="role-list">
            {Array.from({ length: SPEAKER_SLOT_COUNT }, (_, index) => (
              <li key={index} className="role-slot">
                <button
                  type="button"
                  className="role-index"
                  title={
                    host.roles.values[index]?.trim()
                      ? `${numpadHint(index)} · 插入`
                      : numpadHint(index)
                  }
                  disabled={!host.roles.values[index]?.trim()}
                  onClick={() => host.roles.onInsert(index)}
                >
                  {numpadLabel(index)}
                </button>
                <input
                  className="role-input"
                  value={host.roles.values[index] ?? ''}
                  placeholder="空"
                  spellCheck={false}
                  onChange={(event) => host.roles.onChange(index, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      host.roles.onInsert(index)
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        </aside>
      ),
    },
    {
      id: 'studio',
      title: '录音棚',
      visible: host.studio.open,
      defaultPlacement: 'right',
      defaultSize: studioDefaultWidth(),
      minSize: 280,
      maxSize: 760,
      render: (dock) => (
        <RecordingStudio
          mode={host.studio.mode}
          sourceMode={host.studio.sourceMode}
          selectedKeys={host.studio.selectedKeys}
          library={host.studio.librable ? host.studio.library : null}
          textFor={host.studio.textFor}
          onClose={host.studio.onClose}
          onModeChange={host.studio.onModeChange}
          onSourceModeChange={host.studio.onSourceModeChange}
          onClearSelection={host.studio.onClearSelection}
          onClearVoice={host.studio.onClearVoice}
          onImport={host.studio.onImport}
          onReference={host.studio.onReference}
          tts={host.studio.tts}
          onTitlePointerDown={dock.onTitlePointerDown}
          onRedock={dock.onRedock}
        />
      ),
    },
  ]
}
