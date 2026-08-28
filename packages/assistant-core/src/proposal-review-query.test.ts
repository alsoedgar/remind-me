import { describe, expect, it } from 'vitest'
import { parseProposalReviewQuery } from './proposal-review-query'

const labels = ['CS 251 lab', 'Calculus III discussion', 'Call Mom']

describe('parseProposalReviewQuery', () => {
  it('recognizes overview and count questions about the unsaved review', () => {
    expect(parseProposalReviewQuery("What's in the review?", labels)).toEqual({
      kind: 'overview',
      mode: 'names'
    })
    expect(parseProposalReviewQuery('What will this proposal do?', labels)).toEqual({
      kind: 'overview',
      mode: 'actions'
    })
    expect(parseProposalReviewQuery('How many changes are in the preview?', labels)).toEqual({
      kind: 'count'
    })
  })

  it('grounds detail questions by visible position or exact reviewed title', () => {
    expect(parseProposalReviewQuery('What time is the second one?', labels)).toEqual({
      kind: 'detail',
      indexes: [1],
      attribute: 'time'
    })
    expect(parseProposalReviewQuery('Where is CS 251 lab?', labels)).toEqual({
      kind: 'detail',
      indexes: [0],
      attribute: 'location'
    })
    expect(parseProposalReviewQuery('Where is CS 251 lb?', labels)).toEqual({
      kind: 'detail',
      indexes: [0],
      attribute: 'location'
    })
    expect(parseProposalReviewQuery('What time is the secnd one?', labels)).toEqual({
      kind: 'detail',
      indexes: [1],
      attribute: 'time'
    })
    expect(parseProposalReviewQuery('Do the first and third ones repeat?', labels)).toEqual({
      kind: 'detail',
      indexes: [0, 2],
      attribute: 'recurrence'
    })
    expect(parseProposalReviewQuery('Will the first one repeat?', labels)).toEqual({
      kind: 'detail',
      indexes: [0],
      attribute: 'recurrence'
    })
  })

  it('supports conflict questions and leaves ordinary calendar reads alone', () => {
    expect(
      parseProposalReviewQuery('Will these changes conflict with my calendar?', labels)
    ).toEqual({ kind: 'conflicts', indexes: [0, 1, 2] })
    expect(parseProposalReviewQuery('What do I have tomorrow?', labels)).toBeNull()
    expect(
      parseProposalReviewQuery('make a copy of Design review tomorrow', ['Design review'])
    ).toBeNull()
  })

  it('clarifies duplicate titles and out-of-range review positions', () => {
    expect(
      parseProposalReviewQuery('What time is Office hours?', ['Office hours', 'Office hours'])
    ).toMatchObject({ kind: 'clarify' })
    expect(parseProposalReviewQuery('Where is the fourth one?', labels)).toMatchObject({
      kind: 'clarify'
    })
  })
})
