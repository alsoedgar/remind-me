import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assistantContaminationSourcePaths,
  assistantSuiteManifestSchema
} from './assistant-evaluation-contract'
import {
  auditHumanBlindCollection,
  freezeHumanBlindCollection,
  humanBlindCollectionRecordSchema,
  parseHumanBlindCollection,
  type ContaminationSource,
  type HumanBlindCollectionRecord,
  type HumanBlindPolicy
} from './assistant-human-blind'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

function record(
  index = 1,
  overrides: {
    participantId?: string
    text?: string
    annotatorIds?: string[]
    scenarioId?: string
  } = {}
): HumanBlindCollectionRecord {
  const suffix = String(index).padStart(4, '0')
  return humanBlindCollectionRecordSchema.parse({
    schemaVersion: 1,
    protocolVersion: '1.0',
    recordId: `hb-record-${suffix}`,
    participantId: overrides.participantId ?? `participant-${suffix}`,
    consent: {
      consentRecordId: `consent-${suffix}`,
      collectedAt: '2026-01-01T12:00:00.000Z',
      evaluationUse: true,
      publicRelease: true,
      withdrawn: false,
      withdrawalClosesAt: '2026-01-08T12:00:00.000Z'
    },
    independence: {
      participantAuthoredRequests: true,
      shownTrainingExamples: false,
      shownEvaluationExamples: false,
      modelOutputSeenBeforeAuthorship: false,
      developerRewroteParticipantLanguage: false
    },
    privacy: {
      syntheticCalendarFactsOnly: true,
      containsRealCalendarExport: false,
      obviousPiiReviewPassed: true
    },
    annotation: {
      annotatorIds: overrides.annotatorIds ?? ['annotator-alpha', 'annotator-beta'],
      completedAt: '2026-01-02T12:00:00.000Z',
      independentPassesCompleted: true,
      annotatedBeforeModelOutput: true,
      consensusReached: true
    },
    scenario: {
      id: overrides.scenarioId ?? `human.single.${suffix}`,
      category: 'single-action',
      source: 'user-reported',
      inDomain: true,
      trainingExcluded: true,
      tags: [],
      world: { events: [], reminders: [] },
      turns: [
        {
          text:
            overrides.text ??
            `please arrange synthetic task uniqueword${suffix} next Tuesday at nine`,
          expect: {
            responseKinds: ['preview'],
            proposalKind: 'event-save',
            proposalItemCount: 1,
            proposalTitlesAll: [`Synthetic task uniqueword${suffix}`],
            calendarState: 'unchanged',
            activeProposal: 'present'
          }
        }
      ]
    }
  })
}

const relaxedPolicy: HumanBlindPolicy = {
  minimumScenarios: 1,
  minimumParticipants: 1,
  maximumScenariosPerParticipant: 10,
  minimumOutOfDomain: 0,
  minimumNoisyLanguage: 0,
  nearDuplicateThreshold: 0.9,
  categoryMinimums: { 'single-action': 1 }
}

const now = new Date('2026-02-01T00:00:00.000Z')

