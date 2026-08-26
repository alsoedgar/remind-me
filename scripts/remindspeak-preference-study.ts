import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RemindSpeakPlanner, type RemindSpeakFact } from '@remind-me/model-runtime'
import type { ResponsePlan, ResponseStyle } from '@remind-me/contracts'
import { format as formatSource, resolveConfig } from 'prettier'
import { z } from 'zod'

const workspace = process.cwd()
const studyDirectory = resolve(workspace, 'evals/remindspeak/v0.3')
const responseDirectory = resolve(studyDirectory, 'responses')
const packetPath = resolve(studyDirectory, 'blind-study.json')
const keyPath = resolve(studyDirectory, 'sealed-source-key.json')
const htmlPath = resolve(studyDirectory, 'blind-study.html')
const responseSchemaPath = resolve(studyDirectory, 'response.schema.json')
const reportPath = resolve(workspace, 'ml/remindspeak/reports/human-preference-study.json')
const modelRoot = resolve(workspace, 'models')
const studyId = 'remindspeak-v0.3-blind-a-b'

const styles = {
  cozy: {
    warmth: 0.9,
    brevity: 0.52,
    formality: 0.12,
    humor: 0.16,
    emoji: 0,
    contractions: true,
    proactivity: 0.68
  },
  concise: {
    warmth: 0.46,
    brevity: 0.94,
    formality: 0.32,
    humor: 0,
    emoji: 0,
    contractions: true,
    proactivity: 0.18
  },
  polished: {
    warmth: 0.62,
    brevity: 0.62,
    formality: 0.78,
    humor: 0.02,
    emoji: 0,
    contractions: false,
    proactivity: 0.38
  }
} satisfies Record<string, ResponseStyle>

interface StudyInput {
  id: string
  scenario: string
  desiredVoice: keyof typeof styles
  speechAct: ResponsePlan['speechAct']
  facts: RemindSpeakFact[]
  controlTemplate: string
}

const fact = (key: string, kind: RemindSpeakFact['kind'], value: string): RemindSpeakFact => ({
  key,
  kind,
  placeholder: `<${key}>`,
  value
})

