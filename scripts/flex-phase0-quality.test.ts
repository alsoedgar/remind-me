import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const expectationSchema = z
  .object({
    actionCount: z.number().int().positive().optional(),
    operations: z.array(z.string().min(1)).optional(),
    titlesAll: z.array(z.string().min(1)).optional(),
    targetsAll: z.array(z.string().min(1)).optional(),
    locationsAll: z.array(z.string().min(1)).optional(),
    textAll: z.array(z.string().min(1)).optional(),
    textAny: z.array(z.string().min(1)).optional(),
    textNone: z.array(z.string().min(1)).optional(),
    maxWords: z.number().int().positive().optional()
  })
  .strict()

const qualitySuiteSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteVersion: z.literal('0.1.0'),
    trainingExcluded: z.literal(true),
    syntheticPromptsOnly: z.literal(true),
    cases: z
      .array(
        z.discriminatedUnion('type', [
          z
            .object({
              id: z.string().min(1),
              type: z.literal('plan'),
              text: z.string().min(1),
              expect: expectationSchema
            })
            .strict(),
          z
            .object({
              id: z.string().min(1),
              type: z.literal('chat'),
              text: z.string().min(1),
              turns: z.array(
                z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1) }).strict()
              ),
              calendarContext: z.string(),
              expect: expectationSchema
            })
            .strict()
        ])
      )
      .length(12)
  })
  .strict()

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    suiteVersion: z.literal('0.1.0'),
    path: z.literal('evals/flex-model/phase0-quality/cases.json'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    cases: z.literal(12),
    planCases: z.literal(5),
    chatCases: z.literal(7),
    trainingExcluded: z.literal(true),
    syntheticPromptsOnly: z.literal(true),
    requiresRealModel: z.literal(true),
    modelId: z.literal('qwen3-1.7b-q4'),
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict()

describe('Phase 0 real-Qwen quality protocol', () => {
  it('freezes a hash-bound, non-mocked quality suite', async () => {
    const workspace = process.cwd()
    const casesText = await readFile(
      resolve(workspace, 'evals/flex-model/phase0-quality/cases.json'),
      'utf8'
    )
    const suite = qualitySuiteSchema.parse(JSON.parse(casesText))
    const manifest = manifestSchema.parse(
      JSON.parse(
        await readFile(resolve(workspace, 'evals/flex-model/phase0-quality/manifest.json'), 'utf8')
      )
    )

    expect(createHash('sha256').update(casesText).digest('hex')).toBe(manifest.sha256)
    expect(suite.cases.filter((item) => item.type === 'plan')).toHaveLength(manifest.planCases)
    expect(suite.cases.filter((item) => item.type === 'chat')).toHaveLength(manifest.chatCases)
    expect(new Set(suite.cases.map((item) => item.id)).size).toBe(suite.cases.length)
  })
})
