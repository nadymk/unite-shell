import GObject from 'gi://GObject'
import Shell from 'gi://Shell'
import Meta from 'gi://Meta'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Util from 'resource:///org/gnome/shell/misc/util.js'
import { WindowPreview } from 'resource:///org/gnome/shell/ui/windowPreview.js'
import * as Handlers from './handlers.js'

const VALID_TYPES = [
  Meta.WindowType.NORMAL,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
  Meta.WindowType.UTILITY
]

const MOTIF_HINTS = '_MOTIF_WM_HINTS'

const _SHOW_FLAGS = ['0x2', '0x0', '0x1', '0x0', '0x0']
const _HIDE_FLAGS = ['0x2', '0x0', '0x2', '0x0', '0x0']

const AppSystem   = Shell.AppSystem.get_default()
const WinTracker  = Shell.WindowTracker.get_default()

function isValid(win) {
  return win && VALID_TYPES.includes(win.window_type)
}

function getId(win) {
  return win && win.get_id ? win.get_id() : win
}

function getXid(win) {
  const desc  = win.get_description()
  const match = desc && desc.match(/0x[0-9a-f]+/)

  return match && match[0]
}

function setHint(xid, hint, value) {
  value = value.join(', ')
  Util.spawn(['xprop', '-id', xid, '-f', hint, '32c', '-set', hint, value])
}

class ClientDecorations {
  show() {
    return false
  }

  hide() {
    return false
  }

  reset() {
    return false
  }
}

class ServerDecorations {
  constructor({ xid, win }) {
    this.xid = xid
    this.win = win
  }

  get decorated() {
    return this.win.get_frame_type() !== Meta.FrameType.BORDER
  }

  get handle() {
    return this.win.decorated
  }

  show() {
    if (this.handle && !this.decorated) {
      setHint(this.xid, MOTIF_HINTS, _SHOW_FLAGS)
    }
  }

  hide() {
    if (this.handle && this.decorated) {
      setHint(this.xid, MOTIF_HINTS, _HIDE_FLAGS)
    }
  }

  reset() {
    if (this.handle) {
      setHint(this.xid, MOTIF_HINTS, _SHOW_FLAGS)
    }
  }
}

