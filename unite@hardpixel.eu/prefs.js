import Adw from 'gi://Adw'
import Gdk from 'gi://Gdk'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Gtk from 'gi://Gtk'
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'
import * as Theme from './theme.js'
import * as Convenience from './convenience.js'

const PANEL_ITEMS = [
  ['app-menu', 'Application Menu'],
  ['workspace-switcher', 'Workspace Switcher'],
  ['window-buttons', 'Window Buttons'],
  ['clock', 'Clock'],
  ['system-indicators', 'System Indicators'],
]

const PANEL_LANES = [
  ['default', 'Default'],
  ['leftmost', 'Leftmost'],
  ['left', 'Left'],
  ['center', 'Center'],
  ['right', 'Right'],
  ['rightmost', 'Rightmost'],
]

class UnitePreferencesWidget {
  constructor() {
    this._settings  = Convenience.getSettings()
    this._buildable = new Gtk.Builder()
    this._themes    = new Theme.WindowControlsThemes()

    this._loadTemplate()
    this._loadThemes()
    this._loadPanelLayout()

    this._bindStrings()
    this._bindSelects()
    this._bindBooleans()
    this._bindEnumerations()
    this._bindIntegers()
    this._bindDependencies()
  }

  _loadTemplate() {
    const template = GLib.build_filenamev([Convenience.getPath(), 'settings.ui'])
    this._buildable.add_from_file(template)
  }

  _loadThemes() {
    const widget = this._getWidget('window-buttons-theme')
    const themes = this._themes.available.sort((a, b) => {
      return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0
    })

    themes.forEach(theme => {
      if (theme.uuid !== 'default') {
        widget.append(theme.uuid, theme.name)
      }
    })
  }

  _loadPanelLayout() {
    const group = this._getWidget('panel-layout-group')
    const layout = this._settings.get_strv('panel-layout')
    const configured = new Map()
    const ordered = []

    layout.forEach(entry => {
      const [id, lane] = entry.split(':')
      const knownItem = PANEL_ITEMS.some(([itemId]) => itemId === id)
      const knownLane = PANEL_LANES.some(([laneId]) => laneId === lane)

      if (knownItem && knownLane && !configured.has(id)) {
        configured.set(id, lane)
        ordered.push(id)
      }
    })

    PANEL_ITEMS.forEach(([id]) => {
      if (!ordered.includes(id)) ordered.push(id)
    })

    this._panelLayout = new Gtk.ListBox({
      selection_mode: Gtk.SelectionMode.NONE,
      css_classes: ['boxed-list'],
    })
    this._panelLayoutRows = new Map()

    ordered.forEach(id => {
      const item = PANEL_ITEMS.find(([itemId]) => itemId === id)
      if (!item) return

      const row = this._createPanelLayoutRow(
        id, item[1], configured.get(id) || 'default'
      )
      this._panelLayout.append(row)
      this._panelLayoutRows.set(id, row)
    })

    group.add(this._panelLayout)

    const syncWindowButtons = () => {
      const standalone = this._settings.get_string('window-buttons-container') === 'separate'
      this._panelLayoutRows.get('window-buttons')?.set_visible(standalone)
    }

    this._settings.connect('changed::window-buttons-container', syncWindowButtons)
    syncWindowButtons()
  }

