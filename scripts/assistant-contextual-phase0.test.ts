import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assistantEvaluationScenarioSchema,
  assistantSuiteManifestSchema
} from './assistant-evaluation-contract'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('Phase 0 contextual regression corpus', () => {
  it('freezes the screenshot failure and hundreds of contextual paraphrase combinations', async () => {
    const workspace = process.cwd()
    const suite = await readFile(
      resolve(workspace, 'evals/assistant/contextual-phase0/scenarios.jsonl'),
      'utf8'
    )
    const scenarios = suite
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => assistantEvaluationScenarioSchema.parse(JSON.parse(line)))
    const manifest = assistantSuiteManifestSchema.parse(
      JSON.parse(
        await readFile(
          resolve(workspace, 'evals/assistant/contextual-phase0/manifest.json'),
          'utf8'
        )
      )
    )
    const families = [
      'time',
      'location',
      'date',
      'duration',
      'notes',
      'recurrence',
      'ordinal',
      'subset',
      'all-items',
      'summary',
      'typo-spacing',
      'topic-switch'
    ]

    expect(manifest).toMatchObject({
      scenarios: 433,
      turns: 902,
      trainingExcluded: true,
      frozen: true,
      independentHumanBlind: false
    })
    expect(scenarios).toHaveLength(433)
    expect(new Set(scenarios.map((item) => item.id)).size).toBe(scenarios.length)
    expect(sha256(suite)).toBe(manifest.sha256)
    expect(scenarios.every((item) => item.trainingExcluded)).toBe(true)
    expect(scenarios.every((item) => item.tags.includes('phase0-regression'))).toBe(true)
    expect(
      scenarios
        .find((item) => item.id === 'context0.screenshot.anything-tomorrow.what-times')
        ?.turns.map((turn) => turn.text)
    ).toEqual(['do I have anything tomorrow?', 'what times?'])
    for (const family of families) {
      expect(scenarios.filter((item) => item.tags.includes(family))).toHaveLength(36)
    }
    expect(scenarios.filter((item) => item.tags.includes('typo-spacing'))).toHaveLength(36)
    expect(scenarios.filter((item) => item.tags.includes('context-return'))).toHaveLength(36)
  })
})
