import GObject from 'gi://GObject'
import St from 'gi://St'
import Clutter from 'gi://Clutter'
import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js'
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js'
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'
import * as Animation from './animation.js'

export const AppmenuLabel = GObject.registerClass(
  class UniteAppmenuLabel extends PanelMenu.Button {
    _init(text) {
      super._init(0.0, null, true)

      const bin = new St.Bin({ name: 'appMenu' })
      this.add_child(bin)

      this.bind_property('reactive', this, 'can-focus', 0)
      this.reactive = false

      this._container = new St.BoxLayout({ style_class: 'panel-status-menu-box' })
      bin.set_child(this._container)

      this._icon = new St.Icon()
      this._icon.set_icon_size(16)
      this._icon.set_fallback_gicon(null)

      this._iconBox = new St.Bin({ style_class: 'app-menu-icon', y_align: Clutter.ActorAlign.CENTER })
      this._iconBox.set_child(this._icon)
      this._container.add_child(this._iconBox)

      this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER })
      this._container.add_child(this._label)

      this._spinner = new Animation.Spinner(14, { animate: true, hideOnStop: true })
      this._container.add_child(this._spinner)
      this._hiddenIcon = false
      this._compact = false
      this._loading = false

      const menu = new AppMenu(this)
      this.setMenu(menu)

      // GNOME Shell 49+ opens PanelMenu buttons through a ClickGesture.  That
      // gesture also claims clicks from descendant actors, which breaks the
      // window-control buttons when they are embedded in this appmenu actor.
      // Give only the icon and title their own menu gestures below, leaving
      // the embedded controls outside every menu-opening gesture.
      this._clickGesture?.set_enabled(false)

      this._menuClickGestures = [this._iconBox, this._label].map(actor => {
        const gesture = new Clutter.ClickGesture()
        gesture.set_recognize_on_press(true)
        gesture.connect('recognize', () => this.menu?.toggle())
        actor.add_action(gesture)
        actor.reactive = true

        return gesture
      })

      this._titleItem = new PopupMenu.PopupMenuItem('')
      this._titleItem.connect('activate', () => {
        const title = this._label.get_text()

        St.Clipboard.get_default().set_text(
          St.ClipboardType.CLIPBOARD,
          title
        )
        Main.notify(_('Copied to clipboard'), title)
      })
      menu.addMenuItem(this._titleItem, 0)

      this._forceCloseItem = new PopupMenu.PopupMenuItem(_('Force Close'))
      this._forceCloseItem.connect('activate', this._confirmForceClose.bind(this))

      const quitIndex = menu._getMenuItems().indexOf(menu._quitItem)
      menu.addMenuItem(this._forceCloseItem, quitIndex)

      this._menuManager = Main.panel.menuManager
      this._menuManager.addMenu(menu)

      this._iconEffect = new Clutter.DesaturateEffect({ factor: 1.0 })
      this._iconEffect.enabled = false
      this._iconBox.add_effect(this._iconEffect)

      this.setText(text || '')
      this.add_style_class_name('app-menu-label')
      this._syncVisibility()
    }

    setApp(app) {
      this.setIcon(app.get_icon())
      this.setText(app.get_name())
      this.menu.setApp(app)
    }

    setIcon(icon) {
      this._icon.set_gicon(icon)
    }

    setGreyscale(greyscale) {
      this._iconEffect.enabled = greyscale
    }

    _confirmForceClose() {
      const target = global.unite.panelWindow

      if (!target || this._forceCloseDialog) {
        return
      }

      const appName = target.app?.get_name() || target.title
      const dialog = new ModalDialog.ModalDialog({ styleClass: 'prompt-dialog' })
      const content = new Dialog.MessageDialogContent({
        title: _('Force Close “%s”?').format(appName),
        description: _('The application will close immediately. Any unsaved work will be lost.'),
      })

      dialog.contentLayout.add_child(content)
      dialog.setButtons([{
        label: _('Cancel'),
        action: () => dialog.close(),
        key: Clutter.KEY_Escape,
        default: true,
      }, {
        label: _('Force Close'),
        action: () => {
          dialog.close()
          target.win.kill()
        },
      }])

      dialog.connect('closed', () => {
        if (this._forceCloseDialog === dialog) {
          this._forceCloseDialog = null
        }
      })
      target.win.connectObject('unmanaged', () => dialog.close(), dialog)

      this._forceCloseDialog = dialog

      if (!dialog.open()) {
        this._forceCloseDialog = null
        dialog.destroy()
      }
    }

    setText(text) {
      this._label.set_text(text)
      this._titleItem?.label.set_text(text)
      this.syncLayout?.()
    }

    setReactive(reactive) {
      this.reactive = reactive
      this._menuClickGestures?.forEach(gesture => gesture.set_enabled(reactive))
    }

    setVisible(visible) {
      if (this.container.visible != visible) {
        this.container.visible = visible
        this.set_hover(false)
      }
    }

    toggleIcon(hidden) {
      this._hiddenIcon = hidden
      this._syncVisibility()
    }

    setWindowControls(controls) {
      if (this._windowControls === controls) {
        return
      }

      this.removeWindowControls()

      if (controls) {
        controls.get_parent()?.remove_child(controls)
        this._container.insert_child_below(controls, this._label)
        this._windowControls = controls
      }
    }

    removeWindowControls() {
      if (this._windowControls?.get_parent() === this._container) {
        this._container.remove_child(this._windowControls)
      }

      this._windowControls = null
    }

    setCompact(compact) {
      this._compact = compact
      this._syncVisibility()
    }

    measureFullWidth() {
      const iconVisible = this._iconBox.visible
      const labelVisible = this._label.visible
      const spinnerVisible = this._spinner.visible

      this._iconBox.visible = true
      this._label.visible = true
      this._spinner.visible = this._loading

      const width = this._container.get_preferred_width(-1)[1]

      this._iconBox.visible = iconVisible
      this._label.visible = labelVisible
      this._spinner.visible = spinnerVisible

      return width
    }

    _syncVisibility() {
      this._iconBox.visible = !this._hiddenIcon || this._compact
      this._label.visible = !this._compact
      this._spinner.visible = !this._compact && this._loading
    }

    stopAnimation() {
      this._loading = false
      this._spinner.stop()
      this._syncVisibility()
    }

    startAnimation() {
      this._loading = true
      this._spinner.play()
      this._syncVisibility()
    }

    _onDestroy() {
      this._forceCloseDialog?.close()
      this._forceCloseDialog = null

      if (this.menu) {
        this._menuManager.removeMenu(this.menu)
        this._menuManager = null

        this.menu.setApp(null)
        this.setMenu(null)
      }

      super._onDestroy()
    }
  }
)

