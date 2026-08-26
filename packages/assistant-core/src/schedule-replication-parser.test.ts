import { describe, expect, it } from 'vitest'
import { parseScheduleReplicationRequest } from './schedule-replication-parser'

const localDate = '2026-08-24'

describe('schedule replication language', () => {
  it('understands possessive day agendas with mixed unambiguous abbreviations', () => {
    expect(
      parseScheduleReplicationRequest("Mirror Tuesday's agenda onto Th / F and Sun", localDate)
    ).toMatchObject({
      kind: 'intent',
      sourceDate: '2026-08-25',
      targetWeekdays: ['thursday', 'friday', 'sunday'],
      firstTargetDate: '2026-08-27',
      recurrenceEnd: { kind: 'until', date: '2026-10-20' },
      usedDefaultEnd: true
    })
  })

  it('supports schedule-from language, presets, and explicit durations', () => {
    expect(
      parseScheduleReplicationRequest(
        'Reuse the schedule from 2026-08-26 across weekdays for the next 3 weeks',
        localDate
      )
    ).toMatchObject({
      kind: 'intent',
      sourceDate: '2026-08-26',
      targetWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      firstTargetDate: '2026-08-27',
      recurrenceEnd: { kind: 'until', date: '2026-09-16' },
      usedDefaultEnd: false
    })
  })

  it('handles reverse look-like phrasing and named end dates', () => {
    expect(
      parseScheduleReplicationRequest(
        'Make Wednesdays and Saturdays look like Monday through September 30, 2026',
        localDate
      )
    ).toMatchObject({
      kind: 'intent',
      sourceDate: '2026-08-24',
      targetWeekdays: ['wednesday', 'saturday'],
      firstTargetDate: '2026-08-26',
      recurrenceEnd: { kind: 'until', date: '2026-09-30' }
    })
  })

  it.each([
    [
      'Use Thursday as the template for MWF for 4 weeks',
      ['monday', 'wednesday', 'friday'],
      '2026-09-24'
    ],
    [
      'Take everything from Saturday and put it on Tuesdays and Thursdays forever',
      ['tuesday', 'thursday'],
      null
    ],
    [
      'Make Tuesdays and Sundays the same as Friday for 2 weeks',
      ['tuesday', 'sunday'],
      '2026-09-11'
    ],
    ['Carry Wednesday to weekends', ['saturday', 'sunday'], '2026-10-21']
  ])('understands the general schedule-copy form: %s', (text, targetWeekdays, endDate) => {
    const result = parseScheduleReplicationRequest(text, localDate)
    expect(result).toMatchObject({ kind: 'intent', targetWeekdays })
    if (result?.kind !== 'intent') throw new Error('Expected a schedule-copy intent')
    expect(result.recurrenceEnd).toEqual(
      endDate ? { kind: 'until', date: endDate } : { kind: 'never' }
    )
  })

  it('clarifies ambiguous one-letter weekdays instead of guessing', () => {
    expect(
      parseScheduleReplicationRequest('Repeat my Friday routine on T and S', localDate)
    ).toMatchObject({
      kind: 'clarification',
      options: ['Tuesday', 'Thursday']
    })
  })

  it('does not intercept ordinary single-event duplication', () => {
    expect(parseScheduleReplicationRequest('Copy design review to Friday', localDate)).toBeNull()
  })
})
