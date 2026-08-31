import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Gio from 'gi://Gio'
import * as Convenience from './convenience.js'

const THEME_DIRS = [
  GLib.build_filenamev([Convenience.getPath(), 'themes']),
  GLib.build_filenamev([GLib.get_user_data_dir(), 'unite-shell/themes'])
]

const NATIVE_ICON_NAMES = {
  close: 'window-close-symbolic',
  minimize: 'window-minimize-symbolic',
  maximize: 'window-maximize-symbolic',
  unmaximize: ['window-restore-symbolic', 'window-maximize-symbolic']
}

function fileExists(path) {
  return GLib.file_test(path, GLib.FileTest.EXISTS)
}

export function isColorDark({ red, green, blue }) {
  // HSP equation from http://alienryderflex.com/hsp.html
  const hsp = Math.sqrt(
    0.299 * (red * red) +
    0.587 * (green * green) +
    0.114 * (blue * blue)
  )

  return hsp < 127.6
}

export class WindowControlsTheme {
  constructor(uuid, path) {
    this.uuid = uuid
    this.keys = new GLib.KeyFile()
    this._gicons = null

    try {
      const theme = GLib.build_filenamev([path, 'unite.theme'])
      this.keys.load_from_file(theme, GLib.KeyFileFlags.NONE)

      const dark  = this.keys.get_string('Dark', 'Style')
      const light = this.keys.get_string('Light', 'Style')

      this.name  = this.keys.get_string('Theme', 'Name')
      this.dark  = GLib.build_filenamev([path, dark])
      this.light = GLib.build_filenamev([path, light])

      this.valid = fileExists(this.dark) && fileExists(this.light)

      this.darkIconsDir  = GLib.path_get_dirname(this.dark)
      this.lightIconsDir = GLib.path_get_dirname(this.light)
    } catch (e) {
      this.valid = false
    }
  }

  getActionIcons(dark = true) {
    const dir = dark ? this.darkIconsDir : this.lightIconsDir
    if (!this._gicons) {
      this._gicons = {
        close:    getActionIconStates(dir, 'close'),
        minimize: getActionIconStates(dir, 'minimize'),
        maximize: getActionIconStates(dir, 'maximize'),
        unmaximize: getActionIconStates(dir, 'unmaximize', 'maximize')
      }
    }

    return this._gicons
  }

  getStyle(dark = true) {
    return dark ? this.dark : this.light
  }

  match(gtkTheme) {
    return gtkTheme == this.name || gtkTheme.startsWith(`${this.name}-`)
  }
}

class NativeWindowControlsTheme {
  constructor(style = 'gtk3') {
    this.uuid = `native-${style}`
    this.name = 'Native'
    this.native = true
    this.style = style
  }

  getActionIcons() {
    return Object.fromEntries(Object.entries(NATIVE_ICON_NAMES).map(([action, name]) => {
      const icon = Array.isArray(name)
        ? Gio.ThemedIcon.new_from_names(name)
        : Gio.ThemedIcon.new(name)
      return [action, { default: icon, hover: icon, active: icon }]
    }))
  }

  getStyle() {
    return GLib.build_filenamev([
      Convenience.getPath(), 'themes', 'native', `${this.style}.css`
    ])
  }
}

export class WindowControlsThemes {
  constructor() {
    this.themes = {}
    this.update()
  }

  get available() {
    return Object.values(this.themes)
  }

  get default() {
    return this.themes['default']
  }

  forEach(callback) {
    this.available.forEach(callback)
  }

  get(name) {
    return this.themes[name] || this.default
  }

  match(gtkTheme) {
    return this.available.find(theme => theme.match(gtkTheme)) || this.default
  }

  locate(btnTheme, gtkTheme, nativeStyle = 'gtk3') {
    if (btnTheme == 'auto') {
      return this.match(gtkTheme)
    } else if (btnTheme == 'native') {
      return new NativeWindowControlsTheme(nativeStyle)
    } else {
      return this.get(btnTheme)
    }
  }

  update() {
    THEME_DIRS.filter(fileExists).forEach(pathName => {
      const path = Gio.File.new_for_path(pathName)
      const data = path.enumerate_children(
        Gio.FILE_ATTRIBUTE_STANDARD_NAME,
        Gio.FileQueryInfoFlags.NONE,
        null
      )

      while (true) {
        const info = data.next_file(null)
        if (!info) break

        const uuid = info.get_name()
        const path = GLib.build_filenamev([pathName, uuid])
        const item = new WindowControlsTheme(uuid, path)

        if (item.valid) {
          this.themes[uuid] = item
        }
      }

      data.close(null)
    })
  }
}

function getActionIconStates(iconsPath, action, fallbackAction = action) {
  const getGIcon = (state) => {
    const statePostfix = state ? `-${state}` : ''
    let iconPath = GLib.build_filenamev([iconsPath, `${action}${statePostfix}.svg`])

    if (!fileExists(iconPath)) {
      iconPath = GLib.build_filenamev([
        iconsPath, `${fallbackAction}${statePostfix}.svg`
      ])
    }

    return Gio.icon_new_for_string(iconPath)
  }

  return {
    default: getGIcon(),
    hover: getGIcon('hover'),
    active: getGIcon('active')
  }
}
