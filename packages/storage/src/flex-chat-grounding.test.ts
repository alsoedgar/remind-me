import { describe, expect, it } from 'vitest'
import type { FlexModelCalendarFactPacket } from '@remind-me/contracts'
import { groundFlexChatResponse, safeGeneralChatStreamPrefix } from './flex-chat-grounding'

const packet: FlexModelCalendarFactPacket = {
  schemaVersion: 1,
  range: {
    startUtc: '2026-08-28T05:00:00.000Z',
    endUtc: '2026-08-29T05:00:00.000Z',
    timezone: 'America/Chicago'
  },
  facts: [
    {
      ref: 'F1',
      factId: 'event:calc-3:2026-08-28T15:00:00.000Z',
      entityId: 'calc-3',
      kind: 'event',
      priority: 'focused',
      provenance: 'import',
      occurrenceStartUtc: '2026-08-28T15:00:00.000Z',
      fields: {
        title: 'Calculus III',
        date: 'Friday, August 28',
        time: '10:00 AM–10:50 AM',
        start: '10:00 AM',
        end: '10:50 AM',
        duration: '50 minutes',
        location: 'Adams Hall 311',
        notes: null,
        recurrence: 'Monday, Wednesday, and Friday',
        details: 'Calculus III · 10:00 AM–10:50 AM · Adams Hall 311',
        action: null,
        status: 'scheduled'
      }
    },
    {
      ref: 'F2',
      factId: 'reminder:submit-project:2026-08-28T22:00:00.000Z',
      entityId: 'submit-project',
      kind: 'reminder',
      priority: 'range',
      provenance: 'assistant',
      occurrenceStartUtc: '2026-08-28T22:00:00.000Z',
      fields: {
        title: 'Submit project',
        date: 'Friday, August 28',
        time: '5:00 PM',
        start: '5:00 PM',
        end: null,
        duration: null,
        location: null,
        notes: 'Upload the final archive',
        recurrence: null,
        details: 'Submit project · 5:00 PM',
        action: null,
        status: 'open'
      }
    }
  ],
  truncated: false
}

describe('flexible chat grounding boundary', () => {
  it('streams broad-chat words with a safety lag and blocks false write claims', () => {
    expect(
      safeGeneralChatStreamPrefix(
        'You have room to take this one step',
        'Tell me something encouraging'
      )
    ).toBe('You have room to take this')
    expect(
      safeGeneralChatStreamPrefix('I added the meeting.', 'Tell me something encouraging')
    ).toBeNull()
  })

  it('renders only declared placeholders and returns their stable entity links', () => {
    expect(
      groundFlexChatResponse(
        {
          kind: 'answer',
          text: '{{F1.title}} starts at {{F1.start}} in {{F1.location}}.',
          factRefs: [
            {
              ref: 'F1',
              factId: 'event:calc-3:2026-08-28T15:00:00.000Z',
              fields: ['title', 'start', 'location']
            }
          ],
          writeClaim: false
        },
        packet,
        'What time is my first class today, and where is it?'
      )
    ).toEqual({
      ok: true,
      response: {
        kind: 'answer',
        text: 'Calculus III starts at 10:00 AM in Adams Hall 311.',
        relatedEventIds: ['calc-3'],
        relatedReminderIds: []
      }
    })
  })

  it.each([
    {
      label: 'unknown stable ID',
      response: {
        kind: 'answer',
        text: '{{F1.title}}.',
        factRefs: [{ ref: 'F1', factId: 'event:wrong', fields: ['title'] }],
        writeClaim: false
      }
    },
    {
      label: 'undeclared placeholder',
      response: {
        kind: 'answer',
        text: '{{F1.location}}.',
        factRefs: [{ ref: 'F1', factId: packet.facts[0]!.factId, fields: ['title'] }],
        writeClaim: false
      }
    },
    {
      label: 'unused declared fact field',
      response: {
        kind: 'answer',
        text: '{{F1.title}}.',
        factRefs: [{ ref: 'F1', factId: packet.facts[0]!.factId, fields: ['title', 'time'] }],
        writeClaim: false
      }
    },
    {
      label: 'copied fact outside a placeholder',
      response: {
        kind: 'answer',
        text: 'Calculus III begins soon.',
        factRefs: [],
        writeClaim: false
      }
    },
    {
      label: 'factual calendar answer without references',
      response: {
        kind: 'answer',
        text: 'You have one class then.',
        factRefs: [],
        writeClaim: false
      }
    },
    {
      label: 'invented time beside a grounded title',
      response: {
        kind: 'answer',
        text: '{{F1.title}} starts at 9:00 PM.',
        factRefs: [{ ref: 'F1', factId: packet.facts[0]!.factId, fields: ['title'] }],
        writeClaim: false
      }
    },
    {
      label: 'invented location beside a grounded title',
      response: {
        kind: 'answer',
        text: '{{F1.title}} is in Library Hall.',
        factRefs: [{ ref: 'F1', factId: packet.facts[0]!.factId, fields: ['title'] }],
        writeClaim: false
      }
    },
    {
      label: 'a time attached to the wrong titled fact',
      response: {
        kind: 'answer',
        text: '{{F1.title}} starts at {{F2.time}}.',
        factRefs: [
          { ref: 'F1', factId: packet.facts[0]!.factId, fields: ['title'] },
          { ref: 'F2', factId: packet.facts[1]!.factId, fields: ['time'] }
        ],
        writeClaim: false
      }
    },
    {
      label: 'a requested attribute omitted from grounded prose',
      response: {
        kind: 'answer',
        text: '{{F1.title}} is in {{F1.location}}.',
        factRefs: [
          {
            ref: 'F1',
            factId: packet.facts[0]!.factId,
            fields: ['title', 'location']
          }
        ],
        writeClaim: false
      }
    }
  ])('rejects $label before anything can be shown', ({ response }) => {
    expect(
      groundFlexChatResponse(response, packet, 'What time and location do I have today?')
    ).toEqual({
      ok: false,
      reason: 'fact-rejected'
    })
  })

  it.each([
    {
      kind: 'answer',
      text: 'I added the meeting.',
      factRefs: [],
      writeClaim: false
    },
    {
      kind: 'answer',
      text: 'The request is ready for review.',
      factRefs: [],
      writeClaim: true
    }
  ])('rejects calendar write claims even when calendar facts are not needed', (response) => {
    expect(
      groundFlexChatResponse(response, { ...packet, facts: [] }, 'Tell me what happened')
    ).toEqual({
      ok: false,
      reason: 'write-claim-rejected'
    })
  })

  it('preserves non-answer envelope kinds without forcing calendar references', () => {
    expect(
      groundFlexChatResponse(
        {
          kind: 'offline-limit',
          text: 'I cannot verify live train delays while offline.',
          factRefs: [],
          writeClaim: false
        },
        packet,
        'Is my train delayed?'
      )
    ).toEqual({
      ok: true,
      response: {
        kind: 'offline-limit',
        text: 'I cannot verify live train delays while offline.',
        relatedEventIds: [],
        relatedReminderIds: []
      }
    })
  })
})
