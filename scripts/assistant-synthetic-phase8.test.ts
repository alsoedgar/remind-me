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

describe('Phase 8 synthetic engineering proxy', () => {
  it('ships 2,000 schema-valid generated scenarios without claiming human provenance', async () => {
    const workspace = process.cwd()
    const suitePath = resolve(workspace, 'evals/assistant/synthetic-phase8/scenarios.jsonl')
    const manifestPath = resolve(workspace, 'evals/assistant/synthetic-phase8/manifest.json')
    const suite = await readFile(suitePath, 'utf8')
    const scenarios = suite
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => assistantEvaluationScenarioSchema.parse(JSON.parse(line)))
    const manifest = assistantSuiteManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, 'utf8'))
    )

    expect(manifest).toMatchObject({
      scenarios: 2_000,
      independentHumanBlind: false,
      syntheticEngineeringProxy: true,
      humanEvidence: false,
      provenance: 'deterministic-project-authored'
    })
    if (!('syntheticEngineeringProxy' in manifest)) {
      throw new Error('Expected the synthetic proxy manifest variant')
    }
    expect(scenarios).toHaveLength(2_000)
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(2_000)
    expect(scenarios.every((scenario) => scenario.trainingExcluded)).toBe(true)
    expect(scenarios.every((scenario) => scenario.source !== 'user-reported')).toBe(true)
    expect(scenarios.every((scenario) => scenario.tags.includes('synthetic'))).toBe(true)
    expect(scenarios.filter((scenario) => !scenario.inDomain)).toHaveLength(200)
    expect(
      scenarios.filter((scenario) =>
        scenario.tags.some((tag) => /(?:asr|noise|ocr|spacing|typo)/iu.test(tag))
      ).length
    ).toBeGreaterThanOrEqual(200)
    expect(sha256(suite)).toBe(manifest.sha256)
    const generator = await readFile(resolve(workspace, manifest.generator.path))
    expect(sha256(generator)).toBe(manifest.generator.sha256)
  })
})