const inputs: StudyInput[] = [
  {
    id: 'proposal-cozy',
    scenario:
      'The user asked to add a study block and is reviewing the draft before anything saves.',
    desiredVoice: 'cozy',
    speechAct: 'proposal',
    facts: [fact('SUMMARY', 'text', 'Study block on Thursday from 4:00 PM to 5:30 PM')],
    controlTemplate: 'Proposed change: <SUMMARY>. Review it before saving.'
  },
  {
    id: 'proposal-concise',
    scenario: 'The user asked to repeat a workout and wants a brief confirmation preview.',
    desiredVoice: 'concise',
    speechAct: 'proposal',
    facts: [fact('SUMMARY', 'text', 'Workout every Tuesday and Saturday at 7:00 AM')],
    controlTemplate: 'Draft: <SUMMARY>. Nothing is saved yet.'
  },
  {
    id: 'created-polished',
    scenario: 'A reviewed event was just saved locally.',
    desiredVoice: 'polished',
    speechAct: 'creation-confirmed',
    facts: [fact('RECEIPT', 'text', 'Created “Lunch with Maya” on September 4 at 12:30 PM.')],
    controlTemplate: '<RECEIPT> The operation is complete.'
  },
  {
    id: 'updated-cozy',
    scenario: 'The user moved an existing appointment after approving the edit.',
    desiredVoice: 'cozy',
    speechAct: 'update-confirmed',
    facts: [fact('RECEIPT', 'text', 'Moved “Dentist” to Friday at 10:00 AM.')],
    controlTemplate: 'Updated. <RECEIPT>'
  },
  {
    id: 'deleted-concise',
    scenario: 'The user approved deleting one reminder.',
    desiredVoice: 'concise',
    speechAct: 'deletion-confirmed',
    facts: [fact('RECEIPT', 'text', 'Deleted reminder “Renew library book”.')],
    controlTemplate: '<RECEIPT> You can undo this action.'
  },
  {
    id: 'completed-cozy',
    scenario: 'The user completed a reminder and wants a light acknowledgement.',
    desiredVoice: 'cozy',
    speechAct: 'completion-confirmed',
    facts: [fact('RECEIPT', 'text', 'Completed reminder “Submit scholarship form”.')],
    controlTemplate: 'Completed. <RECEIPT>'
  },
  {
    id: 'availability-free',
    scenario: 'The user asked whether a specific time is free.',
    desiredVoice: 'concise',
    speechAct: 'availability-answer',
    facts: [
      fact('SLOT', 'time', 'Friday from 2:00 PM to 3:00 PM'),
      fact('DETAIL', 'text', 'you have no calendar events in that window')
    ],
    controlTemplate: '<SLOT>: <DETAIL>.'
  },
  {
    id: 'availability-busy',
    scenario: 'The user asked whether a window is open, but one event overlaps it.',
    desiredVoice: 'polished',
    speechAct: 'availability-answer',
    facts: [
      fact('SLOT', 'time', 'Monday from 11:30 AM to 1:00 PM'),
      fact('DETAIL', 'text', 'it overlaps “Team review” from noon to 12:45 PM')
    ],
    controlTemplate: 'Availability for <SLOT>: <DETAIL>.'
  },
  {
    id: 'summary-cozy',
    scenario: 'The user asked for a friendly overview of tomorrow.',
    desiredVoice: 'cozy',
    speechAct: 'schedule-summary',
    facts: [fact('SUMMARY', 'text', 'Design critique at 10:00 AM; lab at 2:00 PM')],
    controlTemplate: 'Schedule summary: <SUMMARY>.'
  },
  {
    id: 'summary-polished',
    scenario: 'The user asked for a clear overview of a busy day.',
    desiredVoice: 'polished',
    speechAct: 'schedule-summary',
    facts: [fact('SUMMARY', 'text', 'four items running from 9:00 AM through 6:00 PM')],
    controlTemplate: 'Your calendar contains <SUMMARY>.'
  },
  {
    id: 'next-item-concise',
    scenario: 'The user asked only what comes next.',
    desiredVoice: 'concise',
    speechAct: 'next-item-answer',
    facts: [fact('SUMMARY', 'text', 'Data Structures lecture at 2:00 PM')],
    controlTemplate: 'Next: <SUMMARY>.'
  },
  {
    id: 'item-details-polished',
    scenario: 'The user asked for the location and time of a selected class.',
    desiredVoice: 'polished',
    speechAct: 'item-details-answer',
    facts: [fact('SUMMARY', 'text', 'Calculus III at 1:00 PM in Adams Hall 311')],
    controlTemplate: 'Event details: <SUMMARY>.'
  },
  {
    id: 'empty-cozy',
    scenario: 'The user asked about a day with no events or reminders.',
    desiredVoice: 'cozy',
    speechAct: 'empty-schedule-answer',
    facts: [],
    controlTemplate: 'Nothing is scheduled.'
  },
  {
    id: 'empty-concise',
    scenario: 'The user asked what comes next, but there is no future item.',
    desiredVoice: 'concise',
    speechAct: 'empty-schedule-answer',
    facts: [],
    controlTemplate: 'Nothing is coming up.'
  },
  {
    id: 'conversation-cozy',
    scenario: 'The user said hello and asked what the assistant can do.',
    desiredVoice: 'cozy',
    speechAct: 'conversation-answer',
    facts: [fact('DETAIL', 'text', 'I can plan, change, search, and explain your local calendar')],
    controlTemplate: '<DETAIL>.'
  },
  {
    id: 'conversation-polished',
    scenario: 'The user asked how the private assistant is built.',
    desiredVoice: 'polished',
    speechAct: 'conversation-answer',
    facts: [
      fact('DETAIL', 'text', 'the native models run locally and calendar writes require review')
    ],
    controlTemplate: 'Answer: <DETAIL>.'
  },
  {
    id: 'memory-cozy',
    scenario: 'The user asked what preference the assistant remembers.',
    desiredVoice: 'cozy',
    speechAct: 'memory-answer',
    facts: [fact('DETAIL', 'text', 'you prefer morning meetings')],
    controlTemplate: 'Saved memory: <DETAIL>.'
  },
  {
    id: 'undo-concise',
    scenario: 'The user asked to undo the most recent calendar change.',
    desiredVoice: 'concise',
    speechAct: 'undo-confirmed',
    facts: [fact('RECEIPT', 'text', 'Restored “Project sync” to Wednesday at 3:00 PM.')],
    controlTemplate: 'Undone. <RECEIPT>'
  },
  {
    id: 'rejected-cozy',
    scenario: 'The user declined a draft, so no calendar write occurred.',
    desiredVoice: 'cozy',
    speechAct: 'proposal-rejected',
    facts: [fact('SUMMARY', 'text', 'move every class to Friday')],
    controlTemplate: 'Cancelled proposal: <SUMMARY>. Nothing changed.'
  },
  {
    id: 'clarification-polished',
    scenario: 'The request is missing one required scheduling detail.',
    desiredVoice: 'polished',
    speechAct: 'clarification',
    facts: [fact('DETAIL', 'text', 'Which Tuesday did you mean?')],
    controlTemplate: 'Clarification required: <DETAIL>'
  },
  {
    id: 'conflict-cozy',
    scenario: 'The assistant found an overlap while reviewing a proposed event.',
    desiredVoice: 'cozy',
    speechAct: 'conflict-warning',
    facts: [fact('SUMMARY', 'text', '“Office hours” overlaps “Physics lab” by thirty minutes')],
    controlTemplate: 'Conflict: <SUMMARY>.'
  },
  {
    id: 'unsupported-polished',
    scenario: 'The user asked for live information that the offline app cannot verify.',
    desiredVoice: 'polished',
    speechAct: 'unsupported',
    facts: [fact('DETAIL', 'text', 'I need a connected source to verify live flight status')],
    controlTemplate: 'Unsupported request: <DETAIL>.'
  },
  {
    id: 'error-cozy',
    scenario: 'A local operation stopped safely and left the calendar unchanged.',
    desiredVoice: 'cozy',
    speechAct: 'error',
    facts: [fact('DETAIL', 'text', 'the selected event no longer exists')],
    controlTemplate: 'Error: <DETAIL>.'
  },
  {
    id: 'details-concise',
    scenario: 'The user asked for a compact reminder detail.',
    desiredVoice: 'concise',
    speechAct: 'item-details-answer',
    facts: [fact('SUMMARY', 'text', 'reminder “Call Dad” at 6:00 PM')],
    controlTemplate: '<SUMMARY>.'
  }
]

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function render(template: string, facts: readonly RemindSpeakFact[]): string {
  let output = template
  for (const item of facts) output = output.replaceAll(item.placeholder, item.value)
  return output.replace(/\s+/gu, ' ').trim()
}

