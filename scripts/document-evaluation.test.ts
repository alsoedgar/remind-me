import { describe, expect, it } from 'vitest'
import {
  documentEvalCorpusRecordSchema,
  scoreDocumentEvaluation,
  type DocumentEvalCorpusRecord,
  type DocumentEvalObservation
} from './document-evaluation'

const recurrence = {
  frequency: 'weekly' as const,
  interval: 1,
  byWeekday: ['monday' as const, 'wednesday' as const],
  byMonthDay: [],
  end: { kind: 'until' as const, date: '2026-12-04' }
}

const corpus: DocumentEvalCorpusRecord = documentEvalCorpusRecordSchema.parse({
  id: 'matching.schedule',
  sourceGroupId: 'matching-schedule',
  fixture: 'fixtures/documents/matching-schedule.pdf',
  sourceKind: 'pdf',
  mediaType: 'application/pdf',
  inputClass: 'born-digital',
  layoutFamily: 'row-table',
  pageCount: 1,
  locale: 'en-US',
  timezone: 'America/Chicago',
  provenance: 'project-sanitized',
  trainingExcluded: true,
  independentHumanBlind: false,
  tags: ['same-title', 'component-identity'],
  expectedItems: [
    {
      id: 'lecture',
      page: 1,
      kind: 'event',
      title: 'General Chemistry',
      startDate: '2026-08-24',
      endDate: '2026-08-24',
      startTime: '09:00',
      endTime: '09:50',
      timezone: 'America/Chicago',
      allDay: false,
      location: 'Science Hall 101',
      recurrence,
      schedule: {
        courseCode: 'CHEM 101',
        sectionCode: 'L1',
        crn: '61001',
        component: 'lecture'
      }
    },
    {
      id: 'laboratory',
      page: 1,
      kind: 'event',
      title: 'General Chemistry',
      startDate: '2026-08-24',
      endDate: '2026-08-24',
      startTime: '09:00',
      endTime: '09:50',
      timezone: 'America/Chicago',
      allDay: false,
      location: 'Science Hall 101',
      recurrence,
      schedule: {
        courseCode: 'CHEM 101',
        sectionCode: 'B1',
        crn: '61002',
        component: 'laboratory'
      }
    }
  ],
  expectedSkips: []
})

function observation(): DocumentEvalObservation {
  return {
    fixtureId: corpus.id,
    sourceSha256: 'a'.repeat(64),
    status: 'success',
    error: null,
    pages: 1,
    extractionMethods: ['native-text'],
    processingDurationMs: 12,
    items: [
      {
        id: 'observed-lab',
        page: 1,
        kind: 'event',
        title: 'General Chemistry',
        startDate: '2026-08-24',
        endDate: '2026-08-24',
        startTime: '09:00',
        endTime: '09:50',
        timezone: 'America/Chicago',
        allDay: false,
        location: 'Science Hall 101',
        recurrence,
        schedule: {
          courseCode: 'CHEM 101',
          sectionCode: 'B1',
          crn: '61002',
          component: 'laboratory'
        },
        confidence: 0.94,
        attention: 'ready',
        evidence: { title: true, when: true, location: true, description: true }
      },
      {
        id: 'observed-lecture',
        page: 1,
        kind: 'event',
        title: 'General Chemistry',
        startDate: '2026-08-24',
        endDate: '2026-08-24',
        startTime: '09:00',
        endTime: '09:50',
        timezone: 'America/Chicago',
        allDay: false,
        location: 'Science Hal 101',
        recurrence,
        schedule: {
          courseCode: 'CHEM 101',
          sectionCode: 'L1',
          crn: '61001',
          component: 'lecture'
        },
        confidence: 0.82,
        attention: 'check-evidence',
        evidence: { title: true, when: true, location: true, description: true }
      }
    ],
    skippedCandidateCount: 0,
    duplicateCandidateCount: 0,
    existingCalendarDuplicateCount: 0,
    warnings: []
  }
}

describe('document evaluation', () => {
  it('matches same-title lecture and lab rows by CRN before scoring fields', () => {
    const report = scoreDocumentEvaluation([corpus], [observation()])
    expect(report.overall.precision).toBe(1)
    expect(report.overall.recall).toBe(1)
    expect(report.overall.exactPrecision).toBe(0.5)
    expect(report.overall.exactRecall).toBe(0.5)
    expect(report.fields.crn?.presentAccuracy).toBe(1)
    expect(report.fields.component?.presentAccuracy).toBe(1)
    expect(report.fields.location?.presentAccuracy).toBe(0.5)
    expect(report.overall.perfectDocuments).toBe(0)
    expect(report.failures[0]?.fieldMismatches).toEqual([
      {
        expected: 'General Chemistry',
        observed: 'General Chemistry',
        fields: ['location']
      }
    ])
  })

  it('reports missing observations without pretending they were scored', () => {
    const report = scoreDocumentEvaluation([corpus], [])
    expect(report.coverage.scoredDocuments).toBe(0)
    expect(report.coverage.coverage).toBe(0)
    expect(report.failures[0]?.error).toBe('No observation was supplied')
  })

  it('keeps independent human-blind provenance explicit', () => {
    expect(() =>
      documentEvalCorpusRecordSchema.parse({
        ...corpus,
        provenance: 'project-sanitized',
        independentHumanBlind: true
      })
    ).toThrow(/Human-blind provenance/iu)
  })
})
