import { describe, expect, it } from 'vitest'
import { parseConversationIntent, type ConversationIntent } from './conversation-intent'

describe('local conversational intent parsing', () => {
  it.each<[string, ConversationIntent]>([
    ['Hello!', 'greeting'],
    ['Good afternoon, assistant', 'greeting'],
    ['Hello, what do you do?', 'capabilities'],
    ['What are your capabilities?', 'capabilities'],
    ['What can I ask you?', 'capabilities'],
    ['Give me some examples', 'capabilities'],
    ["Tell me what you're able to do", 'capabilities'],
    ['Who are you?', 'identity'],
    ['What models do you use?', 'architecture'],
    ['Are you local?', 'architecture'],
    ['How are you built?', 'architecture'],
    ['What day is it?', 'local-time'],
    ["What's the time?", 'local-time'],
    ["How's it going?", 'wellbeing'],
    ['Give me a short motivational thought for studying', 'encouragement'],
    ['I could use some encouragement', 'encouragement'],
    ['Thank you so much!', 'thanks'],
    ['Talk to you later', 'goodbye']
  ])('maps %s to %s', (text, intent) => {
    expect(parseConversationIntent(text)).toBe(intent)
  })

  it.each([
    'Hello, add lunch tomorrow at noon',
    'Thanks, move the project review to Friday',
    'Help me schedule a workout next Tuesday at 7 AM',
    'What do I have today?',
    'Are you local, and add lunch tomorrow at noon',
    'Delete the dentist appointment'
  ])('does not swallow a calendar request: %s', (text) => {
    expect(parseConversationIntent(text)).toBeNull()
  })
})
