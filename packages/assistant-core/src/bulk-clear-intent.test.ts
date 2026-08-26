import { describe, expect, it } from 'vitest'
import {
  parseBulkClearIntent,
  parseScopedBulkClearRequest,
  type BulkClearScope
} from './bulk-clear-intent'

describe('whole-calendar clear intent parsing', () => {
  it.each<[string, BulkClearScope]>([
    ['Can you clear my entire schedule?', 'events'],
    ['Can you reset my calendar and schedule?', 'events'],
    ['I want you to remove all dates/events', 'events'],
    ['Erase every appointment and class', 'events'],
    ['Wipe my calendar', 'events'],
    ['Start my calendar over', 'events'],
    ['Clear all reminders', 'reminders'],
    ['Remove every task from my calendar', 'reminders'],
    ['Delete all events and reminders', 'both'],
    ['Reset my calendar and reminders', 'both'],
    ['Clear everything from my calendar', 'both']
  ])('maps %s to the %s scope', (text, scope) => {
    expect(parseBulkClearIntent(text)).toEqual({ scope })
  })

  it.each([
    'Do not clear all events',
    "Don't reset my calendar",
    'Clear my schedule for Tuesday',
    'Remove all events tomorrow',
    'Delete past events',
    'Am I clear all day?',
    'Clear this conversation',
    'Delete the dentist appointment',
    'Reset the event time'
  ])('does not promote a narrower or negated request: %s', (text) => {
    expect(parseBulkClearIntent(text)).toBeNull()
  })
})

describe('scoped bulk clear guard', () => {
  it('captures date-limited destructive language without promoting it globally', () => {
    expect(parseScopedBulkClearRequest('clear everything tomorrow')).toMatchObject({
      scope: 'unclear',
      temporalText: 'tomorrow'
    })
    expect(parseScopedBulkClearRequest('delete all reminders next week')).toMatchObject({
      scope: 'reminders',
      temporalText: 'next week'
    })
    expect(parseBulkClearIntent('clear everything tomorrow')).toBeNull()
  })

  it('ignores non-destructive and whole-calendar requests', () => {
    expect(parseScopedBulkClearRequest('what is tomorrow')).toBeNull()
    expect(parseScopedBulkClearRequest('clear my entire schedule')).toBeNull()
  })
})
