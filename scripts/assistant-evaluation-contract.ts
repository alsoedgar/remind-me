import { z } from 'zod'

export const assistantContaminationSourcePaths = [
  'evals/assistant/v0.1/scenarios.jsonl',
  'evals/assistant/phase7/scenarios.jsonl',
  'ml/assistant_corpus/data/train.jsonl',
  'ml/assistant_corpus/data/development.jsonl',
  'ml/assistant_corpus/data/challenge.jsonl',
  'ml/assistant_corpus/accepted/templates.json',
  'ml/teacher_assisted/accepted/remindcore.json',
  'ml/remindcore_next/teacher/qwen-training-paraphrases.json',
  'ml/remindcore_next/teacher/qwen-training-repair-paraphrases.json',
  'ml/remindcore/.generated/dataset/train.jsonl',
  'ml/remindcore/.generated/dataset/dev.jsonl',
  'ml/remindcore/.generated/dataset/test.jsonl',
  'ml/remindcore/.generated/dataset/teacher-challenge.jsonl',
  'packages/assistant-core/src/assistant-plan.test.ts',
  'packages/assistant-core/src/bulk-clear-intent.test.ts',
  'packages/assistant-core/src/capability-registry.test.ts',
  'packages/assistant-core/src/confirmation-policy.test.ts',
  'packages/assistant-core/src/conversation-intent.test.ts',
  'packages/assistant-core/src/deterministic-parser.test.ts',
  'packages/assistant-core/src/hybrid-parser.test.ts',
  'packages/assistant-core/src/input-normalizer.test.ts',
  'packages/assistant-core/src/memory-intent.test.ts',
  'packages/assistant-core/src/multi-request-parser.test.ts',
  'packages/assistant-core/src/proposal-review-correction.test.ts',
  'packages/assistant-core/src/proposal-review-query.test.ts',
  'packages/assistant-core/src/request-router.test.ts',
  'packages/assistant-core/src/response-renderer.test.ts',
  'packages/assistant-core/src/schedule-replication-parser.test.ts',
  'packages/assistant-core/src/voice-equivalence.test.ts',
  'packages/storage/src/assistant-service.test.ts'
] as const

export const assistantDateSpecSchema = z
  .string()
  .regex(
    /^(?:today|tomorrow|yesterday|[+-]\d+d|(?:this|next):(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{4}-\d{2}-\d{2})$/u
  )

const recurrenceSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().positive().max(365),
    byWeekday: z
      .array(z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']))
      .max(7),
    byMonthDay: z.array(z.number().int().min(-31).max(31)).max(31),
    end: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('never') }).strict(),
      z.object({ kind: z.literal('count'), count: z.number().int().positive() }).strict(),
      z.object({ kind: z.literal('until'), date: assistantDateSpecSchema }).strict()
    ])
  })
  .strict()

const seedEventSchema = z
  .object({
    title: z.string().min(1),
    date: assistantDateSpecSchema,
    startTime: z.string().regex(/^\d{2}:\d{2}$/u),
    endTime: z.string().regex(/^\d{2}:\d{2}$/u),
    location: z.string().default(''),
    description: z.string().default(''),
    recurrence: recurrenceSchema.nullable().default(null)
  })
  .strict()

const seedReminderSchema = z
  .object({
    title: z.string().min(1),
    date: assistantDateSpecSchema,
    time: z.string().regex(/^\d{2}:\d{2}$/u),
    notes: z.string().default(''),
    recurrence: recurrenceSchema.nullable().default(null)
  })
  .strict()

export const assistantStateExpectationSchema = z
  .object({
    eventCount: z.number().int().nonnegative().optional(),
    reminderCount: z.number().int().nonnegative().optional(),
    eventTitlesAll: z.array(z.string().min(1)).optional(),
    eventTitlesNone: z.array(z.string().min(1)).optional(),
    reminderTitlesAll: z.array(z.string().min(1)).optional(),
    reminderTitlesNone: z.array(z.string().min(1)).optional()
  })
  .strict()

