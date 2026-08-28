import { describe, expect, it } from 'vitest'
import {
  documentRepairRequestSchema,
  type DocumentRepairCitation,
  type DocumentRepairRequest
} from '@remind-me/contracts'
import { validateDocumentRepairResponse } from './document-repair'

function citation(
  role: DocumentRepairCitation['role'],
  blockId: string,
  text: string
): DocumentRepairCitation {
  return {
    blockId,
    page: 1,
    role,
    text,
    start: 0,
    end: text.length
  }
}

function repairRequest(): DocumentRepairRequest {
  const title = citation('title', 'block:title', 'Design review')
  const date = citation('date', 'block:date', 'September 4, 2026')
  const time = citation('time', 'block:time', '2:00 PM - 3:00 PM')
  const alternateTitle = citation('title', 'block:alternate-title', 'Project review')
  return documentRepairRequestSchema.parse({
    schemaVersion: 1,
    selectionId: 'document:repair-test',
    sourceSha256: 'a'.repeat(64),
    reason: 'parser-disagreement',
    disagreements: [
      {
        id: 'repair:one',
        reason: 'parser-disagreement',
        activeCandidateId: 'candidate:planscan',
        candidates: [
          {
            id: 'candidate:planscan',
            origin: 'planscan',
            draftId: 'draft:planscan',
            kind: 'event',
            title: title.text,
            when: '2026-09-04 14:00 to 15:00',
            location: '',
            recurrence: '',
            citations: [title, date, time]
          },
          {
            id: 'candidate:rules',
            origin: 'rules',
            draftId: 'draft:rules',
            kind: 'event',
            title: alternateTitle.text,
            when: '2026-09-04 14:00 to 15:00',
            location: '',
            recurrence: '',
            citations: [alternateTitle, date, time]
          }
        ]
      }
    ]
  })
}

describe('evidence-gated document repair', () => {
  it('accepts only a supplied candidate with its exact title, date, and time spans', () => {
    const request = repairRequest()
    const selected = request.disagreements[0]?.candidates[1]
    expect(selected).toBeDefined()

    const response = validateDocumentRepairResponse(request, {
      decisions: [
        {
          disagreementId: 'repair:one',
          candidateId: selected?.id,
          citations: selected?.citations,
          rationale: 'The quoted fields form one internally consistent source row.'
        }
      ]
    })

    expect(response).toMatchObject({
      modelId: 'qwen3-1.7b-q4',
      hasMutationAuthority: false,
      decisions: [{ candidateId: 'candidate:rules' }]
    })
  })

  it('rejects invented candidates, altered evidence, and omitted timed evidence', () => {
    const request = repairRequest()
    const selected = request.disagreements[0]?.candidates[0]
    expect(selected).toBeDefined()

    expect(
      validateDocumentRepairResponse(request, {
        decisions: [
          {
            disagreementId: 'repair:one',
            candidateId: 'candidate:invented',
            citations: selected?.citations,
            rationale: 'Invented candidate.'
          }
        ]
      })
    ).toBeNull()
    expect(
      validateDocumentRepairResponse(request, {
        decisions: [
          {
            disagreementId: 'repair:one',
            candidateId: selected?.id,
            citations: selected?.citations.map((item) =>
              item.role === 'title' ? { ...item, text: 'Different title' } : item
            ),
            rationale: 'Altered evidence.'
          }
        ]
      })
    ).toBeNull()
    expect(
      validateDocumentRepairResponse(request, {
        decisions: [
          {
            disagreementId: 'repair:one',
            candidateId: selected?.id,
            citations: selected?.citations.filter((item) => item.role !== 'time'),
            rationale: 'Missing the printed time.'
          }
        ]
      })
    ).toBeNull()
  })

  it('allows the model to withhold without attaching evidence', () => {
    const request = repairRequest()
    expect(
      validateDocumentRepairResponse(request, {
        decisions: [
          {
            disagreementId: 'repair:one',
            candidateId: null,
            citations: [],
            rationale: 'The quoted rows do not decide between the candidates.'
          }
        ]
      })
    ).toMatchObject({ hasMutationAuthority: false })
  })
})
