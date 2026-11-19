import type {
  ComponentType,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from 'react'

/** A workspace is a view over the same project; plugins never get a workspace-private session. */
export type WorkspaceId = string

export type PluginId = string

export type DockPlacement = 'left' | 'right' | 'top' | 'bottom' | 'float'

/** One file in the project tree, independent of which workspace is currently active. */
export type ProjectFileInfo = {
  /** Project-relative path, for example `src/故事/序章.hs` or `assets/voice/zh/序章.ogg`. */
  path: string
  kind: 'source' | 'asset'
}

/**
 * Project-scoped file access shared by every workspace.
 *
 * The host is deliberately free of workspace-specific models: a plugin that works on
 * documents gets the same view no matter which workspace the user is currently in.
 */
export type ProjectHost = {
  readonly scope: string
  readonly windowId: string
  /** All files that currently exist in the opened project. */
  listFiles(): ProjectFileInfo[]
  /** Latest text: unsaved editor buffer, then local draft, then saved project content. */
  readCurrentText(path: string): Promise<string | null>
  /** Last saved text. This is the baseline for change review and rollback. */
  readSavedText(path: string): Promise<string | null>
  hasDraft(path: string): boolean
  /** Paths with an unsaved local draft created by a plugin. */
  listDraftPaths(): string[]
  /** Stage a local draft. The project itself is only written when the user saves. */
  writeDraft(path: string, text: string): Promise<void>
  discardDraft(path: string): Promise<void>
  /** Path of the document the user is currently looking at, if any. */
  getActivePath(): string | null
  /** Flush every workspace editor buffer into the shared project session. */
  flushEditors(): void
  /** Notify when project content or drafts changed. */
  subscribe(listener: () => void): () => void
  /** Notify after the user saved the project. `paths` may be empty when all drafts were committed. */
  onSaved(listener: (paths: string[]) => void): () => void
}

export type UiChoice = {
  id: string
  label: string
  description?: string
  danger?: boolean
}

/** Generic shell services a plugin may use without importing the application shell. */
export type UiServices = {
  confirm(
    message: string,
    options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean },
  ): Promise<boolean>
  choose(options: {
    title: string
    message?: string
    options: UiChoice[]
    cancelLabel?: string
  }): Promise<string | null>
  notify(text: string): void
  /** Mark project paths read-only for the duration of a plugin task. */
  setReadOnlyPaths(owner: string, paths: readonly string[]): void
}

/** Props the shell hands to every plugin panel. */
export type PanelHostProps = {
  open: boolean
  onClose: () => void
  style?: CSSProperties
  placement?: DockPlacement
  onTitlePointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
  onRedock?: () => void
}

export type PanelContribution = {
  id: string
  title: string
  component: ComponentType<PanelHostProps>
  /** Workspaces that show this panel. Omitted = every workspace. */
  workspaces?: WorkspaceId[]
  defaultOpen?: boolean
  placement?: DockPlacement
  defaultSize?: number
  minSize?: number
  maxSize?: number
  defaultStack?: { with: string; side: DockPlacement }
  order?: number
}

export type MenuContribution = {
  id: string
  /** Menu slot owned by the shell, for example `view` or `help`. */
  menu: string
  label: string
  command: string
  order?: number
}

export type StatusbarContribution = {
  id: string
  label: string
  command: string
  active?: () => boolean
  order?: number
}

export type CommandContribution = {
  id: string
  title: string
  run: () => void | Promise<void>
}

export type HelpContribution = {
  id: string
  title: string
  /** Markdown body. */
  body: string
  order?: number
}

export type PluginContext = {
  readonly pluginId: PluginId
  readonly host: ProjectHost
  readonly ui: UiServices
  registerPanel(panel: PanelContribution): void
  registerMenu(item: MenuContribution): void
  registerStatusbarItem(item: StatusbarContribution): void
  registerCommand(command: CommandContribution): void
  registerHelp(topic: HelpContribution): void
}

export type Plugin = {
  id: PluginId
  name: string
  activate(context: PluginContext): void | Promise<void>
  dispose?(): void
}
