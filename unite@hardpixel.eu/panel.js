import System from 'system'
import GObject from 'gi://GObject'
import St from 'gi://St'
import Pango from 'gi://Pango'
import Clutter from 'gi://Clutter'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Buttons from './buttons.js'
import * as Theme from './theme.js'
import * as Handlers from './handlers.js'

const Activities = Main.panel.statusArea.activities
const PANEL_LAYOUT_IDS = [
  'app-menu',
  'workspace-switcher',
  'window-buttons',
  'clock',
  'system-indicators',
]
const PANEL_LAYOUT_ACTORS = new Map()

function getPanelLayout(settings) {
  const entries = settings.get('panel-layout') || []
  const parsed = []
  const seen = new Set()

  entries.forEach(entry => {
    const [id, lane] = entry.split(':')
    const valid = PANEL_LAYOUT_IDS.includes(id) &&
      ['default', 'leftmost', 'left', 'center', 'right', 'rightmost'].includes(lane)

    if (valid && !seen.has(id)) {
      parsed.push({ id, lane })
      seen.add(id)
    }
  })

  PANEL_LAYOUT_IDS.forEach(id => {
    if (!parsed.some(item => item.id === id)) {
      parsed.push({ id, lane: 'default' })
    }
  })

  return parsed
}

function getPanelPlacement(settings, id) {
  return getPanelLayout(settings).find(item => item.id === id)?.lane || 'default'
}

function getPanelBox(lane) {
  if (lane === 'center') return Main.panel._centerBox
  if (['right', 'rightmost'].includes(lane)) return Main.panel._rightBox
  return Main.panel._leftBox
}

function registerPanelLayoutActor(id, actor) {
  PANEL_LAYOUT_ACTORS.set(id, actor)
}

function unregisterPanelLayoutActor(id, actor) {
  if (PANEL_LAYOUT_ACTORS.get(id) === actor) {
    PANEL_LAYOUT_ACTORS.delete(id)
  }
}

function syncPanelLayout(settings) {
  const layout = getPanelLayout(settings)

  layout.forEach(({ id, lane }) => {
    const actor = PANEL_LAYOUT_ACTORS.get(id)
    if (!actor || lane === 'default') return

    const panelBox = getPanelBox(lane)
    if (actor.get_parent() !== panelBox) {
      actor.get_parent()?.remove_child(actor)
      panelBox.add_child(actor)
    }
  })

  const atStart = (lane, panelBox, offset = 0) => {
    const actors = layout
      .filter(item => item.lane === lane)
      .map(item => PANEL_LAYOUT_ACTORS.get(item.id))
      .filter(Boolean)

    actors.forEach((actor, index) => {
      const target = offset + index
      if (panelBox.get_children().indexOf(actor) !== target) {
        panelBox.set_child_at_index(actor, target)
      }
    })

    return offset + actors.length
  }

  let leftOffset = atStart('leftmost', Main.panel._leftBox)
  atStart('left', Main.panel._leftBox, leftOffset)
  atStart('center', Main.panel._centerBox)
  atStart('right', Main.panel._rightBox)

  const rightmost = layout.filter(item => item.lane === 'rightmost')
    .map(item => PANEL_LAYOUT_ACTORS.get(item.id))
    .filter(Boolean)

  const rightChildren = Main.panel._rightBox.get_children()
  const currentEdge = rightChildren.slice(-rightmost.length)
  const edgeMatches = rightmost.every((actor, index) => actor === currentEdge[index])

  if (!edgeMatches) {
    rightmost.forEach(actor => {
      Main.panel._rightBox.set_child_at_index(actor, -1)
    })
  }

  Main.panel.queue_relayout()
}

class PanelLayoutManager extends Handlers.Feature {
  constructor() {
    super('panel-layout', () => true)
  }

  activate() {
    this.settings = new Handlers.Settings()
    this.signals = new Handlers.Signals()
    this.timeouts = new Handlers.Timeouts()
    this._syncTimeout = null

    this.settings.connect('panel-layout', this._queueSync.bind(this))
    const panelBoxes = [
      Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox,
    ]
    panelBoxes.forEach(panelBox => {
      this.signals.connect(
        panelBox, 'notify::allocation', this._queueSync.bind(this)
      )
    })

    this._queueSync()
  }

  _queueSync() {
    if (this._syncTimeout) return

    this._syncTimeout = this.timeouts.idle(() => {
      this._syncTimeout = null
      syncPanelLayout(this.settings)
    })
  }

  destroy() {
    this.settings.disconnectAll()
    this.signals.disconnectAll()
    this.timeouts.removeAll()
    this._syncTimeout = null
  }
}

class AppmenuButton extends Handlers.Feature {
  constructor() {
    super('show-appmenu-button', setting => setting == true)
  }

