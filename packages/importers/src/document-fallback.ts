import {
  documentFallbackModelOutputSchema,
  documentFallbackRequestSchema,
  documentFallbackResponseSchema,
  type DocumentFallbackGroup,
  type DocumentFallbackModelOutput,
  type DocumentFallbackRequest,
  type DocumentFallbackResponse
} from '@remind-me/contracts'

const month =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const weekday = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
const dateEvidencePattern = new RegExp(
  `(?:\\b${month}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${month}(?:,?\\s+\\d{4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?\\b|\\b(?:(?:this|next)\\s+)?${weekday}\\b|\\b(?:today|tomorrow|day after tomorrow)\\b)`,
  'iu'
)
const timeEvidencePattern =
  /\b(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]\.?m\.?)?|(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*[ap]\.?m\.?|noon|midnight)\b/iu
const recurrenceEvidencePattern =
  /\b(?:every|each|weekly|weekdays?|weekends?|until|through|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b|(?:^|[\s:,(])(?:M(?:WF|W|F)?|T(?:R|H)?|W|R|F)(?=$|[\s:),])/iu
const noFixedTimePattern =
  /\bARR\b|\basynchronous\b|\bno\s+fixed\s+(?:meeting\s+)?time\b|\b(?:meeting\s+)?time\s+(?:TBA|to\s+be\s+announced)\b/iu

function groupReferences(group: DocumentFallbackGroup): string[] {
  return [
    ...group.titleBlockIds,
    group.dateBlockId,
    group.timeBlockId,
    group.locationBlockId,
    group.recurrenceBlockId,
    ...group.descriptionBlockIds
  ].filter((id): id is string => Boolean(id))
}

function groupFingerprint(group: DocumentFallbackGroup): string {
  return JSON.stringify({
    title: [...group.titleBlockIds].sort(),
    date: group.dateBlockId,
    time: group.timeBlockId,
    location: group.locationBlockId,
    recurrence: group.recurrenceBlockId,
    description: [...group.descriptionBlockIds].sort()
  })
}

export function validateDocumentFallbackResponse(
  requestValue: DocumentFallbackRequest,
  outputValue: unknown
): DocumentFallbackResponse | null {
  const request = documentFallbackRequestSchema.parse(requestValue)
  const output = documentFallbackModelOutputSchema.safeParse(outputValue)
  if (!output.success) return null
  const blocks = new Map(request.blocks.map((block) => [block.id, block] as const))
  const fingerprints = new Set<string>()

  for (const group of output.data.groups) {
    const references = groupReferences(group)
    if (references.some((id) => !blocks.has(id))) return null
    const fingerprint = groupFingerprint(group)
    if (fingerprints.has(fingerprint)) return null
    fingerprints.add(fingerprint)

    const dateBlock = blocks.get(group.dateBlockId)!
    const timeBlock = group.timeBlockId ? blocks.get(group.timeBlockId)! : null
    const titleText = group.titleBlockIds.map((id) => blocks.get(id)!.text).join(' ')
    const groupedText = [...new Set(references)].map((id) => blocks.get(id)!.text).join(' ')
    if (!dateEvidencePattern.test(dateBlock.text)) return null
    if (
      timeBlock ? !timeEvidencePattern.test(timeBlock.text) : !/\ball[- ]day\b/iu.test(groupedText)
    ) {
      return null
    }
    if (noFixedTimePattern.test(groupedText)) return null
    if (!/[\p{L}\p{N}]/u.test(titleText) || titleText.length > 540) return null
    if (
      dateEvidencePattern.test(titleText) &&
      !/[\p{L}]{2,}/u.test(titleText.replace(dateEvidencePattern, ' '))
    ) {
      return null
    }
    if (group.recurrenceBlockId) {
      const recurrence = blocks.get(group.recurrenceBlockId)!
      if (!recurrenceEvidencePattern.test(recurrence.text)) return null
    }
    if (group.locationBlockId) {
      const location = blocks.get(group.locationBlockId)!
      if (dateEvidencePattern.test(location.text) || timeEvidencePattern.test(location.text)) {
        return null
      }
    }
    if (dateBlock.claimed && (!timeBlock || timeBlock.claimed)) return null
  }

  return documentFallbackResponseSchema.parse({
    ...output.data,
    requestId: request.requestId,
    page: request.page,
    modelId: 'qwen3-1.7b-q4',
    hasMutationAuthority: false
  })
}

export type { DocumentFallbackModelOutput }