const MetaWindow = GObject.registerClass(
  class UniteMetaWindow extends GObject.Object {
    _init(win) {
      win._uniteShellManaged = true

      this.win = win
      this.xid = getXid(win)

      this.signals  = new Handlers.Signals()
      this.settings = new Handlers.Settings()

      if (this.xid && !this.clientDecorated) {
        this.decorations = new ServerDecorations(this)
      } else {
        this.decorations = new ClientDecorations(this)
      }

      this.signals.connect(
        win, 'size-changed', this._onStateChanged.bind(this)
      )

      this.signals.connect(
        win, 'notify::title', this._onTitleChanged.bind(this)
      )

      this.signals.connect(
        win, 'notify::skip-taskbar', this._onEligibilityChanged.bind(this)
      )

      this.signals.connect(
        win, 'notify::window-type', this._onEligibilityChanged.bind(this)
      )

      this.signals.connect(
        win, 'notify::minimized', this._onPanelEligibilityChanged.bind(this)
      )

      this.signals.connect(
        win, 'workspace-changed', this._onPanelEligibilityChanged.bind(this)
      )

      this.settings.connect(
        'restrict-to-primary-screen', this.syncComponents.bind(this)
      )

      this.settings.connect(
        'hide-window-titlebars', this.syncDecorations.bind(this)
      )

      this.settings.connect(
        'show-window-buttons', this.syncControls.bind(this)
      )

      this.settings.connect(
        'show-window-title', this.syncAppmenu.bind(this)
      )

      this.syncComponents()
    }

    get app() {
      return WinTracker.get_window_app(this.win)
    }

    get hasFocus() {
      return this.win.has_focus()
    }

    get isPanelTarget() {
      return global.unite?.panelWindow === this
    }

    get title() {
      if (this.showTitle) {
        return this.win.get_title()
      } else {
        return this.app.get_name()
      }
    }

    get clientDecorated() {
      if (this.win.is_client_decorated) {
        return this.win.is_client_decorated()
      }

      if (this.win.get_client_type() == Meta.WindowClientType.WAYLAND) {
        return true
      }

      return false
    }

    get skipTaskbar() {
      if (Meta.is_wayland_compositor) {
        return Meta.is_wayland_compositor() && this.win.skip_taskbar
      }

      return this.win.skip_taskbar
    }

    get primaryScreen() {
      return this.win.is_on_primary_monitor()
    }

    get minimized() {
      return this.win.minimized
    }

    get anyMaximized() {
      return this.win.maximized_horizontally || this.win.maximized_vertically
    }

    get maximized() {
      return this.win.maximized_horizontally && this.win.maximized_vertically
    }

    get tiled() {
      return !this.maximized && this.anyMaximized
    }

    get restrictToPrimary() {
      return this.settings.get('restrict-to-primary-screen')
    }

    get handleScreen() {
      return this.primaryScreen || !this.restrictToPrimary
    }

    get showTitle() {
      return this._parseEnumSetting('show-window-title')
    }

    get showButtons() {
      return this._parseEnumSetting('show-window-buttons')
    }

    get hideTitlebars() {
      return this._parseEnumSetting('hide-window-titlebars')
    }

    setMaximizeFlags(flags) {
      if (this.win.set_maximize_flags) {
        this.win.set_maximize_flags(flags)
      } else {
        this.win.maximize(flags)
      }
    }

    setUnmaximizeFlags(flags) {
      if (this.win.set_unmaximize_flags) {
        this.win.set_unmaximize_flags(flags)
      } else {
        this.win.unmaximize(flags)
      }
    }

    minimize() {
      if (this.minimized) {
        this.win.unminimize()
      } else {
        this.win.minimize()
      }
    }

    maximize() {
      if (this.maximized) {
        this.setUnmaximizeFlags(Meta.MaximizeFlags.BOTH)
      } else {
        this.setMaximizeFlags(Meta.MaximizeFlags.BOTH)
      }
    }

    maximizeX() {
      if (this.win.maximized_horizontally) {
        this.setUnmaximizeFlags(Meta.MaximizeFlags.HORIZONTAL)
      } else {
        this.setMaximizeFlags(Meta.MaximizeFlags.HORIZONTAL)
      }
    }

    maximizeY() {
      if (this.win.maximized_vertically) {
        this.setUnmaximizeFlags(Meta.MaximizeFlags.VERTICAL)
      } else {
        this.setMaximizeFlags(Meta.MaximizeFlags.VERTICAL)
      }
    }

    lower() {
      this.win.lower()
    }

    close() {
      const time = global.get_current_time()
      time && this.win.delete(time)
    }

    syncDecorations() {
      if (this.hideTitlebars) {
        this.decorations.hide()
      } else {
        this.decorations.show()
      }
    }

    syncControls() {
      if (this.isPanelTarget) {
        const controls = Main.panel.statusArea.uniteWindowControls

        controls && controls.setVisible(
          !this.skipTaskbar && this.showButtons
        )
      }
    }

    syncAppmenu() {
      const appmenu = Main.panel.statusArea.uniteAppMenu

      if (appmenu && this.isPanelTarget && isValid(this.win) &&
          !this.skipTaskbar && this.title) {
        const title = this.title.replace(/\r?\n|\r/g, ' ')
        appmenu.setText(title)
      }
    }

    syncComponents() {
      this.syncDecorations()
      this.syncControls()
      this.syncAppmenu()
    }

    _parseEnumSetting(name) {
      switch (this.settings.get(name)) {
        case 'always':    return true
        case 'never':     return false
        case 'tiled':     return this.handleScreen && this.tiled
        case 'maximized': return this.handleScreen && this.maximized
        case 'both':      return this.handleScreen && this.anyMaximized
      }
    }

    _onStateChanged() {
      this.syncComponents()
    }

    _onTitleChanged() {
      this.syncAppmenu()
    }

    _onEligibilityChanged() {
      global.unite.windowManager.queuePanelStateChanged()

      if (isValid(this.win) && !this.skipTaskbar) {
        this.syncComponents()
      }
    }

    _onPanelEligibilityChanged() {
      global.unite.windowManager.queuePanelStateChanged()
    }

    destroy(reset = true) {
      reset && this.decorations.reset()

      this.signals.disconnectAll()
      this.settings.disconnectAll()

      this.win._uniteShellManaged = false
    }
  }
)

