import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RemindSpeakPlanner,
  remindSpeakTemplateFingerprint,
  type RemindSpeakRequest
} from './remindspeak'

const modelRoot = fileURLToPath(new URL('../../../models/', import.meta.url))

const cozyStyle = {
  warmth: 0.82,
  brevity: 0.64,
  formality: 0.18,
  humor: 0.12,
  emoji: 0,
  contractions: true,
  proactivity: 0.48
}

function proposalRequest(recentReplies: readonly string[] = []): RemindSpeakRequest {
  return {
    requestId: `request:proposal:${recentReplies.length}`,
    speechAct: 'proposal',
    facts: [
      {
        key: 'SUMMARY',
        kind: 'text',
        placeholder: '<SUMMARY>',
        value: 'Create “Tea with Priya” tomorrow at 4:00 PM'
      }
    ],
    style: cozyStyle,
    recentReplies
  }
}

function render(template: string, request: RemindSpeakRequest): string {
  let output = template
  for (const fact of request.facts) output = output.replaceAll(fact.placeholder, fact.value)
  return output
}

describe('RemindSpeak protected PhraseLattice runtime', () => {
  it('loads compact project-trained teacher-assisted weights with honest provenance', async () => {
    const speaker = await RemindSpeakPlanner.load(modelRoot)
    expect(speaker.info).toMatchObject({
      available: true,
      mode: 'protected-overgenerate-rerank',
      candidateCount: 5,
      teacherUsed: true,
      networkRequired: false
    })
    expect(speaker.info.parameterCount).toBeGreaterThanOrEqual(25_000_000)
    expect(speaker.info.parameterCount).toBeLessThanOrEqual(35_000_000)
    expect(speaker.info.modelBytes).toBeLessThan(512 * 1024)
    expect(speaker.info.workingSetBytes).toBeLessThan(32 * 1024 * 1024)
  })

  it('overgenerates five unique candidates with every protected fact exactly once', async () => {
    const speaker = await RemindSpeakPlanner.load(modelRoot)
    const request = proposalRequest()
    const result = speaker.generate(request)
    expect(result.templates).toHaveLength(5)
    expect(new Set(result.templates).size).toBe(5)
    expect(result.candidatesEvaluated).toBe(350)
    for (const template of result.templates) {
      expect(template.match(/<SUMMARY>/gu)).toHaveLength(1)
      expect(template.match(/<[A-Z][A-Z0-9_]*>/gu)).toEqual(['<SUMMARY>'])
      expect(render(template, request)).toContain(request.facts[0]?.value)
    }
  })

  it('supports multi-fact answers without inserting unprotected dates or numbers', async () => {
    const speaker = await RemindSpeakPlanner.load(modelRoot)
    const request: RemindSpeakRequest = {
      requestId: 'request:availability',
      speechAct: 'availability-answer',
      facts: [
        { key: 'SLOT', kind: 'time', placeholder: '<SLOT>', value: 'Friday at 2:00 PM' },
        {
          key: 'DETAIL',
          kind: 'text',
          placeholder: '<DETAIL>',
          value: 'you have no events in that window'
        }
      ],
      style: cozyStyle,
      recentReplies: []
    }
    for (const template of speaker.generateTemplates(request)) {
      const staticText = template.replace(/<[A-Z][A-Z0-9_]*>/gu, '')
      expect(staticText).not.toMatch(/\d/u)
      expect(template.match(/<[A-Z][A-Z0-9_]*>/gu)?.sort()).toEqual(['<DETAIL>', '<SLOT>'])
    }
  })

  it('rejects an exact recent reply and offers a genuinely different top candidate', async () => {
    const speaker = await RemindSpeakPlanner.load(modelRoot)
    const firstRequest = proposalRequest()
    const first = render(speaker.generateTemplates(firstRequest)[0] ?? '', firstRequest)
    const secondRequest = proposalRequest([first])
    const second = render(speaker.generateTemplates(secondRequest)[0] ?? '', secondRequest)
    expect(second).not.toBe(first)
  })

  it('changes surface realization when the local style profile changes', async () => {
    const speaker = await RemindSpeakPlanner.load(modelRoot)
    const request = proposalRequest()
    const concise = speaker.generateTemplates({
      ...request,
      requestId: 'request:style-stable',
      style: {
        warmth: 0.46,
        brevity: 0.94,
        formality: 0.32,
        humor: 0,
        emoji: 0,
        contractions: true,
        proactivity: 0.18
      }
    })[0]
    const polished = speaker.generateTemplates({
      ...request,
      requestId: 'request:style-stable',
      style: {
        warmth: 0.62,
        brevity: 0.62,
        formality: 0.78,
        humor: 0.02,
        emoji: 0,
        contractions: false,
        proactivity: 0.38
      }
    })[0]
    expect(concise).not.toBe(polished)
    expect((concise ?? '').split(/\s+/u).length).toBeLessThan((polished ?? '').split(/\s+/u).length)
  })

  it('covers Phase 6 conversation and empty-schedule acts without weakening grounding', async () => {
    const speaker = await RemindSpeakPlanner.load(modelRoot)
    const conversation = speaker.generateTemplates({
      requestId: 'request:conversation-answer',
      speechAct: 'conversation-answer',
      facts: [
        {
          key: 'DETAIL',
          kind: 'text',
          placeholder: '<DETAIL>',
          value: 'I can help you shape a calmer week'
        }
      ],
      style: cozyStyle,
      recentReplies: []
    })
    const empty = speaker.generateTemplates({
      requestId: 'request:empty-schedule',
      speechAct: 'empty-schedule-answer',
      facts: [],
      style: cozyStyle,
      recentReplies: []
    })

    expect(conversation).toHaveLength(5)
    expect(conversation.every((template) => template.match(/<DETAIL>/gu)?.length === 1)).toBe(true)
    expect(empty).toHaveLength(5)
    expect(empty.every((template) => !template.includes('<'))).toBe(true)
  })

  it('applies only a bounded local phrase preference during reranking', async () => {
    const speaker = await RemindSpeakPlanner.load(modelRoot)
    const request = { ...proposalRequest(), requestId: 'request:preference-rerank' }
    const baseline = speaker.generateTemplates(request)
    const preferred = baseline.at(-1)
    expect(preferred).toBeDefined()

    const reranked = speaker.generateTemplates({
      ...request,
      templatePreferences: [
        { templateFingerprint: remindSpeakTemplateFingerprint(preferred ?? ''), score: 3 }
      ]
    })
    expect(reranked[0]).toBe(preferred)
  })
})
