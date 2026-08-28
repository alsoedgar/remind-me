import { describe, expect, it } from 'vitest'
import { createEventDocumentImportIdentity, documentSourceRowId } from '@remind-me/calendar-engine'
import {
  reviewedDocumentItemSchema,
  type DocumentImportDraft,
  type EventForm
} from '@remind-me/contracts'
import {
  canMergeDocumentDrafts,
  canReclassifyDocumentDraft,
  mergeDocumentDrafts,
  reclassifyDocumentDraft,
  splitDocumentDraft
} from './document-review-operations'

const sourceSha256 = 'a'.repeat(64)

function eventDraft(
  id: string,
  weekdays: Array<'monday' | 'wednesday' | 'friday'>,
  component: 'lecture' | 'laboratory' = 'lecture',
  withSchedule = true
): DocumentImportDraft {
  const form: EventForm = {
    id: null,
    calendarId: 'calendar:default',
    title: 'CS 251',
    description: 'Data Structures',
    location: 'CDRL 1426',
    startDate: '2026-08-24',
    startTime: '14:00',
    endDate: '2026-08-24',
    endTime: '14:50',
    timezone: 'America/Chicago',
    allDay: false,
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      byWeekday: weekdays,
      byMonthDay: [],
      end: { kind: 'until', date: '2026-12-04' }
    }
  }
  const schedule = withSchedule
    ? {
        courseCode: 'CS 251',
        sectionCode: 'L01',
        crn: '12345',
        creditHours: 4,
        component,
        termStartDate: '2026-08-24',
        termEndDate: '2026-12-04',
        weekdays,
        verification: 'layout' as const
      }
    : null
  const sourceIdentity = {
    sourceSha256,
    sourceRowId: documentSourceRowId(id)
  }
  return {
    id: `draft:${id}`,
    page: 1,
    confidence: 0.91,
    attention: 'ready',
    sourceText: 'CS 251 MWF 2:00 PM CDRL 1426',
    proposal: {} as never,
    resolved: {} as never,
    semanticRecord: {
      kind: 'event',
      startDate: form.startDate,
      endDate: form.endDate,
      recurrence: form.recurrence,
      schedule
    } as never,
    importIdentity: createEventDocumentImportIdentity(sourceIdentity, form, schedule),
    reconciliation: { state: 'new', recommendedSelected: true, matches: [] },
    schedule,
    fieldEvidence: {
      title: ['block:title'],
      when: ['block:when'],
      location: ['block:location'],
      description: ['block:description']
    },
    fieldConfidence: { title: 0.96, when: 0.94, location: 0.88, description: 0.86 },
    warnings: [],
    kind: 'event',
    form
  } as DocumentImportDraft
}

describe('document review structure operations', () => {
  it('splits a multi-weekday class into stable, independently reviewable series', () => {
    const split = splitDocumentDraft(eventDraft('one', ['monday', 'wednesday', 'friday']), [], [])
    expect(split).toHaveLength(3)
    expect(split.map((draft) => draft.form.recurrence?.byWeekday)).toEqual([
      ['monday'],
      ['wednesday'],
      ['friday']
    ])
    expect(new Set(split.map((draft) => draft.importIdentity.sourceRowId)).size).toBe(3)
    expect(split.map((draft) => draft.schedule?.weekdays)).toEqual([
      ['monday'],
      ['wednesday'],
      ['friday']
    ])
    for (const draft of split) {
      expect(
        reviewedDocumentItemSchema.safeParse({
          draftId: draft.id,
          kind: 'event',
          sourceIdentity: {
            sourceSha256: draft.importIdentity.sourceSha256,
            sourceRowId: draft.importIdentity.sourceRowId
          },
          schedule: draft.schedule,
          form: draft.form
        }).success
      ).toBe(true)
    }
  })

  it('merges only compatible weekly rows and protects different components', () => {
    const anchor = eventDraft('anchor', ['monday'])
    const matching = eventDraft('matching', ['wednesday'])
    const laboratory = eventDraft('laboratory', ['friday'], 'laboratory')
    expect(canMergeDocumentDrafts(anchor, matching)).toBe(true)
    expect(canMergeDocumentDrafts(anchor, laboratory)).toBe(false)

    const merged = mergeDocumentDrafts(anchor, [matching, laboratory], [], [])
    expect(merged.form.recurrence?.byWeekday).toEqual(['monday', 'wednesday'])
    expect(merged.schedule?.component).toBe('lecture')
    expect(merged.importIdentity.sourceRowId).not.toBe(anchor.importIdentity.sourceRowId)
  })

  it('reclassifies general plans but never turns a course component into a reminder', () => {
    const course = eventDraft('course', ['monday'])
    expect(canReclassifyDocumentDraft(course)).toBe(false)
    expect(reclassifyDocumentDraft(course, [], []).kind).toBe('event')

    const general = eventDraft('general', ['monday'], 'lecture', false)
    const reminder = reclassifyDocumentDraft(general, [], [])
    expect(reminder.kind).toBe('reminder')
    expect(reminder.schedule).toBeNull()
    expect(reminder.importIdentity.semanticKind).toBe('reminder')

    const eventAgain = reclassifyDocumentDraft(reminder, [], [])
    expect(eventAgain.kind).toBe('event')
    expect(eventAgain.form).toMatchObject({ startTime: '14:00', endTime: '15:00' })
  })
})