describe('Phase 8 human-blind collection', () => {
  it('accepts a consented, independently authored and independently annotated record', () => {
    const parsed = parseHumanBlindCollection(`${JSON.stringify(record())}\n`)
    const audit = auditHumanBlindCollection(parsed, [], { now, policy: relaxedPolicy })

    expect(audit.readyToFreeze).toBe(true)
    expect(audit).toMatchObject({ scenarios: 1, participants: 1, annotators: 2 })
  })

  it('rejects self-annotation and model-exposed authorship', () => {
    const base = record()
    expect(() =>
      humanBlindCollectionRecordSchema.parse({
        ...base,
        annotation: { ...base.annotation, annotatorIds: [base.participantId, 'annotator-beta'] }
      })
    ).toThrow(/cannot annotate their own scenario/iu)
    expect(() =>
      humanBlindCollectionRecordSchema.parse({
        ...base,
        independence: { ...base.independence, modelOutputSeenBeforeAuthorship: true }
      })
    ).toThrow()
  })

  it('rejects weak annotations and inconsistent participant consent', () => {
    const base = record()
    expect(() =>
      humanBlindCollectionRecordSchema.parse({
        ...base,
        scenario: {
          ...base.scenario,
          turns: [{ text: base.scenario.turns[0]?.text, expect: { responseKinds: ['preview'] } }]
        }
      })
    ).toThrow(/grounded semantic assertion/iu)

    const first = record(1, { participantId: 'participant-shared' })
    const second = record(2, { participantId: 'participant-shared' })
    expect(() =>
      parseHumanBlindCollection(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
    ).toThrow(/one consistent consent record/iu)
  })

  it('blocks obvious private data even when the collector attested that review passed', () => {
    const audit = auditHumanBlindCollection(
      [record(1, { text: 'email the calendar plan to person@example.com tomorrow' })],
      [],
      { now, policy: relaxedPolicy }
    )

    expect(audit.readyToFreeze).toBe(false)
    expect(audit.blockers).toContain('hb-record-0001: possible email address')
  })

  it('detects repeated participant language and training contamination', () => {
    const duplicatedText = 'please add the dentist appointment tomorrow at nine in the morning'
    const duplicateAudit = auditHumanBlindCollection(
      [record(1, { text: duplicatedText }), record(2, { text: duplicatedText })],
      [],
      {
        now,
        policy: { ...relaxedPolicy, minimumScenarios: 2, minimumParticipants: 2 }
      }
    )
    expect(duplicateAudit.exactInternalDuplicates).toBe(1)
    expect(duplicateAudit.readyToFreeze).toBe(false)

    const contamination: ContaminationSource[] = [
      {
        path: 'training.jsonl',
        sha256: 'a'.repeat(64),
        surfaces: ['please add dentist appointment tomorrow at nine in the morning']
      }
    ]
    const contaminationAudit = auditHumanBlindCollection(
      [record(1, { text: duplicatedText })],
      contamination,
      { now, policy: relaxedPolicy }
    )
    expect(contaminationAudit.nearContaminationMatches).toBe(1)
    expect(contaminationAudit.readyToFreeze).toBe(false)
  })

  it('freezes only the de-identified projection with a fully bound manifest', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'remind-me-human-blind-'))
    temporaryDirectories.push(workspace)
    for (const [index, path] of assistantContaminationSourcePaths.entries()) {
      const fullPath = resolve(workspace, path)
      await mkdir(dirname(fullPath), { recursive: true })
      const contents = path.endsWith('.jsonl')
        ? `${JSON.stringify({ text: `unrelated fixture phrase source${index}` })}\n`
        : path.endsWith('.ts')
          ? `const request = "unrelated fixture phrase source${index}"\n`
          : `${JSON.stringify([{ template: `unrelated fixture phrase source${index}` }])}\n`
      await writeFile(fullPath, contents, 'utf8')
    }
    const protocolPath = resolve(workspace, 'evals/assistant/human-blind/protocol-v1.md')
    const modelLockPath = resolve(workspace, 'models/manifest.json')
    const sourcePath = resolve(workspace, 'evals/assistant/human-blind/collection.local.jsonl')
    const outputDirectory = resolve(workspace, 'evals/assistant/human-blind/releases/v8.0.0-test')
    await mkdir(dirname(protocolPath), { recursive: true })
    await mkdir(dirname(modelLockPath), { recursive: true })
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(protocolPath, '# Frozen protocol\n', 'utf8')
    await writeFile(modelLockPath, '{"model":"locked"}\n', 'utf8')
    const records = Array.from({ length: 100 }, (_, index) => record(index + 1))
    await writeFile(
      sourcePath,
      `${records.map((item) => JSON.stringify(item)).join('\n')}\n`,
      'utf8'
    )

    const result = await freezeHumanBlindCollection({
      workspace,
      sourcePath,
      outputDirectory,
      suiteVersion: '8.0.0-test',
      modelLockPath,
      protocolPath,
      now,
      policy: {
        ...relaxedPolicy,
        minimumScenarios: 100,
        minimumParticipants: 100,
        maximumScenariosPerParticipant: 1,
        categoryMinimums: { 'single-action': 100 }
      }
    })

    expect(result.manifest.independentHumanBlind).toBe(true)
    expect(result.manifest.participantCount).toBe(100)
    expect(result.manifest.contaminationAudit.sources).toHaveLength(
      assistantContaminationSourcePaths.length
    )
    const frozen = await readFile(resolve(outputDirectory, 'scenarios.jsonl'), 'utf8')
    expect(frozen).not.toContain('participantId')
    expect(frozen).not.toContain('consentRecordId')
    expect(
      assistantSuiteManifestSchema.parse(
        JSON.parse(await readFile(resolve(outputDirectory, 'manifest.json'), 'utf8'))
      ).independentHumanBlind
    ).toBe(true)
  })

  it('refuses to freeze outside the dedicated public release directory', async () => {
    await expect(
      freezeHumanBlindCollection({
        workspace: process.cwd(),
        sourcePath: 'missing.jsonl',
        outputDirectory: resolve(process.cwd(), 'evals/assistant/not-sealed'),
        suiteVersion: '8.0.0',
        modelLockPath: 'models/manifest.json',
        protocolPath: 'evals/assistant/human-blind/protocol-v1.md'
      })
    ).rejects.toThrow(/must be a child/iu)
  })
})
