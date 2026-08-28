import { describe, expect, it } from 'vitest'
import { routeAssistantRequest } from './request-router'

describe('hierarchical assistant request router', () => {
  it('classifies conversational text before calendar typo repair can distort it', () => {
    const routed = routeAssistantRequest('hey there')
    expect(routed).toMatchObject({
      route: 'conversation',
      conversationIntent: 'greeting'
    })
    expect(routed.originalText).toBe('hey there')
  })

  it('repairs only bounded colloquial calendar forms and records every rewrite', () => {
    const deletion = routeAssistantRequest('get rid of Old appointment')
    expect(deletion).toMatchObject({
      route: 'calendar',
      normalizedText: 'delete Old appointment',
      rewrites: [{ kind: 'colloquial-delete' }]
    })

    const move = routeAssistantRequest('push Project sync tomorrow to 3 pm', {
      knownTitles: ['Project sync']
    })
    expect(move.normalizedText).toBe('move Project sync to tomorrow at 3 pm')
    expect(move.rewrites.map((rewrite) => rewrite.kind)).toContain('colloquial-move')
  })

  it('canonicalizes common event and reminder idioms at every action boundary', () => {
    const routed = routeAssistantRequest(
      'pencil in yoga October 3, 2026 at 7 AM and do not let me forget to call Mom October 4, 2026 at 6 PM'
    )

    expect(routed.normalizedText).toBe(
      'add yoga october 3, 2026 at 7 AM and remind me to call Mom october 4, 2026 at 6 PM'
    )
    expect(routed.rewrites.map((rewrite) => rewrite.kind)).toEqual([
      'colloquial-create',
      'colloquial-reminder'
    ])
    expect(routeAssistantRequest('block off focus time tomorrow at 2 PM').normalizedText).toBe(
      'add focus time tomorrow at 2 PM'
    )
  })

  it('canonicalizes destructive and selected-item idioms only for known local titles', () => {
    const knownTitles = ['Design review', 'Water plants']
    const cases = [
      ['take Design review off my calendar', 'delete Design review'],
      [
        'bump Design review to October 8, 2026 at 3 PM',
        'move Design review to october 8, 2026 at 3 PM'
      ],
      [
        'make a copy of Design review on October 10, 2026',
        'duplicate Design review to october 10, 2026'
      ],
      ['cross Water plants off', 'complete Water plants'],
      ['Water plants is done', 'complete Water plants']
    ] as const

    for (const [source, expected] of cases) {
      const routed = routeAssistantRequest(source, { knownTitles })
      expect(routed.normalizedText).toBe(expected)
      expect(routed.rewrites.map((rewrite) => rewrite.kind)).toContain('colloquial-target-action')
    }

    expect(routeAssistantRequest('cross the street before lunch')).toMatchObject({
      route: 'broad-chat',
      rewrites: []
    })
    expect(
      routeAssistantRequest('take quarterly review off my calendar', { knownTitles }).normalizedText
    ).toBe('take quarterly review off my calendar')
  })

  it('preserves bullet boundaries and turns a list header into explicit actions', () => {
    const routed = routeAssistantRequest(
      'Add these:\n- gym tomorrow at 7 am\n- advising tomorrow at 1 pm\n- study group tomorrow at 6 pm'
    )
    expect(routed.normalizedText).toBe(
      'add gym tomorrow at 7 am; add advising tomorrow at 1 pm; add study group tomorrow at 6 pm'
    )
    expect(routed.rewrites).toMatchObject([{ kind: 'structured-list' }])
  })

  it('canonicalizes next-item and grounded calendar-reflection questions', () => {
    expect(routeAssistantRequest('whats th enext event?').normalizedText).toBe('what is next?')
    expect(
      routeAssistantRequest('What should I focus on next week based on my calendar?').normalizedText
    ).toBe('summarize next week with details')
  })

  it('does not treat arbitrary requests as calendar commands', () => {
    expect(routeAssistantRequest('write a poem about rain')).toMatchObject({
      route: 'broad-chat',
      rewrites: []
    })
    expect(routeAssistantRequest('push yourself to keep studying')).toMatchObject({
      route: 'broad-chat',
      rewrites: []
    })
    expect(routeAssistantRequest('get rid of this bad mood')).toMatchObject({
      route: 'broad-chat',
      rewrites: []
    })
    expect(routeAssistantRequest('pencil sketch ideas for my portfolio')).toMatchObject({
      route: 'broad-chat',
      rewrites: []
    })
  })
})
