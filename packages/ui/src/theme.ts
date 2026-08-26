export const themeIds = ['morning-lo-fi', 'soft-sunset', 'quiet-evening', 'custom'] as const

export const surfaceStyleIds = ['paper', 'frosted', 'liquid'] as const

export type ThemeId = (typeof themeIds)[number]
export type SurfaceStyle = (typeof surfaceStyleIds)[number]
export type ThemeTone = 'light' | 'dark'

export interface ThemePalette {
  backgroundColor: string
  surfaceColor: string
  cardColor: string
  textColor: string
  mutedTextColor: string
  accentColor: string
  borderColor: string
}

export interface ThemeDefinition {
  id: ThemeId
  name: string
  description: string
  palette: ThemePalette
  swatches: readonly [string, string, string, string]
}

export interface GlassOptions {
  opacity: number
  blur: number
  saturation: number
}

export interface PaletteContrast {
  primary: number
  muted: number
  accent: number
  minimum: number
  passesAA: boolean
}

const morningPalette: ThemePalette = {
  backgroundColor: '#f7f0e3',
  surfaceColor: '#fdfaf3',
  cardColor: '#ebd9c5',
  textColor: '#3c2f2f',
  mutedTextColor: '#6f5b50',
  accentColor: '#c08a6e',
  borderColor: '#3c2f2f'
}

const sunsetPalette: ThemePalette = {
  backgroundColor: '#f4eae1',
  surfaceColor: '#faede6',
  cardColor: '#f2d1c9',
  textColor: '#3a2e32',
  mutedTextColor: '#6e555b',
  accentColor: '#dca396',
  borderColor: '#3a2e32'
}

const eveningPalette: ThemePalette = {
  backgroundColor: '#262228',
  surfaceColor: '#302a30',
  cardColor: '#40363d',
  textColor: '#f5ece3',
  mutedTextColor: '#cebcb4',
  accentColor: '#d5a28b',
  borderColor: '#f0ddd1'
}

export const defaultThemePalette = { ...morningPalette }

export const themes: readonly ThemeDefinition[] = [
  {
    id: 'morning-lo-fi',
    name: 'Morning Lo-Fi',
    description: 'Cream, linen, warm clay, and coffee-colored ink.',
    palette: morningPalette,
    swatches: ['#f7f0e3', '#fdfaf3', '#ebd9c5', '#c08a6e']
  },
  {
    id: 'soft-sunset',
    name: 'Soft Sunset',
    description: 'Blush paper, muted rose, and a soft apricot accent.',
    palette: sunsetPalette,
    swatches: ['#f4eae1', '#faede6', '#f2d1c9', '#dca396']
  },
  {
    id: 'quiet-evening',
    name: 'Quiet Evening',
    description: 'A low-light plum palette for late planning sessions.',
    palette: eveningPalette,
    swatches: ['#262228', '#302a30', '#40363d', '#d5a28b']
  },
  {
    id: 'custom',
    name: 'My Palette',
    description: 'Choose every color and keep up to eight personal palettes.',
    palette: morningPalette,
    swatches: ['#f7f0e3', '#fdfaf3', '#ebd9c5', '#c08a6e']
  }
] as const

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum))
}

export function normalizeHex(value: unknown, fallback = '#000000'): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
    ? value.toLowerCase()
    : fallback.toLowerCase()
}

function hexToRgb(value: string): { r: number; g: number; b: number } {
  const hex = normalizeHex(value).slice(1)
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  }
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) =>
      Math.round(clamp(channel, 0, 255))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