  activate() {
    this.signals  = new Handlers.Signals()
    this.settings = new Handlers.Settings()
    this.timeouts = new Handlers.Timeouts()
    this.button   = new Buttons.AppmenuLabel()
    this.focused  = null
    this._hoverExpandTimeout = null
    this._buttonsRevealTimeout = null
    this._titleCollapseTimeout = null
    this._layoutSyncTimeout = null
    this._titleExpanded = false
    this._acceptWindowControls = false

    this.signals.connect(
      Main.overview, 'showing', this._syncState.bind(this)
    )

    this.signals.connect(
      Main.overview, 'hiding', this._syncState.bind(this)
    )

    this._panelStateListener = this._syncState.bind(this)
    global.unite.windowManager.addPanelStateListener(this._panelStateListener)

    this.signals.connect(
      Main.panel._leftBox, 'notify::allocation', this._queueSyncLayout.bind(this)
    )

    this.signals.connect(
      Main.panel._rightBox, 'notify::allocation', this._queueSyncLayout.bind(this)
    )

    this.settings.connect(
      'hide-app-menu-icon', this._onHideIconChange.bind(this)
    )

    this.settings.connect(
      'greyscale-tray-icons', this._onGreyscaleChange.bind(this)
    )

    this.settings.connect(
      'app-menu-max-width', this._onMaxWidthChange.bind(this)
    )

    this.settings.connect(
      'app-menu-ellipsize-mode', this._onEllipsizeModeChange.bind(this)
    )

    this.settings.connect(
      'app-menu-placement', this._onPositionChange.bind(this)
    )

    this.settings.connect(
      'app-menu-panel-placement', this._onPositionChange.bind(this)
    )

    this.settings.connect(
      'panel-layout', this._onPositionChange.bind(this)
    )

    this.settings.connect(
      'window-buttons-container', this._onCombinedChange.bind(this)
    )

    this.settings.connect(
      'compact-app-menu-button', this._onCompactModeChange.bind(this)
    )

    this.settings.connect(
      'compact-app-menu-hover-delay', this._onCompactModeChange.bind(this)
    )

    this.settings.connect(
      'compact-app-menu-threshold', this._onCompactModeChange.bind(this)
    )

    this.settings.connect(
      'reveal-window-buttons-on-hover', this._onHoverButtonsChange.bind(this)
    )

    this.settings.connect(
      'window-buttons-hover-delay', this._onHoverButtonsChange.bind(this)
    )

    this.settings.connect(
      'show-window-buttons', this._onHoverButtonsChange.bind(this)
    )

    this.button.connect(
      'notify::hover', this._onAppMenuHover.bind(this)
    )

    this.signals.connect(
      this.button.menu, 'open-state-changed', this._onAppMenuOpenStateChanged.bind(this)
    )

    this.button.syncPlacement = this._syncPlacement.bind(this)
    this.button.syncLayout = this._syncLayout.bind(this)
    this.button.syncHoverButtons = this._syncHoverButtons.bind(this)

    Main.panel.addToStatusArea(
      'uniteAppMenu', this.button, 1, 'left'
    )

    this._originalPanelParent = this.button.container.get_parent()
    this._originalPanelIndex = this._originalPanelParent
      .get_children().indexOf(this.button.container)

    this._onHideIconChange()
    this._onGreyscaleChange()
    this._onMaxWidthChange()
    this._syncPlacement()

    this._syncState()
    this._acceptWindowControls = true
  }

  get hideIcon() {
    return this.settings.get('hide-app-menu-icon')
  }

  get maxWidth() {
    return this.settings.get('app-menu-max-width')
  }

  get ellipsizeMode() {
    return this.settings.get('app-menu-ellipsize-mode')
  }

  get placement() {
    return this.settings.get('app-menu-placement')
  }

  get panelPlacement() {
    return getPanelPlacement(this.settings, 'app-menu')
  }

  get panelSide() {
    if (this.panelPlacement === 'default') return 'left'
    return ['right', 'rightmost'].includes(this.panelPlacement) ? 'right' : 'left'
  }

  get combined() {
    return this.settings.get('window-buttons-container') == 'appmenu'
  }

  get compactMode() {
    return this.settings.get('compact-app-menu-button')
  }

  get adaptiveMode() {
    return this.combined || this.compactMode
  }

  get compactHoverDelay() {
    return Math.max(0, this.settings.get('compact-app-menu-hover-delay'))
  }

  get compactThreshold() {
    return Math.max(0, this.settings.get('compact-app-menu-threshold'))
  }

  get revealButtonsOnHover() {
    return this.settings.get('reveal-window-buttons-on-hover')
  }

  get buttonsHoverDelay() {
    return Math.max(0, this.settings.get('window-buttons-hover-delay'))
  }

  get buttonsMode() {
    return this.settings.get('show-window-buttons')
  }

  setLabelMaxWidth(width) {
    this.button._label.set_style(width ? `max-width: ${width}px` : null)
  }

  setTextEllipsizeMode(mode) {
    const type = mode.toUpperCase()
    this.button._label.get_clutter_text().set_ellipsize(Pango.EllipsizeMode[type])
  }

  _syncState() {
    const astates = Shell.AppState.STARTING
    const focused = global.unite.panelApp
    const visible = focused != null
    const loading = focused != null && (focused.get_state() == astates || focused.get_busy())

    if (focused !== this.focused) {
      this.focused?.disconnectObject(this)
      this.focused = focused

      if (this.focused) {
        this.focused.connectObject('notify::busy', this._syncState.bind(this), this)
        this.button.setApp(this.focused)
      }
    }

    if (loading) {
      this.button.startAnimation()
    } else {
      this.button.stopAnimation()
    }

    this.button.setReactive(visible && !loading)
    this.button.setVisible(visible)
    this._syncCompactMode()
    this._syncHoverButtons()
  }

  _onAppMenuHover(appMenu) {
    if (!appMenu.get_hover()) {
      this._cancelHoverExpand()
      this._cancelButtonsReveal()
      this._setButtonsHoverVisible(false)
      this._queueTitleCollapse()
      return
    }

    this._cancelTitleCollapse()
    this._syncHoverButtons()

    if (this.adaptiveMode && !this._fitsFullWidth()) {
      this._cancelHoverExpand()
      this._hoverExpandTimeout = this.timeouts.timeout(this.compactHoverDelay, () => {
        this._hoverExpandTimeout = null

        if (appMenu.get_hover()) {
          this._expandTitle()
        }
      })
    }

  }

  _onAppMenuOpenStateChanged(menu, open) {
    if (open) {
      this._cancelTitleCollapse()
    } else if (!this.button.get_hover()) {
      this._queueTitleCollapse()
    }
  }

  _onHideIconChange() {
    this.button.toggleIcon(this.combined ? false : this.hideIcon)
  }

  _onGreyscaleChange() {
    this.button.setGreyscale(this.settings.get('greyscale-tray-icons'))
  }

  _onMaxWidthChange() {
    this.setLabelMaxWidth(this.combined ? 0 : this.maxWidth)
    this.setTextEllipsizeMode(this.ellipsizeMode)
  }

  _onEllipsizeModeChange() {
    this.setTextEllipsizeMode(this.ellipsizeMode)
  }

  _onCompactModeChange() {
    this._cancelHoverExpand()
    this._collapseTitle()
    this._syncCompactMode()
  }

  _onHoverButtonsChange() {
    this._cancelButtonsReveal()
    this._setButtonsHoverVisible(false)
    this._syncHoverButtons()
  }

