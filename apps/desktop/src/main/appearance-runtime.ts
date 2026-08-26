import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { release as osRelease } from 'node:os'
import type { PreferencesEntity } from '@remind-me/contracts'

export interface AppearanceSupport {
  nativeBackdrop: boolean
  transparentWindow: boolean
  windowControlsOverlay: boolean
  label: string
}

export function getAppearanceSupport(
  platform: NodeJS.Platform = process.platform,
  release = osRelease()
): AppearanceSupport {
  if (platform === 'darwin') {
    return {
      nativeBackdrop: true,
      transparentWindow: true,
      windowControlsOverlay: false,
      label: 'Live macOS vibrancy'
    }
  }
  if (platform === 'win32') {
    const build = Number(release.split('.')[2] ?? 0)
    if (build >= 22_621) {
      return {
        nativeBackdrop: true,
        transparentWindow: true,
        windowControlsOverlay: true,
        label: 'Live Windows transparency + Acrylic'
      }
    }
    return {
      nativeBackdrop: false,
      transparentWindow: true,
      windowControlsOverlay: true,
      label: 'Live Windows transparency'
    }
  }
  return {
    nativeBackdrop: false,
    transparentWindow: false,
    windowControlsOverlay: false,
    label: 'Cross-platform CSS glass'
  }
}

export function backgroundMaterialFor(
  preferences: PreferencesEntity,
  support = getAppearanceSupport()
): 'none' | 'mica' | 'acrylic' {
  if (!support.nativeBackdrop || preferences.surfaceStyle === 'paper') return 'none'
  // Frosted glass uses Windows' real blurred Acrylic backdrop. Liquid glass leaves
  // the DWM material clear so the renderer's translucent layers reveal live windows.
  return preferences.surfaceStyle === 'frosted' ? 'acrylic' : 'none'
}

export function windowAppearanceOptions(
  preferences: PreferencesEntity,
  support = getAppearanceSupport(),
  platform: NodeJS.Platform = process.platform
): Pick<
  BrowserWindowConstructorOptions,
  | 'backgroundColor'
  | 'backgroundMaterial'
  | 'transparent'
  | 'frame'
  | 'titleBarStyle'
  | 'titleBarOverlay'
  | 'thickFrame'
  | 'roundedCorners'
> {
  const backgroundColor = support.transparentWindow ? '#00000000' : preferences.backgroundColor

  if (platform === 'win32' && support.transparentWindow) {
    return {
      backgroundColor,
      backgroundMaterial: backgroundMaterialFor(preferences, support),
      transparent: true,
      frame: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: preferences.textColor,
        height: 36
      },
      thickFrame: true,
      roundedCorners: true
    }
  }

  if (platform === 'darwin' && support.transparentWindow) {
    return {
      backgroundColor,
      transparent: true,
      titleBarStyle: 'hiddenInset'
    }
  }

  return { backgroundColor }
}

export function applyWindowAppearance(
  window: BrowserWindow,
  preferences: PreferencesEntity,
  support = getAppearanceSupport()
): void {
  const glassEnabled = preferences.surfaceStyle !== 'paper'
  if (process.platform === 'win32') {
    try {
      window.setBackgroundMaterial(backgroundMaterialFor(preferences, support))
    } catch (error) {
      console.warn('Could not apply the Windows backdrop material.', error)
    }
    if (support.windowControlsOverlay) {
      try {
        window.setTitleBarOverlay({
          color: '#00000000',
          symbolColor: preferences.textColor,
          height: 36
        })
      } catch (error) {
        console.warn('Could not refresh the Windows title-bar overlay.', error)
      }
    }
  } else if (process.platform === 'darwin') {
    try {
      window.setVibrancy(glassEnabled && support.nativeBackdrop ? 'under-window' : null)
    } catch (error) {
      console.warn('Could not apply the macOS vibrancy material.', error)
    }
  }

  try {
    // Keep a transparency-capable native canvas clear even while the paper surface is
    // selected. Paper is made solid by renderer layers; this lets an unsaved live
    // Frosted/Liquid preview reveal the desktop without recreating the BrowserWindow.
    window.setBackgroundColor(support.transparentWindow ? '#00000000' : preferences.backgroundColor)
  } catch (error) {
    console.warn(
      'Could not apply the native window background; CSS appearance remains active.',
      error
    )
  }
}
