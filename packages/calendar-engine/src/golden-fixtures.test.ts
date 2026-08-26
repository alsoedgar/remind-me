import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dryRunCalendarCommand } from './dry-run'
import { goldenFixtureSchema } from './golden-fixture'
import { resolveCalendarIR } from './resolver'

const fixturePath = fileURLToPath(
  new URL('../../../fixtures/golden/calendar-ir.v0.1.jsonl', import.meta.url)
)

describe('golden CalendarIR fixtures', () => {
  it('validates, resolves, serializes, and dry-runs every case', () => {
    const fixtures = readFileSync(fixturePath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => goldenFixtureSchema.parse(JSON.parse(line)))

    expect(fixtures.length).toBeGreaterThanOrEqual(250)

    for (const fixture of fixtures) {
      const roundTrip = goldenFixtureSchema.parse(JSON.parse(JSON.stringify(fixture)))
      expect(roundTrip, fixture.id).toEqual(fixture)

      const resolved = resolveCalendarIR(fixture.draft, fixture.context)
      expect(resolved, fixture.id).toEqual(fixture.expectedResolved)

      const dryRun = dryRunCalendarCommand(resolved, fixture.initialState, fixture.context)
      expect(dryRun, fixture.id).toEqual(fixture.expectedDryRun)
    }
  })
})