  _onCombinedChange() {
    this._cancelHoverExpand()
    this._onHoverButtonsChange()
    this._collapseTitle()
    this._onHideIconChange()
    this._onMaxWidthChange()
    this._syncPlacement()
  }

  _onPositionChange() {
    // PanelMenu.Button is wrapped in `button.container` by GNOME Shell.
    // Always position that wrapper; moving the button itself detaches it from
    // the actor whose visibility GNOME Shell manages.
    const container = this.button.container
    const controls = this._acceptWindowControls
      ? Main.panel.statusArea.uniteWindowControls?.container
      : null

    if (this.panelPlacement === 'default') {
      unregisterPanelLayoutActor('app-menu', container)

      if (this.combined && controls) {
        this.button.setWindowControls(controls)
        this.button.setWindowControlsPlacement(this.placement, 'left')
      } else if (!this.combined) {
        this.button.removeWindowControls()
      }

      if (container.get_parent() !== this._originalPanelParent) {
        container.get_parent()?.remove_child(container)
        this._originalPanelParent.add_child(container)
      }

      this._originalPanelParent.set_child_at_index(
        container, this._originalPanelIndex
      )
      Main.panel.queue_relayout()
      return
    }

    if (this.combined) {
      if (controls) {
        this.button.setWindowControls(controls)
      }

      this.button.setWindowControlsPlacement(this.placement, this.panelSide)

      registerPanelLayoutActor('app-menu', container)
      syncPanelLayout(this.settings)
      return
    }

    this.button.removeWindowControls()

    registerPanelLayoutActor('app-menu', container)
    syncPanelLayout(this.settings)
  }

  _syncPlacement() {
    this._onPositionChange()
    Activities.syncPlacement?.()
    this._syncCompactMode()
  }

  _syncLayout() {
    this._syncCompactMode()
  }

  _shouldRevealButtons() {
    const controls = Main.panel.statusArea.uniteWindowControls

    return controls && this.combined && this.revealButtonsOnHover &&
      this.buttonsMode != 'always' && !controls.policyVisible &&
      this.button.get_hover() && global.unite.panelWindow != null
  }

  _syncHoverButtons() {
    const controls = Main.panel.statusArea.uniteWindowControls

    if (!this._shouldRevealButtons()) {
      this._cancelButtonsReveal()
      this._setButtonsHoverVisible(false)
      return
    }

    if (controls.hoverVisible || this._buttonsRevealTimeout) {
      return
    }

    this._buttonsRevealTimeout = this.timeouts.timeout(this.buttonsHoverDelay, () => {
      this._buttonsRevealTimeout = null

      if (this._shouldRevealButtons()) {
        this._setButtonsHoverVisible(true)
      }
    })
  }

  _setButtonsHoverVisible(visible) {
    const controls = Main.panel.statusArea.uniteWindowControls

    if (!controls || controls.hoverVisible == visible) {
      return
    }

    controls.setHoverVisible(visible)
    Main.panel.queue_relayout()
    this._queueSyncLayout()
  }

  _queueSyncLayout() {
    if (this._layoutSyncTimeout) {
      return
    }

    this._layoutSyncTimeout = this.timeouts.idle(() => {
      this._layoutSyncTimeout = null
      this._syncLayout()
    })
  }

  _cancelHoverExpand() {
    if (this._hoverExpandTimeout) {
      this.timeouts.remove(this._hoverExpandTimeout)
      this._hoverExpandTimeout = null
    }
  }

  _cancelButtonsReveal() {
    if (this._buttonsRevealTimeout) {
      this.timeouts.remove(this._buttonsRevealTimeout)
      this._buttonsRevealTimeout = null
    }
  }

  _cancelTitleCollapse() {
    if (this._titleCollapseTimeout) {
      this.timeouts.remove(this._titleCollapseTimeout)
      this._titleCollapseTimeout = null
    }
  }

  _queueTitleCollapse() {
    this._cancelTitleCollapse()
    this._titleCollapseTimeout = this.timeouts.idle(() => {
      this._titleCollapseTimeout = null

      if (!this.button.get_hover() && !this.button.menu.isOpen) {
        this._collapseTitle()
      }
    })
  }

  _fitsFullWidth() {
    const container = this.button.container
    const panelBox = container.get_parent()

    if (![Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]
      .includes(panelBox)) {
      return true
    }

    if (panelBox.get_width() <= 0) {
      return true
    }

    const available = this._availablePanelBoxWidth()
    if (available <= 0) {
      return false
    }

    return this.button.measureFullWidth() + this.compactThreshold <= available
  }

  _availablePanelBoxWidth() {
    const container = this.button.container
    const panelBox = container.get_parent()
    const panelWidth = Main.panel.get_width()
    const centerWidth = Main.panel._centerBox.get_width()
    const capacity = panelBox === Main.panel._centerBox
      ? centerWidth
      : Math.max(0, Math.floor((panelWidth - centerWidth) / 2))

    return capacity - panelBox.get_children().reduce((width, child) => {
      return child == container ? width : width + child.get_width()
    }, 0)
  }

  _syncCompactMode() {
    const actor = this.button

    if (Main.overview.visibleTarget) {
      this.button.setCompact(false)
      return
    }

    if (!actor.container.visible || !this.adaptiveMode || this._titleExpanded) {
      this.button.setCompact(false)
      return
    }

    const compact = !this._fitsFullWidth()
    this.button.setCompact(compact)

    if (!compact) {
      this._collapseTitle()
    }
  }

  _expandTitle() {
    const actor = this.button

    if (this._titleExpanded || !actor.container.visible || !this.adaptiveMode || this._fitsFullWidth()) {
      return
    }

    if (!this.focused) {
      return
    }

    this._titleExpanded = true
    this.button.setCompact(false)
    Main.panel.queue_relayout()
  }

  _collapseTitle() {
    if (!this._titleExpanded) {
      return
    }

    this._titleExpanded = false
    this._syncCompactMode()
    Main.panel.queue_relayout()
  }

