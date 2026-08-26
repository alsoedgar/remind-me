import { describe, expect, it } from 'vitest'
import type { PreferencesEntity } from '@remind-me/contracts'
import {
  applyWindowAppearance,
  backgroundMaterialFor,
  getAppearanceSupport,
  windowAppearanceOptions
} from './appearance-runtime'

function preferences(surfaceStyle: PreferencesEntity['surfaceStyle']): PreferencesEntity {
  return { surfaceStyle } as PreferencesEntity
}

describe('native appearance support', () => {
  it('uses native glass on macOS and current Windows 11 builds', () => {
    expect(getAppearanceSupport('darwin', '25.0.0')).toMatchObject({
      nativeBackdrop: true,
      transparentWindow: true,
      windowControlsOverlay: false,
      label: 'Live macOS vibrancy'
    })
    expect(getAppearanceSupport('win32', '10.0.22631')).toMatchObject({
      nativeBackdrop: true,
      transparentWindow: true,
      windowControlsOverlay: true
    })
  })

  it('keeps live transparency on older Windows and a complete CSS fallback on Linux', () => {
    expect(getAppearanceSupport('win32', '10.0.19045')).toMatchObject({
      nativeBackdrop: false,
      transparentWindow: true,
      windowControlsOverlay: true
    })
    expect(getAppearanceSupport('linux', '6.8.0')).toEqual({
      nativeBackdrop: false,
      transparentWindow: false,
      windowControlsOverlay: false,
      label: 'Cross-platform CSS glass'
    })
  })

  it('maps each surface style to a safe Windows material', () => {
    const support = {
      nativeBackdrop: true,
      transparentWindow: true,
      windowControlsOverlay: true,
      label: 'test'
    }
    expect(backgroundMaterialFor(preferences('paper'), support)).toBe('none')
    expect(backgroundMaterialFor(preferences('frosted'), support)).toBe('acrylic')
    expect(backgroundMaterialFor(preferences('liquid'), support)).toBe('none')
    expect(
      backgroundMaterialFor(preferences('liquid'), {
        nativeBackdrop: false,
        transparentWindow: true,
        windowControlsOverlay: true,
        label: 'fallback'
      })
    ).toBe('none')
  })

  it('enables a genuinely transparent Windows window at construction time', () => {
    const options = windowAppearanceOptions(
      {
        ...preferences('liquid'),
        backgroundColor: '#f7f0e3',
        textColor: '#302824'
      },
      getAppearanceSupport('win32', '10.0.22631'),
      'win32'
    )
    expect(options).toMatchObject({
      backgroundColor: '#00000000',
      backgroundMaterial: 'none',
      transparent: true,
      frame: false,
      titleBarStyle: 'hidden',
      thickFrame: true,
      roundedCorners: true,
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#302824',
        height: 36
      }
    })
  })

  it('keeps the native canvas clear so an unsaved glass preview works from paper', () => {
    const backgroundColors: string[] = []
    const window = {
      setBackgroundColor: (color: string) => backgroundColors.push(color),
      setBackgroundMaterial: () => undefined,
      setTitleBarOverlay: () => undefined
    }

    applyWindowAppearance(
      window as never,
      {
        ...preferences('paper'),
        backgroundColor: '#f7f0e3',
        textColor: '#302824'
      },
      getAppearanceSupport('win32', '10.0.22631')
    )

    expect(backgroundColors).toEqual(['#00000000'])
  })
})
