import { describe, expect, it } from 'vitest'
import {
  assessPaletteContrast,
  contrastRatio,
  derivePaletteFromAccent,
  normalizeHex,
  paletteForTheme,
  themeCssVariables
} from './theme'

describe('theme palettes', () => {
  it('normalizes valid colors and rejects malformed custom values', () => {
    expect(normalizeHex('#C08A6E')).toBe('#c08a6e')
    expect(normalizeHex('url(evil)', '#123456')).toBe('#123456')
  })

  it.each(['light', 'dark'] as const)('derives a readable %s palette from any accent', (tone) => {
    const palette = derivePaletteFromAccent('#7557d9', tone)
    const contrast = assessPaletteContrast(palette)
    expect(contrast.primary).toBeGreaterThanOrEqual(4.5)
    expect(contrast.muted).toBeGreaterThanOrEqual(4.5)
    expect(contrast.passesAA).toBe(true)
  })

  it('returns independent preset palettes', () => {
    const first = paletteForTheme('soft-sunset')
    first.accentColor = '#000000'
    expect(paletteForTheme('soft-sunset').accentColor).toBe('#dca396')
  })

  it('keeps every built-in palette readable', () => {
    for (const theme of ['morning-lo-fi', 'soft-sunset', 'quiet-evening'] as const) {
      expect(assessPaletteContrast(paletteForTheme(theme)).passesAA).toBe(true)
    }
  })

  it('clamps glass controls and chooses readable button text', () => {
    const palette = derivePaletteFromAccent('#b455c9', 'light')
    const variables = themeCssVariables(palette, {
      opacity: 1_000,
      blur: -20,
      saturation: 500
    })
    expect(variables['--glass-surface-opacity']).toBe('96%')
    expect(variables['--glass-blur']).toBe('0px')
    expect(variables['--glass-saturation']).toBe('160%')
    expect(
      contrastRatio(palette.accentColor, variables['--color-button-text'] ?? '#000000')
    ).toBeGreaterThanOrEqual(4.5)
  })
})
