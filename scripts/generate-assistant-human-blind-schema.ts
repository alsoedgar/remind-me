import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { format, resolveConfig } from 'prettier'
import { z } from 'zod'
import { humanBlindCollectionRecordSchema } from './assistant-human-blind'

const workspace = process.cwd()
const outputPath = resolve(workspace, 'evals/assistant/human-blind/collection-record.schema.json')
const schema = z.toJSONSchema(humanBlindCollectionRecordSchema) as Record<string, unknown>
schema.title = 'Remind Me Phase 8 independent human-blind collection record'
schema.description =
  'One private collection record. The TypeScript validator additionally enforces temporal ordering, participant/annotator separation, user-reported provenance, uniqueness, privacy scans, coverage, and contamination boundaries.'

const properties = schema.properties as Record<string, Record<string, unknown>>
const scenario = properties.scenario
const scenarioProperties = scenario?.properties as Record<string, unknown> | undefined
if (scenarioProperties) scenarioProperties.source = { const: 'user-reported', type: 'string' }
const annotation = properties.annotation
const annotationProperties = annotation?.properties as
  Record<string, Record<string, unknown>> | undefined
if (annotationProperties?.annotatorIds) annotationProperties.annotatorIds.uniqueItems = true

const prettierConfig = (await resolveConfig(outputPath)) ?? {}
const contents = await format(JSON.stringify(schema), {
  ...prettierConfig,
  parser: 'json'
})
if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8')
  if (existing !== contents) {
    throw new Error(
      'The Phase 8 collection schema is stale; run pnpm eval:assistant:human-blind:schema'
    )
  }
  console.log('Phase 8 collection schema matches the executable validator.')
} else {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, contents, 'utf8')
  console.log(`Wrote ${outputPath}`)
}
