import { describe, expect, it } from 'vitest'
import { splitCalendarRequests } from './multi-request-parser'

describe('multi-request splitting', () => {
  it('keeps explicit semicolon and newline actions separate', () => {
    expect(
      splitCalendarRequests(
        'Schedule dentist Monday at 2 PM; remind me to call Mom Tuesday at 6 PM'
      )
    ).toEqual(['Schedule dentist Monday at 2 PM', 'remind me to call Mom Tuesday at 6 PM'])
    expect(splitCalendarRequests('1. Delete dentist\n2. Move lunch to Friday at noon')).toEqual([
      'Delete dentist',
      'Move lunch to Friday at noon'
    ])
  })

  it('inherits an event verb across an implicit dated list', () => {
    expect(
      splitCalendarRequests(
        'Add dentist Monday at 2 PM, gym Tuesday at 6 PM, and dinner Wednesday at 7 PM'
      )
    ).toEqual([
      'Add dentist Monday at 2 PM',
      'Add gym Tuesday at 6 PM',
      'Add dinner Wednesday at 7 PM'
    ])
  })

  it('does not split an ordinary event title containing and', () => {
    expect(splitCalendarRequests('Schedule coffee and planning tomorrow at 9 AM')).toEqual([
      'Schedule coffee and planning tomorrow at 9 AM'
    ])
  })

  it('splits coordinated events while inheriting the shared day and conversational verb', () => {
    expect(
      splitCalendarRequests(
        'can you add my CS 251 lab for tmr at 1pm, and my Calc III discussion at 2pm?'
      )
    ).toEqual(['can you add my CS 251 lab for tmr at 1pm', 'add my Calc III discussion at 2pm tmr'])
    expect(splitCalendarRequests('Schedule dentist tomorrow at 2 PM and my lunch at 3 PM')).toEqual(
      ['Schedule dentist tomorrow at 2 PM', 'Schedule my lunch at 3 PM tomorrow']
    )
    expect(splitCalendarRequests('schedule tutoring tomorrow at 4 pm and dinner at 7 pm')).toEqual([
      'schedule tutoring tomorrow at 4 pm',
      'schedule dinner at 7 pm tomorrow'
    ])
  })

  it('expands exact known targets for selected and shared mutations', () => {
    const titles = ['Design review', 'Project sync', 'Water plants', 'Coffee and planning']
    expect(splitCalendarRequests('Delete Design review and Project sync', titles)).toEqual([
      'Delete Design review',
      'Delete Project sync'
    ])
    expect(
      splitCalendarRequests('Move Design review and Project sync to Friday at 2 PM', titles)
    ).toEqual(['Move Design review to Friday at 2 PM', 'Move Project sync to Friday at 2 PM'])
    expect(
      splitCalendarRequests(
        'Move Design review to Friday at 2 PM and Project sync to Monday at 9 AM',
        titles
      )
    ).toEqual(['Move Design review to Friday at 2 PM', 'Move Project sync to Monday at 9 AM'])
    expect(splitCalendarRequests('Mark Water plants and Project sync done', titles)).toEqual([
      'Complete Water plants',
      'Complete Project sync'
    ])
  })

  it('does not split one known title that contains a conjunction', () => {
    expect(
      splitCalendarRequests('Delete Coffee and planning', ['Coffee and planning', 'Design review'])
    ).toEqual(['Delete Coffee and planning'])
  })
})
