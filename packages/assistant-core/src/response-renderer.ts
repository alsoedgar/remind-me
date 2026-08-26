import { responsePlanSchema, type ResponsePlan, type ResponseStyle } from '@remind-me/contracts'

export interface GroundedFact {
  key: string
  kind: ResponsePlan['facts'][number]['kind']
  value: string
  evidenceIds?: string[]
}

export interface GroundedReplyInput {
  requestId: string
  speechAct: ResponsePlan['speechAct']
  facts: readonly GroundedFact[]
  templates: readonly string[]
  recentReplies?: readonly string[]
  style?: ResponseStyle
  templateGenerator?: GroundedTemplateGenerator | null
  templatePreferences?: readonly GroundedTemplatePreference[]
}

export interface GroundedTemplatePreference {
  templateFingerprint: string
  score: number
}

export interface GroundedReply {
  plan: ResponsePlan
  text: string
  fingerprint: string
  templateFingerprint: string
  source: 'remindspeak' | 'template'
}

export interface GroundedTemplateGenerator {
  generateTemplates: (input: {
    requestId: string
    speechAct: ResponsePlan['speechAct']
    facts: ReadonlyArray<{
      key: string
      kind: ResponsePlan['facts'][number]['kind']
      placeholder: string
      value: string
    }>
    style: ResponseStyle
    recentReplies: readonly string[]
    templatePreferences?: readonly GroundedTemplatePreference[]
  }) => readonly string[]
}

const defaultStyle: ResponseStyle = {
  warmth: 0.86,
  brevity: 0.58,
  formality: 0.12,
  humor: 0.16,
  emoji: 0,
  contractions: true,
  proactivity: 0.56
}

function placeholderFor(key: string): string {
  const normalized = key
    .toLocaleUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  return `<${normalized || 'FACT'}>`
}

function hash(value: string): number {
  let result = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16_777_619)
  }
  return result >>> 0
}

export function replyFingerprint(text: string): string {
  return hash(text.trim().toLocaleLowerCase().replace(/\s+/gu, ' ')).toString(16).padStart(8, '0')
}

export function renderResponsePlan(inputPlan: ResponsePlan): string {
  const plan = responsePlanSchema.parse(inputPlan)
  let rendered = plan.fallbackTemplate
  for (const fact of plan.facts) rendered = rendered.replaceAll(fact.placeholder, fact.value)
  if (/<[A-Z][A-Z0-9_]*>/u.test(rendered)) {
    throw new Error('A protected response placeholder was left unresolved')
  }
  return rendered
}

export function createGroundedReply(input: GroundedReplyInput): GroundedReply {
  if (input.templates.length === 0) throw new Error('At least one grounded template is required')
  const facts = input.facts.map((fact) => ({
    key: fact.key,
    kind: fact.kind,
    placeholder: placeholderFor(fact.key),
    value: fact.value,
    evidenceIds: [...(fact.evidenceIds ?? [])]
  }))
  const style = input.style ?? defaultStyle
  const generatedTemplates = (() => {
    try {
      return (
        input.templateGenerator?.generateTemplates({
          requestId: input.requestId,
          speechAct: input.speechAct,
          facts,
          style,
          recentReplies: input.recentReplies ?? [],
          ...(input.templatePreferences ? { templatePreferences: input.templatePreferences } : {})
        }) ?? []
      )
    } catch {
      return [] as readonly string[]
    }
  })()
  const templateIsEligible = (template: string): boolean => {
    const found: string[] = template.match(/<[A-Z][A-Z0-9_]*>/gu) ?? []
    const unprotectedText = template.replace(/<[A-Z][A-Z0-9_]*>/gu, ' ')
    return (
      found.length === facts.length &&
      new Set(found).size === found.length &&
      !/\d/u.test(unprotectedText) &&
      !/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/iu.test(
        unprotectedText
      ) &&
      facts.every(
        (fact) => found.includes(fact.placeholder) && template.split(fact.placeholder).length === 2
      )
    )
  }
  const eligibleGenerated = [...new Set(generatedTemplates)].filter(templateIsEligible)
  const eligibleTemplates = input.templates.filter(templateIsEligible)
  if (eligibleTemplates.length === 0) {
    throw new Error('No response template contains every protected fact placeholder')
  }
  const recentFingerprints = (input.recentReplies ?? []).map(replyFingerprint)
  const startIndex = hash(`${input.requestId}:${input.speechAct}`) % eligibleTemplates.length
  const rotated = eligibleTemplates.map(
    (_, index) => eligibleTemplates[(startIndex + index) % eligibleTemplates.length]
  )
  const renderedCandidate = (candidate: string): string => {
    let rendered = candidate
    for (const fact of facts) rendered = rendered.replaceAll(fact.placeholder, fact.value)
    return rendered
  }
  const generatedTemplate = eligibleGenerated.find(
    (candidate) => !recentFingerprints.includes(replyFingerprint(renderedCandidate(candidate)))
  )
  const template =
    generatedTemplate ??
    rotated.find(
      (candidate) =>
        candidate !== undefined &&
        !recentFingerprints.includes(replyFingerprint(renderedCandidate(candidate)))
    ) ??
    rotated[0]
  if (!template) throw new Error('Could not select a response template')

  const plan = responsePlanSchema.parse({
    version: '0.1',
    requestId: input.requestId,
    speechAct: input.speechAct,
    facts,
    style,
    fallbackTemplate: template,
    recentReplyFingerprints: recentFingerprints.slice(-20)
  })
  const text = renderResponsePlan(plan)
  return {
    plan,
    text,
    fingerprint: replyFingerprint(text),
    templateFingerprint: replyFingerprint(template),
    source: generatedTemplate ? 'remindspeak' : 'template'
  }
}
