import { describe, expect, it } from 'vitest'
import {
  normalizeAssistantText,
  normalizeAssistantWhitespace,
  repairKnownMutationTargets,
  typoPhraseSimilarity
} from './input-normalizer'

describe('assistant input normalization', () => {
  it.each([
    ['  wahts   th enext   evnt ?? ', 'whats the next event??'],
    ['can yuo ad lunch to morrow at 2 p m', 'can you add lunch tomorrow at 2 pm'],
    ['cler my entier scheduel', 'clear my entire schedule'],
    ['mvoe Design review to wednsday', 'move Design review to wednesday']
  ])('repairs command vocabulary and accidental spaces: %s', (source, expected) => {
    expect(normalizeAssistantText(source)).toBe(expected)
  })

  it('collapses whitespace without spell-checking personal memory content', () => {
    expect(normalizeAssistantWhitespace('  My   name is   Helo  ')).toBe('My name is Helo')
    expect(normalizeAssistantText('Schedule Teh Helo Meetup tomorrow at 2 PM')).toBe(
      'schedule Teh Helo Meetup tomorrow at 2 PM'
    )
  })

  it('finds transposed and missing letters in saved titles', () => {
    expect(typoPhraseSimilarity('Desgin reveiw', 'Design review')).toBeGreaterThan(0.8)
    expect(typoPhraseSimilarity('Dentist', 'Dinner')).toBe(0)
    expect(
      repairKnownMutationTargets('delete Desgin reveiw and Projet sycn', [
        'Design review',
        'Project sync'
      ])
    ).toBe('delete Design review and Project sync')
  })
})