  destroy() {
    global.unite.windowManager.removePanelStateListener(this._panelStateListener)
    this._panelStateListener = null
    this._cancelHoverExpand()
    this._cancelButtonsReveal()
    this._setButtonsHoverVisible(false)
    this._cancelTitleCollapse()
    this._titleExpanded = false
    this._acceptWindowControls = false
    this.timeouts.removeAll()
    this.signals.disconnectAll()
    this.settings.disconnectAll()

    unregisterPanelLayoutActor('app-menu', this.button.container)
    this.button.removeWindowControls()
    Main.panel.statusArea.uniteWindowControls?.syncPlacement?.(true)
    this.button.destroy()
  }
}

class WindowButtons extends Handlers.Feature {
  constructor() {
    super(
      ['show-window-buttons', 'window-buttons-container'],
      (setting, container) => setting != 'never' || container != 'separate'
    )
  }

  activate() {
    this.signals  = new Handlers.Signals()
    this.settings = new Handlers.Settings()
    this.styles   = new Handlers.Styles()
    this.controls = new Buttons.WindowControls()
    this.themes   = new Theme.WindowControlsThemes()
    this.theme    = this.themes.default
    this.isDark   = true

    this.signals.connect(
      Main.overview, 'showing', this._syncVisible.bind(this)
    )

    this.signals.connect(
      Main.overview, 'hiding', this._syncVisible.bind(this)
    )

    this._panelStateListener = this._syncVisible.bind(this)
    global.unite.windowManager.addPanelStateListener(this._panelStateListener)

    this.signals.connect(
      Main.panel, 'style-changed', this._onPanelStyleChange.bind(this)
    )

    this.settings.connect(
      'button-layout', this._onPositionChange.bind(this)
    )

    this.settings.connect(
      'window-buttons-placement', this._onPositionChange.bind(this)
    )

    this.settings.connect(
      'panel-layout', this._onPositionChange.bind(this)
    )

    this.settings.connect(
      'window-buttons-container', this._onPositionChange.bind(this)
    )

    this.settings.connect(
      'window-buttons-order', this._onLayoutChange.bind(this)
    )

    this.settings.connect(
      'window-buttons-theme', this._onThemeChange.bind(this)
    )

    this.settings.connect(
      'native-icon-style', this._onThemeChange.bind(this)
    )

    this.settings.connect(
      'icon-theme', this._onNativeIconThemeChange.bind(this)
    )

    this.settings.connect(
      'gtk-theme', this._onAutoThemeChange.bind(this)
    )

    this.settings.connect(
      'icon-scale-workaround', this._updateIconScaleWorkaround.bind(this, true)
    )

    Main.panel.addToStatusArea(
      'uniteWindowControls', this.controls, this.index, this.side
    )

    this.controls.syncPlacement = forceStandalone => this._onPositionChange(forceStandalone)

    this._onThemeChange()
    this._onPositionChange()
    this._syncVisible()
    Main.panel.statusArea.uniteAppMenu?.syncPlacement?.()
  }

  get gtkTheme() {
    return this.settings.get('gtk-theme')
  }

  get themeName() {
    return this.settings.get('window-buttons-theme')
  }

  get nativeIconStyle() {
    return this.settings.get('native-icon-style')
  }

  get position() {
    return this.settings.get('window-buttons-position')
  }

  get placement() {
    return getPanelPlacement(this.settings, 'window-buttons')
  }

  get combined() {
    return this.settings.get('window-buttons-container') == 'appmenu'
  }

  get workspaceCombined() {
    return this.settings.get('window-buttons-container') == 'workspace'
  }

  get buttonOrder() {
    return this.settings.get('window-buttons-order')
  }

  get iconScaleWorkaround() {
    return this.settings.get('icon-scale-workaround')
  }

  get side() {
    if (this.placement === 'default') return this.position
    if (this.placement === 'leftmost') return 'left'
    if (this.placement === 'rightmost') return 'right'
    return this.placement
  }

  get index() {
    return this.placement === 'default' ? null : 0
  }

  get sibling() {
    if (this.side == 'left') {
      return Main.panel.statusArea.uniteAppMenu || Main.panel.statusArea.activities
    } else {
      return Main.panel.statusArea.quickSettings
    }
  }

  get container() {
    return getPanelBox(this.side)
  }

  _onLayoutChange() {
    let buttons

    if (this.buttonOrder == 'left') {
      buttons = ['close', 'maximize', 'minimize']
    } else if (this.buttonOrder == 'right') {
      buttons = ['minimize', 'maximize', 'close']
    } else {
      buttons = this.settings.get('window-buttons-layout')
    }

    this.controls.addButtons(buttons)
    this._syncVisible()
  }

  _onPositionChange(forceStandalone = false) {
    const controls  = this.controls.container
    const container = controls.get_parent()
    const appmenu = Main.panel.statusArea.uniteAppMenu
    const workspace = Main.panel.statusArea.activities

    appmenu?.removeWindowControls?.()
    workspace?.removeWindowControls?.()

    controls.add_style_class_name('window-controls-container')

    if (this.combined && appmenu && !forceStandalone) {
      unregisterPanelLayoutActor('window-buttons', controls)
      this.controls.restoreContent()
      appmenu.setWindowControls(controls)
      appmenu.syncPlacement?.()
      this._onLayoutChange()
      return
    }

    if (this.workspaceCombined && workspace?.setWindowControls) {
      unregisterPanelLayoutActor('window-buttons', controls)
      workspace.setWindowControls(this.controls.content)
      this._onLayoutChange()
      return
    }

    this.controls.restoreContent()

    if (this.placement === 'default') {
      unregisterPanelLayoutActor('window-buttons', controls)

      if (container !== this.container) {
        container?.remove_child(controls)
        this.container.add_child(controls)
      }

      const sibling = this.sibling.get_parent()

      if (sibling?.get_parent() === this.container) {
        this.container.set_child_below_sibling(controls, sibling)
      } else {
        this.container.set_child_at_index(controls, -1)
      }
    } else {
      registerPanelLayoutActor('window-buttons', controls)
      syncPanelLayout(this.settings)
    }

    Main.panel.statusArea.uniteAppMenu?.syncPlacement?.()
    this._onLayoutChange()
  }

