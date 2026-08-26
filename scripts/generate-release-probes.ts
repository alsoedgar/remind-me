import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { releaseProbeSuiteSchema } from '@remind-me/model-runtime'

interface PlanScanFixtureRow {
  method: string
  documentType: string
  page: unknown
  gold: { groups: Array<{ title: string }> }
}

const workspace = process.cwd()
const fixturePath = resolve(workspace, 'fixtures/planscan/heldout.v0.1.jsonl')
const outputPath = resolve(workspace, 'models/release-probes.v0.1.json')
const manifestPath = resolve(workspace, 'models/manifest.json')
const fixtureRows = (await readFile(fixturePath, 'utf8'))
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as PlanScanFixtureRow)
const documentFixture = fixtureRows.find(
  (row) => row.method === 'native-text' && row.gold.groups.length >= 2
)
if (!documentFixture) throw new Error('A native PlanScan release fixture is required')

const suite = releaseProbeSuiteSchema.parse({
  schemaVersion: 1,
  contractVersion: '0.1',
  generatedFrom: 'fixtures/planscan/heldout.v0.1.jsonl',
  planner: [
    {
      text: 'Remind me to call Mom tomorrow at 6 pm',
      expectedOperation: 'reminder.create',
      expectedEligibleForAssistance: true
    },
    {
      text: 'Show my agenda tomorrow',
      expectedOperation: 'calendar.list',
      expectedEligibleForAssistance: true
    },
    {
      text: 'Block focus time Friday from 2 pm to 4 pm',
      expectedOperation: 'event.create',
      expectedEligibleForAssistance: true
    }
  ],
  speaker: {
    requestId: 'release-probe:speaker',
    speechAct: 'proposal',
    facts: [
      {
        key: 'SUMMARY',
        kind: 'text',
        placeholder: '<SUMMARY>',
        value: 'Create “Tea with Mina” next Friday at 4:00 PM'
      }
    ],
    style: {
      warmth: 0.82,
      brevity: 0.62,
      formality: 0.18,
      humor: 0.12,
      emoji: 0,
      contractions: true,
      proactivity: 0.48
    },
    recentReplies: [],
    expectedCandidateCount: 5
  },
  document: {
    page: documentFixture.page,
    expectedDocumentType: documentFixture.documentType,
    expectedGroupTitles: documentFixture.gold.groups.map((group) => group.title)
  }
})
const contents = `${JSON.stringify(suite, null, 2)}\n`
await writeFile(outputPath, contents, 'utf8')

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  artifacts: Array<Record<string, unknown>>
}
manifest.artifacts = manifest.artifacts.filter((artifact) => artifact.role !== 'release-validation')
manifest.artifacts.push({
  id: 'remind-me-release-probes.v0.1',
  role: 'release-validation',
  component: 'golden-fixture',
  version: '0.1.0',
  format: 'json',
  path: 'release-probes.v0.1.json',
  sha256: createHash('sha256').update(contents).digest('hex'),
  byteLength: Buffer.byteLength(contents),
  required: true,
  contractVersion: '0.1',
  locale: 'en-US',
  license: 'MIT',
  provenance: 'project-trained',
  sourceUrl: null,
  generator: 'scripts/generate-release-probes.ts'
})
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`Generated ${suite.planner.length + 2} first-launch release probes.`)
