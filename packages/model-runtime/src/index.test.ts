import { describe, expect, it } from 'vitest'
import { confidenceFromLogProbabilities, normalizeVoiceTranscript } from './index'

describe('voice transcript post-processing', () => {
  it.each([
    ['REMIND ME TO CALL MARY TO MORROW AT SIX P M', 'Remind me to call mary tomorrow at 6 pm'],
    [
      'BLOCK FOCUS TIME NEXT FRIDAY FROM TWO IN THE AFTERNOON TO FOUR IN THE AFTERNOON',
      'Block focus time next friday from 2 pm to 4 pm'
    ],
    ['schedule tea at half past six', 'Schedule tea at 6:30'],
    ['tea from quarter past two to quarter to five', 'Tea from 2:15 to 4:45'],
    ['remind me at nine thirty a m', 'Remind me at 9:30 am']
  ])('normalizes %s', (input, expected) => {
    expect(normalizeVoiceTranscript(input)).toBe(expected)
  })

  it('turns token log probabilities into a bounded confidence hint', () => {
    expect(confidenceFromLogProbabilities([])).toBeNull()
    expect(confidenceFromLogProbabilities([0, Math.log(0.5)])).toBeCloseTo(0.75)
    expect(confidenceFromLogProbabilities([10])).toBe(1)
  })
})
