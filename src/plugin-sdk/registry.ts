import type {
  CommandContribution,
  HelpContribution,
  MenuContribution,
  PanelContribution,
  Plugin,
  PluginContext,
  PluginId,
  ProjectHost,
  StatusbarContribution,
  UiServices,
  WorkspaceId,
} from './types'

type Owned<T> = T & { pluginId: PluginId }

/** Declarative registrations collected from activated plugins. */
export class PluginRegistry {
  private readonly plugins = new Map<PluginId, Plugin>()
  private readonly panels: Array<Owned<PanelContribution>> = []
  private readonly menus: Array<Owned<MenuContribution>> = []
  private readonly statusbar: Array<Owned<StatusbarContribution>> = []
  private readonly commands = new Map<string, Owned<CommandContribution>>()
  private readonly help: Array<Owned<HelpContribution>> = []
  private disposed = false

  get activeIds(): PluginId[] {
    return [...this.plugins.keys()]
  }

  async activate(plugin: Plugin, host: ProjectHost, ui: UiServices): Promise<void> {
    if (this.disposed) throw new Error('plugin registry is disposed')
    if (this.plugins.has(plugin.id)) throw new Error(`plugin already active: ${plugin.id}`)
    // A plugin that throws halfway through activate must not leave contributions behind.
    const snapshot = {
      panels: this.panels.length,
      menus: this.menus.length,
      statusbar: this.statusbar.length,
      help: this.help.length,
      commands: [...this.commands.keys()],
    }
    const context: PluginContext = {
      pluginId: plugin.id,
      host,
      ui,
      registerPanel: (panel) => this.panels.push({ ...panel, pluginId: plugin.id }),
      registerMenu: (item) => this.menus.push({ ...item, pluginId: plugin.id }),
      registerStatusbarItem: (item) => this.statusbar.push({ ...item, pluginId: plugin.id }),
      registerCommand: (command) => {
        if (this.commands.has(command.id)) throw new Error(`duplicate command: ${command.id}`)
        this.commands.set(command.id, { ...command, pluginId: plugin.id })
      },
      registerHelp: (topic) => this.help.push({ ...topic, pluginId: plugin.id }),
    }
    this.plugins.set(plugin.id, plugin)
    try {
      await plugin.activate(context)
    } catch (error) {
      this.plugins.delete(plugin.id)
      this.panels.length = snapshot.panels
      this.menus.length = snapshot.menus
      this.statusbar.length = snapshot.statusbar
      this.help.length = snapshot.help
      for (const id of [...this.commands.keys()]) {
        if (!snapshot.commands.includes(id)) this.commands.delete(id)
      }
      throw error
    }
  }

  panelsFor(workspace: WorkspaceId): PanelContribution[] {
    return this.panels
      .filter((panel) => !panel.workspaces || panel.workspaces.includes(workspace))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map(({ pluginId: _pluginId, ...panel }) => panel)
  }

  menusFor(menu: string): MenuContribution[] {
    return this.menus
      .filter((item) => item.menu === menu)
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map(({ pluginId: _pluginId, ...item }) => item)
  }

  statusbarItems(): StatusbarContribution[] {
    return this.statusbar
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map(({ pluginId: _pluginId, ...item }) => item)
  }

  helpTopics(): HelpContribution[] {
    return this.help
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map(({ pluginId: _pluginId, ...topic }) => topic)
  }

  command(id: string): CommandContribution | null {
    const command = this.commands.get(id)
    if (!command) return null
    const { pluginId: _pluginId, ...rest } = command
    return rest
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const plugin of [...this.plugins.values()].reverse()) {
      try {
        plugin.dispose?.()
      } catch {
        // A failing plugin must not block shell teardown.
      }
    }
    this.plugins.clear()
    this.panels.length = 0
    this.menus.length = 0
    this.statusbar.length = 0
    this.commands.clear()
    this.help.length = 0
  }
}