export const DesktopLabel = GObject.registerClass(
  class UniteDesktopLabel extends PanelMenu.Button {
    _init(text) {
      super._init(0.0, null, true)

      this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER })
      this.add_child(this._label)

      this.reactive = false
      this.label_actor = this._label

      this.setText(text || 'Desktop')
      this.add_style_class_name('desktop-name-label')
    }

    setText(text) {
      this._label.set_text(text)
    }

    setVisible(visible) {
      this.container.visible = visible
    }
  }
)

export const TrayIndicator = GObject.registerClass(
  class UniteTrayIndicator extends PanelMenu.Button {
    _init() {
      this._icons = []
      super._init(0.0, null, true)

      this._indicators = new St.BoxLayout({ style_class: 'panel-status-indicators-box' })
      this.add_child(this._indicators)

      this.add_style_class_name('system-tray-icons')
      this._sync()
    }

    _sync() {
      this.visible = this._icons.length > 0
    }

    addIcon(icon) {
      this._icons.push(icon)

      const mask = St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE
      const ibtn = new St.Button({ child: icon, button_mask: mask })

      this._indicators.add_child(ibtn)

      ibtn.clear_actions()
      icon.connect('destroy', () => { ibtn.destroy() })
      ibtn.connect('button-release-event', (actor, event) => icon.click(event))

      icon.set_reactive(true)
      icon.set_x_align(Clutter.ActorAlign.CENTER)
      icon.set_y_align(Clutter.ActorAlign.CENTER)

      this._sync()
    }

    removeIcon(icon) {
      const actor = icon.get_parent() || icon
      actor.destroy()

      const index = this._icons.indexOf(icon)
      this._icons.splice(index, 1)

      this._sync()
    }

    forEach(callback) {
      this._icons.forEach(icon => callback.call(null, icon))
    }
  }
)

export const WindowControls = GObject.registerClass(
  class UniteWindowControls extends PanelMenu.Button {
    _init() {
      super._init(0.0, null, true)

      // This actor is only a panel-compatible wrapper around the real
      // St.Button controls.  Its PanelMenu click gesture must not claim
      // pointer sequences from those child buttons.
      this._clickGesture?.set_enabled(false)

      this._controls = new St.BoxLayout({ style_class: 'window-controls-box' })
      this.add_child(this._controls)

      this.add_style_class_name('window-controls')
      this.remove_style_class_name('panel-button')
    }

    setControlThemeParams(params) {
      this._actionIcons = params.actionIcons
      this._iconScaleWorkaround = params.iconScaleWorkaround
    }

    _addButton(action) {
      const pos = Clutter.ActorAlign.CENTER
      const bin = new St.Bin({ style_class: 'icon', x_align: pos, y_align: pos })
      const btn = new St.Button({ track_hover: true })

      if (this._iconScaleWorkaround) {
        // A workaround for multi-scaling setups https://github.com/hardpixel/unite-shell/issues/106
        const gicon = this._actionIcons[action];
        const icon = new St.Icon({
          x_align: pos,
          y_align: pos,
          gicon: gicon.default,
        })
        btn.connect(
          'notify::hover', () => void icon.set_gicon(btn.hover ? gicon.hover : gicon.default)
        )
        btn.connect(
          'notify::pressed', () => void icon.set_gicon(btn.pressed ? gicon.active : gicon.default)
        )
        bin.set_child(icon)
        // Add only root class name for button sizing
        btn.add_style_class_name('window-button')
      } else {
        // Normal approach with CSS-based icons
        btn.add_style_class_name(`window-button ${action}`)
      }

      btn.set_child(bin)

      btn.connect('clicked', () => {
        const target = global.unite.panelWindow
        const method = target && target[action]

        method && method.call(target)
      })

      this._controls.add_child(btn)
    }

    addButtons(buttons) {
      this._controls.destroy_all_children()
      buttons && buttons.forEach(this._addButton.bind(this))
    }

    setVisible(visible) {
      this.container.visible = visible
    }
  }
)
