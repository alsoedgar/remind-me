import { describe, expect, it } from 'vitest'
import { parseMemoryIntent } from './memory-intent'

describe('explicit personal memory intents', () => {
  it.each([
    ['Call me Edgar', { kind: 'set-name', name: 'Edgar' }],
    [
      'Remember that I prefer morning meetings.',
      { kind: 'remember', memory: 'I prefer morning meetings' }
    ],
    ['What do you remember about me?', { kind: 'recall' }],
    [
      'Forget that I prefer morning meetings',
      { kind: 'forget', memory: 'I prefer morning meetings' }
    ],
    ['Forget everything you know about me', { kind: 'forget-all' }]
  ])('parses %s', (text, expected) => {
    expect(parseMemoryIntent(text)).toEqual(expected)
  })

  it.each([
    'Remember to buy milk tomorrow',
    'Remind me to call Dad',
    'Delete my meeting',
    'Call me Edgar and add lunch tomorrow at noon',
    'Remember that I prefer mornings, then move lunch to Friday'
  ])('does not swallow calendar language: %s', (text) => expect(parseMemoryIntent(text)).toBeNull())
})
