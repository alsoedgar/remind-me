import { describe, expect, it, vi } from 'vitest'
import { focusComposerAtEnd, type ComposerFocusTarget } from './composer-focus'

describe('assistant composer focus recovery', () => {
  it('focuses a mounted composer and restores the caret after its draft', () => {
    const focus = vi.fn()
    const setSelectionRange = vi.fn()
    const target: ComposerFocusTarget = {
      isConnected: true,
      value: 'new draft after clearing',
      focus,
      setSelectionRange
    }

    expect(focusComposerAtEnd(target)).toBe(true)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(setSelectionRange).toHaveBeenCalledWith(24, 24)
  })

  it('does not focus a composer that was removed while the assistant closed', () => {
    const focus = vi.fn()
    expect(
      focusComposerAtEnd({
        isConnected: false,
        value: '',
        focus,
        setSelectionRange: vi.fn()
      })
    ).toBe(false)
    expect(focus).not.toHaveBeenCalled()
  })
})