function hexToHsl(value: string): { h: number; s: number; l: number } {
  const { r: rawRed, g: rawGreen, b: rawBlue } = hexToRgb(value)
  const red = rawRed / 255
  const green = rawGreen / 255
  const blue = rawBlue / 255
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const delta = maximum - minimum
  let hue = 0
  if (delta > 0) {
    if (maximum === red) hue = ((green - blue) / delta) % 6
    else if (maximum === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue = (hue * 60 + 360) % 360
  }
  const lightness = (maximum + minimum) / 2
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
  return { h: hue, s: saturation, l: lightness }
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const normalizedHue = ((hue % 360) + 360) % 360
  const normalizedSaturation = clamp(saturation)
  const normalizedLightness = clamp(lightness)
  const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation
  const segment = normalizedHue / 60
  const x = chroma * (1 - Math.abs((segment % 2) - 1))
  let channels: readonly [number, number, number]
  if (segment < 1) channels = [chroma, x, 0]
  else if (segment < 2) channels = [x, chroma, 0]
  else if (segment < 3) channels = [0, chroma, x]
  else if (segment < 4) channels = [0, x, chroma]
  else if (segment < 5) channels = [x, 0, chroma]
  else channels = [chroma, 0, x]
  const offset = normalizedLightness - chroma / 2
  return rgbToHex(
    (channels[0] + offset) * 255,
    (channels[1] + offset) * 255,
    (channels[2] + offset) * 255
  )
}

export function mixHex(first: string, second: string, secondWeight: number): string {
  const left = hexToRgb(first)
  const right = hexToRgb(second)
  const weight = clamp(secondWeight)
  return rgbToHex(
    left.r * (1 - weight) + right.r * weight,
    left.g * (1 - weight) + right.g * weight,
    left.b * (1 - weight) + right.b * weight
  )
}

export function relativeLuminance(value: string): number {
  const { r, g, b } = hexToRgb(value)
  const channels = [r, g, b].map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.039_28 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
}

export function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function ensureContrast(
  startingColor: string,
  backgrounds: readonly string[],
  target: number,
  makeDarker: boolean
): string {
  let hsl = hexToHsl(startingColor)
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const candidate = hslToHex(hsl.h, hsl.s, hsl.l)
    if (backgrounds.every((background) => contrastRatio(candidate, background) >= target))
      return candidate
    hsl = { ...hsl, l: clamp(hsl.l + (makeDarker ? -0.025 : 0.025)) }
  }
  return makeDarker ? '#171319' : '#fffaf4'
}

export function paletteForTheme(theme: ThemeId): ThemePalette {
  const definition = themes.find((candidate) => candidate.id === theme) ?? themes[0]
  return { ...(definition?.palette ?? morningPalette) }
}

export function normalizeThemePalette(
  value: Partial<ThemePalette>,
  fallback: ThemePalette = defaultThemePalette
): ThemePalette {
  return {
    backgroundColor: normalizeHex(value.backgroundColor, fallback.backgroundColor),
    surfaceColor: normalizeHex(value.surfaceColor, fallback.surfaceColor),
    cardColor: normalizeHex(value.cardColor, fallback.cardColor),
    textColor: normalizeHex(value.textColor, fallback.textColor),
    mutedTextColor: normalizeHex(value.mutedTextColor, fallback.mutedTextColor),
    accentColor: normalizeHex(value.accentColor, fallback.accentColor),
    borderColor: normalizeHex(value.borderColor, fallback.borderColor)
  }
}

export function derivePaletteFromAccent(accentValue: string, tone: ThemeTone): ThemePalette {
  const source = normalizeHex(accentValue, morningPalette.accentColor)
  const accentHsl = hexToHsl(source)
  const saturation = clamp(Math.max(accentHsl.s, 0.34), 0.34, 0.84)
  const dark = tone === 'dark'
  const backgroundColor = hslToHex(accentHsl.h, saturation * 0.28, dark ? 0.105 : 0.965)
  const surfaceColor = hslToHex(accentHsl.h, saturation * 0.2, dark ? 0.145 : 0.987)
  const cardColor = hslToHex(accentHsl.h, saturation * 0.42, dark ? 0.205 : 0.895)
  const backgrounds = [backgroundColor, surfaceColor, cardColor]
  const textColor = ensureContrast(
    hslToHex(accentHsl.h, saturation * 0.22, dark ? 0.94 : 0.13),
    backgrounds,
    7,
    !dark
  )
  const mutedTextColor = ensureContrast(
    hslToHex(accentHsl.h, saturation * 0.3, dark ? 0.78 : 0.34),
    backgrounds,
    4.5,
    !dark
  )
  const accentColor = hslToHex(
    accentHsl.h,
    saturation,
    dark ? Math.max(0.62, accentHsl.l) : clamp(accentHsl.l, 0.4, 0.62)
  )
  return {
    backgroundColor,
    surfaceColor,
    cardColor,
    textColor,
    mutedTextColor,
    accentColor,
    borderColor: textColor
  }
}

