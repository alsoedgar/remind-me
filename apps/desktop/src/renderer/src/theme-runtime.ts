import type { PreferencesEntity } from '@remind-me/contracts'
import {
  isSurfaceStyle,
  isThemeId,
  normalizeThemePalette,
  paletteColorScheme,
  themeCssVariables,
  type SurfaceStyle,
  type ThemeId,
  type ThemePalette
} from '@remind-me/ui'

export interface AppliedAppearance {
  themeId: ThemeId
  palette: ThemePalette
  surfaceStyle: SurfaceStyle
  glassOpacity: number
  glassBlur: number
  glassSaturation: number
}

export function appearanceFromPreferences(preferences: PreferencesEntity): AppliedAppearance {
  return {
    themeId: isThemeId(preferences.themeId) ? preferences.themeId : 'custom',
    palette: normalizeThemePalette({
      backgroundColor: preferences.backgroundColor,
      surfaceColor: preferences.surfaceColor,
      cardColor: preferences.cardColor,
      textColor: preferences.textColor,
      mutedTextColor: preferences.mutedTextColor,
      accentColor: preferences.accentColor,
      borderColor: preferences.borderColor
    }),
    surfaceStyle: isSurfaceStyle(preferences.surfaceStyle) ? preferences.surfaceStyle : 'paper',
    glassOpacity: preferences.glassOpacity,
    glassBlur: preferences.glassBlur,
    glassSaturation: preferences.glassSaturation
  }
}

export function applyAppearanceToDocument(
  appearance: AppliedAppearance,
  nativeBackdrop: boolean,
  root: HTMLElement = document.documentElement
): void {
  root.dataset.theme = appearance.themeId
  root.dataset.surface = appearance.surfaceStyle
  root.dataset.nativeBackdrop = String(nativeBackdrop && appearance.surfaceStyle !== 'paper')
  root.style.colorScheme = paletteColorScheme(appearance.palette)
  const variables = themeCssVariables(appearance.palette, {
    opacity: appearance.glassOpacity,
    blur: appearance.glassBlur,
    saturation: appearance.glassSaturation
  })
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value)
}
