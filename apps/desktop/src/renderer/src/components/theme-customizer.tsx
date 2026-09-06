import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PreferencesEntity, PreferencesUpdate, SavedTheme } from '@remind-me/contracts'
import {
  assessPaletteContrast,
  derivePaletteFromAccent,
  paletteForTheme,
  themes,
  type SurfaceStyle,
  type ThemeId,
  type ThemePalette
} from '@remind-me/ui'
import {
  appearanceFromPreferences,
  applyAppearanceToDocument,
  type AppliedAppearance
} from '../theme-runtime'
import { useUiStore } from '../store/ui-store'

interface ThemeCustomizerProps {
  preferences: PreferencesEntity
  nativeBackdrop: boolean
  transparentWindow: boolean
  nativeBackdropLabel: string
  busy: boolean
  onSave: (update: PreferencesUpdate) => Promise<boolean>
}

const paletteFields: ReadonlyArray<{ key: keyof ThemePalette; label: string }> = [
  { key: 'backgroundColor', label: 'Room' },
  { key: 'surfaceColor', label: 'Surfaces' },
  { key: 'cardColor', label: 'Cards' },
  { key: 'textColor', label: 'Main text' },
  { key: 'mutedTextColor', label: 'Quiet text' },
  { key: 'accentColor', label: 'Accent' },
  { key: 'borderColor', label: 'Lines' }
]

const surfaceOptions: ReadonlyArray<{
  id: SurfaceStyle
  name: string
  description: string
}> = [
  {
    id: 'paper',
    name: 'Cozy paper',
    description: 'Solid, calm, and easiest on every computer.'
  },
  {
    id: 'frosted',
    name: 'Frosted glass',
    description: 'Soft translucent panels with a restrained blur.'
  },
  {
    id: 'liquid',
    name: 'Liquid glass',
    description: 'Apple-inspired translucent layers, light, and soft depth.'
  }
]

function appearanceUpdate(
  themeId: ThemeId,
  palette: ThemePalette,
  surfaceStyle: SurfaceStyle,
  glassOpacity: number,
  glassBlur: number,
  glassSaturation: number,
  savedThemes: SavedTheme[]
): PreferencesUpdate {
  return {
    themeId,
    backgroundColor: palette.backgroundColor,
    surfaceColor: palette.surfaceColor,
    cardColor: palette.cardColor,
    textColor: palette.textColor,
    mutedTextColor: palette.mutedTextColor,
    accentColor: palette.accentColor,
    borderColor: palette.borderColor,
    surfaceStyle,
    glassOpacity,
    glassBlur,
    glassSaturation,
    savedThemes
  }
}

