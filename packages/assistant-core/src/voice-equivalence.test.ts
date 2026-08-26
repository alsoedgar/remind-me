import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeVoiceTranscript } from '@remind-me/model-runtime'
import type { CalendarIRDraft } from '@remind-me/contracts'
import { parseCalendarText, type DeterministicParserContext } from './deterministic-parser'

interface VoiceEquivalenceFixture {
  id: string
  tags: string[]
  typed: string
  transcript: string
}

const fixturePath = fileURLToPath(
  new URL('../../../fixtures/golden/voice-equivalence.v0.1.json', import.meta.url)
)

function parse(text: string): CalendarIRDraft {
  const context: DeterministicParserContext = {
    requestId: 'request:voice-equivalence',
    text,
    previousUserText: null,
    nowUtc: '2026-08-23T17:00:00.000Z',
    localDate: '2026-08-23',
    timezone: 'America/Chicago',
    locale: 'en-US',
    events: [],
    reminders: []
  }
  return parseCalendarText(context).draft
}

function semanticProjection(draft: CalendarIRDraft): unknown {
  return {
    operation: draft.operation,
    title: draft.fields.title?.value.toLocaleLowerCase() ?? null,
    when: draft.fields.when?.value ?? null,
    recurrence: draft.recurrence,
    scope: draft.scope,
    ambiguityCodes: draft.ambiguities.map((ambiguity) => ambiguity.code)
  }
}

describe('typed and spoken golden equivalence', () => {
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as VoiceEquivalenceFixture[]

  it.each(fixtures)('$id resolves to the same semantic CalendarIR', (fixture) => {
    const typed = parse(fixture.typed)
    const spoken = parse(normalizeVoiceTranscript(fixture.transcript))
    expect(semanticProjection(spoken)).toEqual(semanticProjection(typed))
  })
})
