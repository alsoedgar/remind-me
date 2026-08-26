import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { arch, availableParallelism, cpus, freemem, homedir, platform, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { performance as perf } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { getLlama, LlamaChatSession, LlamaLogLevel } from 'node-llama-cpp'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(SCRIPT_DIRECTORY, '..', '..', '..')
const MODEL_FILE = 'Qwen3-1.7B-Q4_K_M.gguf'
const MODEL_BYTES = 1_282_439_264
const MODEL_SHA256 = 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5'

function defaultModelPath() {
  if (platform() === 'win32' && process.env.APPDATA) {
    return resolve(
      process.env.APPDATA,
      '@remind-me',
      'desktop',
      'optional-models',
      'qwen3-1.7b-q4',
      MODEL_FILE
    )
  }
  if (platform() === 'darwin') {
    return resolve(
      homedir(),
      'Library',
      'Application Support',
      '@remind-me',
      'desktop',
      'optional-models',
      'qwen3-1.7b-q4',
      MODEL_FILE
    )
  }
  return resolve(
    process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'),
    '@remind-me',
    'desktop',
    'optional-models',
    'qwen3-1.7b-q4',
    MODEL_FILE
  )
}

function argument(name) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null
}

async function sha256(path) {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path, { highWaterMark: 4 * 1_024 * 1_024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', rejectHash)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

function percentile(values, value) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * value) - 1)] ?? 0
}

function round(value, digits = 2) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

async function main() {
  const modelPath = resolve(
    argument('model') || process.env.REMIND_ME_QWEN_PATH || defaultModelPath()
  )
  const outputPath = resolve(
    argument('output') ||
      resolve(WORKSPACE, 'evals', 'flex-model', 'phase7', 'benchmark.latest.json')
  )
  const requestedThreads = argument('threads')
    ?.split(',')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0)
  const logicalThreads = Math.max(1, availableParallelism?.() ?? cpus().length)
  const threadPoints = [
    ...new Set(
      (requestedThreads?.length
        ? requestedThreads
        : [
            Math.max(1, Math.min(4, logicalThreads - 1)),
            Math.max(1, Math.min(8, logicalThreads - 1)),
            Math.max(1, Math.min(12, logicalThreads - 1)),
            Math.max(1, Math.min(16, logicalThreads - 1))
          ]
      ).filter((value) => value <= logicalThreads)
    )
  ].sort((left, right) => left - right)

  const modelStats = await stat(modelPath)
  if (!modelStats.isFile() || modelStats.size !== MODEL_BYTES) {
    throw new Error(`The pinned optional model was not found at the expected byte length`)
  }
  const integrityStarted = perf.now()
  if ((await sha256(modelPath)) !== MODEL_SHA256) {
    throw new Error('The optional model failed its pinned SHA-256 check')
  }
  const integrityCheckMs = perf.now() - integrityStarted

  const useMetal = platform() === 'darwin' && arch() === 'arm64'
  const startedLoad = perf.now()
  const llama = await getLlama({
    gpu: useMetal ? 'auto' : false,
    build: 'never',
    skipDownload: true,
    progressLogs: false,
    logLevel: LlamaLogLevel.error,
    maxThreads: Math.max(...threadPoints)
  })
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: useMetal ? 'auto' : 0,
    useMmap: true
  })
  const modelLoadMs = perf.now() - startedLoad
  const prompt =
    '/no_think\nAnswer in one short sentence: What can a private offline calendar assistant help with?'
  const results = []

  try {
    for (const threads of threadPoints) {
      const contextStarted = perf.now()
      const context = await model.createContext({
        contextSize: 4096,
        batchSize: 512,
        flashAttention: 'auto',
        threads,
        performanceTracking: true
      })
      const contextCreateMs = perf.now() - contextStarted
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt:
          'You are a concise private local calendar assistant. Do not think aloud or invent personal facts.'
      })
      const samples = []
      try {
        for (let index = 0; index < 3; index += 1) {
          session.resetChatHistory()
          const started = perf.now()
          const response = await session.prompt(prompt, {
            budgets: { thoughtTokens: 0 },
            maxTokens: 48,
            temperature: 0,
            seed: 17
          })
          const elapsedMs = perf.now() - started
          const outputTokens = model.tokenize(response).length
          samples.push({
            elapsedMs: round(elapsedMs),
            outputTokens,
            effectiveTokensPerSecond: round((outputTokens * 1000) / elapsedMs),
            warm: index > 0
          })
        }
        const warm = samples.filter((sample) => sample.warm)
        results.push({
          threads,
          contextCreateMs: round(contextCreateMs),
          samples,
          warmMedianMs: round(
            percentile(
              warm.map((sample) => sample.elapsedMs),
              0.5
            )
          ),
          warmP95Ms: round(
            percentile(
              warm.map((sample) => sample.elapsedMs),
              0.95
            )
          ),
          rssMiB: round(process.memoryUsage().rss / 1024 / 1024)
        })
      } finally {
        session.dispose({ disposeSequence: true })
        await context.dispose()
      }
    }
  } finally {
    await model.dispose()
    await llama.dispose()
  }

  const fastest = [...results].sort((left, right) => left.warmMedianMs - right.warmMedianMs)[0]
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    workload: '48-token-cap concise chat; first sample cold-prefix, next two prefix-reuse',
    model: {
      id: 'qwen3-1.7b-q4',
      quantization: 'Q4_K_M',
      bytes: MODEL_BYTES,
      sha256: MODEL_SHA256
    },
    machine: {
      platform: platform(),
      arch: arch(),
      logicalThreads,
      totalMemoryGiB: round(totalmem() / 1024 / 1024 / 1024),
      freeMemoryGiBAtStart: round(freemem() / 1024 / 1024 / 1024),
      backend: useMetal ? 'metal' : 'cpu'
    },
    modelLoadMs: round(modelLoadMs),
    integrityCheckMs: round(integrityCheckMs),
    results,
    fastestThreadPoint: fastest?.threads ?? null,
    note: 'This synthetic benchmark never reads calendar data, conversations, profile memory, or application state.'
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

await main()
