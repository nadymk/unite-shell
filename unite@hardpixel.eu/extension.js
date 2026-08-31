import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Handlers from './handlers.js'
import * as Convenience from './convenience.js'
import { PanelManager } from './panel.js'
import { LayoutManager } from './layout.js'
import { WindowManager } from './window.js'

export default class UniteExtension extends Extension {
  enable() {
    global.unite = this

    const settings = Convenience.getSettings()
    if (
      settings.get_user_value('window-buttons-container') == null &&
      settings.get_boolean('combine-window-buttons')
    ) {
      settings.set_string('window-buttons-container', 'appmenu')
    }

    if (settings.get_user_value('panel-layout') == null) {
      const preferences = Convenience.getPreferences()
      const lane = placement => {
        if (placement == 'default') return 'default'
        if (placement == 'first') return 'leftmost'
        if (placement == 'last') return 'rightmost'
        return placement
      }
      const buttonPlacement = settings.get_string('window-buttons-placement')
      const buttonLane = buttonPlacement == 'auto'
        ? preferences.getSetting('window-buttons-position')
        : lane(buttonPlacement)
      const layout = [
        `app-menu:${lane(settings.get_string('app-menu-panel-placement'))}`,
        `workspace-switcher:${lane(settings.get_string('workspace-switcher-placement'))}`,
        `window-buttons:${buttonLane}`,
        `clock:${lane(settings.get_string('clock-placement'))}`,
        `system-indicators:${lane(settings.get_string('system-indicators-placement'))}`,
      ]

      settings.set_strv('panel-layout', layout)
    }

    this.windowManager = new WindowManager()
    this.panelManager  = new PanelManager()
    this.layoutManager = new LayoutManager()

    Handlers.resetGtkStyles()

    this.panelManager.activate()
    this.layoutManager.activate()
    this.windowManager.activate()

    Main.panel.add_style_class_name('unite-shell')
  }

  disable() {
    Handlers.resetGtkStyles()

    this.panelManager.destroy()
    this.layoutManager.destroy()
    this.windowManager.destroy()

    Main.panel.remove_style_class_name('unite-shell')

    global.unite = null
  }

  get focusApp() {
    return this.windowManager.focusApp
  }

  get focusWindow() {
    return this.windowManager.focusWindow
  }

  get panelApp() {
    return this.windowManager.panelApp
  }

  get panelWindow() {
    return this.windowManager.panelWindow
  }
}