export const assistantTurnExpectationSchema = z
  .object({
    responseKinds: z
      .array(
        z.enum([
          'answer',
          'clarification',
          'preview',
          'receipt',
          'rejected',
          'unsupported',
          'error'
        ])
      )
      .min(1),
    textAll: z.array(z.string().min(1)).optional(),
    textAny: z.array(z.string().min(1)).optional(),
    textNone: z.array(z.string().min(1)).optional(),
    maxWords: z.number().int().positive().optional(),
    relatedEventMin: z.number().int().nonnegative().optional(),
    relatedReminderMin: z.number().int().nonnegative().optional(),
    relatedEventSeedIndexesExact: z.array(z.number().int().nonnegative()).max(100).optional(),
    relatedReminderSeedIndexesExact: z.array(z.number().int().nonnegative()).max(100).optional(),
    proposalKind: z
      .enum([
        'event-save',
        'event-delete',
        'reminder-save',
        'reminder-complete',
        'reminder-delete',
        'bulk-delete',
        'batch'
      ])
      .optional(),
    proposalOperation: z.string().min(1).optional(),
    proposalItemCount: z.number().int().positive().optional(),
    proposalItemKinds: z.array(z.string().min(1)).optional(),
    proposalTitlesAll: z.array(z.string().min(1)).optional(),
    proposalDatesAll: z.array(assistantDateSpecSchema).optional(),
    proposalTimesAll: z.array(z.string().regex(/^\d{2}:\d{2}$/u)).optional(),
    proposalEndDatesAll: z.array(assistantDateSpecSchema).optional(),
    proposalEndTimesAll: z.array(z.string().regex(/^\d{2}:\d{2}$/u)).optional(),
    proposalLocationsAll: z.array(z.string().min(1)).optional(),
    proposalDetailsAll: z.array(z.string().min(1)).optional(),
    proposalWeekdaysAll: z.array(z.string().min(1)).optional(),
    proposalFrequenciesAll: z.array(z.enum(['daily', 'weekly', 'monthly', 'yearly'])).optional(),
    calendarState: z.enum(['unchanged', 'changed']).optional(),
    activeProposal: z.enum(['present', 'absent']).optional(),
    proposalTransition: z.enum(['created', 'same', 'replaced', 'cleared', 'none']).optional(),
    bulkScope: z.enum(['events', 'reminders', 'both']).optional(),
    bulkEventCount: z.number().int().nonnegative().optional(),
    bulkReminderCount: z.number().int().nonnegative().optional(),
    state: assistantStateExpectationSchema.optional()
  })
  .strict()

const assistantTurnSchema = z
  .object({
    text: z.string().trim().min(1),
    expect: assistantTurnExpectationSchema,
    after: z.enum(['confirm', 'reject']).optional(),
    postState: assistantStateExpectationSchema.optional()
  })
  .strict()

export const assistantEvaluationScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u),
    category: z.enum([
      'single-action',
      'multi-action',
      'mutation',
      'bulk',
      'query',
      'multi-turn',
      'conversation',
      'memory',
      'ambiguity',
      'safety',
      'open-dialogue'
    ]),
    source: z.enum(['user-reported', 'developer-challenge', 'safety-contract']),
    inDomain: z.boolean(),
    trainingExcluded: z.literal(true),
    tags: z.array(z.string().min(1)).default([]),
    world: z
      .object({
        events: z.array(seedEventSchema).default([]),
        reminders: z.array(seedReminderSchema).default([])
      })
      .strict()
      .default({ events: [], reminders: [] }),
    turns: z.array(assistantTurnSchema).min(1)
  })
  .strict()

const manifestBase = z.object({
  schemaVersion: z.literal(1),
  suiteVersion: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  scenarios: z.number().int().positive(),
  turns: z.number().int().positive(),
  trainingExcluded: z.literal(true),
  frozen: z.literal(true)
})

const regressionManifestSchema = manifestBase
  .extend({ independentHumanBlind: z.literal(false) })
  .strict()

