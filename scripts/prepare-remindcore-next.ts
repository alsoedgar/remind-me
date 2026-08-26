import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assistantCapabilityRegistry } from '@remind-me/assistant-core'

const outcomeOnly = new Set([
  'calendar.import.propose',
  'assistant.clarify',
  'assistant.reject',
  'assistant.unsupported'
])

function routeFor(domain: string, capabilityId: string): string {
  if (capabilityId === 'assistant.chat.respond') return 'broad-chat'
  if (domain === 'memory') return 'memory'
  if (domain === 'conversation') return 'conversation'
  if (domain === 'document') return 'document'
  if (domain === 'app' || domain === 'model') return 'app'
  return 'calendar'
}

const registryProjection = assistantCapabilityRegistry.map((capability) => ({
  id: capability.id,
  domain: capability.domain,
  status: capability.status,
  confirmation: capability.confirmation,
  supportsMultiAction: capability.supportsMultiAction,
  requiresOptionalModel: capability.requiresOptionalModel
}))
const registrySha256 = createHash('sha256').update(JSON.stringify(registryProjection)).digest('hex')
const teacherJobs = JSON.parse(
  await readFile(resolve(process.cwd(), 'ml/assistant_corpus/raw/teacher-jobs.json'), 'utf8')
) as {
  registrySha256: string
  jobs: Array<{ capabilityId: string; cues: string[] }>
}
if (teacherJobs.registrySha256 !== registrySha256) {
  throw new Error('The project-authored cue catalog drifted from the capability registry')
}
const cuesByCapability = new Map(
  teacherJobs.jobs.map((job) => [job.capabilityId, [...new Set(job.cues)]])
)
const capabilities = assistantCapabilityRegistry
  .filter((capability) => !outcomeOnly.has(capability.id))
  .map((capability) => ({
    id: capability.id,
    route: routeFor(capability.domain, capability.id),
    domain: capability.domain,
    status: capability.status,
    handler: capability.handler,
    title: capability.title,
    description: capability.description,
    aliases: [...capability.aliases],
    cues: cuesByCapability.get(capability.id) ?? [],
    confirmation: capability.confirmation,
    supportsMultiAction: capability.supportsMultiAction,
    requiresOptionalModel: capability.requiresOptionalModel
  }))

const output = {
  schemaVersion: 1,
  generator: 'scripts/prepare-remindcore-next.ts',
  registrySha256,
  provenance: {
    source: 'project-authored AssistantPlan v2 capability registry',
    cueSource: 'project-authored Phase 4 seed catalog; no heldout surface templates',
    heldoutRowsUsed: false,
    teacherAuthoredLabels: false
  },
  capabilities
}
const nextDirectory = resolve(process.cwd(), 'ml/remindcore_next')
const path = resolve(nextDirectory, 'data/capabilities.json')
await mkdir(resolve(nextDirectory, 'data'), { recursive: true })
await mkdir(resolve(nextDirectory, 'teacher'), { recursive: true })
await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

const accepted = JSON.parse(
  await readFile(resolve(process.cwd(), 'ml/assistant_corpus/accepted/templates.json'), 'utf8')
) as {
  provenance: { teacherModelId: string; teacherSha256: string }
  templates: Array<{
    capabilityId: string
    template: string
    placeholders: string[]
    split: string
    source: string
  }>
}
const trainSeeds = new Map(
  accepted.templates
    .filter((template) => template.split === 'train' && template.source === 'project-seed')
    .map((template) => [template.capabilityId, template])
)
const jobs = capabilities.map((capability) => {
  const seed = trainSeeds.get(capability.id)
  if (!seed) throw new Error(`Missing training-only seed for ${capability.id}`)
  return {
    id: `remindcore-next:${capability.id}:train`,
    capabilityId: capability.id,
    meaning: capability.title,
    seedTemplate: seed.template,
    placeholders: seed.placeholders,
    cues: capability.cues,
    sourceSplit: 'train',
    labelAuthority: 'project-registry'
  }
})
await writeFile(
  resolve(nextDirectory, 'teacher/teacher-jobs.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generator: 'scripts/prepare-remindcore-next.ts',
      teacherModelId: accepted.provenance.teacherModelId,
      teacherSha256: accepted.provenance.teacherSha256,
      teacherRole: 'training-only delexicalized surface paraphrase',
      registrySha256,
      paraphrasesPerJob: 2,
      jobs
    },
    null,
    2
  )}\n`,
  'utf8'
)
const repairJobs = jobs.map((job) => ({
  ...job,
  id: job.id.replace(/:train$/u, ':repair'),
  cues: job.cues.length > 1 ? [...job.cues.slice(1), job.cues[0]] : job.cues,
  repairRound: 1
}))
await writeFile(
  resolve(nextDirectory, 'teacher/teacher-repair-jobs.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generator: 'scripts/prepare-remindcore-next.ts',
      teacherModelId: accepted.provenance.teacherModelId,
      teacherSha256: accepted.provenance.teacherSha256,
      teacherRole: 'training-only delexicalized surface paraphrase repair',
      registrySha256,
      paraphrasesPerJob: 2,
      repairRound: 1,
      jobs: repairJobs
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log(`Prepared ${capabilities.length} RemindCore Next capability descriptors.`)
