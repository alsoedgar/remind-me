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
    ['mvoe Design review to wednsday', 'move Design review to wednesday'],
    ['whats my frist claas today', 'whats my first class today'],
    ['do i hav anythng tmr?', 'do i have anything tmr?'],
    ['shwo me evrything i have tmrw', 'show me everything i have tmrw'],
    ['what dose tomorow look like', 'what does tomorrow look like'],
    ['walk me thru my scheduel tommorrow', 'walk me through my schedule tomorrow'],
    ["what's scheduled next Monday?", "what's scheduled next monday?"]
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
    expect(
      repairKnownMutationTargets('take Desgin reveiw off my calendar', ['Design review'])
    ).toBe('take Design review off my calendar')
  })
})
