import { describe, expect, it } from 'vitest'
import {
  fitWindowBounds,
  glanceBoundsForWorkArea,
  widgetBoundsForWorkArea
} from './window-geometry'

describe('desktop window geometry', () => {
  it('places the compact widget at the lower-right of the active work area', () => {
    expect(widgetBoundsForWorkArea({ x: 0, y: 0, width: 1920, height: 1080 })).toEqual({
      x: 1476,
      y: 376,
      width: 420,
      height: 680
    })
  })

  it('places the tiny glance like a desktop widget', () => {
    expect(glanceBoundsForWorkArea({ x: 0, y: 0, width: 1920, height: 1080 })).toEqual({
      x: 1598,
      y: 794,
      width: 304,
      height: 268
    })
  })

  it('keeps a restored full window visible after the display layout changes', () => {
    expect(
      fitWindowBounds(
        { x: 2600, y: -800, width: 1320, height: 840 },
        { x: 0, y: 0, width: 1440, height: 900 },
        920,
        640
      )
    ).toEqual({ x: 120, y: 0, width: 1320, height: 840 })
  })
})
