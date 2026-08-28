import { describe, expect, it } from 'vitest'
import type {
  DocumentImportSourceIdentity,
  DocumentScheduleMetadata,
  EventEntity,
  EventForm,
  ReminderEntity,
  ReminderForm
} from '@remind-me/contracts'
import {
  canonicalDocumentLocation,
  createEventDocumentImportIdentity,
  createReminderDocumentImportIdentity,
  reconcileDocumentEvent
} from './document-reconciliation'

const form: EventForm = {
  id: null,
  calendarId: 'calendar:local',
  title: 'Project kick-off',
  description: '',
  location: 'Science & Engineering South, Room 130',
  startDate: '2026-08-24',
  startTime: '14:00',
  endDate: '2026-08-24',
  endTime: '14:50',
  timezone: 'America/Chicago',
  allDay: false,
  recurrence: null
}

const source = (character: string, row: string): DocumentImportSourceIdentity => ({
  sourceSha256: character.repeat(64),
  sourceRowId: `row:${row.repeat(16)}`
})

function event(
  inputForm: EventForm,
  importIdentity: EventEntity['importIdentity'],
  id = 'event:existing'
): EventEntity {
  return {
    id,
    calendarId: 'calendar:local',
    title: inputForm.title,
    description: inputForm.description,
    location: inputForm.location,
    startUtc: '2026-08-24T19:00:00.000Z',
    endUtc: '2026-08-24T19:50:00.000Z',
    timezone: inputForm.timezone,
    allDay: inputForm.allDay,
    recurrence: inputForm.recurrence,
    status: 'active',
    provenance: 'import',
    importIdentity,
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z'
  }
}

