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

  async activate(plugin: Plugin, host: ProjectHost, ui: UiServices): Promise<void> {
    await this.registry.activate(plugin, host, ui)
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

  get activePluginIds(): string[] {
    return this.registry.activeIds
  }

  async dispose(): Promise<void> {
    await this.registry.dispose()
  }
}

/** Process-wide loader instance; the shell owns its lifecycle. */
export const pluginLoader = new PluginLoader()
