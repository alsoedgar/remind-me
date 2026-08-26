import { describe, expect, it } from 'vitest'
import { shouldSubmitComposerKey } from './composer-keyboard'

describe('assistant composer keyboard behavior', () => {
  it('sends with Enter', () => {
    expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(
      true
    )
  })

  it('keeps Shift+Enter available for multi-line typing', () => {
    expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(
      false
    )
  })

  it('does not submit while an input method editor is composing text', () => {
    expect(shouldSubmitComposerKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(
      false
    )
  })

  it('ignores unrelated keys', () => {
    expect(shouldSubmitComposerKey({ key: ' ', shiftKey: false, isComposing: false })).toBe(false)
  })
})
