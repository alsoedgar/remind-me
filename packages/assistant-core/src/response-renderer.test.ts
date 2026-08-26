import { describe, expect, it } from 'vitest'
import { createGroundedReply, renderResponsePlan, replyFingerprint } from './response-renderer'

describe('grounded response renderer', () => {
  it('protects and renders verified facts', () => {
    const reply = createGroundedReply({
      requestId: 'request:one',
      speechAct: 'availability-answer',
      facts: [
        { key: 'SLOT', kind: 'time', value: 'Friday at 2:00 PM' },
        { key: 'DETAIL', kind: 'text', value: 'you have no events then' }
      ],
      templates: ['<SLOT> is open; <DETAIL>.']
    })
    expect(reply.text).toBe('Friday at 2:00 PM is open; you have no events then.')
    expect(renderResponsePlan(reply.plan)).toBe(reply.text)
  })

  it('selects a different eligible template when a recent fingerprint collides', () => {
    const firstTemplate = '<SUMMARY> is ready.'
    const secondTemplate = 'I have <SUMMARY> ready for review.'
    const first = createGroundedReply({
      requestId: 'request:stable',
      speechAct: 'proposal',
      facts: [{ key: 'SUMMARY', kind: 'text', value: 'Lunch tomorrow' }],
      templates: [firstTemplate, secondTemplate]
    })
    const second = createGroundedReply({
      requestId: 'request:stable',
      speechAct: 'proposal',
      facts: [{ key: 'SUMMARY', kind: 'text', value: 'Lunch tomorrow' }],
      templates: [firstTemplate, secondTemplate],
      recentReplies: [first.text]
    })
    expect(replyFingerprint(second.text)).not.toBe(replyFingerprint(first.text))
  })

  it('rejects templates that omit a protected fact', () => {
    expect(() =>
      createGroundedReply({
        requestId: 'request:unsafe',
        speechAct: 'schedule-summary',
        facts: [{ key: 'SUMMARY', kind: 'text', value: 'one event' }],
        templates: ['Here is your schedule.']
      })
    ).toThrow(/protected fact/u)
  })

  it('rejects generated factual literals and preserves the deterministic fallback', () => {
    const reply = createGroundedReply({
      requestId: 'request:hostile-surface',
      speechAct: 'schedule-summary',
      facts: [{ key: 'SUMMARY', kind: 'text', value: 'one verified event' }],
      templates: ['Your calendar has <SUMMARY>.'],
      templateGenerator: {
        generateTemplates: () => ['Invented Monday at 9:00 AM with <SUMMARY>.']
      }
    })
    expect(reply.source).toBe('template')
    expect(reply.text).toBe('Your calendar has one verified event.')
  })

  it('fingerprints the selected phrase independently from protected fact values', () => {
    const first = createGroundedReply({
      requestId: 'request:phrase-one',
      speechAct: 'next-item-answer',
      facts: [{ key: 'SUMMARY', kind: 'text', value: 'Calculus' }],
      templates: ['Next is <SUMMARY>.']
    })
    const second = createGroundedReply({
      requestId: 'request:phrase-two',
      speechAct: 'next-item-answer',
      facts: [{ key: 'SUMMARY', kind: 'text', value: 'Data Structures' }],
      templates: ['Next is <SUMMARY>.']
    })

    expect(first.templateFingerprint).toBe(second.templateFingerprint)
    expect(first.fingerprint).not.toBe(second.fingerprint)
  })
})