function sourceOrder(caseId: string): ['candidate', 'control'] | ['control', 'candidate'] {
  return Number.parseInt(sha256(`${studyId}:${caseId}`).slice(0, 2), 16) % 2 === 0
    ? ['candidate', 'control']
    : ['control', 'candidate']
}

function studyHtml(packet: unknown): string {
  const embedded = JSON.stringify(packet).replace(/</gu, '\\u003c')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RemindSpeak blind response study</title><style>
:root{color-scheme:light;--ink:#3c2f2f;--muted:#715f55;--paper:#f8f1e6;--card:#ead8c4;--accent:#b98469;--line:#3c2f2f}*{box-sizing:border-box}body{margin:0;color:var(--ink);font:16px/1.5 system-ui,sans-serif;background:var(--paper)}main{width:min(980px,calc(100% - 32px));margin:32px auto 80px}h1,h2{font-family:Georgia,serif}.intro,.case,.export{padding:22px;margin:18px 0;background:#fffaf2;border:2px solid var(--line);border-radius:18px;box-shadow:5px 5px 0 #765f58}.meta,.facts{color:var(--muted);font-size:.9rem}.responses{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:16px 0}.response{padding:16px;background:var(--card);border:2px solid var(--line);border-radius:13px}.response strong{display:block;margin-bottom:8px;font-size:.75rem;letter-spacing:.12em}.question{padding-top:12px;border-top:1px dashed #8a766d}.choices{display:flex;flex-wrap:wrap;gap:14px}.choices label{cursor:pointer}input{accent-color:var(--accent)}button{padding:12px 18px;color:var(--ink);font-weight:800;background:var(--accent);border:2px solid var(--line);border-radius:10px;box-shadow:3px 3px 0 #765f58;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.error{color:#8c2f24;font-weight:700}.success{color:#426248;font-weight:700}@media(max-width:680px){.responses{grid-template-columns:1fr}}
</style></head><body><main><section class="intro"><p>PRIVATE · OFFLINE · BLINDED</p><h1>Which reply feels better?</h1><p>Compare each pair for naturalness, fit to the requested voice, and clarity. Dynamic calendar facts are shown separately so you can also flag a reply that changes or invents them. The source order is randomized and is not present in this file.</p><label>Anonymous participant code <input id="participant" minlength="10" pattern="anonymous-[a-z0-9-]+"></label><p id="progress"></p></section><div id="cases"></div><section class="export"><label><input id="human" type="checkbox"> I completed these judgments myself.</label><br><label><input id="blind" type="checkbox"> I did not view the separate source key.</label><p id="message"></p><button id="download">Validate and download response</button></section></main><script>
const study=${embedded};const root=document.getElementById('cases');const participant=document.getElementById('participant');participant.value='anonymous-'+crypto.randomUUID().slice(0,12);const esc=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};for(const c of study.cases){const section=document.createElement('section');section.className='case';section.dataset.id=c.id;section.innerHTML='<h2>'+esc(c.scenario)+'</h2><p class="meta">Desired voice: <strong>'+esc(c.desiredVoice)+'</strong></p><p class="facts"><strong>Verified content:</strong> '+(c.verifiedFacts.length?c.verifiedFacts.map(f=>esc(f.value)).join(' · '):'No dynamic facts are required.')+'</p><div class="responses"><div class="response"><strong>RESPONSE A</strong>'+esc(c.responseA)+'</div><div class="response"><strong>RESPONSE B</strong>'+esc(c.responseB)+'</div></div><div class="question"><strong>Overall preference</strong><div class="choices">'+['A','B','tie'].map(v=>'<label><input type="radio" name="pref-'+c.id+'" value="'+v+'"> '+(v==='tie'?'Tie':v)+'</label>').join('')+'</div></div><div class="question"><strong>Which response preserves all verified content?</strong><div class="choices">'+['A','B','both','neither'].map(v=>'<label><input type="radio" name="fact-'+c.id+'" value="'+v+'"> '+v+'</label>').join('')+'</div></div>';root.append(section)}
function read(name){return document.querySelector('input[name="'+name+'"]:checked')?.value??null}function update(){const done=study.cases.filter(c=>read('pref-'+c.id)&&read('fact-'+c.id)).length;document.getElementById('progress').textContent=done+' of '+study.cases.length+' comparisons complete'}document.addEventListener('change',update);update();document.getElementById('download').onclick=()=>{const message=document.getElementById('message');const judgments=study.cases.map(c=>({caseId:c.id,preference:read('pref-'+c.id),factFaithfulness:read('fact-'+c.id)}));if(!/^anonymous-[a-z0-9-]{6,32}$/.test(participant.value)||judgments.some(j=>!j.preference||!j.factFaithfulness)||!document.getElementById('human').checked||!document.getElementById('blind').checked){message.className='error';message.textContent='Complete every comparison, both attestations, and a valid anonymous code first.';return}const response={schemaVersion:1,studyId:study.studyId,participantId:participant.value,attestation:{humanCompleted:true,sourceKeyNotViewed:true},judgments};const blob=new Blob([JSON.stringify(response,null,2)+'\\n'],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='remindspeak-response-'+participant.value+'.json';a.click();URL.revokeObjectURL(a.href);message.className='success';message.textContent='Response downloaded. Return that JSON file to the study organizer.'}
</script></body></html>`
}

const responseJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'RemindSpeak blinded preference response',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'studyId', 'participantId', 'attestation', 'judgments'],
  properties: {
    schemaVersion: { const: 1 },
    studyId: { const: studyId },
    participantId: { type: 'string', pattern: '^anonymous-[a-z0-9-]{6,32}$' },
    attestation: {
      type: 'object',
      additionalProperties: false,
      required: ['humanCompleted', 'sourceKeyNotViewed'],
      properties: { humanCompleted: { const: true }, sourceKeyNotViewed: { const: true } }
    },
    judgments: {
      type: 'array',
      minItems: inputs.length,
      maxItems: inputs.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['caseId', 'preference', 'factFaithfulness'],
        properties: {
          caseId: { enum: inputs.map((input) => input.id) },
          preference: { enum: ['A', 'B', 'tie'] },
          factFaithfulness: { enum: ['A', 'B', 'both', 'neither'] }
        }
      }
    }
  }
}

async function prepare(): Promise<void> {
  const speaker = await RemindSpeakPlanner.load(modelRoot)
  const formatting = (await resolveConfig(resolve(workspace, 'package.json'))) ?? {}
  const cases = inputs.map((input) => {
    const generated = speaker.generateTemplates({
      requestId: `study:${input.id}`,
      speechAct: input.speechAct,
      facts: input.facts,
      style: styles[input.desiredVoice],
      recentReplies: []
    })
    const control = render(input.controlTemplate, input.facts)
    const candidateTemplate = generated.find(
      (template) => render(template, input.facts) !== control
    )
    if (!candidateTemplate) throw new Error(`No distinct model candidate for ${input.id}`)
    const candidate = render(candidateTemplate, input.facts)
    const order = sourceOrder(input.id)
    const bySource = { candidate, control }
    return {
      public: {
        id: input.id,
        scenario: input.scenario,
        desiredVoice: input.desiredVoice,
        verifiedFacts: input.facts.map((item) => ({ key: item.key, value: item.value })),
        responseA: bySource[order[0]],
        responseB: bySource[order[1]]
      },
      key: {
        id: input.id,
        sourceA: order[0],
        sourceB: order[1],
        candidateTemplateSha256: sha256(candidateTemplate),
        controlTemplateSha256: sha256(input.controlTemplate)
      }
    }
  })
  const packet = {
    schemaVersion: 1,
    studyId,
    design: 'within-subject randomized blinded A/B',
    caseCount: cases.length,
    sourceDisclosure: 'Source labels are stored only in the separate sealed key.',
    cases: cases.map((item) => item.public)
  }
  const packetText = await formatSource(JSON.stringify(packet), {
    ...formatting,
    parser: 'json'
  })
  const key = {
    schemaVersion: 1,
    studyId,
    packetSha256: sha256(packetText),
    model: speaker.info,
    candidate: 'RemindSpeak v0.3 top grounded candidate under the requested style',
    control: 'deterministic protected-template baseline',
    cases: cases.map((item) => item.key)
  }
  await mkdir(responseDirectory, { recursive: true })
  const [keyText, htmlText, schemaText] = await Promise.all([
    formatSource(JSON.stringify(key), { ...formatting, parser: 'json' }),
    formatSource(studyHtml(packet), { ...formatting, parser: 'html' }),
    formatSource(JSON.stringify(responseJsonSchema), { ...formatting, parser: 'json' })
  ])
  await Promise.all([
    writeFile(packetPath, packetText, 'utf8'),
    writeFile(keyPath, keyText, 'utf8'),
    writeFile(htmlPath, htmlText, 'utf8'),
    writeFile(responseSchemaPath, schemaText, 'utf8')
  ])
  console.log(`Prepared ${cases.length} blinded RemindSpeak comparisons in ${htmlPath}`)
}

const responseSchema = z
  .object({
    schemaVersion: z.literal(1),
    studyId: z.literal(studyId),
    participantId: z.string().regex(/^anonymous-[a-z0-9-]{6,32}$/u),
    attestation: z
      .object({ humanCompleted: z.literal(true), sourceKeyNotViewed: z.literal(true) })
      .strict(),
    judgments: z
      .array(
        z
          .object({
            caseId: z.string(),
            preference: z.enum(['A', 'B', 'tie']),
            factFaithfulness: z.enum(['A', 'B', 'both', 'neither'])
          })
          .strict()
      )
      .length(inputs.length)
  })
  .strict()

function wilson(successes: number, total: number): { low: number; high: number } | null {
  if (total === 0) return null
  const zScore = 1.96
  const rate = successes / total
  const denominator = 1 + (zScore * zScore) / total
  const center = (rate + (zScore * zScore) / (2 * total)) / denominator
  const margin =
    (zScore / denominator) *
    Math.sqrt((rate * (1 - rate)) / total + (zScore * zScore) / (4 * total * total))
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) }
}

async function score(requireGate: boolean): Promise<void> {
  const [packetText, keyText] = await Promise.all([
    readFile(packetPath, 'utf8'),
    readFile(keyPath, 'utf8')
  ])
  const key = JSON.parse(keyText) as {
    studyId: string
    packetSha256: string
    cases: Array<{ id: string; sourceA: 'candidate' | 'control'; sourceB: 'candidate' | 'control' }>
  }
  if (key.studyId !== studyId || key.packetSha256 !== sha256(packetText)) {
    throw new Error('The blind packet and sealed source key do not match')
  }
  const sourceKeys = new Map(key.cases.map((item) => [item.id, item]))
  const expectedIds = new Set(inputs.map((input) => input.id))
  const files = (await readdir(responseDirectory)).filter((name) => name.endsWith('.json')).sort()
  const participantIds = new Set<string>()
  const rejectedFiles: Array<{ file: string; reason: string }> = []
  let candidateWins = 0
  let controlWins = 0
  let ties = 0
  let candidateFactIssues = 0
  let judgments = 0

  for (const file of files) {
    try {
      const response = responseSchema.parse(
        JSON.parse(await readFile(resolve(responseDirectory, file), 'utf8'))
      )
      if (participantIds.has(response.participantId)) throw new Error('duplicate participant code')
      const caseIds = response.judgments.map((item) => item.caseId)
      if (
        new Set(caseIds).size !== expectedIds.size ||
        caseIds.some((id) => !expectedIds.has(id))
      ) {
        throw new Error('judgments do not cover every study case exactly once')
      }
      participantIds.add(response.participantId)
      for (const judgment of response.judgments) {
        const source = sourceKeys.get(judgment.caseId)
        if (!source) throw new Error(`unknown case ${judgment.caseId}`)
        if (judgment.preference === 'tie') ties += 1
        else if (source[`source${judgment.preference}`] === 'candidate') candidateWins += 1
        else controlWins += 1
        const candidateLabel = source.sourceA === 'candidate' ? 'A' : 'B'
        if (
          judgment.factFaithfulness === 'neither' ||
          (judgment.factFaithfulness !== 'both' && judgment.factFaithfulness !== candidateLabel)
        ) {
          candidateFactIssues += 1
        }
        judgments += 1
      }
    } catch (error) {
      rejectedFiles.push({
        file,
        reason: error instanceof Error ? error.message : 'invalid response'
      })
    }
  }

  const preferenceScore = judgments ? (candidateWins + ties * 0.5) / judgments : null
  const interval = wilson(candidateWins + ties * 0.5, judgments)
  const candidateFactIssueRate = judgments ? candidateFactIssues / judgments : null
  const gates = {
    minimumParticipants: {
      required: 5,
      actual: participantIds.size,
      passed: participantIds.size >= 5
    },
    minimumJudgments: { required: 120, actual: judgments, passed: judgments >= 120 },
    candidatePreference: {
      required: 0.6,
      actual: preferenceScore,
      passed: preferenceScore !== null && preferenceScore >= 0.6
    },
    preferenceWilsonLowerBound: {
      required: 0.5,
      actual: interval?.low ?? null,
      passed: interval !== null && interval.low >= 0.5
    },
    candidateFactIssueRate: {
      maximum: 0.01,
      actual: candidateFactIssueRate,
      passed: candidateFactIssueRate !== null && candidateFactIssueRate <= 0.01
    }
  }
  const gatePassed = Object.values(gates).every((gate) => gate.passed)
  const status =
    participantIds.size === 0
      ? 'awaiting-participants'
      : gatePassed
        ? 'complete-passed'
        : participantIds.size < 5 || judgments < 120
          ? 'insufficient-sample'
          : 'complete-not-passed'
  const report = {
    schemaVersion: 1,
    studyId,
    status,
    studyDesign: 'within-subject randomized blinded A/B',
    candidate: 'RemindSpeak v0.3',
    control: 'deterministic protected-template baseline',
    participantCount: participantIds.size,
    judgments,
    rejectedFiles,
    results: {
      candidateWins,
      controlWins,
      ties,
      candidatePreferenceScore: preferenceScore,
      preferenceWilson95: interval,
      candidateFactIssues,
      candidateFactIssueRate
    },
    gates,
    gatePassed,
    claimBoundary:
      participantIds.size === 0
        ? 'The protocol is prepared, but no human preference result is claimed.'
        : gatePassed
          ? 'The prespecified blinded human preference gate passed.'
          : 'Human observations are reported, but the prespecified promotion gate has not passed.'
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(
    `RemindSpeak blind study: ${status}; ${participantIds.size} participants, ${judgments} judgments, gate ${gatePassed ? 'passed' : 'not passed'}.`
  )
  if (requireGate && !gatePassed) process.exitCode = 1
}

const command = process.argv[2] ?? 'prepare'
if (command === 'prepare') await prepare()
else if (command === 'score') await score(process.argv.includes('--require-gate'))
else throw new Error(`Unknown command: ${command}`)
