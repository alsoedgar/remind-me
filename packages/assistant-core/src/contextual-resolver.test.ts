import { describe, expect, it } from 'vitest'
import { assistantDialogueStateSchema, type AssistantQueryFrameItem } from '@remind-me/contracts'
import { resolveContextualRequest, type ContextualItemDescriptor } from './contextual-resolver'

const at = '2026-08-28T15:00:00.000Z'
const range = {
  rangeStartUtc: '2026-08-31T05:00:00.000Z',
  rangeEndUtc: '2026-09-01T05:00:00.000Z',
  timezone: 'America/Chicago'
}
const items: AssistantQueryFrameItem[] = [
  { kind: 'event', id: 'event:algebra', occurrenceStart: '2026-08-31T17:00:00.000Z' },
  { kind: 'event', id: 'event:calculus', occurrenceStart: '2026-08-31T18:00:00.000Z' },
  { kind: 'event', id: 'event:lab', occurrenceStart: '2026-08-31T19:00:00.000Z' },
  { kind: 'reminder', id: 'reminder:essay', occurrenceStart: '2026-08-31T22:00:00.000Z' }
]
const descriptors: ContextualItemDescriptor[] = [
  { item: items[0]!, title: 'Applied Linear Algebra', categories: ['event', 'class', 'lecture'] },
  { item: items[1]!, title: 'Calculus III', categories: ['event', 'class', 'lecture'] },
  { item: items[2]!, title: 'CS 251 Lab', categories: ['event', 'class', 'lab'] },
  { item: items[3]!, title: 'Submit essay', categories: ['reminder'] }
]

function state(
  resultCursor: number | null = null,
  selectedItems: readonly AssistantQueryFrameItem[] = items,
  continuationCursor: number | null = null
) {
  return assistantDialogueStateSchema.parse({
    version: 2,
    focusedEventIds: ['event:algebra', 'event:calculus', 'event:lab'],
    focusedReminderIds: ['reminder:essay'],
    lastResultEventIds: ['event:algebra', 'event:calculus', 'event:lab'],
    lastResultReminderIds: ['reminder:essay'],
    lastQuery: null,
    activeRange: range,
    pendingClarification: null,
    queryFrames: [
      {
        frameId: 'frame:current',
        operation: 'calendar.list',
        range,
        orderedItems: items,
        selectedItems,
        requestedFields: ['name'],
        resultCursor,
        continuationCursor,
        createdAt: at
      }
    ],
    activeQueryFrameId: 'frame:current',
    updatedAt: at
  })
}

describe('typed contextual resolver', () => {
  it('resolves a bare plural time question over all ordered results', () => {
    expect(
      resolveContextualRequest({ text: 'what times?', state: state(), items: descriptors })
    ).toMatchObject({
      kind: 'resolved',
      intent: 'list',
      fields: ['time'],
      scope: 'all',
      selectedItems: items
    })
  })

  it('keeps multi-selection order for ordinal references', () => {
    expect(
      resolveContextualRequest({
        text: 'what rooms are the frist and third ones in?',
        state: state(),
        items: descriptors
      })
    ).toMatchObject({
      kind: 'resolved',
      fields: ['location'],
      scope: 'selected',
      selectedItems: [items[0], items[2]]
    })
  })

  it('treats last as a duration verb rather than an ordinal in a contextual question', () => {
    expect(
      resolveContextualRequest({
        text: 'how long does it last?',
        state: state(0, [items[0]!]),
        items: descriptors
      })
    ).toMatchObject({
      kind: 'resolved',
      fields: ['duration'],
      scope: 'one',
      selectedItems: [items[0]]
    })
  })

  it.each([
    ['how much time does each take?', ['duration']],
    ['tell me their descriptions', ['notes']],
    ['which weekdays are those classes?', ['recurrence']],
    ['quick summary please', ['name']],
    ['locatons?', ['location']],
    ['sumarize em', ['name']]
  ])('maps broad and noisy field wording: %s', (text, fields) => {
    expect(resolveContextualRequest({ text, state: state(), items: descriptors })).toMatchObject({
      kind: 'resolved',
      fields
    })
  })

  it.each([
    ['locations for numbers 2 and 3', [items[1], items[2]]],
    ['where are items one and two?', [items[0], items[1]]],
    ['times for the first two please', [items[0], items[1]]],
    ['which room is number two in?', [items[1]]],
    ['1st n 3rd times?', [items[0], items[2]]]
  ])('resolves human number variants: %s', (text, selectedItems) => {
    expect(resolveContextualRequest({ text, state: state(), items: descriptors })).toMatchObject({
      kind: 'resolved',
      selectedItems
    })
  })

  it('selects semantic item kinds and action intents', () => {
    expect(
      resolveContextualRequest({
        text: 'move the labs',
        state: state(),
        items: descriptors
      })
    ).toMatchObject({
      kind: 'resolved',
      intent: 'modify',
      scope: 'one',
      selectedItems: [items[2]]
    })
  })

  it('advances a stable result cursor', () => {
    expect(
      resolveContextualRequest({
        text: 'where is the next one?',
        state: state(1),
        items: descriptors
      })
    ).toMatchObject({
      kind: 'resolved',
      fields: ['location'],
      selectedItems: [items[2]],
      resultCursor: 2
    })
  })

  it('distinguishes the whole result, unselected others, and paged continuation', () => {
    expect(
      resolveContextualRequest({
        text: 'show all of them',
        state: state(0, [items[0]!]),
        items: descriptors
      })
    ).toMatchObject({ kind: 'resolved', scope: 'all', selectedItems: items })

    expect(
      resolveContextualRequest({
        text: 'what about the others?',
        state: state(0, [items[0]!]),
        items: descriptors
      })
    ).toMatchObject({
      kind: 'resolved',
      intent: 'continue',
      selectedItems: [items[1], items[2], items[3]]
    })

    expect(
      resolveContextualRequest({
        text: 'continue',
        state: state(null, items, 2),
        items: descriptors
      })
    ).toMatchObject({
      kind: 'resolved',
      intent: 'continue',
      fields: ['name'],
      selectedItems: items
    })
  })

  it('gives a specific completion message when no continuation remains', () => {
    expect(
      resolveContextualRequest({ text: 'next page', state: state(), items: descriptors })
    ).toMatchObject({
      kind: 'clarification',
      message: 'That result is already fully shown.'
    })
  })

  it('asks for a target when a singular pronoun follows a plural selection', () => {
    expect(
      resolveContextualRequest({ text: 'where is it?', state: state(), items: descriptors })
    ).toMatchObject({ kind: 'clarification', message: 'Which item do you mean?' })
  })

  it('does not hijack general chat or a fresh date-scoped query', () => {
    expect(
      resolveContextualRequest({ text: 'hello', state: state(), items: descriptors })
    ).toBeNull()
    expect(
      resolveContextualRequest({
        text: 'what time is my first class tomorrow?',
        state: state(),
        items: descriptors
      })
    ).toBeNull()
  })
})