export const contextualReleaseManifestSchema = manifestBase
  .extend({
    path: z.literal('evals/assistant/contextual-phase7/scenarios.jsonl'),
    independentHumanBlind: z.literal(false),
    contextualRelease: z.literal(true),
    humanEvidence: z.literal(false),
    sourceSuite: z
      .object({
        path: z.literal('evals/assistant/contextual-phase0/scenarios.jsonl'),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u)
      })
      .strict(),
    languageSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    coverage: z
      .object({
        exactReferentTurns: z.number().int().positive(),
        contextualFollowUpTurns: z.number().int().positive()
      })
      .strict()
  })
  .strict()

export const syntheticProxyManifestSchema = manifestBase
  .extend({
    path: z.literal('evals/assistant/synthetic-phase8/scenarios.jsonl'),
    independentHumanBlind: z.literal(false),
    syntheticEngineeringProxy: z.literal(true),
    humanEvidence: z.literal(false),
    provenance: z.literal('deterministic-project-authored'),
    generator: z
      .object({
        path: z.literal('scripts/generate-assistant-synthetic-phase8.ts'),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        version: z.literal(1),
        seed: z.string().min(1)
      })
      .strict(),
    coverage: z
      .object({
        categoryCounts: z.record(z.string(), z.number().int().nonnegative()),
        outOfDomain: z.number().int().min(200),
        noisyLanguage: z.number().int().min(200),
        uniqueRequestSurfaces: z.number().int().positive()
      })
      .strict()
  })
  .strict()

const digestSourceSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict()

export const humanBlindManifestSchema = manifestBase
  .extend({
    path: z
      .string()
      .regex(/^evals\/assistant\/human-blind\/releases\/v[a-z0-9][a-z0-9._-]*\/scenarios\.jsonl$/u),
    independentHumanBlind: z.literal(true),
    collectionProtocol: z
      .object({
        version: z.literal('1.0'),
        path: z.literal('evals/assistant/human-blind/protocol-v1.md'),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u)
      })
      .strict(),
    sourceCollectionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    frozenAt: z.string().datetime(),
    participantCount: z.number().int().min(100),
    annotatorCount: z.number().int().min(2),
    publicReleaseConsent: z.literal(true),
    withdrawalWindowClosed: z.literal(true),
    twoAnnotatorConsensus: z.literal(true),
    annotationQualityPassed: z.literal(true),
    syntheticCalendarFactsOnly: z.literal(true),
    piiReviewPassed: z.literal(true),
    modelLockedBeforeEvaluation: z.literal(true),
    modelLock: digestSourceSchema.extend({ path: z.literal('models/manifest.json') }).strict(),
    contaminationAudit: z
      .object({
        exactMatches: z.literal(0),
        nearMatches: z.literal(0),
        threshold: z.number().min(0.8).max(1),
        sources: z
          .array(
            digestSourceSchema.extend({ path: z.enum(assistantContaminationSourcePaths) }).strict()
          )
          .length(assistantContaminationSourcePaths.length)
      })
      .strict()
  })
  .strict()
  .superRefine((manifest, context) => {
    const expectedSuitePath = `evals/assistant/human-blind/releases/v${manifest.suiteVersion}/scenarios.jsonl`
    if (manifest.path !== expectedSuitePath) {
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: `The suite path must match its version: ${expectedSuitePath}`
      })
    }
    const actual = new Set(manifest.contaminationAudit.sources.map((source) => source.path))
    for (const path of assistantContaminationSourcePaths) {
      if (!actual.has(path)) {
        context.addIssue({
          code: 'custom',
          path: ['contaminationAudit', 'sources'],
          message: `Missing required contamination source: ${path}`
        })
      }
    }
  })

export const assistantSuiteManifestSchema = z.union([
  regressionManifestSchema,
  contextualReleaseManifestSchema,
  syntheticProxyManifestSchema,
  humanBlindManifestSchema
])

export type AssistantEvaluationScenario = z.infer<typeof assistantEvaluationScenarioSchema>
export type AssistantStateExpectation = z.infer<typeof assistantStateExpectationSchema>
export type AssistantTurnExpectation = z.infer<typeof assistantTurnExpectationSchema>
export type AssistantSuiteManifest = z.infer<typeof assistantSuiteManifestSchema>
