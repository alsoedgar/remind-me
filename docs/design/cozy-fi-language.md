# Cozy-Fi visual language extraction

## Source audit

The Phase 0 interface was derived from the user’s Cozy-Fi Electron application. The useful design signals were its narrow navigation, simple DOM hierarchy, warm palette variables, tactile borders and offset shadows, settings-based palette selection, small router, and compact responsive behavior.

Spotify-specific player controls, album artwork, playback layout, service branding, and oversized media cards were intentionally excluded.

## Token mapping

| Cozy-Fi token          | Remind Me token          | Morning value | Purpose                          |
| ---------------------- | ------------------------ | ------------- | -------------------------------- |
| `--bg-primary`         | `--color-bg-primary`     | `#f7f0e3`     | Application paper                |
| `--bg-secondary`       | `--color-bg-secondary`   | `#fdfaf3`     | Navigation and raised surfaces   |
| `--bg-card`            | `--color-bg-card`        | `#ebd9c5`     | Selected items and cozy cards    |
| `--text-primary`       | `--color-text-primary`   | `#3c2f2f`     | Main ink                         |
| `--text-secondary`     | `--color-text-secondary` | `#6f5b50`     | Supporting text                  |
| `--accent-color`       | `--color-accent`         | `#c08a6e`     | Primary actions and today marker |
| `--accent-color-hover` | `--color-accent-hover`   | `#a77c5c`     | Interactive hover                |
| `--border-color`       | `--color-border`         | `#3c2f2f`     | Retro outlines                   |
| `--shadow-color`       | `--color-shadow`         | `#3c2f2f`     | Offset tactile shadow            |

Remind Me adds semantic success, warning, danger, and focus colors so status is not communicated by the accent color alone.

## Component rules

- Use a three-pixel outline and visible offset shadow for primary cards and actions.
- Keep most radii between 4 and 14 pixels; circles are reserved for status, dates, and voice affordances.
- Use the display face for labels/headings and a system face for time-dense content.
- Keep the assistant composer visually anchored and show structured proposals separately from prose.
- Calendar grids may be denser than Today cards, but never hide time, timezone, recurrence, or scope.
- Use 150–220 ms motion and respect reduced-motion settings.
- Preserve a visible focus indicator with at least three pixels of contrast.

## Navigation behavior

Desktop uses a persistent left rail with Today, Calendar, Reminders, and Settings. Each item includes a plain-language hint. Narrow layouts reduce the rail to icons while retaining accessible labels. Image/PDF import remains an assistant action and review workspace rather than a permanent navigation destination.

## Themes

- **Morning Lo-Fi** retains the original cream/clay Cozy-Fi palette.
- **Soft Sunset** retains the blush palette.
- **Quiet Evening** adds a low-light option with light borders and the same tactile hierarchy.

Theme selection is stored locally. Future custom palettes must run contrast validation before saving.