  _onThemeChange() {
    const previousThemeUuid = this.theme.uuid
    const previousThemeNative = this.theme.native || false
    this.controls.remove_style_class_name(this.theme.uuid)

    this.theme = this.themes.locate(
      this.themeName, this.gtkTheme, this.nativeIconStyle
    )
    this.styles.addShellStyle('windowButtons', this.theme.getStyle(this.isDark))

    this.controls.add_style_class_name(this.theme.uuid)

    // Icon actors need to be recreated when entering or changing a native
    // style; CSS-only themes update without rebuilding unless the scale
    // workaround is enabled.
    const shouldUpdateTheme = this.theme.uuid !== previousThemeUuid &&
      (this.iconScaleWorkaround || previousThemeNative || this.theme.native)
    this._updateIconScaleWorkaround(shouldUpdateTheme)
  }

  _onPanelStyleChange() {
    const node = Main.panel.get_theme_node()
    const dark = Theme.isColorDark(node.get_background_color())

    if (this.isDark != dark) {
      this.isDark = dark
      this._onThemeChange()
    }
  }

  _onAutoThemeChange() {
    if (this.themeName == 'auto') {
      this._onThemeChange()
    }
  }

  _onNativeIconThemeChange() {
    if (this.themeName == 'native') {
      this._onThemeChange()
      this._onLayoutChange()
    }
  }

  _syncVisible() {
    const focusApp = global.unite.panelApp

    if (focusApp && focusApp.state == Shell.AppState.RUNNING) {
      const win = global.unite.panelWindow
      this.controls.setMaximized(win?.maximized || false)
      this.controls.setVisible(win && win.showButtons)
    } else {
      this.controls.setVisible(false)
    }

    Main.panel.statusArea.uniteAppMenu?.syncLayout?.()
    Main.panel.statusArea.uniteAppMenu?.syncHoverButtons?.()
    Main.panel.statusArea.activities?.syncWindowControls?.()
  }

  _updateIconScaleWorkaround(forceLayoutChange = false) {
    this.controls.setControlThemeParams({
      actionIcons: this.theme.getActionIcons(this.isDark),
      iconScaleWorkaround: this.iconScaleWorkaround,
      nativeIcons: this.theme.native || false,
      nativeIconStyle: this.nativeIconStyle,
    })


    if (forceLayoutChange) {
      this._onLayoutChange()
    }
  }

  destroy() {
    global.unite.windowManager.removePanelStateListener(this._panelStateListener)
    this._panelStateListener = null
    this.signals.disconnectAll()
    this.settings.disconnectAll()
    this.styles.removeAll()

    unregisterPanelLayoutActor('window-buttons', this.controls.container)
    Main.panel.statusArea.uniteAppMenu?.removeWindowControls?.()
    Main.panel.statusArea.activities?.removeWindowControls?.()
    this.controls.restoreContent()
    this.controls.setHoverVisible(false)

    if (Main.panel.statusArea.uniteWindowControls === this.controls) {
      delete Main.panel.statusArea.uniteWindowControls
    }

    this.controls.destroy()
  }
}

class ExtendLeftBox extends Handlers.Feature {
  constructor() {
    // Keep the feature available so combined mode can request the extra panel
    // space even when the standalone "extend left box" option is disabled.
    super('extend-left-box', () => true)
  }

  activate() {
    this.injections = new Handlers.Injections()
    this.settings = new Handlers.Settings()
    this._allocationInjection = null

    this.settings.connect(
      'extend-left-box', this._syncEnabled.bind(this)
    )

    this.settings.connect(
      'window-buttons-container', this._syncEnabled.bind(this)
    )

    this._syncEnabled()
  }

  get enabled() {
    return this.settings.get('extend-left-box') ||
      this.settings.get('window-buttons-container') == 'appmenu'
  }

  _syncEnabled() {
    if (this.enabled && !this._allocationInjection) {
      this._allocationInjection = this.injections.vfunc(
        Main.panel, 'allocate', this._allocate.bind(this)
      )
    } else if (!this.enabled && this._allocationInjection) {
      this.injections.remove(this._allocationInjection)
      this._allocationInjection = null
    }

    Main.panel.queue_relayout()
  }

  _allocate(box) {
    Main.panel.set_allocation(box)

    const leftBox     = Main.panel._leftBox
    const centerBox   = Main.panel._centerBox
    const rightBox    = Main.panel._rightBox
    const childBox    = new Clutter.ActorBox()

    const leftWidth   = leftBox.get_preferred_width(-1)[1]
    const centerWidth = centerBox.get_preferred_width(-1)[1]
    const rightWidth  = rightBox.get_preferred_width(-1)[1]

    const allocWidth  = box.x2 - box.x1
    const allocHeight = box.y2 - box.y1
    const sideWidth   = Math.floor(allocWidth - centerWidth - rightWidth)

    const rtlTextDir  = Main.panel.get_text_direction() == Clutter.TextDirection.RTL

    childBox.y1 = 0
    childBox.y2 = allocHeight

    if (rtlTextDir) {
      childBox.x1 = allocWidth - Math.min(sideWidth, leftWidth)
      childBox.x2 = allocWidth
    } else {
      childBox.x1 = 0
      childBox.x2 = Math.min(sideWidth, leftWidth)
    }

    leftBox.allocate(childBox)

    childBox.y1 = 0
    childBox.y2 = allocHeight

    if (rtlTextDir) {
      childBox.x1 = rightWidth
      childBox.x2 = childBox.x1 + centerWidth
    } else {
      childBox.x1 = allocWidth - centerWidth - rightWidth
      childBox.x2 = childBox.x1 + centerWidth
    }

    centerBox.allocate(childBox)

    childBox.y1 = 0
    childBox.y2 = allocHeight

    if (rtlTextDir) {
      childBox.x1 = 0
      childBox.x2 = rightWidth
    } else {
      childBox.x1 = allocWidth - rightWidth
      childBox.x2 = allocWidth
    }

    rightBox.allocate(childBox)
  }

  destroy() {
    this.settings.disconnectAll()
    this.injections.removeAll()
    this._allocationInjection = null
    Main.panel.queue_relayout()
  }
}

