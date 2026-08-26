import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { goldenFixtureSchema } from '@remind-me/calendar-engine'

const fixturePath = resolve(process.cwd(), 'fixtures/golden/calendar-ir.v0.1.jsonl')
const manifestPath = resolve(process.cwd(), 'fixtures/golden/manifest.json')
const jsonLines = await readFile(fixturePath, 'utf8')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  count: number
  sha256: string
  operationCounts: Record<string, number>
}
const lines = jsonLines.trim().split(/\r?\n/)
const fixtures = lines.map((line) => goldenFixtureSchema.parse(JSON.parse(line)))
const ids = new Set(fixtures.map((fixture) => fixture.id))
const digest = createHash('sha256').update(jsonLines).digest('hex')

if (fixtures.length < 250)
  throw new Error(`Expected at least 250 fixtures, found ${fixtures.length}`)
if (ids.size !== fixtures.length) throw new Error('Golden fixture IDs are not unique')
if (manifest.count !== fixtures.length)
  throw new Error('Golden fixture manifest count does not match')
if (manifest.sha256 !== digest) throw new Error('Golden fixture manifest hash does not match')

const requiredOperations = [
  'event.create',
  'event.duplicate',
  'event.update',
  'event.move',
  'event.delete',
  'reminder.create',
  'reminder.update',
  'reminder.complete',
  'reminder.delete',
  'calendar.list',
  'calendar.search',
  'calendar.availability',
  'calendar.conflicts',
  'assistant.clarify',
  'assistant.reject',
  'assistant.unsupported',
  'import.propose'
]

for (const operation of requiredOperations) {
  if (!manifest.operationCounts[operation])
    throw new Error(`Missing golden operation: ${operation}`)
}

console.log(
  `Verified ${fixtures.length} golden fixtures and all ${requiredOperations.length} operations.`
)