export const WindowManager = GObject.registerClass(
  class UniteWindowManager extends GObject.Object {
    _init() {
      this.windows  = new Map()
      this.signals  = new Handlers.Signals()
      this.settings = new Handlers.Settings()
      this.timeouts = new Handlers.Timeouts()
      this.styles   = new Handlers.Styles()
      this.injections = new Handlers.Injections()

      this._focusWindow = null
      this._overviewWindow = null
      this._overviewActive = false
      this._panelStateTimeout = null
      this._panelStateListeners = new Set()
      this._overviewPreviews = new Map()

      this.signals.connect(
        global.display, 'window-created', this._onWindowCreated.bind(this)
      )

      this.signals.connect(
        global.display, 'window-entered-monitor', this._onWindowEntered.bind(this)
      )

      this.signals.connect(
        global.display, 'notify::focus-window', this._onFocusWindow.bind(this)
      )

      this.signals.connect(
        global.display, 'window-demands-attention', this._onAttention.bind(this)
      )

      this.signals.connect(
        AppSystem, 'app-state-changed', this._onAppStateChanged.bind(this)
      )

      this.signals.connect(
        WinTracker, 'notify::focus-app', this.queuePanelStateChanged.bind(this)
      )

      this.signals.connect(
        Main.overview, 'showing', this._onOverviewShowing.bind(this)
      )

      this.signals.connect(
        Main.overview, 'hiding', this._onOverviewHiding.bind(this)
      )

      this.signals.connect(
        global.stage, 'notify::key-focus', this._onKeyFocusChanged.bind(this)
      )

      this.signals.connect(
        global.workspace_manager, 'active-workspace-changed',
        this._onWorkspaceChanged.bind(this)
      )

      this.settings.connect(
        'hide-window-titlebars', this._onStylesChange.bind(this)
      )

      this.settings.connect(
        'button-layout', this._onStylesChange.bind(this)
      )
    }

    get focusApp() {
      const app = this.focusWindow?.app
      const workspace = global.workspace_manager.get_active_workspace()

      return app?.is_on_workspace(workspace) ? app : null
    }

    get panelApp() {
      const app = this.panelWindow?.app
      const workspace = global.workspace_manager.get_active_workspace()

      return app?.is_on_workspace(workspace) ? app : null
    }

    get panelWindow() {
      return this._overviewActive ? this._overviewWindow : this.focusWindow
    }

    get focusWindow() {
      if (this._focusWindow) {
        const meta = this.getWindow(this._focusWindow)
        const workspace = global.workspace_manager.get_active_workspace()

        // Some desktop implementations create a normal window first, then
        // turn it into a DESKTOP/skip-taskbar window. Do not trust the type it
        // had when it was registered.
        if (meta && meta.hasFocus && !meta.minimized &&
            meta.win.located_on_workspace(workspace) &&
            isValid(meta.win) && !meta.skipTaskbar) {
          return meta
        }
      }
    }

    get hideTitlebars() {
      return this.settings.get('hide-window-titlebars')
    }

    hasWindow(win) {
      return win && this.windows.has(getId(win))
    }

    getWindow(win) {
      return win && this.windows.get(getId(win))
    }

    setWindow(win) {
      if (!this.hasWindow(win)) {
        const meta = new MetaWindow(win)
        this.windows.set(getId(win), meta)

        win.connect('unmanaged', () => {
          this.deleteWindow(win, false)
        })
      }
    }

    deleteWindow(win, reset = true) {
      if (this.hasWindow(win)) {
        const meta = this.getWindow(win)

        if (this._overviewWindow === meta) {
          this._overviewWindow = null
          this.queuePanelStateChanged()
        }

        meta.destroy(reset)

        this.windows.delete(getId(win))
      }
    }

    clearWindows() {
      for (const key of this.windows.keys()) {
        this.deleteWindow(key)
      }
    }

    registerWindow(meta_window) {
      if (isValid(meta_window)) {
        this.setWindow(meta_window)
      }
    }

    registerActor({ meta_window }) {
      this.registerWindow(meta_window)
    }

    _onWindowCreated(display, meta_window) {
      this.registerWindow(meta_window)
    }

    _onWindowEntered(display, index, meta_window) {
      const meta = this.getWindow(meta_window)

      if (meta) {
        meta.syncComponents()
      } else {
        this.registerWindow(meta_window)
      }
    }

    _onFocusWindow(display) {
      this._focusWindow = display.focus_window

      if (!this._overviewActive) {
        this.queuePanelStateChanged()
      }
    }

    _onWorkspaceChanged() {
      this._focusWindow = global.display.focus_window

      if (!this._overviewActive) {
        this.queuePanelStateChanged()
      }
    }

    _onOverviewShowing() {
      this._overviewActive = true
      this._overviewWindow = this.focusWindow
      this.queuePanelStateChanged()
    }

    _onOverviewHiding() {
      this._overviewActive = false
      this._overviewWindow = null
      this.queuePanelStateChanged()
    }

    _watchOverviewPreview(preview) {
      if (this._overviewPreviews.has(preview)) {
        return
      }

      const hoverId = preview.connect('notify::hover', () => {
        if (preview.hover) {
          this.setOverviewWindow(preview.metaWindow)
        }
      })
      const focusId = preview.connect('key-focus-in', () => {
        this.setOverviewWindow(preview.metaWindow)
      })
      const destroyId = preview.connect('destroy', () => {
        this._overviewPreviews.delete(preview)
      })

      this._overviewPreviews.set(preview, [hoverId, focusId, destroyId])
    }

    _onKeyFocusChanged() {
      if (!this._overviewActive) {
        return
      }

      const focus = global.stage.get_key_focus()
      const preview = [...this._overviewPreviews.keys()].find(actor => {
        return focus && (actor === focus || actor.contains(focus))
      })

      if (preview) {
        this.setOverviewWindow(preview.metaWindow)
      }
    }

    setOverviewWindow(win) {
      if (!this._overviewActive || !win) {
        return
      }

      if (!this.hasWindow(win)) {
        this.registerWindow(win)
      }

      const target = this.getWindow(win)

      if (target && !target.skipTaskbar && this._overviewWindow !== target) {
        this._overviewWindow = target
        this.queuePanelStateChanged()
      }
    }

    addPanelStateListener(callback) {
      this._panelStateListeners.add(callback)
      return callback
    }

    removePanelStateListener(callback) {
      this._panelStateListeners.delete(callback)
    }

    _onAppStateChanged(appSys, app) {
      this.queuePanelStateChanged()
    }

    queuePanelStateChanged() {
      if (this._panelStateTimeout) {
        return
      }

      this._panelStateTimeout = this.timeouts.idle(() => {
        this._panelStateTimeout = null

        for (const callback of this._panelStateListeners) {
          try {
            callback()
          } catch (error) {
            console.error('[Unite] Failed to update a panel component', error)
          }
        }

        // Appmenu state sets the application name first. Apply the selected
        // window's title afterwards so the panel consistently represents the
        // same target in both the desktop and overview.
        this.panelWindow?.syncComponents()
      })
    }

    _onAttention(actor, win) {
      const auto = this.settings.get('autofocus-windows')
      const time = global.get_current_time()

      auto && Main.activateWindow(win, time)
    }

    _onStylesChange() {
      if (this.hideTitlebars != 'never') {
        const side = this.settings.get('window-buttons-position')
        const path = `@/buttons-${side}/${this.hideTitlebars}.css`

        this.styles.addGtkStyle('windowDecorations', path)
      } else {
        this.styles.deleteStyle('windowDecorations')
      }
    }

    activate() {
      const manager = this

      this.injections.wrap(WindowPreview, '_init', originalMethod => {
        return function(...args) {
          originalMethod.call(this, ...args)
          manager._watchOverviewPreview(this)
        }
      })

      this.timeouts.idle(() => {
        const actors = global.get_window_actors()
        actors.forEach(actor => this.registerActor(actor))
      })

      this._onFocusWindow(global.display)
      this._onStylesChange()
    }

    destroy() {
      this._focusWindow = null
      this._overviewWindow = null
      this._overviewActive = false
      this._panelStateTimeout = null

      this.timeouts.removeAll()
      this.signals.disconnectAll()
      this.settings.disconnectAll()
      this.styles.removeAll()
      this.injections.removeAll()

      for (const [preview, ids] of this._overviewPreviews) {
        ids.forEach(id => preview.disconnect(id))
      }

      this._overviewPreviews.clear()
      this._panelStateListeners.clear()

      this.clearWindows()
    }
  }
)
