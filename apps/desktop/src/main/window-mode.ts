import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { AppWindowMode, AppWindowState } from '@remind-me/contracts'
import {
  fitWindowBounds,
  glanceBoundsForWorkArea,
  widgetBoundsForWorkArea
} from './window-geometry'

const fullMinimumWidth = 920
const fullMinimumHeight = 640

export class WindowModeController {
  private mode: AppWindowMode = 'full'
  private pinned = false
  private fullBounds: Rectangle | null = null
  private fullWasMaximized = false

  constructor(private readonly window: BrowserWindow) {}

  getState(): AppWindowState {
    const bounds = this.window.getBounds()
    return {
      mode: this.mode,
      pinned: this.pinned,
      width: bounds.width,
      height: bounds.height
    }
  }

  setMode(mode: AppWindowMode): AppWindowState {
    if (mode === this.mode) return this.getState()
    if (mode === 'full') this.enterFullApp()
    else this.enterCompact(mode)
    return this.getState()
  }

  setPinned(pinned: boolean): AppWindowState {
    if (this.mode === 'full') return this.getState()
    this.pinned = pinned
    this.window.setAlwaysOnTop(pinned, 'floating')
    return this.getState()
  }

  private enterCompact(mode: Extract<AppWindowMode, 'widget' | 'glance'>): void {
    if (this.mode === 'full') {
      this.fullWasMaximized = this.window.isMaximized()
      this.fullBounds = this.fullWasMaximized
        ? this.window.getNormalBounds()
        : this.window.getBounds()
      if (this.fullWasMaximized) this.window.unmaximize()
    }
    const display = screen.getDisplayMatching(this.window.getBounds())
    const bounds =
      mode === 'glance'
        ? glanceBoundsForWorkArea(display.workArea)
        : widgetBoundsForWorkArea(display.workArea)
    this.window.setMinimumSize(
      Math.min(mode === 'glance' ? 272 : 340, bounds.width),
      Math.min(mode === 'glance' ? 228 : 480, bounds.height)
    )
    this.window.setResizable(mode === 'widget')
    this.window.setMaximizable(false)
    this.window.setFullScreenable(false)
    this.window.setBounds(bounds)
    this.window.setSkipTaskbar(true)
    this.window.setMenuBarVisibility(false)
    if (process.platform === 'darwin') {
      this.window.setHiddenInMissionControl(true)
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    this.window.setAlwaysOnTop(true, 'floating')
    this.window.setTitle(mode === 'glance' ? 'Remind Me · Glance' : 'Remind Me · Mini view')
    this.mode = mode
    this.pinned = true
    this.window.show()
  }

  private enterFullApp(): void {
    this.window.setAlwaysOnTop(false)
    this.window.setSkipTaskbar(false)
    this.window.setMenuBarVisibility(process.platform !== 'win32')
    this.window.setResizable(true)
    this.window.setMaximizable(true)
    this.window.setFullScreenable(true)
    this.window.setMinimumSize(fullMinimumWidth, fullMinimumHeight)
    if (process.platform === 'darwin') {
      this.window.setHiddenInMissionControl(false)
      this.window.setVisibleOnAllWorkspaces(false)
    }
    if (this.fullBounds) {
      const display = screen.getDisplayMatching(this.fullBounds)
      this.window.setBounds(
        fitWindowBounds(this.fullBounds, display.workArea, fullMinimumWidth, fullMinimumHeight)
      )
    }
    if (this.fullWasMaximized) this.window.maximize()
    this.window.setTitle('Remind Me')
    this.mode = 'full'
    this.pinned = false
    this.window.show()
    this.window.focus()
  }
}
