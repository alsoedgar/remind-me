import { describe, expect, it } from 'vitest'
import { assistantSuggestions } from './assistant-prompts'

describe('assistant conversation starters', () => {
  it('offers both a capability tour and useful calendar actions', () => {
    expect(assistantSuggestions[0]).toBe('What can you do?')
    expect(assistantSuggestions.some((prompt) => /free/iu.test(prompt))).toBe(true)
    expect(assistantSuggestions.some((prompt) => /remind/iu.test(prompt))).toBe(true)
    expect(assistantSuggestions.some((prompt) => /move/iu.test(prompt))).toBe(true)
  })
})
