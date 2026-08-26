import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CalendarSnapshotRequest, ReviewedDocumentItem } from '@remind-me/contracts'
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
      expect(imported.receipt.summary).toContain('week-plan.pdf')
      const undone = calendar.undoLastAction(range)
      expect(undone.snapshot.events).toEqual([])
      expect(undone.snapshot.reminders).toEqual([])
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

  it('refuses to import the same reviewed document items twice', async () => {
    const { calendar, repository } = await service()
    try {
      calendar.importReviewedDocumentItems(reviewedItems, 'week-plan.pdf', range)
      expect(() =>
        calendar.importReviewedDocumentItems(reviewedItems, 'week-plan.pdf', range)
      ).toThrow(/already exists/iu)
      const snapshot = calendar.getSnapshot(range)
      expect(snapshot.events).toHaveLength(1)
      expect(snapshot.reminders).toHaveLength(1)
    } finally {
      repository.close()
    }
  })
})