class WorkspaceSwitcherPosition extends Handlers.Feature {
  constructor() {
    super('workspace-switcher-placement', () => true)
  }

  activate() {
    this.settings = new Handlers.Settings()
    this.signals = new Handlers.Signals()
    this.timeouts = new Handlers.Timeouts()
    this._overviewActive = Main.overview.visibleTarget
    this._workspaceSwitchActive = false
    this._overviewHideTimeout = null
    this._workspaceSwitchTimeout = null
    this._showingWorkspace = null
    this.actor = Activities.container
    this.workspaceChildren = Activities.get_children()
    this.workspaceHost = new St.BoxLayout({ clip_to_allocation: true })
    this.workspaceChildren.forEach(child => {
      Activities.remove_child(child)
      this.workspaceHost.add_child(child)
    })
    Activities.add_child(this.workspaceHost)
    Activities.workspaceHost = this.workspaceHost
    Activities.workspaceContent = this.workspaceChildren[0]
    this.originalParent = this.actor.get_parent()
    this.originalIndex = this.originalParent.get_children().indexOf(this.actor)
    this.syncPlacement = this._onPositionChange.bind(this)
    Activities.syncPlacement = this.syncPlacement
    Activities.setWindowControls = this._setWindowControls.bind(this)
    Activities.removeWindowControls = this._removeWindowControls.bind(this)
    Activities.syncWindowControls = this._syncWindowControls.bind(this)

    this.signals.connect(
      Main.overview, 'showing', this._onOverviewShowing.bind(this)
    )

    this.signals.connect(
      Main.overview, 'hiding', this._onOverviewHiding.bind(this)
    )

    this.signals.connect(
      global.window_manager, 'switch-workspace', this._onWorkspaceSwitch.bind(this)
    )

    const swipeTracker = Main.wm._workspaceAnimation?._swipeTracker
    if (swipeTracker) {
      this.signals.connect(
        swipeTracker, 'begin', this._onWorkspaceSwitch.bind(this)
      )
      this.signals.connect(
        swipeTracker, 'end', this._waitForWorkspaceAnimation.bind(this)
      )
    }

    this.settings.connect(
      'workspace-switcher-placement', this.syncPlacement
    )

    this.settings.connect(
      'panel-layout', this.syncPlacement
    )

    this._onPositionChange()
    Main.panel.statusArea.uniteWindowControls?.syncPlacement?.()
  }

  get placement() {
    return getPanelPlacement(this.settings, 'workspace-switcher')
  }

  get animationDuration() {
    return Math.max(0, this.settings.get('workspace-buttons-animation-duration'))
  }

  get animationDirection() {
    return this.settings.get('workspace-buttons-animation-direction')
  }

  _onPositionChange() {
    if (this.placement === 'default') {
      unregisterPanelLayoutActor('workspace-switcher', this.actor)
      this._restoreOriginalPosition()
      return
    }

    registerPanelLayoutActor('workspace-switcher', this.actor)
    syncPanelLayout(this.settings)
  }

  _restoreOriginalPosition() {
    const parent = this.actor.get_parent()

    if (parent !== this.originalParent) {
      parent?.remove_child(this.actor)
      this.originalParent.add_child(this.actor)
    }

    this.originalParent.set_child_at_index(this.actor, this.originalIndex)
    Main.panel.queue_relayout()
  }

  _setWindowControls(controls) {
    if (this.controls === controls) {
      return
    }

    this._removeWindowControls()
    controls.get_parent()?.remove_child(controls)
    this.workspaceHost.add_child(controls)
    this.controls = controls
    this._syncWindowControls()
  }

  _removeWindowControls() {
    if (!this.controls) {
      return
    }

    Main.panel.statusArea.uniteWindowControls?.setHoverVisible(false)
    Main.panel.statusArea.uniteWindowControls?.setWorkspaceSuppressed(false)
    this.controls.get_parent()?.remove_child(this.controls)
    this.controls = null
    this._setWorkspaceContentVisible(true)
    Activities._clickGesture?.set_enabled(true)
  }

  _setWorkspaceContentVisible(visible) {
    this.workspaceHost.get_children().forEach(child => {
      if (child !== this.controls) {
        child.visible = visible
      }
    })
  }

  _onOverviewShowing() {
    if (this._overviewHideTimeout) {
      this.timeouts.remove(this._overviewHideTimeout)
      this._overviewHideTimeout = null
    }

    this._overviewActive = true
    this._syncWindowControls()
  }

  _onOverviewHiding() {
    if (this._overviewHideTimeout) {
      this.timeouts.remove(this._overviewHideTimeout)
    }

    this._overviewHideTimeout = this.timeouts.timeout(300, () => {
      this._overviewHideTimeout = null
      this._overviewActive = false
      this._syncWindowControls()
    })
  }

  _onWorkspaceSwitch() {
    this._workspaceSwitchActive = true
    this._syncWindowControls()
    this._waitForWorkspaceAnimation()
  }

  _waitForWorkspaceAnimation() {
    if (this._workspaceSwitchTimeout) {
      return
    }

    this._workspaceSwitchTimeout = this.timeouts.interval(16, () => {
      const animation = Main.wm._workspaceAnimation
      const inProgress = Main.wm._switchInProgress || animation?._switchData != null

      if (inProgress) {
        return true
      }

      this._workspaceSwitchTimeout = null
      this._workspaceSwitchActive = false
      this._syncWindowControls()
      return false
    })
  }

  _slideControlsIn() {
    if (!this.controls) {
      return
    }

    this.controls.remove_all_transitions()
    const panelHeight = this.workspaceHost.height || Main.panel.height
    const offset = this.animationDirection == 'top' ? -panelHeight : panelHeight
    this.controls.set({
      opacity: 0,
      translation_y: offset,
    })
    this.controls.ease({
      duration: this.animationDuration,
      mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      opacity: 255,
      translation_y: 0,
    })
  }

