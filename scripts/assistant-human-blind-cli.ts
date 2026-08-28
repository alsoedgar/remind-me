import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assistantSuiteManifestSchema } from './assistant-evaluation-contract'
import {
  assertHumanBlindTrainingBoundary,
  freezeHumanBlindCollection,
  loadAndAuditHumanBlindCollection,
  phase8HumanBlindPolicy,
  type HumanBlindAudit
} from './assistant-human-blind'

const workspace = process.cwd()
const args = process.argv.slice(2)
const command = args[0]?.startsWith('--') ? 'status' : (args[0] ?? 'status')

function option(name: string): string | undefined {
  const prefix = `--${name}=`
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function flag(name: string): boolean {
  return args.includes(`--${name}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function printAudit(audit: HumanBlindAudit): void {
  console.log(`Phase 8 human-blind status: ${audit.readyToFreeze ? 'ready to freeze' : 'pending'}`)
  console.log(`Scenarios: ${audit.scenarios}/${phase8HumanBlindPolicy.minimumScenarios}`)
  console.log(`Participants: ${audit.participants}/${phase8HumanBlindPolicy.minimumParticipants}`)
  console.log(`Independent annotators: ${audit.annotators}`)
  console.log(`Turns: ${audit.turns}`)
  console.log(`Out of domain: ${audit.outOfDomain}/${phase8HumanBlindPolicy.minimumOutOfDomain}`)
  console.log(
    `Noisy language: ${audit.noisyLanguage}/${phase8HumanBlindPolicy.minimumNoisyLanguage}`
  )
  console.log(
    `Contamination: ${audit.exactContaminationMatches} exact, ${audit.nearContaminationMatches} near`
  )
  if (audit.blockers.length > 0) {
    console.log('Blockers:')
    for (const blocker of audit.blockers) console.log(`- ${blocker}`)
  }
}

async function printSyntheticProxyStatus(): Promise<void> {
  const path = resolve(workspace, 'evals/assistant/synthetic-phase8/manifest.json')
  if (!(await exists(path))) {
    console.log('Synthetic engineering proxy: not generated')
    return
  }
  const parsed = assistantSuiteManifestSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!parsed.success || !('syntheticEngineeringProxy' in parsed.data)) {
    console.log('Synthetic engineering proxy: invalid manifest')
    return
  }
  console.log(
    `Synthetic engineering proxy: ${parsed.data.scenarios}/2,000 scenarios (project-authored; not human evidence)`
  )
}

function help(): void {
  console.log(`Phase 8 independent human-language evaluation

Commands:
  status      Report collection readiness without failing when collection has not started
  validate    Validate and audit the private collection; fails while any blocker remains
  freeze      Create a de-identified, hash-bound release under human-blind/releases
  boundary    Prove training and teacher code cannot read the sealed evaluation path

Options:
  --input=<path>       Private JSONL collection (default: evals/assistant/human-blind/collection.local.jsonl)
  --version=<version>  Required by freeze, for example 8.0.0
  --force              Explicitly replace an existing release
  --json               Print the audit as JSON`)
}

const sourcePath = resolve(
  workspace,
  option('input') ?? 'evals/assistant/human-blind/collection.local.jsonl'
)
const protocolPath = resolve(workspace, 'evals/assistant/human-blind/protocol-v1.md')
const modelLockPath = resolve(workspace, 'models/manifest.json')

try {
  if (command === 'help' || flag('help')) {
    help()
  } else if (command === 'boundary') {
    await assertHumanBlindTrainingBoundary(workspace)
    console.log('Phase 8 training boundary passed: sealed human-blind paths are not referenced.')
  } else if (command === 'status' || command === 'validate') {
    if (!(await exists(sourcePath))) {
      console.log('Phase 8 human-blind status: not started')
      console.log(`Scenarios: 0/${phase8HumanBlindPolicy.minimumScenarios}`)
      console.log(`Participants: 0/${phase8HumanBlindPolicy.minimumParticipants}`)
      console.log(`Private collection path: ${sourcePath}`)
      console.log('No participant records were fabricated. The production claim remains pending.')
      await printSyntheticProxyStatus()
      if (command === 'validate') process.exitCode = 1
    } else {
      const audit = await loadAndAuditHumanBlindCollection(workspace, sourcePath)
      if (flag('json')) console.log(JSON.stringify(audit, null, 2))
      else printAudit(audit)
      if (command === 'status' && !flag('json')) await printSyntheticProxyStatus()
      if (command === 'validate' && !audit.readyToFreeze) process.exitCode = 1
    }
  } else if (command === 'freeze') {
    const version = option('version')
    if (!version || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu.test(version)) {
      throw new Error('freeze requires --version=<semver>, for example --version=8.0.0')
    }
    const outputDirectory = resolve(workspace, `evals/assistant/human-blind/releases/v${version}`)
    const result = await freezeHumanBlindCollection({
      workspace,
      sourcePath,
      outputDirectory,
      suiteVersion: version,
      modelLockPath,
      protocolPath,
      force: flag('force')
    })
    console.log(`Frozen ${result.audit.scenarios} scenarios at ${outputDirectory}`)
    console.log(`Suite SHA-256: ${result.manifest.sha256}`)
    console.log(
      'The release is eligible for scoring; it is not a passing result until the Phase 8 gate runs.'
    )
  } else {
    throw new Error(`Unknown command: ${command}. Run with help for usage.`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
