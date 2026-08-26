import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPlanScanInfo, unavailablePlanScanInfo } from './planscan'

const modelRoot = fileURLToPath(new URL('../../../models/', import.meta.url))

describe('PlanScan installation status', () => {
  it('loads the bundled scratch-model metadata used by app info', async () => {
    await expect(loadPlanScanInfo(modelRoot)).resolves.toMatchObject({
      available: true,
      id: 'planscan-spatialhashgraph-5m-en',
      version: '0.1.0',
      architecture: 'SpatialHashGraph',
      parameterCount: 5_242_880,
      workingSetBytes: 5_242_880,
      mode: 'evidence-gated-spatial-graph',
      teacherUsed: false,
      networkRequired: false,
      error: null
    })
  })

  it('exposes a truthful rules fallback when loading fails', () => {
    expect(unavailablePlanScanInfo(new Error('digest mismatch'))).toMatchObject({
      available: false,
      parameterCount: 0,
      architecture: 'rules fallback',
      networkRequired: false,
      error: 'digest mismatch'
    })
  })
})
