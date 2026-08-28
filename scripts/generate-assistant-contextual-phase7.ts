import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  assistantEvaluationScenarioSchema,
  assistantSuiteManifestSchema,
  type AssistantEvaluationScenario
} from './assistant-evaluation-contract'

const workspace = process.cwd()
const sourcePath = resolve(workspace, 'evals/assistant/contextual-phase0/scenarios.jsonl')
const sourceManifestPath = resolve(workspace, 'evals/assistant/contextual-phase0/manifest.json')
const outputPath = resolve(workspace, 'evals/assistant/contextual-phase7/scenarios.jsonl')
const outputManifestPath = resolve(workspace, 'evals/assistant/contextual-phase7/manifest.json')

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
}

function parseScenarios(contents: string): AssistantEvaluationScenario[] {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => assistantEvaluationScenarioSchema.parse(JSON.parse(line)))
}

function selectionFromText(text: string, itemCount: number): number[] {
  const value = normalized(text)
  const all = Array.from({ length: itemCount }, (_, index) => index)
  if (/\b(?:all|both|each|every|whole set|they|them|those|these)\b/iu.test(value)) return all
  if (/\bfirst two\b/iu.test(value)) return all.slice(0, 2)
  if (/\b(?:first|1st|one)\s*(?:and|&|n)\s*(?:third|3rd|three)\b/iu.test(value)) {
    return [0, 2].filter((index) => index < itemCount)
  }
  if (
    /\b(?:items?\s+)?(?:one|1)\s*(?:and|&|n)\s*(?:two|2)\b/iu.test(value) ||
    /\bnumbers?\s+1\s*(?:and|&|n)\s*2\b/iu.test(value)
  ) {
    return [0, 1].filter((index) => index < itemCount)
  }
  if (
    /\b(?:items?\s+)?(?:two|2)\s*(?:and|&|n)\s*(?:three|3)\b/iu.test(value) ||
    /\bnumbers?\s+2\s*(?:and|&|n)\s*3\b/iu.test(value)
  ) {
    return [1, 2].filter((index) => index < itemCount)
  }
  if (/\bsecond\s*(?:and|&|n)\s*last\b/iu.test(value)) {
    return [...new Set([1, itemCount - 1])].filter((index) => index >= 0 && index < itemCount)
  }
  if (/\b(?:first|1st|number one|item one|item 1)\b/iu.test(value)) return all.slice(0, 1)
  if (/\b(?:second|2nd|number two|number 2|item two|item 2)\b/iu.test(value)) {
    return itemCount > 1 ? [1] : []
  }
  if (/\b(?:third|3rd|number three|number 3|item three|item 3)\b/iu.test(value)) {
    return itemCount > 2 ? [2] : []
  }
  if (/\blast\b/iu.test(value)) return itemCount > 0 ? [itemCount - 1] : []
  return all
}

function exactEventIndexes(scenario: AssistantEvaluationScenario, turnIndex: number): number[] {
  const turn = scenario.turns[turnIndex]
  if (!turn || turn.expect.relatedEventMin === undefined) return []
  if (turnIndex === 0) return scenario.world.events.map((_, index) => index)
  const expectedText = turn.expect.textAll?.map(normalized) ?? []
  const titleMatches = scenario.world.events.flatMap((event, index) => {
    const title = normalized(event.title)
    return expectedText.some(
      (candidate) =>
        candidate.length >= 4 && (title.includes(candidate) || candidate.includes(title))
    )
      ? [index]
      : []
  })
  if (titleMatches.length > 0) return titleMatches
  return selectionFromText(turn.text, scenario.world.events.length)
}

function enrichScenario(scenario: AssistantEvaluationScenario): AssistantEvaluationScenario {
  return assistantEvaluationScenarioSchema.parse({
    ...scenario,
    turns: scenario.turns.map((turn, turnIndex) => ({
      ...turn,
      expect: {
        ...turn.expect,
        ...(turn.expect.relatedEventMin === undefined
          ? {}
          : { relatedEventSeedIndexesExact: exactEventIndexes(scenario, turnIndex) }),
        ...(turn.expect.relatedReminderMin === undefined
          ? {}
          : {
              relatedReminderSeedIndexesExact: scenario.world.reminders.map((_, index) => index)
            })
      }
    }))
  })
}

const sourceContents = await readFile(sourcePath, 'utf8')
const sourceManifest = assistantSuiteManifestSchema.parse(
  JSON.parse(await readFile(sourceManifestPath, 'utf8'))
)
if (sha256(sourceContents) !== sourceManifest.sha256) {
  throw new Error('The frozen Phase 0 contextual source no longer matches its manifest')
}

const sourceScenarios = parseScenarios(sourceContents)
const scenarios = sourceScenarios.map(enrichScenario)
const outputContents = `${scenarios.map((scenario) => JSON.stringify(scenario)).join('\n')}\n`
const languageSha256 = sha256(
  JSON.stringify(
    scenarios.map((scenario) => ({
      id: scenario.id,
      turns: scenario.turns.map((turn) => turn.text)
    }))
  )
)
const exactReferentTurns = scenarios
  .flatMap((scenario) => scenario.turns)
  .filter(
    (turn) =>
      turn.expect.relatedEventSeedIndexesExact !== undefined ||
      turn.expect.relatedReminderSeedIndexesExact !== undefined
  ).length
const contextualFollowUpTurns = scenarios.reduce(
  (total, scenario) =>
    total + (scenario.tags.includes('contextual-follow-up') ? scenario.turns.length - 1 : 0),
  0
)
const manifest = {
  schemaVersion: 1,
  suiteVersion: '7.1.0-contextual-release.1',
  path: 'evals/assistant/contextual-phase7/scenarios.jsonl',
  sha256: sha256(outputContents),
  scenarios: scenarios.length,
  turns: scenarios.reduce((total, scenario) => total + scenario.turns.length, 0),
  trainingExcluded: true,
  frozen: true,
  independentHumanBlind: false,
  contextualRelease: true,
  humanEvidence: false,
  sourceSuite: {
    path: 'evals/assistant/contextual-phase0/scenarios.jsonl',
    sha256: sourceManifest.sha256
  },
  languageSha256,
  coverage: { exactReferentTurns, contextualFollowUpTurns }
}
const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`
assistantSuiteManifestSchema.parse(manifest)

if (process.argv.includes('--check')) {
  const [existingSuite, existingManifest] = await Promise.all([
    readFile(outputPath, 'utf8').catch(() => ''),
    readFile(outputManifestPath, 'utf8').catch(() => '')
  ])
  if (existingSuite !== outputContents || existingManifest !== manifestContents) {
    throw new Error(
      'The contextual Phase 7 release suite is stale; run pnpm eval:assistant:contextual-phase7:generate'
    )
  }
  console.log(
    `Contextual Phase 7 suite is current: ${scenarios.length} scenarios, ${manifest.turns} turns, ${exactReferentTurns} exact referent checks.`
  )
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await Promise.all([
    writeFile(outputPath, outputContents, 'utf8'),
    writeFile(outputManifestPath, manifestContents, 'utf8')
  ])
  console.log(
    `Generated contextual Phase 7 suite: ${scenarios.length} scenarios, ${manifest.turns} turns, ${exactReferentTurns} exact referent checks.`
  )
}
