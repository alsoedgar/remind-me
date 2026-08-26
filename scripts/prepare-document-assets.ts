import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = join(repositoryRoot, 'apps', 'desktop')
const sourcePublicRoot = join(desktopRoot, 'src', 'renderer', 'public')
const outputRoot = join(desktopRoot, '.generated-public')
const require = createRequire(import.meta.url)

function packageRoot(packageName: string, searchPath: string): string {
  return dirname(require.resolve(`${packageName}/package.json`, { paths: [searchPath] }))
}

function assertGeneratedTarget(target: string): void {
  const resolvedTarget = resolve(target)
  const outputPrefix = `${resolve(outputRoot)}${sep}`
  if (resolvedTarget !== resolve(outputRoot) && !resolvedTarget.startsWith(outputPrefix)) {
    throw new Error(`Refusing to write document assets outside ${outputRoot}`)
  }
}

async function copyFile(source: string, destination: string): Promise<number> {
  assertGeneratedTarget(destination)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination)
  return (await stat(destination)).size
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  assertGeneratedTarget(destination)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
}

async function main(): Promise<void> {
  assertGeneratedTarget(outputRoot)
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  await copyDirectory(sourcePublicRoot, outputRoot)

  const tesseractRoot = packageRoot('tesseract.js', desktopRoot)
  const tesseractCoreRoot = packageRoot('tesseract.js-core', tesseractRoot)
  const englishDataRoot = packageRoot('@tesseract.js-data/eng', desktopRoot)
  const pdfRoot = packageRoot('pdfjs-dist', desktopRoot)
  const copied: Record<string, number> = {}

  copied.tesseractWorker = await copyFile(
    join(tesseractRoot, 'dist', 'worker.min.js'),
    join(outputRoot, 'ocr', 'worker.min.js')
  )
  for (const coreFile of [
    'tesseract-core-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js'
  ]) {
    copied[coreFile] = await copyFile(
      join(tesseractCoreRoot, coreFile),
      join(outputRoot, 'ocr', 'core', coreFile)
    )
  }
  copied.englishModel = await copyFile(
    join(englishDataRoot, '4.0.0_best_int', 'eng.traineddata.gz'),
    join(outputRoot, 'ocr', 'lang', 'eng.traineddata.gz')
  )
  copied.pdfWorker = await copyFile(
    join(pdfRoot, 'legacy', 'build', 'pdf.worker.min.mjs'),
    join(outputRoot, 'document', 'pdf.worker.min.mjs')
  )
  copied.planScanConfiguration = await copyFile(
    join(repositoryRoot, 'models', 'planscan', 'planscan-v0.1-int8.json'),
    join(outputRoot, 'planscan', 'planscan-v0.1-int8.json')
  )
  copied.planScanWeights = await copyFile(
    join(repositoryRoot, 'models', 'planscan', 'planscan-v0.1-int8.bin.gz'),
    join(outputRoot, 'planscan', 'planscan-v0.1-int8.bin.gz')
  )
  await copyDirectory(join(pdfRoot, 'cmaps'), join(outputRoot, 'document', 'cmaps'))
  await copyDirectory(
    join(pdfRoot, 'standard_fonts'),
    join(outputRoot, 'document', 'standard_fonts')
  )
  await copyDirectory(join(pdfRoot, 'wasm'), join(outputRoot, 'document', 'wasm'))

  const tesseractPackage = JSON.parse(
    await readFile(join(tesseractRoot, 'package.json'), 'utf8')
  ) as { version: string }
  const pdfPackage = JSON.parse(await readFile(join(pdfRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  const manifestPath = join(outputRoot, 'document', 'runtime-manifest.json')
  assertGeneratedTarget(manifestPath)
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        formatVersion: 1,
        pdfjsVersion: pdfPackage.version,
        tesseractVersion: tesseractPackage.version,
        planScanVersion: '0.1.0',
        language: 'eng',
        copiedBytes: Object.values(copied).reduce((total, value) => total + value, 0),
        assets: Object.fromEntries(Object.entries(copied).map(([key, size]) => [key, { size }]))
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  console.log(`Prepared local document assets in ${relative(repositoryRoot, outputRoot)}`)
}

await main()
