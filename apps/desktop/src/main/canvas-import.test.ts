import { describe, expect, it } from 'vitest'
import type { CanvasAssignment } from '@remind-me/contracts'
import { PersistentCalendarService, SqliteCalendarRepository } from '@remind-me/storage'
import { buildCanvasImportPlan } from './canvas-import'

const assignment: CanvasAssignment = {
  sourceKey: 'canvas:assignment-one',
  assignmentId: '1',
  courseId: '44',
  courseName: 'Calculus III',
  title: 'Second exam',
  dueAtUtc: '2026-09-01T03:30:00.000Z',
  description: 'Bring a pencil.',
  pointsPossible: 100,
  importKind: null
}

describe('Canvas calendar importer', () => {
  it('turns selected due dates into locally timed reminders', () => {
    const plan = buildCanvasImportPlan({
      assignments: [assignment],
      targetKind: 'reminder',
      timezone: 'America/Chicago',
      existingLinks: [],
      localEntityExists: () => false,
      createId: () => 'reminder:canvas-one'
    })

    expect(plan).toMatchObject({
      createdCount: 1,
      updatedCount: 0,
      links: [
        {
          sourceKey: 'canvas:assignment-one',
          entityKind: 'reminder',
          entityId: 'reminder:canvas-one'
        }
      ],
      items: [
        {
          kind: 'reminder-save',
          form: {
            id: 'reminder:canvas-one',
            title: 'Second exam',
            dueDate: '2026-08-31',
            dueTime: '22:30',
            timezone: 'America/Chicago'
          }
        }
      ]
    })
    expect(plan.items[0]).toMatchObject({
      form: { notes: expect.stringContaining('Canvas assignment · Calculus III') }
    })
  })

  it('updates a prior linked calendar item rather than creating a duplicate', () => {
    const plan = buildCanvasImportPlan({
      assignments: [assignment],
      targetKind: 'reminder',
      timezone: 'America/Chicago',
      existingLinks: [
        {
          sourceKey: 'canvas:assignment-one',
          entityKind: 'event',
          entityId: 'event:canvas-one'
        }
      ],
      localEntityExists: () => true,
      createId: () => 'should-not-be-used'
    })

    expect(plan).toMatchObject({
      createdCount: 0,
      updatedCount: 1,
      links: [
        {
          sourceKey: 'canvas:assignment-one',
          entityKind: 'event',
          entityId: 'event:canvas-one'
        }
      ],
      items: [
        {
          kind: 'event-save',
          form: {
            id: 'event:canvas-one',
            allDay: true,
            startDate: '2026-08-31',
            endDate: '2026-08-31'
          }
        }
      ]
    })
  })

  it('does not create the same local item twice when a stale selection is repeated', () => {
    const plan = buildCanvasImportPlan({
      assignments: [assignment, assignment],
      targetKind: 'all-day-event',
      timezone: 'America/Chicago',
      existingLinks: [],
      localEntityExists: () => false,
      createId: () => 'event:canvas-one'
    })

    expect(plan.items).toHaveLength(1)
    expect(plan.createdCount).toBe(1)
  })

  it('creates the planned opaque ID in one undoable local batch', () => {
    const repository = new SqliteCalendarRepository(':memory:')
    try {
      const plan = buildCanvasImportPlan({
        assignments: [assignment],
        targetKind: 'reminder',
        timezone: 'America/Chicago',
        existingLinks: [],
        localEntityExists: () => false,
        createId: () => 'reminder:canvas-one'
      })
      const result = new PersistentCalendarService(repository).applyBatch(
        plan.items,
        'Added Canvas reminder.',
        {
          rangeStartUtc: '2026-08-01T00:00:00.000Z',
          rangeEndUtc: '2026-10-01T00:00:00.000Z'
        },
        {
          actor: 'import',
          operation: 'reminder.create',
          allowCreateWithId: true
        }
      )

      expect(result.snapshot.reminders).toContainEqual(
        expect.objectContaining({ id: 'reminder:canvas-one', title: 'Second exam' })
      )
      expect(result.receipt.undoable).toBe(true)
    } finally {
      repository.close()
    }
  })
})
