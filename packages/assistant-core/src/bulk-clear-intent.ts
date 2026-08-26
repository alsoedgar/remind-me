export type BulkClearScope = 'events' | 'reminders' | 'both'

export interface BulkClearIntent {
  scope: BulkClearScope
}

export interface ScopedBulkClearRequest {
  scope: BulkClearScope | 'unclear'
  temporalText: string
  message: string
  options: string[]
}

function normalizeBulkClearText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[/|]+/gu, ' ')
    .replace(/[.!?;:,]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

const destructiveAction =
  /\b(?:clear(?:\s+out)?|delete|remove|erase|wipe|empty|reset|purge|get\s+rid\s+of|start\s+over\s+with|start\s+(?:(?:my|the)\s+)?(?:calendar|schedule|agenda)\s+over)\b/u
const universalScope = /\b(?:all|every|everything|entire|whole|completely)\b/u
const calendarContainer = /\b(?:calendar|schedule|agenda)\b/u
const eventTarget = /\b(?:events?|dates?|appointments?|meetings?|classes?|entries|plans?)\b/u
const reminderTarget = /\b(?:reminders?|tasks?|to[ -]?dos?)\b/u
const temporalSubset =
  /\b(?:today|tomorrow|tonight|yesterday|upcoming|future|past|this\s+week|next\s+week|last\s+week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|before|after|through|until)\b|\b\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?\b/u
const negatedAction =
  /\b(?:do\s+not|don't|dont|never|not\s+to)\s+(?:clear|delete|remove|erase|wipe|empty|reset|purge)\b/u

/**
 * Recognizes only whole-calendar destructive requests. Day/range-limited
 * deletion is intentionally left to the ordinary calendar parser so a phrase
 * such as “clear Tuesday” can never be promoted into a global wipe.
 */
export function parseBulkClearIntent(text: string): BulkClearIntent | null {
  const normalized = normalizeBulkClearText(text)
  if (!normalized || negatedAction.test(normalized) || temporalSubset.test(normalized)) return null
  if (!destructiveAction.test(normalized)) return null

  const hasContainer = calendarContainer.test(normalized)
  const hasEvents = eventTarget.test(normalized)
  const hasReminders = reminderTarget.test(normalized)
  if (!hasContainer && !hasEvents && !hasReminders) return null

  const directContainerClear =
    /\b(?:clear(?:\s+out)?|reset|wipe|empty|purge)\s+(?:(?:all|everything)\s+(?:in|from)\s+)?(?:(?:my|the|this)\s+)?(?:(?:entire|whole)\s+)?(?:calendar|schedule|agenda)\b/u.test(
      normalized
    ) || /\bstart\s+(?:(?:my|the)\s+)?(?:calendar|schedule|agenda)\s+over\b/u.test(normalized)

  if (!universalScope.test(normalized) && !directContainerClear) return null

  if (hasEvents && hasReminders) return { scope: 'both' }
  if (hasReminders) {
    const explicitlyIncludesContainer =
      /\b(?:calendar|schedule|agenda)\b.*\b(?:and|plus|including)\b.*\b(?:reminders?|tasks?|to[ -]?dos?)\b/u.test(
        normalized
      ) ||
      /\b(?:reminders?|tasks?|to[ -]?dos?)\b.*\b(?:and|plus)\b.*\b(?:calendar|schedule|agenda)\b/u.test(
        normalized
      )
    return { scope: explicitlyIncludesContainer ? 'both' : 'reminders' }
  }
  if (hasEvents) return { scope: 'events' }

  const everythingInContainer =
    /\beverything\b.*\b(?:in|from|inside|on)\b.*\b(?:calendar|schedule|agenda)\b/u.test(normalized)
  return { scope: everythingInContainer ? 'both' : 'events' }
}

/**
 * Detects destructive language that also contains a date or range. It keeps
 * that request out of the global-clear path until its exact subset is known.
 */
export function parseScopedBulkClearRequest(text: string): ScopedBulkClearRequest | null {
  const normalized = normalizeBulkClearText(text)
  if (!normalized || negatedAction.test(normalized) || !destructiveAction.test(normalized)) {
    return null
  }
  const temporalMatch = temporalSubset.exec(normalized)
  if (!temporalMatch?.[0]) return null
  const hasContainer = calendarContainer.test(normalized)
  const hasEvents = eventTarget.test(normalized)
  const hasReminders = reminderTarget.test(normalized)
  if (!hasContainer && !hasEvents && !hasReminders && !universalScope.test(normalized)) return null
  const broadSubset =
    universalScope.test(normalized) ||
    /\b(?:clear(?:\s+out)?|wipe|empty|reset|purge)\b.*\b(?:calendar|schedule|agenda)\b/u.test(
      normalized
    ) ||
    /\b(?:events|dates|appointments|meetings|classes|entries|plans|reminders|tasks|to[ -]?dos)\b/u.test(
      normalized
    )
  if (!broadSubset) return null

  const scope: ScopedBulkClearRequest['scope'] =
    hasEvents && hasReminders
      ? 'both'
      : hasReminders
        ? 'reminders'
        : hasEvents || hasContainer
          ? 'events'
          : 'unclear'
  const temporalText = temporalMatch[0]
  return {
    scope,
    temporalText,
    message:
      scope === 'unclear'
        ? `Should I remove only events on ${temporalText}, only reminders, or both? I will not treat this as a whole-calendar reset.`
        : `I understood a ${temporalText}-only deletion, not a whole-calendar reset. Which exact ${scope === 'both' ? 'events and reminders' : scope} should be included?`,
    options:
      scope === 'unclear'
        ? ['Events only', 'Reminders only', 'Events and reminders', 'Cancel']
        : [`All matching ${scope}`, 'Let me choose', 'Cancel']
  }
}