  _createPanelLayoutRow(id, title, lane) {
    const row = new Gtk.ListBoxRow()
    row.panelItemId = id

    const content = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 12,
      margin_top: 8,
      margin_bottom: 8,
      margin_start: 12,
      margin_end: 12,
    })
    const handle = new Gtk.Image({
      icon_name: 'list-drag-handle-symbolic',
      tooltip_text: 'Drag to reorder',
      valign: Gtk.Align.CENTER,
    })
    const label = new Gtk.Label({
      label: title,
      xalign: 0,
      hexpand: true,
    })
    const lanes = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })

    PANEL_LANES.forEach(([laneId, laneTitle]) => lanes.append(laneId, laneTitle))
    lanes.set_active_id(lane)
    lanes.connect('changed', () => this._savePanelLayout())

    content.append(handle)
    content.append(label)
    content.append(lanes)
    row.set_child(content)

    const drag = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE })
    drag.connect('prepare', () => {
      const value = new GObject.Value()
      value.init(GObject.TYPE_STRING)
      value.set_string(id)
      return Gdk.ContentProvider.new_for_value(value)
    })
    handle.add_controller(drag)

    const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE)
    drop.connect('drop', (target, sourceId, x, y) => {
      return this._movePanelLayoutRow(sourceId, id, y > row.get_height() / 2)
    })
    row.add_controller(drop)
    row.panelLane = lanes

    return row
  }

  _movePanelLayoutRow(sourceId, targetId, after) {
    if (sourceId === targetId || !this._panelLayoutRows.has(sourceId)) {
      return false
    }

    const source = this._panelLayoutRows.get(sourceId)
    const target = this._panelLayoutRows.get(targetId)
    let targetIndex = target.get_index() + (after ? 1 : 0)

    if (source.get_index() < targetIndex) targetIndex--
    this._panelLayout.remove(source)
    this._panelLayout.insert(source, targetIndex)
    this._savePanelLayout()
    return true
  }

  _savePanelLayout() {
    const layout = []

    for (let index = 0; ; index++) {
      const row = this._panelLayout.get_row_at_index(index)
      if (!row) break
      layout.push(`${row.panelItemId}:${row.panelLane.get_active_id()}`)
    }

    this._settings.set_strv('panel-layout', layout)
  }

  _getWidget(name) {
    let widgetName = name.replace(/-/g, '_')
    return this._buildable.get_object(widgetName)
  }

  _bindInput(setting, prop) {
    let widget = this._getWidget(setting)
    this._settings.bind(setting, widget, prop, this._settings.DEFAULT_BINDING)
  }

  _bindEnum(setting) {
    let widget = this._getWidget(setting)
    widget.set_active(this._settings.get_enum(setting))

    widget.connect('changed', combobox => {
      this._settings.set_enum(setting, combobox.get_active())
    })
  }

  _bindStrings() {
    let settings = this._settings.getTypeSettings('string')
    settings.forEach(setting => this._bindInput(setting, 'text'))
  }

  _bindSelects() {
    let settings = this._settings.getTypeSettings('select')
    settings.forEach(setting => this._bindInput(setting, 'active-id'))
  }

  _bindBooleans() {
    let settings = this._settings.getTypeSettings('boolean')
    settings.forEach(setting => this._bindInput(setting, 'active'))
  }

  _bindEnumerations() {
    let settings = this._settings.getTypeSettings('enum')
    settings.forEach(setting => this._bindEnum(setting))
  }

  _bindIntegers() {
    let settings = this._settings.getTypeSettings('int')
    settings.forEach(setting => this._bindInput(setting, 'value'))
  }

  _bindDependencies() {
    const revealRow = this._getWidget('reveal-window-buttons-on-hover-row')
    const delayRow = this._getWidget('window-buttons-hover-delay-row')
    const nativeStyleRow = this._getWidget('native-icon-style-row')
    const workspaceAnimationRows = [
      this._getWidget('workspace-buttons-animation-duration-row'),
      this._getWidget('workspace-buttons-animation-direction-row'),
    ]
    const appMenuPlacementRow = this._getWidget('app-menu-placement-row')

    const syncHoverButtonOptions = () => {
      const combined = this._settings.get_string('window-buttons-container') === 'appmenu'
      const buttonsMode = this._settings.get_string('show-window-buttons')
      const enabled = this._settings.get_boolean('reveal-window-buttons-on-hover')
      const available = combined && buttonsMode != 'always'

      revealRow.set_sensitive(available)
      delayRow.set_sensitive(available && enabled)
    }

    const syncNativeIconOptions = () => {
      nativeStyleRow.set_sensitive(
        this._settings.get_string('window-buttons-theme') === 'native'
      )
    }

    const syncWorkspaceAnimationOptions = () => {
      const enabled = this._settings.get_string('window-buttons-container') === 'workspace'
      workspaceAnimationRows.forEach(row => row.set_sensitive(enabled))
    }

    const syncAppMenuPlacementOption = () => {
      appMenuPlacementRow.set_sensitive(
        this._settings.get_string('window-buttons-container') === 'appmenu'
      )
    }

    this._settings.connect(
      'changed::window-buttons-container', syncHoverButtonOptions
    )
    this._settings.connect(
      'changed::show-window-buttons', syncHoverButtonOptions
    )
    this._settings.connect(
      'changed::reveal-window-buttons-on-hover', syncHoverButtonOptions
    )
    this._settings.connect(
      'changed::window-buttons-theme', syncNativeIconOptions
    )
    this._settings.connect(
      'changed::window-buttons-container', syncWorkspaceAnimationOptions
    )
    this._settings.connect(
      'changed::window-buttons-container', syncAppMenuPlacementOption
    )

    syncHoverButtonOptions()
    syncNativeIconOptions()
    syncWorkspaceAnimationOptions()
    syncAppMenuPlacementOption()
  }
}

export default class UnitePreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const widget = new UnitePreferencesWidget()

    window.add(widget._getWidget('general_page'))
    window.add(widget._getWidget('layout_page'))
    window.add(widget._getWidget('windows_page'))

    window.set_default_size(620, 660)
  }
}
