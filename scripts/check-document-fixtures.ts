import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { maximumDocumentBytes } from '@remind-me/contracts'
import { validateDocumentBytes } from '../packages/importers/src/document-geometry'

const fixtures = [
  { name: 'phase4-schedule.pdf', kind: 'pdf' as const },
  { name: 'phase4-scanned-schedule.pdf', kind: 'pdf' as const },
  {
    name: 'phase4-schedule.png',
    kind: 'image' as const,
    dimensions: { width: 1275, height: 1650 }
  },
  { name: 'phase7-table-plan.pdf', kind: 'pdf' as const },
  { name: 'phase7-scanned-table-plan.pdf', kind: 'pdf' as const },
  {
    name: 'phase7-table-plan.png',
    kind: 'image' as const,
    dimensions: { width: 1650, height: 1275 }
  }
]

const digests = new Set<string>()

for (const fixture of fixtures) {
  const filePath = resolve(process.cwd(), 'fixtures', 'documents', fixture.name)
  const bytes = await readFile(filePath)
  if (bytes.byteLength <= 0 || bytes.byteLength > maximumDocumentBytes) {
    throw new Error(`${fixture.name} is outside the document byte limits`)
  }
  const validation = validateDocumentBytes(bytes)
  if (validation.kind !== fixture.kind) {
    throw new Error(`${fixture.name} was detected as ${validation.kind}, expected ${fixture.kind}`)
  }
  if (fixture.kind === 'pdf' && !bytes.subarray(-1_024).toString('latin1').includes('%%EOF')) {
    throw new Error(`${fixture.name} has no PDF end marker`)
  }
  if (fixture.dimensions) {
    if (
      validation.dimensions?.width !== fixture.dimensions.width ||
      validation.dimensions.height !== fixture.dimensions.height
    ) {
      throw new Error(`${fixture.name} dimensions changed unexpectedly`)
    }
  }
  digests.add(createHash('sha256').update(bytes).digest('hex'))
}

if (digests.size !== fixtures.length) throw new Error('Document fixtures must be distinct')

console.log(
  `Verified ${fixtures.length} bounded native-PDF, scanned-PDF, and image fixtures across vertical and table layouts.`
)
