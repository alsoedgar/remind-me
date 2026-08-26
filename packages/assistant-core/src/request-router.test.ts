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
  })
})
