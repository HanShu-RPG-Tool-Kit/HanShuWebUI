import { PluginRegistry } from '../plugin-sdk'
import type {
  CommandContribution,
  HelpContribution,
  MenuContribution,
  PanelContribution,
  Plugin,
  ProjectHost,
  StatusbarContribution,
  UiServices,
  WorkspaceId,
} from '../plugin-sdk'
import { getProjectHost } from '../project/projectHost'
import { chooseDialog, confirmDialog } from '../ui/dialogs'
import { notify } from '../activity'

/**
 * The single place where the shell assembles plugins.
 *
 * The application shell must reach plugin contributions only through this
 * loader (or through a component that receives them from it). Deleting a
 * plugin from the built-in list and removing the loader import must leave a
 * shell that still type-checks and renders.
 */
export class PluginLoader {
  private readonly registry = new PluginRegistry()
  private readonly listeners = new Set<() => void>()

  async activate(plugin: Plugin, host: ProjectHost, ui: UiServices): Promise<void> {
    await this.registry.activate(plugin, host, ui)
    this.emit()
  }

  panelsFor(workspace: WorkspaceId): PanelContribution[] {
    return this.registry.panelsFor(workspace)
  }

  menusFor(menu: string): MenuContribution[] {
    return this.registry.menusFor(menu)
  }

  statusbarItems(): StatusbarContribution[] {
    return this.registry.statusbarItems()
  }

  helpTopics(): HelpContribution[] {
    return this.registry.helpTopics()
  }

  command(id: string): CommandContribution | null {
    return this.registry.command(id)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  get activePluginIds(): string[] {
    return this.registry.activeIds
  }

  async dispose(): Promise<void> {
    await this.registry.dispose()
  }
}

/** Process-wide loader instance; the shell owns its lifecycle. */
export const pluginLoader = new PluginLoader()

/**
 * 动态 ProjectHost：工程会话切换时 `getProjectHost()` 会换新对象，
 * 插件拿到的 host 必须始终转发到当前工程，而不是激活时的旧快照。
 */
function dynamicHost(): ProjectHost {
  const host = () => getProjectHost()
  const call = <T,>(pick: (current: ProjectHost) => T, fallback: T): T => {
    const current = host()
    return current ? pick(current) : fallback
  }
  return {
    get scope() {
      return host()?.scope ?? 'local'
    },
    listFiles: () => call((current) => current.listFiles(), []),
    readCurrentText: (path) => call((current) => current.readCurrentText(path), null),
    readSavedText: (path) => call((current) => current.readSavedText(path), Promise.resolve(null)),
    hasDraft: (path) => call((current) => current.hasDraft(path), false),
    listDraftPaths: () => call((current) => current.listDraftPaths(), []),
    writeDraft: (path, text) => {
      host()?.writeDraft(path, text)
    },
    discardDraft: (path) => {
      host()?.discardDraft(path)
    },
    stageAssetText: (path, text) => host()?.stageAssetText(path, text) ?? Promise.resolve(),
    stagedAssetText: (path) => call((current) => current.stagedAssetText(path), undefined),
    discardAssetText: (path) => {
      host()?.discardAssetText?.(path)
    },
    isHumanDirty: (path) => call((current) => current.isHumanDirty?.(path) ?? false, false),
    getActivePath: () => call((current) => current.getActivePath(), null),
    getLocale: () => host()?.getLocale() ?? 'zh_cn',
    flushEditors: () => {
      host()?.flushEditors()
    },
    subscribe: (listener) => {
      const current = host()
      return current ? current.subscribe(listener) : () => undefined
    },
    onSaved: (listener) => {
      const current = host()
      return current ? current.onSaved(listener) : () => undefined
    },
  }
}

const defaultUiServices: UiServices = {
  confirm: (message, options = {}) =>
    confirmDialog({
      title: options.title,
      message,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      danger: options.danger,
    }),
  choose: (options) =>
    chooseDialog({
      title: options.title,
      message: options.message,
      options: options.options,
      cancelLabel: options.cancelLabel,
    }),
  notify: (text) => notify(text),
  setReadOnlyPaths: () => undefined,
}

let builtinsActivated = false

/** 内置插件注册表：插件自己的安装文件把工厂登记进来，loader 不静态依赖任何插件。 */
const builtinInitializers: Array<() => Plugin | Promise<Plugin>> = []

export function registerBuiltinPlugin(initializer: () => Plugin | Promise<Plugin>): void {
  if (builtinInitializers.includes(initializer)) return
  builtinInitializers.push(initializer)
}

/**
 * 注册内置插件。工作区在挂载时调用；工程文件通道没就绪时下次再试。
 * 内置列表是主体接入插件的唯一一行静态 import。
 */
export async function activateBuiltinPlugins(): Promise<void> {
  if (builtinsActivated) return
  if (!getProjectHost()) return
  builtinsActivated = true
  try {
    for (const initializer of builtinInitializers) {
      const plugin = await initializer()
      await pluginLoader.activate(plugin, dynamicHost(), defaultUiServices)
    }
  } catch (error) {
    builtinsActivated = false
    throw error
  }
}
