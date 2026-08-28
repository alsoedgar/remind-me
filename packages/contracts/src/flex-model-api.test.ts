import { describe, expect, it } from 'vitest'
import {
  flexModelCalendarFactPacketSchema,
  flexModelCalendarFallbackResultSchema,
  flexModelChatRequestSchema,
  flexModelChatResponseSchema,
  flexModelFallbackFailureKindSchema,
  flexModelGeneralFallbackResultSchema
} from './flex-model-api'

describe('typed flexible-model fallback results', () => {
  it('accepts only the documented runtime failure reasons', () => {
    expect(flexModelFallbackFailureKindSchema.options).toEqual([
      'missing',
      'disabled',
      'timeout',
      'cancelled',
      'unavailable',
      'invalid-output'
    ])
  })

  it('keeps structured calendar plans separate from free-form answers', () => {
    expect(
      flexModelCalendarFallbackResultSchema.parse({
        kind: 'plan',
        plan: {
          actions: [
            {
              sourceText: 'Add lunch tomorrow at noon',
              operation: 'event.create',
              titleText: 'lunch'
            }
          ]
        }
      })
    ).toMatchObject({ kind: 'plan' })
    expect(flexModelCalendarFallbackResultSchema.parse({ kind: 'not-calendar' })).toEqual({
      kind: 'not-calendar'
    })
    expect(
      flexModelCalendarFallbackResultSchema.safeParse({
        kind: 'answer',
        text: 'Done, I added it.'
      }).success
    ).toBe(false)
    expect(
      flexModelCalendarFallbackResultSchema.safeParse({ kind: 'plan', plan: null }).success
    ).toBe(false)
  })

  it('keeps general responses free of executable plans and ambiguous nulls', () => {
    expect(
      flexModelGeneralFallbackResultSchema.parse({
        kind: 'answer',
        text: 'Hello there.',
        factRefs: [],
        writeClaim: false
      })
    ).toEqual({ kind: 'answer', text: 'Hello there.', factRefs: [], writeClaim: false })
    expect(flexModelGeneralFallbackResultSchema.parse({ kind: 'timeout' })).toEqual({
      kind: 'timeout'
    })
    expect(
      flexModelGeneralFallbackResultSchema.safeParse({
        kind: 'plan',
        plan: { actions: [] }
      }).success
    ).toBe(false)
    expect(flexModelGeneralFallbackResultSchema.safeParse(null).success).toBe(false)
  })

  it('requires a bounded structured chat envelope and keeps summaries separate from memory', () => {
    const envelope = {
      kind: 'answer' as const,
      text: 'Your next class is {{F1.title}} at {{F1.time}}.',
      factRefs: [{ ref: 'F1', factId: 'event:class-1:2026-08-28', fields: ['title', 'time'] }],
      writeClaim: false
    }

    expect(flexModelChatResponseSchema.parse(envelope)).toEqual(envelope)
    expect(flexModelChatResponseSchema.safeParse({ ...envelope, writeClaim: null }).success).toBe(
      false
    )
    expect(
      flexModelChatRequestSchema.safeParse({
        text: 'What is next?',
        turns: [],
        calendarContext: '',
        currentLocalDateTime: '2026-08-28T09:00-05:00[America/Chicago]',
        timezone: 'America/Chicago',
        profile: {
          preferredName: '',
          customInstructions: '',
          memoryEnabled: false,
          memories: []
        },
        style: {
          warmth: 0.7,
          brevity: 0.58,
          formality: 0.3,
          humor: 0.08,
          emoji: 0,
          contractions: true,
          proactivity: 0.45
        }
      }).success
    ).toBe(false)
  })

  it('accepts stable, provenance-bearing calendar fact packets and rejects duplicate refs', () => {
    const packet = {
      schemaVersion: 1 as const,
      range: null,
      facts: [
        {
          ref: 'F1',
          factId: 'event:class-1:2026-08-28',
          entityId: 'class-1',
          kind: 'event' as const,
          priority: 'focused' as const,
          provenance: 'manual' as const,
          occurrenceStartUtc: '2026-08-28T15:00:00.000Z',
          fields: {
            title: 'Calculus III',
            date: 'Friday, August 28',
            time: '10:00 AM–10:50 AM',
            start: '10:00 AM',
            end: '10:50 AM',
            duration: '50 minutes',
            location: 'Room 311',
            notes: null,
            recurrence: 'Monday, Wednesday, and Friday',
            details: 'Calculus III · 10:00 AM–10:50 AM · Room 311',
            action: null,
            status: 'scheduled'
          }
        }
      ],
      truncated: false
    }

    expect(flexModelCalendarFactPacketSchema.parse(packet)).toEqual(packet)
    expect(
      flexModelCalendarFactPacketSchema.safeParse({
        ...packet,
        facts: [packet.facts[0], { ...packet.facts[0], factId: 'event:class-2:2026-08-28' }]
      }).success
    ).toBe(false)
  })
})
