export type ConversationIntent =
  | 'greeting'
  | 'capabilities'
  | 'identity'
  | 'architecture'
  | 'local-time'
  | 'wellbeing'
  | 'encouragement'
  | 'thanks'
  | 'goodbye'

function normalizedConversationText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/,+/gu, ' ')
    .replace(/[.!?;:]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

const leadingGreeting =
  /^(?:hi|hello|hey|hiya|howdy|yo|good morning|good afternoon|good evening)(?: there| remind me| assistant)?(?:,|\s)+/u

/**
 * Recognizes only complete conversational turns. Mixed turns such as
 * “hello, add lunch tomorrow” intentionally continue into calendar parsing.
 */
export function parseConversationIntent(text: string): ConversationIntent | null {
  const normalized = normalizedConversationText(text)
  if (!normalized) return null
  const withoutGreeting = normalized.replace(leadingGreeting, '').trim()

  if (
    /^(?:help|can you help(?: me)?|how can you help(?: me)?|how (?:do i use you|does this work)|what (?:can|could) you (?:do(?: for me)?|help(?: me)? with)|what do you do|what are your (?:features|capabilities)|what are you capable of|show me what you can do|tell me what you can do|tell me what you're able to do|what can i (?:ask|tell|say to) you|what should i (?:ask|say)|give me (?:some )?examples|show me (?:some )?prompts)$/u.test(
      withoutGreeting
    )
  ) {
    return 'capabilities'
  }
  if (
    /^(?:who are you|what are you|what(?:'s| is) your name|tell me about yourself)$/u.test(
      withoutGreeting
    )
  ) {
    return 'identity'
  }
  if (
    /^(?:(?:what|which) models? (?:are you|do you use|power you)|what powers you|how do you work|how are you built|are you (?:an? )?(?:llm|ai|local|offline|private)|do you (?:run|work) (?:locally|offline)|does my data (?:leave|stay on) (?:this device|my computer)|tell me about (?:your|the) models?)$/u.test(
      withoutGreeting
    )
  ) {
    return 'architecture'
  }
  if (
    /^(?:what time is it|what(?:'s| is) the (?:time|date)|what day is it|what(?:'s| is) today(?:'s date)?|today(?:'s| is the) date)$/u.test(
      withoutGreeting
    )
  ) {
    return 'local-time'
  }
  if (
    /^(?:how are you(?: doing)?|how(?:'s| is) it going|are you there|you there)$/u.test(
      withoutGreeting
    )
  ) {
    return 'wellbeing'
  }
  if (
    /^(?:(?:give|share|tell) me (?:a |some )?(?:(?:short|quick|little) )?(?:motivation|motivational (?:thought|message|note|boost|encouragement))(?: for .+)?|motivate me(?: to .+)?|encourage me(?: to .+)?|i (?:need|could use|want) (?:some )?(?:motivation|encouragement)(?: for .+)?)$/u.test(
      withoutGreeting
    )
  ) {
    return 'encouragement'
  }
  if (
    /^(?:thanks|thanks a lot|thanks so much|thank you|thank you so much|thank you very much|much appreciated|i appreciate it)$/u.test(
      withoutGreeting
    )
  ) {
    return 'thanks'
  }
  if (
    /^(?:bye|goodbye|see you|see you later|talk to you later|good night|catch you later)$/u.test(
      withoutGreeting
    )
  ) {
    return 'goodbye'
  }
  if (
    /^(?:hi|hello|hey|hiya|howdy|yo|good morning|good afternoon|good evening)(?: there| remind me| assistant)?$/u.test(
      normalized
    )
  ) {
    return 'greeting'
  }
  return null
}
