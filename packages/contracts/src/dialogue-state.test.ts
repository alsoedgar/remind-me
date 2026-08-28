import { describe, expect, it } from 'vitest'
import {
  assistantDialogueStateSchema,
  emptyAssistantDialogueState,
  upgradeAssistantDialogueState
} from './dialogue-state'

const answeredAt = '2026-08-28T15:00:00.000Z'

describe('assistant dialogue state', () => {
  it('starts with a versioned empty query-frame history', () => {
    expect(emptyAssistantDialogueState(answeredAt)).toMatchObject({
      version: 2,
      queryFrames: [],
      activeQueryFrameId: null
    })
  })

  it('upgrades v1 payloads without losing query focus', () => {
    const upgraded = upgradeAssistantDialogueState(
      {
        version: 1,
        focusedEventIds: ['event:class'],
        focusedReminderIds: [],
        lastResultEventIds: ['event:class', 'event:lab'],
        lastResultReminderIds: ['reminder:essay'],
        lastQuery: {
          requestId: 'request:legacy',
          operation: 'calendar.list',
          sourceText: 'What do I have tomorrow?',
          rangeStartUtc: '2026-08-29T05:00:00.000Z',
          rangeEndUtc: '2026-08-30T05:00:00.000Z',
          queryText: null,
          answeredAt
        },
        activeRange: {
          rangeStartUtc: '2026-08-29T05:00:00.000Z',
          rangeEndUtc: '2026-08-30T05:00:00.000Z',
          timezone: 'America/Chicago'
        },
        pendingClarification: null,
        updatedAt: answeredAt
      },
      '2026-08-28T15:01:00.000Z'
    )

    expect(upgraded).toMatchObject({
      version: 2,
      focusedEventIds: ['event:class'],
      activeQueryFrameId: 'frame:request:legacy'
    })
    expect(upgraded.queryFrames[0]).toMatchObject({
      frameId: 'frame:request:legacy',
      orderedItems: [
        { kind: 'event', id: 'event:class', occurrenceStart: null },
        { kind: 'event', id: 'event:lab', occurrenceStart: null },
        { kind: 'reminder', id: 'reminder:essay', occurrenceStart: null }
      ],
      selectedItems: [{ kind: 'event', id: 'event:class', occurrenceStart: null }],
      continuationCursor: null
    })
  })

  it('defaults continuation state for dialogue payloads written by early v2 builds', () => {
    const parsed = assistantDialogueStateSchema.parse({
      ...emptyAssistantDialogueState(answeredAt),
      queryFrames: [
        {
          frameId: 'frame:early-v2',
          operation: 'calendar.list',
          range: {
            rangeStartUtc: '2026-08-29T05:00:00.000Z',
            rangeEndUtc: '2026-08-30T05:00:00.000Z',
            timezone: 'America/Chicago'
          },
          orderedItems: [
            { kind: 'event', id: 'event:one', occurrenceStart: '2026-08-29T15:00:00.000Z' }
          ],
          selectedItems: [
            { kind: 'event', id: 'event:one', occurrenceStart: '2026-08-29T15:00:00.000Z' }
          ],
          requestedFields: ['name'],
          resultCursor: null,
          createdAt: answeredAt
        }
      ],
      activeQueryFrameId: 'frame:early-v2'
    })

    expect(parsed.queryFrames[0]?.continuationCursor).toBeNull()
  })

  it('rejects selections that are not in the ordered result', () => {
    expect(() =>
      assistantDialogueStateSchema.parse({
        ...emptyAssistantDialogueState(answeredAt),
        queryFrames: [
          {
            frameId: 'frame:bad',
            operation: 'calendar.list',
            range: {
              rangeStartUtc: '2026-08-29T05:00:00.000Z',
              rangeEndUtc: '2026-08-30T05:00:00.000Z',
              timezone: 'America/Chicago'
            },
            orderedItems: [],
            selectedItems: [{ kind: 'event', id: 'event:missing', occurrenceStart: null }],
            requestedFields: ['time'],
            resultCursor: null,
            createdAt: answeredAt
          }
        ],
        activeQueryFrameId: 'frame:bad'
      })
    ).toThrow()
  })
})