export function ThemeCustomizer({
  preferences,
  nativeBackdrop,
  transparentWindow,
  nativeBackdropLabel,
  busy,
  onSave
}: ThemeCustomizerProps): ReactNode {
  const persistedAppearance = appearanceFromPreferences(preferences)
  const persistedAppearanceRef = useRef(persistedAppearance)
  const persistedTransparencyRef = useRef(transparentWindow)
  const setAppTheme = useUiStore((state) => state.setTheme)
  const [themeId, setThemeId] = useState<ThemeId>(persistedAppearance.themeId)
  const [palette, setPalette] = useState<ThemePalette>(persistedAppearance.palette)
  const [surfaceStyle, setSurfaceStyle] = useState<SurfaceStyle>(persistedAppearance.surfaceStyle)
  const [glassOpacity, setGlassOpacity] = useState(persistedAppearance.glassOpacity)
  const [glassBlur, setGlassBlur] = useState(persistedAppearance.glassBlur)
  const [glassSaturation, setGlassSaturation] = useState(persistedAppearance.glassSaturation)
  const [savedThemes, setSavedThemes] = useState<SavedTheme[]>(preferences.savedThemes)
  const [selectedSavedId, setSelectedSavedId] = useState('')
  const [paletteName, setPaletteName] = useState('My palette')

  useEffect(() => {
    const next = appearanceFromPreferences(preferences)
    persistedAppearanceRef.current = next
    setThemeId(next.themeId)
    setPalette(next.palette)
    setSurfaceStyle(next.surfaceStyle)
    setGlassOpacity(next.glassOpacity)
    setGlassBlur(next.glassBlur)
    setGlassSaturation(next.glassSaturation)
    setSavedThemes(preferences.savedThemes)
  }, [preferences])

  useEffect(() => {
    persistedTransparencyRef.current = transparentWindow
  }, [transparentWindow])

  const draftAppearance = useMemo<AppliedAppearance>(
    () => ({
      themeId,
      palette,
      surfaceStyle,
      glassOpacity,
      glassBlur,
      glassSaturation
    }),
    [glassBlur, glassOpacity, glassSaturation, palette, surfaceStyle, themeId]
  )
  useEffect(() => {
    applyAppearanceToDocument(draftAppearance, transparentWindow)
  }, [draftAppearance, transparentWindow])
  useEffect(
    () => () => {
      applyAppearanceToDocument(persistedAppearanceRef.current, persistedTransparencyRef.current)
    },
    []
  )

  const contrast = useMemo(() => assessPaletteContrast(palette), [palette])
  const saveAppearance = async (
    nextSavedThemes = savedThemes,
    nextThemeId = themeId
  ): Promise<boolean> => {
    const saved = await onSave(
      appearanceUpdate(
        nextThemeId,
        palette,
        surfaceStyle,
        glassOpacity,
        glassBlur,
        glassSaturation,
        nextSavedThemes
      )
    )
    if (saved) setAppTheme(nextThemeId)
    return saved
  }
  const updatePaletteColor = (key: keyof ThemePalette, value: string): void => {
    setThemeId('custom')
    setPalette((current) => ({ ...current, [key]: value }))
  }
  const chooseTheme = (nextThemeId: ThemeId): void => {
    setThemeId(nextThemeId)
    if (nextThemeId !== 'custom') setPalette(paletteForTheme(nextThemeId))
  }
  const buildPalette = (tone: 'light' | 'dark'): void => {
    setThemeId('custom')
    setPalette(derivePaletteFromAccent(palette.accentColor, tone))
  }
  const saveNamedPalette = async (): Promise<void> => {
    const name = paletteName.trim() || 'My palette'
    const existingIndex = savedThemes.findIndex((item) => item.id === selectedSavedId)
    const id = existingIndex >= 0 ? selectedSavedId : `theme:${crypto.randomUUID()}`
    const nextTheme: SavedTheme = { id, name, palette }
    const nextSavedThemes =
      existingIndex >= 0
        ? savedThemes.map((item, index) => (index === existingIndex ? nextTheme : item))
        : [...savedThemes, nextTheme].slice(0, 8)
    setThemeId('custom')
    setSavedThemes(nextSavedThemes)
    setSelectedSavedId(id)
    await saveAppearance(nextSavedThemes, 'custom')
  }
  const deleteNamedPalette = async (): Promise<void> => {
    if (!selectedSavedId) return
    const nextSavedThemes = savedThemes.filter((item) => item.id !== selectedSavedId)
    setSavedThemes(nextSavedThemes)
    setSelectedSavedId('')
    setPaletteName('My palette')
    await saveAppearance(nextSavedThemes)
  }

  return (
    <section className="theme-customizer" aria-labelledby="theme-customizer-heading">
      <div className="settings-heading-row">
        <div>
          <p className="eyebrow">Appearance</p>
          <h2 id="theme-customizer-heading">Make the room yours</h2>
        </div>
        <span className="appearance-runtime-badge" data-native={nativeBackdrop}>
          {nativeBackdropLabel}
        </span>
      </div>

      <div className="theme-options" role="radiogroup" aria-label="Color theme">
        {themes.map((option) => {
          const swatches =
            option.id === 'custom'
              ? [
                  palette.backgroundColor,
                  palette.surfaceColor,
                  palette.cardColor,
                  palette.accentColor
                ]
              : option.swatches
          return (
            <button
              className="theme-option"
              data-active={themeId === option.id}
              key={option.id}
              onClick={() => chooseTheme(option.id)}
              role="radio"
              aria-checked={themeId === option.id}
              type="button"
            >
              <span className="theme-swatches" aria-hidden="true">
                {swatches.map((swatch, index) => (
                  <span key={`${swatch}:${index}`} style={{ background: swatch }} />
                ))}
              </span>
              <strong>{option.name}</strong>
              <small>{option.description}</small>
            </button>
          )
        })}
      </div>

      <div className="theme-editor-grid">
        <div className="palette-editor">
          <div className="theme-subheading">
            <div>
              <strong>Palette</strong>
              <small>Every important color is editable.</small>
            </div>
            <div className="palette-build-actions">
              <button type="button" onClick={() => buildPalette('light')}>
                Build light
              </button>
              <button type="button" onClick={() => buildPalette('dark')}>
                Build dark
              </button>
            </div>
          </div>
          <div className="palette-color-grid">
            {paletteFields.map((field) => (
              <label className="palette-color-field" key={field.key}>
                <span>{field.label}</span>
                <span>
                  <input
                    type="color"
                    value={palette[field.key]}
                    onChange={(event) => updatePaletteColor(field.key, event.target.value)}
                    aria-label={`${field.label} color`}
                  />
                  <code>{palette[field.key]}</code>
                </span>
              </label>
            ))}
          </div>
          <div className="contrast-status" data-passes={contrast.passesAA}>
            <span aria-hidden="true">{contrast.passesAA ? '✓' : '!'}</span>
            <p>
              <strong>{contrast.passesAA ? 'Comfortable contrast' : 'Low contrast'}</strong>
              <small>
                Text {contrast.primary.toFixed(1)}:1 · quiet text {contrast.muted.toFixed(1)}:1
              </small>
            </p>
          </div>
        </div>

        <div className="surface-editor">
          <div className="theme-subheading">
            <div>
              <strong>Surface</strong>
              <small>Choose how solid or glassy the app feels.</small>
            </div>
          </div>
          <div className="surface-options" role="radiogroup" aria-label="Surface style">
            {surfaceOptions.map((option) => (
              <button
                type="button"
                role="radio"
                aria-checked={surfaceStyle === option.id}
                data-active={surfaceStyle === option.id}
                data-surface-preview={option.id}
                key={option.id}
                onClick={() => setSurfaceStyle(option.id)}
              >
                <span aria-hidden="true" />
                <strong>{option.name}</strong>
                <small>{option.description}</small>
              </button>
            ))}
          </div>
          {surfaceStyle !== 'paper' ? (
            <div className="glass-controls">
              <label>
                <span>
                  Opacity <output>{glassOpacity}%</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={glassOpacity}
                  onChange={(event) => setGlassOpacity(Number(event.target.value))}
                />
              </label>
              <label>
                <span>
                  Blur <output>{glassBlur}px</output>
                </span>
                <input
                  type="range"
                  min="0"
                  max="48"
                  value={glassBlur}
                  onChange={(event) => setGlassBlur(Number(event.target.value))}
                />
              </label>
              <label>
                <span>
                  Color depth <output>{glassSaturation}%</output>
                </span>
                <input
                  type="range"
                  min="90"
                  max="160"
                  value={glassSaturation}
                  onChange={(event) => setGlassSaturation(Number(event.target.value))}
                />
              </label>
            </div>
          ) : null}
        </div>
      </div>

      <div className="saved-palette-row">
        <label>
          Saved palettes
          <select
            value={selectedSavedId}
            onChange={(event) => {
              const id = event.target.value
              setSelectedSavedId(id)
              const saved = savedThemes.find((item) => item.id === id)
              if (!saved) {
                setPaletteName('My palette')
                return
              }
              setThemeId('custom')
              setPalette(saved.palette)
              setPaletteName(saved.name)
            }}
          >
            <option value="">New palette</option>
            {savedThemes.map((saved) => (
              <option value={saved.id} key={saved.id}>
                {saved.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Palette name
          <input
            value={paletteName}
            maxLength={32}
            onChange={(event) => setPaletteName(event.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          type="button"
          disabled={busy || (!selectedSavedId && savedThemes.length >= 8)}
          onClick={() => void saveNamedPalette()}
        >
          {selectedSavedId ? 'Update named palette' : 'Save named palette'}
        </button>
        <button
          className="text-button"
          type="button"
          disabled={busy || !selectedSavedId}
          onClick={() => void deleteNamedPalette()}
        >
          Delete
        </button>
      </div>

      <div className="appearance-save-row">
        <p>Preview is live. Changes stay only after you save them.</p>
        <button
          className="retro-button"
          type="button"
          disabled={busy}
          onClick={() => void saveAppearance()}
        >
          Save appearance
        </button>
      </div>
    </section>
  )
}
