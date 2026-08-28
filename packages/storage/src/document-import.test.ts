import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CalendarSnapshotRequest, EventForm, ReviewedDocumentItem } from '@remind-me/contracts'
import { PersistentCalendarService } from './calendar-service'
import { SqliteCalendarRepository } from './sqlite-repository'

const temporaryDirectories: string[] = []
const range: CalendarSnapshotRequest = {
  rangeStartUtc: '2026-08-01T00:00:00.000Z',
  rangeEndUtc: '2026-10-01T00:00:00.000Z'
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function service(): Promise<{
  calendar: PersistentCalendarService
  repository: SqliteCalendarRepository
}> {
  const directory = await mkdtemp(join(tmpdir(), 'remind-me-document-import-'))
  temporaryDirectories.push(directory)
  const repository = new SqliteCalendarRepository(join(directory, 'calendar.sqlite3'))
  return { calendar: new PersistentCalendarService(repository), repository }
}

const reviewedItems: ReviewedDocumentItem[] = [
  {
    draftId: 'draft:event',
    kind: 'event',
    sourceIdentity: {
      sourceSha256: 'a'.repeat(64),
      sourceRowId: 'row:0000000000000001'
    },
    schedule: null,
    form: {
      id: null,
      calendarId: 'calendar:local',
      title: 'Project kickoff',
      description: '',
      location: 'Studio A',
      startDate: '2026-08-26',
      startTime: '09:00',
      endDate: '2026-08-26',
      endTime: '10:00',
      timezone: 'America/Chicago',
      allDay: false,
      recurrence: null
    }
  },
  {
    draftId: 'draft:reminder',
    kind: 'reminder',
    sourceIdentity: {
      sourceSha256: 'a'.repeat(64),
      sourceRowId: 'row:0000000000000002'
    },
    schedule: null,
    form: {
      id: null,
      calendarId: 'calendar:local',
      title: 'Submit portfolio',
      notes: '',
      dueDate: '2026-08-30',
      dueTime: '18:00',
      timezone: 'America/Chicago',
      recurrence: null
    }
  }
]

describe('reviewed document imports', () => {
  it('applies a batch atomically with import provenance and one undo receipt', async () => {
    const { calendar, repository } = await service()
    try {
      const imported = calendar.importReviewedDocumentItems(reviewedItems, 'week-plan.pdf', range)
      expect(imported.snapshot.events).toHaveLength(1)
      expect(imported.snapshot.reminders).toHaveLength(1)
      expect(imported.snapshot.events[0]?.provenance).toBe('import')
      expect(imported.snapshot.reminders[0]?.provenance).toBe('import')
      expect(imported.snapshot.events[0]?.importIdentity).toMatchObject({
        sourceSha256: 'a'.repeat(64),
        sourceRowId: 'row:0000000000000001',
        semanticKind: 'event'
      })
      expect(imported.snapshot.reminders[0]?.importIdentity).toMatchObject({
        sourceSha256: 'a'.repeat(64),
        sourceRowId: 'row:0000000000000002',
        semanticKind: 'reminder'
      })
      expect(imported.receipt.summary).toContain('week-plan.pdf')
      const undone = calendar.undoLastAction(range)
      expect(undone.snapshot.events).toEqual([])
      expect(undone.snapshot.reminders).toEqual([])
      const reimported = calendar.importReviewedDocumentItems(reviewedItems, 'week-plan.pdf', range)
      expect(reimported.snapshot.events).toHaveLength(1)
      expect(reimported.snapshot.reminders).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('validates every reviewed item before opening the storage transaction', async () => {
    const { calendar, repository } = await service()
    try {
      const invalid = structuredClone(reviewedItems)
      if (invalid[1]?.kind === 'reminder') invalid[1].form.title = ''
      expect(() => calendar.importReviewedDocumentItems(invalid, 'broken.png', range)).toThrow()
      expect(calendar.getSnapshot(range).events).toEqual([])
      expect(calendar.getSnapshot(range).reminders).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('rejects a repeated source row inside one reviewed batch', async () => {
    const { calendar, repository } = await service()
    try {
      const first = reviewedItems[0]
      if (first?.kind !== 'event') throw new Error('Expected the reviewed event')
      const repeated = structuredClone(first)
      repeated.draftId = 'draft:event-repeat'
      repeated.form.title = 'A second interpretation of the same row'
      expect(() =>
        calendar.importReviewedDocumentItems([first, repeated], 'ambiguous.pdf', range)
      ).toThrow(/same source row twice/iu)
      expect(calendar.getSnapshot(range).events).toEqual([])
    } finally {
      repository.close()
    }
  })

  it('refuses to import the same reviewed document items twice', async () => {
    const { calendar, repository } = await service()
    try {
      calendar.importReviewedDocumentItems(reviewedItems, 'week-plan.pdf', range)
      expect(() =>
        calendar.importReviewedDocumentItems(reviewedItems, 'week-plan.pdf', range)
      ).toThrow(/imported already/iu)
      const snapshot = calendar.getSnapshot(range)
      expect(snapshot.events).toHaveLength(1)
      expect(snapshot.reminders).toHaveLength(1)
    } finally {
      repository.close()
    }
  })

  it('allows an explicitly selected semantic duplicate from a different source row', async () => {
    const { calendar, repository } = await service()
    try {
      calendar.importReviewedDocumentItems([reviewedItems[0]!], 'first.pdf', range)
      const second = structuredClone(reviewedItems[0]!)
      second.draftId = 'draft:event-copy'
      second.sourceIdentity = {
        sourceSha256: 'b'.repeat(64),
        sourceRowId: 'row:0000000000000009'
      }
      const imported = calendar.importReviewedDocumentItems([second], 'second.pdf', range)
      expect(imported.snapshot.events).toHaveLength(2)
      expect(
        new Set(imported.snapshot.events.map((event) => event.importIdentity?.semanticKey)).size
      ).toBe(1)
    } finally {
      repository.close()
    }
  })

  it('persists source identity across restart and refreshes it after an edit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remind-me-document-identity-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'calendar.sqlite3')
    const firstRepository = new SqliteCalendarRepository(databasePath)
    const firstService = new PersistentCalendarService(firstRepository)
    const imported = firstService.importReviewedDocumentItems(
      [reviewedItems[0]!],
      'first.pdf',
      range
    )
    const original = imported.snapshot.events[0]
    if (!original?.importIdentity) throw new Error('Expected a persisted import identity')
    const originalSemanticKey = original.importIdentity.semanticKey
    firstRepository.close()

    const reopenedRepository = new SqliteCalendarRepository(databasePath)
    const reopenedService = new PersistentCalendarService(reopenedRepository)
    try {
      const reopened = reopenedRepository.getEvent(original.id)
      expect(reopened?.importIdentity).toEqual(original.importIdentity)
      const reviewedEvent = reviewedItems[0]
      if (reviewedEvent?.kind !== 'event') throw new Error('Expected the reviewed event')
      const edited = reopenedService.saveEvent(
        { ...reviewedEvent.form, id: original.id, title: 'Project kickoff revised' },
        range
      ).snapshot.events[0]
      expect(edited?.importIdentity).toMatchObject({
        sourceSha256: original.importIdentity.sourceSha256,
        sourceRowId: original.importIdentity.sourceRowId
      })
      expect(edited?.importIdentity?.semanticKey).not.toBe(originalSemanticKey)

      reopenedService.deleteEvent(original.id, range)
      const reimported = reopenedService.importReviewedDocumentItems(
        [reviewedEvent],
        'first.pdf',
        range
      )
      expect(reimported.snapshot.events).toHaveLength(1)
    } finally {
      reopenedRepository.close()
    }
  })

  it('keeps similar class rows distinct when their CRNs or components differ', async () => {
    const { calendar, repository } = await service()
    try {
      const baseForm: EventForm = {
        id: null,
        calendarId: 'calendar:local',
        title: 'CS 251',
        description: 'Course: CS 251',
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
          byWeekday: ['monday', 'wednesday', 'friday'],
          byMonthDay: [],
          end: { kind: 'until', date: '2026-12-04' }
        }
      }
      const classItems: ReviewedDocumentItem[] = [
        {
          draftId: 'draft:lecture',
          kind: 'event',
          sourceIdentity: {
            sourceSha256: 'c'.repeat(64),
            sourceRowId: 'row:0000000000000010'
          },
          schedule: {
            courseCode: 'CS 251',
            sectionCode: 'A',
            crn: '12345',
            creditHours: 4,
            component: 'lecture',
            termStartDate: '2026-08-24',
            termEndDate: '2026-12-04',
            weekdays: ['monday', 'wednesday', 'friday'],
            verification: 'layout'
          },
          form: { ...baseForm, description: 'Course: CS 251 · Section: A · CRN: 12345 · Lecture' }
        },
        {
          draftId: 'draft:lab',
          kind: 'event',
          sourceIdentity: {
            sourceSha256: 'c'.repeat(64),
            sourceRowId: 'row:0000000000000011'
          },
          schedule: {
            courseCode: 'CS 251',
            sectionCode: 'B',
            crn: '67890',
            creditHours: 0,
            component: 'laboratory',
            termStartDate: '2026-08-24',
            termEndDate: '2026-12-04',
            weekdays: ['monday', 'wednesday', 'friday'],
            verification: 'layout'
          },
          form: {
            ...baseForm,
            description: 'Course: CS 251 · Section: B · CRN: 67890 · Laboratory'
          }
        }
      ]
      const imported = calendar.importReviewedDocumentItems(classItems, 'classes.pdf', range)
      expect(imported.snapshot.events).toHaveLength(2)
      expect(
        imported.snapshot.events.map((event) => event.importIdentity?.course?.crn).sort()
      ).toEqual(['12345', '67890'])
      expect(
        new Set(imported.snapshot.events.map((event) => event.importIdentity?.semanticKey)).size
      ).toBe(2)
    } finally {
      repository.close()
    }
  })
})
