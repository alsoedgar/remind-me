import { describe, expect, it } from 'vitest'
import { renderGroundedAnswer, type GroundedAnswerItem } from './grounded-answer'

function item(index: number, overrides: Partial<GroundedAnswerItem> = {}): GroundedAnswerItem {
  return {
    key: `event:event-${index}:2026-09-${String(index + 1).padStart(2, '0')}T14:00:00.000Z`,
    kind: 'event',
    title: `Item ${index + 1}`,
    dateLabel: index < 5 ? 'Tuesday, September 1' : 'Wednesday, September 2',
    timeLabel: `${9 + (index % 5)}:00 AM`,
    detail: `${9 + (index % 5)}:00 AM, “Item ${index + 1}” at Room ${index + 1}`,
    attributes: {
      time: `${9 + (index % 5)}:00 AM–10:00 AM`,
      start: `${9 + (index % 5)}:00 AM`,
      end: '10:00 AM',
      date: index < 5 ? 'Tuesday, September 1' : 'Wednesday, September 2',
      location: `Room ${index + 1}`,
      duration: '1 hour',
      notes: 'no notes saved',
      recurrence: 'does not repeat'
    },
    ...overrides
  }
}

describe('grounded answer renderer', () => {
  it('keeps duplicate occurrences and disambiguates them without inventing facts', () => {
    const answer = renderGroundedAnswer({
      items: [
        item(0, { title: 'Studio', dateLabel: 'Monday, August 31', timeLabel: '9:00 AM' }),
        item(1, { title: 'Studio', dateLabel: 'Wednesday, September 2', timeLabel: '1:00 PM' })
      ],
      locale: 'en-US',
      mode: 'names'
    })

    expect(answer.text).toContain('Studio (Monday, August 31, 9:00 AM)')
    expect(answer.text).toContain('Studio (Wednesday, September 2, 1:00 PM)')
    expect(answer.presentedKeys).toHaveLength(2)
  })

  it('groups large results and returns a durable next cursor', () => {
    const items = Array.from({ length: 11 }, (_, index) => item(index))
    const first = renderGroundedAnswer({ items, locale: 'en-US', mode: 'names' })
    expect(first.text).toContain('Tuesday, September 1:')
    expect(first.text).toContain('Wednesday, September 2:')
    expect(first.text).toContain('Showing 1–8 of 11. Say “continue” for the next 3.')
    expect(first.nextCursor).toBe(8)

    const second = renderGroundedAnswer({
      items,
      locale: 'en-US',
      mode: 'names',
      startIndex: first.nextCursor ?? 0
    })
    expect(second.text).toContain('Showing 9–11 of 11.')
    expect(second.text).not.toContain('Item 1;')
    expect(second.nextCursor).toBeNull()
  })

  it('returns only requested attributes and explains stale selections', () => {
    const answer = renderGroundedAnswer({
      items: [item(0, { attributes: { location: 'no room or location saved' } })],
      locale: 'en-US',
      mode: 'attributes',
      fields: ['location'],
      staleCount: 1
    })

    expect(answer.text).toBe(
      'Item 1 — no room or location saved. I skipped 1 deleted or unavailable item.'
    )
    expect(answer.text).not.toContain('9:00 AM')
  })
})