describe('document reconciliation', () => {
  it('canonicalizes common building aliases before comparing locations', () => {
    expect(canonicalDocumentLocation('Science & Engineering South, Room 130')).toBe('ses 130')
    expect(canonicalDocumentLocation('SES 130')).toBe('ses 130')
  })

  it('shows a semantic match from another source as a reviewable likely duplicate', () => {
    const candidateIdentity = createEventDocumentImportIdentity(source('a', '1'), form, null)
    const existingForm = { ...form, location: 'SES 130' }
    const existingIdentity = createEventDocumentImportIdentity(source('b', '2'), existingForm, null)

    expect(
      reconcileDocumentEvent(candidateIdentity, form, [event(existingForm, existingIdentity)])
    ).toMatchObject({
      state: 'likely-duplicate',
      recommendedSelected: false,
      matches: [{ relationship: 'same-semantic-item' }]
    })
  })

  it('tolerates punctuation, accidental spacing, one typo, and a longer location label', () => {
    const candidateIdentity = createEventDocumentImportIdentity(source('a', '8'), form, null)
    const existingForm = {
      ...form,
      title: 'Project kickof',
      location: 'Chicago, SES 130'
    }
    const existingIdentity = createEventDocumentImportIdentity(source('b', '9'), existingForm, null)

    expect(
      reconcileDocumentEvent(candidateIdentity, form, [event(existingForm, existingIdentity)])
    ).toMatchObject({
      state: 'likely-duplicate',
      recommendedSelected: false,
      matches: [{ relationship: 'likely-semantic-overlap' }]
    })
  })

  it('treats the same source row as imported even when an edited form changes its semantic key', () => {
    const existingIdentity = createEventDocumentImportIdentity(source('a', '3'), form, null)
    const editedForm = { ...form, title: 'Project kick-off — revised' }
    const candidateIdentity = createEventDocumentImportIdentity(source('a', '3'), editedForm, null)

    expect(
      reconcileDocumentEvent(candidateIdentity, editedForm, [event(form, existingIdentity)])
    ).toMatchObject({
      state: 'same-source',
      recommendedSelected: false,
      matches: [{ relationship: 'same-source-row' }]
    })
  })

  it('finds a same-source row across entity kinds after the old reminder was completed', () => {
    const reminderForm: ReminderForm = {
      id: null,
      calendarId: 'calendar:local',
      title: 'Project kick-off',
      notes: '',
      dueDate: '2026-08-24',
      dueTime: '14:00',
      timezone: 'America/Chicago',
      recurrence: null
    }
    const sharedSource = source('e', '6')
    const reminderIdentity = createReminderDocumentImportIdentity(sharedSource, reminderForm)
    const reminder: ReminderEntity = {
      id: 'reminder:completed',
      calendarId: 'calendar:local',
      title: reminderForm.title,
      notes: '',
      dueAtUtc: '2026-08-24T19:00:00.000Z',
      timezone: reminderForm.timezone,
      recurrence: null,
      status: 'completed',
      completedAt: '2026-08-24T19:01:00.000Z',
      provenance: 'import',
      importIdentity: reminderIdentity,
      createdAt: '2026-08-20T12:00:00.000Z',
      updatedAt: '2026-08-24T19:01:00.000Z'
    }
    const candidateIdentity = createEventDocumentImportIdentity(sharedSource, form, null)

    expect(reconcileDocumentEvent(candidateIdentity, form, [], [reminder])).toMatchObject({
      state: 'same-source',
      recommendedSelected: false,
      matches: [{ entityKind: 'reminder', relationship: 'same-source-row' }]
    })
  })

  it('never auto-merges overlapping class rows with different CRNs or components', () => {
    const recurrence: NonNullable<EventForm['recurrence']> = {
      frequency: 'weekly',
      interval: 1,
      byWeekday: ['monday', 'wednesday', 'friday'],
      byMonthDay: [],
      end: { kind: 'until', date: '2026-12-04' }
    }
    const candidateForm: EventForm = { ...form, title: 'CS 251', recurrence }
    const lecture: DocumentScheduleMetadata = {
      courseCode: 'CS 251',
      sectionCode: 'A',
      crn: '12345',
      creditHours: 4,
      component: 'lecture',
      termStartDate: '2026-08-24',
      termEndDate: '2026-12-04',
      weekdays: recurrence.byWeekday,
      verification: 'layout'
    }
    const laboratory: DocumentScheduleMetadata = {
      ...lecture,
      sectionCode: 'B',
      crn: '67890',
      creditHours: 0,
      component: 'laboratory'
    }
    const candidateIdentity = createEventDocumentImportIdentity(
      source('c', '4'),
      candidateForm,
      lecture
    )
    const existingIdentity = createEventDocumentImportIdentity(
      source('d', '5'),
      candidateForm,
      laboratory
    )

    expect(
      reconcileDocumentEvent(candidateIdentity, candidateForm, [
        event(candidateForm, existingIdentity)
      ])
    ).toMatchObject({
      state: 'protected-distinct',
      recommendedSelected: true,
      matches: [{ relationship: 'protected-distinct-course' }]
    })
  })

  it('flags a revised time as likely when the course registration identity is unchanged', () => {
    const recurrence: NonNullable<EventForm['recurrence']> = {
      frequency: 'weekly',
      interval: 1,
      byWeekday: ['monday', 'wednesday'],
      byMonthDay: [],
      end: { kind: 'until', date: '2026-12-04' }
    }
    const schedule: DocumentScheduleMetadata = {
      courseCode: 'CS 251',
      sectionCode: 'A',
      crn: '12345',
      creditHours: 4,
      component: 'lecture',
      termStartDate: '2026-08-24',
      termEndDate: '2026-12-04',
      weekdays: recurrence.byWeekday,
      verification: 'layout'
    }
    const existingForm: EventForm = { ...form, title: 'CS 251', recurrence }
    const revisedForm: EventForm = {
      ...existingForm,
      startTime: '15:00',
      endTime: '15:50'
    }
    const existingIdentity = createEventDocumentImportIdentity(
      source('c', 'a'),
      existingForm,
      schedule
    )
    const revisedIdentity = createEventDocumentImportIdentity(
      source('d', 'b'),
      revisedForm,
      schedule
    )

    expect(
      reconcileDocumentEvent(revisedIdentity, revisedForm, [event(existingForm, existingIdentity)])
    ).toMatchObject({
      state: 'likely-duplicate',
      recommendedSelected: false,
      matches: [{ relationship: 'likely-semantic-overlap' }]
    })
  })

  it('prioritizes a same-source row over a long list of distinct class matches', () => {
    const recurrence: NonNullable<EventForm['recurrence']> = {
      frequency: 'weekly',
      interval: 1,
      byWeekday: ['monday'],
      byMonthDay: [],
      end: { kind: 'until', date: '2026-12-04' }
    }
    const classForm: EventForm = { ...form, title: 'CS 251', recurrence }
    const schedule: DocumentScheduleMetadata = {
      courseCode: 'CS 251',
      sectionCode: 'A',
      crn: '12345',
      creditHours: 4,
      component: 'lecture',
      termStartDate: '2026-08-24',
      termEndDate: '2026-12-04',
      weekdays: ['monday'],
      verification: 'layout'
    }
    const sharedSource = source('f', '7')
    const candidateIdentity = createEventDocumentImportIdentity(sharedSource, classForm, schedule)
    const distinctEvents = Array.from({ length: 6 }, (_, index) => {
      const distinctSchedule: DocumentScheduleMetadata = {
        ...schedule,
        sectionCode: `B${index}`,
        crn: `9000${index}`,
        component: 'laboratory'
      }
      return event(
        classForm,
        createEventDocumentImportIdentity(
          source(index % 2 === 0 ? 'a' : 'b', String(index + 1)),
          classForm,
          distinctSchedule
        ),
        `event:distinct:${index}`
      )
    })
    const sameSourceEvent = event(classForm, candidateIdentity, 'event:same-source')

    const reconciliation = reconcileDocumentEvent(candidateIdentity, classForm, [
      ...distinctEvents,
      sameSourceEvent
    ])
    expect(reconciliation.state).toBe('same-source')
    expect(reconciliation.matches[0]?.relationship).toBe('same-source-row')
  })
})