  _syncWindowControls() {
    if (!this.controls) {
      return
    }

    const windowControls = Main.panel.statusArea.uniteWindowControls
    const showWorkspace = this._overviewActive || this._workspaceSwitchActive ||
      !windowControls?.policyVisible

    const wasShowingWorkspace = this._showingWorkspace
    this._showingWorkspace = showWorkspace
    this._setWorkspaceContentVisible(showWorkspace)
    windowControls?.setWorkspaceSuppressed(showWorkspace)

    if (showWorkspace) {
      this.controls.remove_all_transitions()
      this.controls.set({ opacity: 255, translation_y: 0 })
    } else if (wasShowingWorkspace === true) {
      this._slideControlsIn()
    }

    Activities._clickGesture?.set_enabled(showWorkspace)
    Main.panel.queue_relayout()
  }

  destroy() {
    this.settings.disconnectAll()
    this.signals.disconnectAll()
    this.timeouts.removeAll()
    unregisterPanelLayoutActor('workspace-switcher', this.actor)
    this._removeWindowControls()

    if (Activities.syncPlacement === this.syncPlacement) {
      delete Activities.syncPlacement
    }

    delete Activities.setWindowControls
    delete Activities.removeWindowControls
    delete Activities.syncWindowControls
    delete Activities.workspaceHost
    delete Activities.workspaceContent

    Activities.remove_child(this.workspaceHost)
    this.workspaceHost.get_children().forEach(child => {
      this.workspaceHost.remove_child(child)
      Activities.add_child(child)
    })
    this.workspaceHost.destroy()

    this._restoreOriginalPosition()
  }
}

class PanelItemPosition extends Handlers.Feature {
  constructor(setting, layoutId) {
    super(setting, () => true)
    this.setting = setting
    this.layoutId = layoutId
  }

  activate() {
    this.settings = new Handlers.Settings()
    this.actor = this.getActor().container
    this.originalParent = this.actor.get_parent()
    this.originalIndex = this.originalParent.get_children().indexOf(this.actor)

    this.settings.connect(this.setting, this._onPositionChange.bind(this))
    this.settings.connect('panel-layout', this._onPositionChange.bind(this))
    this._onPositionChange()
  }

  get placement() {
    return getPanelPlacement(this.settings, this.layoutId)
  }

  _onPositionChange() {
    if (this.placement === 'default') {
      unregisterPanelLayoutActor(this.layoutId, this.actor)
      this._restoreOriginalPosition()
      return
    }

    registerPanelLayoutActor(this.layoutId, this.actor)
    syncPanelLayout(this.settings)
  }

  _restoreOriginalPosition() {
    const parent = this.actor.get_parent()

    if (parent !== this.originalParent) {
      parent?.remove_child(this.actor)
      this.originalParent.add_child(this.actor)
    }

    this.originalParent.set_child_at_index(this.actor, this.originalIndex)
    Main.panel.queue_relayout()
  }

  destroy() {
    this.settings.disconnectAll()
    unregisterPanelLayoutActor(this.layoutId, this.actor)
    this._restoreOriginalPosition()
  }
}

class ClockPosition extends PanelItemPosition {
  constructor() {
    super('clock-placement', 'clock')
  }

  getActor() {
    return Main.panel.statusArea.dateMenu
  }
}

class SystemIndicatorsPosition extends PanelItemPosition {
  constructor() {
    super('system-indicators-placement', 'system-indicators')
  }

  getActor() {
    return Main.panel.statusArea.quickSettings
  }
}

class ActivitiesButton extends Handlers.Feature {
  constructor() {
    super('hide-activities-button', setting => setting != 'never')
  }

  activate() {
    this.signals  = new Handlers.Signals()
    this.settings = new Handlers.Settings()

    this.signals.connect(
      Main.overview, 'showing', this._syncVisible.bind(this)
    )

    this.signals.connect(
      Main.overview, 'hiding', this._syncVisible.bind(this)
    )

    this._panelStateListener = this._syncVisible.bind(this)
    global.unite.windowManager.addPanelStateListener(this._panelStateListener)

    this.settings.connect(
      'show-desktop-name', this._syncVisible.bind(this)
    )

    this.settings.connect(
      'window-buttons-container', this._syncVisible.bind(this)
    )

    this._syncVisible()
  }

  get hideButton() {
    return this.settings.get('hide-activities-button')
  }

  get showDesktop() {
    return this.settings.get('show-desktop-name')
  }

  get hostsWindowButtons() {
    return this.settings.get('window-buttons-container') == 'workspace'
  }

  _syncVisible() {
    const button   = Activities.container
    const overview = Main.overview.visibleTarget
    const focusApp = global.unite.panelApp

    if (this.hostsWindowButtons) {
      button.show()
      Activities.syncWindowControls?.()
      return
    }

    if (this.hideButton == 'always') {
      return button.hide()
    }

    if (this.showDesktop) {
      button.visible = overview
    } else {
      button.visible = overview || focusApp == null
    }

    Main.panel.statusArea.uniteAppMenu?.syncPlacement?.()
  }

  destroy() {
    global.unite.windowManager.removePanelStateListener(this._panelStateListener)
    this._panelStateListener = null

    if (!Main.overview.isDummy) {
      Activities.container.show()
    }

    this.signals.disconnectAll()
    this.settings.disconnectAll()
  }
}

class ActivitiesText extends Handlers.Feature {
  constructor() {
    super('use-activities-text', setting => setting == true)
  }

  activate() {
    this.label = new St.Label({ y_align: Clutter.ActorAlign.CENTER })
    this.label.set_text(Activities.get_accessible_name())

    this.switcher = Activities.workspaceContent || Activities.get_first_child()
    this.contentHost = Activities.workspaceHost || Activities
    this.contentHost.remove_child(this.switcher)
    this.contentHost.add_child(this.label)
    Activities.workspaceContent = this.label
    Activities.syncWindowControls?.()
  }

  destroy() {
    this.contentHost.remove_child(this.label)
    this.label.destroy()

    this.contentHost.add_child(this.switcher)
    Activities.workspaceContent = this.switcher
    Activities.syncWindowControls?.()
    this.switcher = null
    this.contentHost = null
  }
}

class DesktopName extends Handlers.Feature {
  constructor() {
    super('show-desktop-name', setting => setting == true)
  }

