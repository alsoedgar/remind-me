import {
  documentAnalysisSchema,
  documentRepairModelOutputSchema,
  documentRepairResponseSchema,
  type DocumentAnalysis,
  type DocumentRepairCandidate,
  type DocumentRepairCitation,
  type DocumentRepairModelOutput,
  type DocumentRepairRequest,
  type DocumentRepairResponse
} from '@remind-me/contracts'

function sameCitation(left: DocumentRepairCitation, right: DocumentRepairCitation): boolean {
  return (
    left.blockId === right.blockId &&
    left.page === right.page &&
    left.role === right.role &&
    left.text === right.text &&
    left.start === right.start &&
    left.end === right.end
  )
}

function citationsGroundCandidate(
  candidate: DocumentRepairCandidate,
  citations: readonly DocumentRepairCitation[]
): boolean {
  if (
    citations.some((citation) => !candidate.citations.some((item) => sameCitation(item, citation)))
  ) {
    return false
  }
  const quotedRoles = new Set(citations.map((citation) => citation.role))
  if (!quotedRoles.has('title') || !quotedRoles.has('date')) return false
  if (
    candidate.citations.some((citation) => citation.role === 'time') &&
    !quotedRoles.has('time')
  ) {
    return false
  }
  return true
}

export function validateDocumentRepairResponse(
  request: DocumentRepairRequest,
  outputValue: unknown
): DocumentRepairResponse | null {
  const parsed = documentRepairModelOutputSchema.safeParse(outputValue)
  if (!parsed.success) return null
  const decisions = parsed.data.decisions
  if (new Set(decisions.map((decision) => decision.disagreementId)).size !== decisions.length) {
    return null
  }
  if (decisions.length !== request.disagreements.length) return null
  const disagreements = new Map(request.disagreements.map((item) => [item.id, item] as const))
  for (const decision of decisions) {
    const disagreement = disagreements.get(decision.disagreementId)
    if (!disagreement) return null
    if (decision.candidateId === null) continue
    const candidate = disagreement.candidates.find((item) => item.id === decision.candidateId)
    if (!candidate || !citationsGroundCandidate(candidate, decision.citations)) return null
  }
  return documentRepairResponseSchema.parse({
    ...parsed.data,
    modelId: 'qwen3-1.7b-q4',
    hasMutationAuthority: false
  })
}

export function applyDocumentRepairResponse(
  analysisValue: DocumentAnalysis,
  responseValue: DocumentRepairResponse
): DocumentAnalysis {
  const analysis = documentAnalysisSchema.parse(analysisValue)
  const session = analysis.repairSession
  const parsedResponse = documentRepairResponseSchema.safeParse(responseValue)
  if (!session || !parsedResponse.success || parsedResponse.data.hasMutationAuthority !== false) {
    return analysis
  }
  const response = validateDocumentRepairResponse(session.request, {
    decisions: parsedResponse.data.decisions
  })
  if (!response) return analysis

  const alternatives = new Map(
    session.alternatives.map((alternative) => [alternative.candidateId, alternative.draft] as const)
  )
  const disagreements = new Map(
    session.request.disagreements.map((disagreement) => [disagreement.id, disagreement] as const)
  )
  const replacements = new Map<string, (typeof session.alternatives)[number]['draft']>()
  let changed = 0
  let corroborated = 0
  for (const decision of response.decisions) {
    if (!decision.candidateId) continue
    const disagreement = disagreements.get(decision.disagreementId)
    const selected = alternatives.get(decision.candidateId)
    const active = disagreement ? alternatives.get(disagreement.activeCandidateId) : null
    if (!disagreement || !selected || !active) continue
    if (decision.candidateId === disagreement.activeCandidateId) {
      corroborated += 1
      continue
    }
    replacements.set(active.id, {
      ...selected,
      attention: 'check-evidence',
      warnings: [
        ...selected.warnings,
        'The optional local repair model preferred this existing source-backed parser candidate. Its quoted evidence still requires your review.'
      ].slice(0, 20)
    })
    changed += 1
  }
  if (changed === 0 && corroborated === 0) return analysis
  const repaired = analysis.drafts.map((draft) => replacements.get(draft.id) ?? draft)
  return documentAnalysisSchema.parse({
    ...analysis,
    drafts: repaired,
    plannerWarnings: [
      ...analysis.plannerWarnings,
      changed > 0
        ? `The optional local repair model selected ${changed} alternate parser candidate${changed === 1 ? '' : 's'} using exact quoted source spans. Nothing is saved until you confirm.`
        : `The optional local repair model corroborated ${corroborated} disputed parser candidate${corroborated === 1 ? '' : 's'} using exact quoted source spans. Nothing is saved until you confirm.`
    ].slice(0, 50)
  })
}

export type { DocumentRepairModelOutput }
