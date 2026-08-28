import { describe, expect, it } from 'vitest'
import { parseProposalReviewCorrection } from './proposal-review-correction'

const labels = ['CS 251 lab', 'Calculus III discussion', 'Study group']

describe('parseProposalReviewCorrection', () => {
  it('grounds ordinal edits and keeps their shared instruction', () => {
    expect(parseProposalReviewCorrection('Actually, make the second one 4 PM', labels)).toEqual({
      kind: 'edit',
      indexes: [1],
      instruction: '4 PM',
      verb: 'make'
    })
    expect(
      parseProposalReviewCorrection('change first and third to Saturday at 2 PM', labels)
    ).toEqual({
      kind: 'edit',
      indexes: [0, 2],
      instruction: 'saturday at 2 PM',
      verb: 'change'
    })
    expect(parseProposalReviewCorrection('actually make it 5 PM', ['Dentist'])).toEqual({
      kind: 'edit',
      indexes: [0],
      instruction: '5 PM',
      verb: 'make'
    })
  })

  it('selects subsets without confusing ordinary calendar deletion', () => {
    expect(parseProposalReviewCorrection('keep only the first and third ones', labels)).toEqual({
      kind: 'keep',
      indexes: [0, 2]
    })
    expect(parseProposalReviewCorrection('remove the first one from that review', labels)).toEqual({
      kind: 'remove',
      indexes: [0]
    })
    expect(parseProposalReviewCorrection('remove all calendar events', labels)).toBeNull()
  })

  it('repairs common ordinal typos before selection and rejects out-of-range positions', () => {
    expect(parseProposalReviewCorrection('make the secnd one 5 PM', labels)).toEqual({
      kind: 'edit',
      indexes: [1],
      instruction: '5 PM',
      verb: 'make'
    })
    expect(parseProposalReviewCorrection('make the fourth one 5 PM', labels)).toMatchObject({
      kind: 'clarify'
    })
  })

  it('requires positions when duplicate proposal titles make a name ambiguous', () => {
    expect(
      parseProposalReviewCorrection('actually change Office hours to 5 PM', [
        'Office hours',
        'Office hours'
      ])
    ).toMatchObject({ kind: 'clarify' })
  })

  it('grounds full reviewed names even when the title itself contains “to”', () => {
    expect(parseProposalReviewCorrection('change Talk to Mom to 7 PM', ['Talk to Mom'])).toEqual({
      kind: 'edit',
      indexes: [0],
      instruction: '7 PM',
      verb: 'change'
    })
  })
})