export function assessPaletteContrast(paletteValue: ThemePalette): PaletteContrast {
  const palette = normalizeThemePalette(paletteValue)
  const backgrounds = [palette.backgroundColor, palette.surfaceColor, palette.cardColor]
  const primary = Math.min(
    ...backgrounds.map((background) => contrastRatio(palette.textColor, background))
  )
  const muted = Math.min(
    ...backgrounds.map((background) => contrastRatio(palette.mutedTextColor, background))
  )
  const accent = Math.min(
    contrastRatio(palette.accentColor, palette.backgroundColor),
    contrastRatio(palette.accentColor, palette.surfaceColor)
  )
  return {
    primary,
    muted,
    accent,
    minimum: Math.min(primary, muted),
    passesAA: primary >= 4.5 && muted >= 4.5
  }
}

export function paletteColorScheme(palette: ThemePalette): ThemeTone {
  return relativeLuminance(palette.backgroundColor) < 0.3 ? 'dark' : 'light'
}

export function themeCssVariables(
  paletteValue: ThemePalette,
  glassValue: GlassOptions
): Readonly<Record<string, string>> {
  const palette = normalizeThemePalette(paletteValue)
  const dark = paletteColorScheme(palette) === 'dark'
  const opacity = Math.round(clamp(glassValue.opacity, 65, 96))
  const blur = Math.round(clamp(glassValue.blur, 0, 48))
  const saturation = Math.round(clamp(glassValue.saturation, 90, 160))
  const accentHover = mixHex(palette.accentColor, dark ? '#ffffff' : '#000000', 0.16)
  const buttonText =
    contrastRatio(palette.accentColor, '#000000') >= contrastRatio(palette.accentColor, '#ffffff')
      ? '#000000'
      : '#ffffff'

  return {
    '--color-base-bg-primary': palette.backgroundColor,
    '--color-base-bg-secondary': palette.surfaceColor,
    '--color-base-bg-card': palette.cardColor,
    '--color-base-bg-card-light': mixHex(palette.cardColor, palette.surfaceColor, 0.42),
    '--color-text-primary': palette.textColor,
    '--color-text-secondary': palette.mutedTextColor,
    '--color-accent': palette.accentColor,
    '--color-accent-hover': accentHover,
    '--color-border': palette.borderColor,
    '--color-progress': mixHex(palette.cardColor, palette.surfaceColor, 0.55),
    '--color-shadow': mixHex(palette.borderColor, '#000000', dark ? 0.5 : 0.08),
    '--color-button-text': buttonText,
    '--color-success': dark ? '#91b698' : '#55745d',
    '--color-warning': dark ? '#e1b06e' : '#9b6634',
    '--color-danger': dark ? '#e38b91' : '#9b4d59',
    '--color-focus': dark ? '#8fc5dc' : '#426e86',
    '--glass-main-opacity': `${Math.max(45, opacity - 12)}%`,
    '--glass-surface-opacity': `${opacity}%`,
    '--glass-card-opacity': `${Math.min(99, opacity + 7)}%`,
    '--glass-blur': `${blur}px`,
    '--glass-saturation': `${saturation}%`,
    '--glass-start': mixHex(palette.backgroundColor, palette.accentColor, dark ? 0.26 : 0.2),
    '--glass-end': mixHex(palette.surfaceColor, palette.cardColor, 0.55),
    '--glass-glow': mixHex(palette.cardColor, palette.accentColor, 0.38),
    '--glass-sheen': dark ? '#fffaf4' : '#ffffff'
  }
}

export function isThemeId(value: string): value is ThemeId {
  return (themeIds as readonly string[]).includes(value)
}

export function isSurfaceStyle(value: string): value is SurfaceStyle {
  return (surfaceStyleIds as readonly string[]).includes(value)
}