  activate() {
    this.signals  = new Handlers.Signals()
    this.settings = new Handlers.Settings()
    this.label    = new Buttons.DesktopLabel()

    this.signals.connect(
      Main.overview, 'showing', this._syncVisible.bind(this)
    )

    this.signals.connect(
      Main.overview, 'hiding', this._syncVisible.bind(this)
    )

    this._panelStateListener = this._syncVisible.bind(this)
    global.unite.windowManager.addPanelStateListener(this._panelStateListener)

    this.settings.connect(
      'desktop-name-text', this._onTextChanged.bind(this)
    )

    Main.panel.addToStatusArea(
      'uniteDesktopLabel', this.label, 1, 'left'
    )

    this._onTextChanged()
    this._syncVisible()
  }

  _syncVisible() {
    const focusApp = global.unite.panelApp

    this.label.setVisible(focusApp == null)
    Main.panel.statusArea.uniteAppMenu?.syncPlacement?.()
  }

  _onTextChanged() {
    const text = this.settings.get('desktop-name-text')
    this.label.setText(text)
  }

  destroy() {
    global.unite.windowManager.removePanelStateListener(this._panelStateListener)
    this._panelStateListener = null
    this.signals.disconnectAll()
    this.settings.disconnectAll()

    this.label.destroy()
  }
}

class TrayIcons extends Handlers.Feature {
  constructor() {
    super('show-legacy-tray', setting => setting == true)
  }

  activate() {
    this.tray       = new Shell.TrayManager()
    this.settings   = new Handlers.Settings()
    this.indicators = new Buttons.TrayIndicator()

    this.tray.connect(
      'tray-icon-added', this._onIconAdded.bind(this)
    )

    this.tray.connect(
      'tray-icon-removed', this._onIconRemoved.bind(this)
    )

    this.settings.connect(
      'greyscale-tray-icons', this._onGreyscaleChange.bind(this)
    )

    Main.panel.addToStatusArea(
      'uniteTrayIndicator', this.indicators, 0, 'right'
    )

    this.tray.manage_screen(Main.panel)
  }

  _desaturateIcon(icon) {
    const greyscale = this.settings.get('greyscale-tray-icons')
    icon.clear_effects()

    if (greyscale) {
      const desEffect = new Clutter.DesaturateEffect({ factor : 1.0 })
      const briEffect = new Clutter.BrightnessContrastEffect({})

      briEffect.set_brightness(0.2)
      briEffect.set_contrast(0.3)

      icon.add_effect_with_name('desaturate', desEffect)
      icon.add_effect_with_name('brightness-contrast', briEffect)
    }
  }

  _onIconAdded(trayManager, icon) {
    this.indicators.addIcon(icon)
    this._desaturateIcon(icon)
  }

  _onIconRemoved(trayManager, icon) {
    this.indicators.removeIcon(icon)
  }

  _onGreyscaleChange() {
    this.indicators.forEach(this._desaturateIcon.bind(this))
  }

  destroy() {
    this.tray = null
    System.gc()

    this.indicators.destroy()
    this.settings.disconnectAll()
  }
}

class TitlebarActions extends Handlers.Feature {
  constructor() {
    super('enable-titlebar-actions', setting => setting == true)
  }

  activate() {
    this.signals  = new Handlers.Signals()
    this.settings = new Handlers.Settings()

    this.signals.connect(
      Main.panel, 'button-press-event', this._onButtonPressEvent.bind(this)
    )
  }

  _onButtonPressEvent(actor, event) {
    if (Main.modalCount > 0 || event.get_source() != null) {
      return Clutter.EVENT_PROPAGATE
    }

    const focusWindow = global.unite.focusWindow

    if (!focusWindow || !focusWindow.hideTitlebars) {
      return Clutter.EVENT_PROPAGATE
    }

    const ccount = event.get_click_count && event.get_click_count()
    const button = event.get_button()

    let action = null

    if (button == 1 && ccount == 2) {
      action = this.settings.get('action-double-click-titlebar')
    }

    if (button == 2) {
      action = this.settings.get('action-middle-click-titlebar')
    }

    if (button == 3) {
      action = this.settings.get('action-right-click-titlebar')
    }

    if (action == 'menu') {
      return this._openWindowMenu(focusWindow.win, event.get_coords()[0])
    }

    if (action && action != 'none') {
      return this._handleClickAction(action, focusWindow)
    }

    return Clutter.EVENT_PROPAGATE
  }

  _handleClickAction(action, win) {
    const mapping = {
      'toggle-maximize':              'maximize',
      'toggle-maximize-horizontally': 'maximizeX',
      'toggle-maximize-vertically':   'maximizeY',
      'minimize':                     'minimize',
      'lower':                        'lower'
    }

    const method = win[mapping[action]]

    if (typeof method !== 'function') {
      return Clutter.EVENT_PROPAGATE
    }

    method.call(win)
    return Clutter.EVENT_STOP
  }

  _openWindowMenu(win, x) {
    const rect = this._menuPositionRect(x)
    const type = Meta.WindowMenuType.WM

    Main.wm._windowMenuManager.showWindowMenuForWindow(win, type, rect)
    return Clutter.EVENT_STOP
  }

  _menuPositionRect(x) {
    const size = Main.panel.height
    return { x: x - size, y: 0, width: size * 2, height: size }
  }

  destroy() {
    this.signals.disconnectAll()
    this.settings.disconnectAll()
  }
}

export const PanelManager = GObject.registerClass(
  class UnitePanelManager extends GObject.Object {
    _init() {
      this.features = new Handlers.Features()

      this.features.add(PanelLayoutManager)
      this.features.add(AppmenuButton)
      this.features.add(WindowButtons)
      this.features.add(ExtendLeftBox)
      this.features.add(WorkspaceSwitcherPosition)
      this.features.add(ClockPosition)
      this.features.add(SystemIndicatorsPosition)
      this.features.add(ActivitiesButton)
      this.features.add(ActivitiesText)
      this.features.add(DesktopName)
      this.features.add(TrayIcons)
      this.features.add(TitlebarActions)
    }

    activate() {
      this.features.activate()
    }

    destroy() {
      this.features.destroy()
    }
  }
)
