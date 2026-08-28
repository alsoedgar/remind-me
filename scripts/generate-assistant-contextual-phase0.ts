import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  assistantEvaluationScenarioSchema,
  assistantSuiteManifestSchema,
  type AssistantEvaluationScenario
} from './assistant-evaluation-contract'

const workspace = process.cwd()
const outputDirectory = resolve(workspace, 'evals/assistant/contextual-phase0')
const suitePath = resolve(outputDirectory, 'scenarios.jsonl')
const manifestPath = resolve(outputDirectory, 'manifest.json')
const suiteVersion = '0.2.0-context.1'
const combinationsPerFamily = 36

const families = [
  'time',
  'location',
  'date',
  'duration',
  'notes',
  'recurrence',
  'ordinal',
  'subset',
  'all-items',
  'summary',
  'typo-spacing',
  'topic-switch'
] as const

type Family = (typeof families)[number]

interface FollowUp {
  text: string
  expected: string[]
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function suffix(value: number): string {
  return String(value + 1).padStart(4, '0')
}

function scenario(value: unknown): AssistantEvaluationScenario {
  return assistantEvaluationScenarioSchema.parse(value)
}

function standardWorld(value: number) {
  const id = suffix(value)
  return {
    events: [
      {
        title: `Linear Algebra ${id}`,
        date: 'tomorrow',
        startTime: '09:00',
        endTime: '09:50',
        location: 'Science Hall 130',
        description: `Bring problem set ${id}`,
        recurrence: null
      },
      {
        title: `Calculus III ${id}`,
        date: 'tomorrow',
        startTime: '11:00',
        endTime: '12:00',
        location: 'Adams Hall 311',
        description: `Review chapter 7 for section ${id}`,
        recurrence: null
      },
      {
        title: `Data Structures ${id}`,
        date: 'tomorrow',
        startTime: '14:00',
        endTime: '14:45',
        location: 'Learning Center 1426',
        description: `Laptop required for lab ${id}`,
        recurrence: null
      }
    ],
    reminders: []
  }
}

function recurringWorld(value: number) {
  const id = suffix(value)
  const recurrence = {
    frequency: 'weekly' as const,
    interval: 1,
    byWeekday: ['monday', 'wednesday', 'friday'] as const,
    byMonthDay: [],
    end: { kind: 'count' as const, count: 30 }
  }
  return {
    events: [
      {
        title: `Calculus Lecture ${id}`,
        date: 'next:monday',
        startTime: '09:00',
        endTime: '09:50',
        location: 'Lecture Center A1',
        description: '',
        recurrence
      },
      {
        title: `Programming Lab ${id}`,
        date: 'next:monday',
        startTime: '13:00',
        endTime: '14:50',
        location: 'Computer Lab 3',
        description: '',
        recurrence
      }
    ],
    reminders: []
  }
}

const initialQueries = [
  'do I have anything tomorrow?',
  "what's on my calendar tomorrow?",
  'show me everything I have tomorrow',
  'what does tomorrow look like?',
  'list my plans for tomorrow',
  'walk me through my schedule tomorrow'
]

const recurringQueries = [
  'what classes do I have next Monday?',
  "what's scheduled next Monday?",
  'show my classes for next Monday',
  'list everything on next Monday',
  'what does next Monday look like?',
  'walk me through next Monday'
]

const followUps: Record<Exclude<Family, 'typo-spacing' | 'topic-switch'>, FollowUp[]> = {
  time: [
    { text: 'what times?', expected: ['9:00 AM', '11:00 AM', '2:00 PM'] },
    { text: 'when are they?', expected: ['9:00 AM', '11:00 AM', '2:00 PM'] },
    { text: 'what are their times?', expected: ['9:00 AM', '11:00 AM', '2:00 PM'] },
    {
      text: 'at what times do I have those classes?',
      expected: ['9:00 AM', '11:00 AM', '2:00 PM']
    },
    {
      text: 'show me the start times for all of those',
      expected: ['9:00 AM', '11:00 AM', '2:00 PM']
    },
    { text: 'and the times for each one?', expected: ['9:00 AM', '11:00 AM', '2:00 PM'] }
  ],
  location: [
    {
      text: 'where are they?',
      expected: ['Science Hall 130', 'Adams Hall 311', 'Learning Center 1426']
    },
    {
      text: 'what rooms?',
      expected: ['Science Hall 130', 'Adams Hall 311', 'Learning Center 1426']
    },
    {
      text: 'locations for all of those?',
      expected: ['Science Hall 130', 'Adams Hall 311', 'Learning Center 1426']
    },
    {
      text: 'where do I go for each one?',
      expected: ['Science Hall 130', 'Adams Hall 311', 'Learning Center 1426']
    },
    {
      text: 'can you list their rooms?',
      expected: ['Science Hall 130', 'Adams Hall 311', 'Learning Center 1426']
    },
    {
      text: 'and where are those classes held?',
      expected: ['Science Hall 130', 'Adams Hall 311', 'Learning Center 1426']
    }
  ],
  date: [
    {
      text: 'what date are those on?',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    },
    { text: 'which day is that?', expected: ['Linear Algebra', 'Calculus III', 'Data Structures'] },
    {
      text: 'give me the dates for each',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    },
    {
      text: 'when on the calendar are those?',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    },
    {
      text: 'what day do all of them happen?',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    },
    { text: 'and their dates?', expected: ['Linear Algebra', 'Calculus III', 'Data Structures'] }
  ],
  duration: [
    { text: 'how long are they?', expected: ['50 minutes', '1 hour', '45 minutes'] },
    { text: 'what are their durations?', expected: ['50 minutes', '1 hour', '45 minutes'] },
    { text: 'how much time does each take?', expected: ['50 minutes', '1 hour', '45 minutes'] },
    { text: 'duration for all three?', expected: ['50 minutes', '1 hour', '45 minutes'] },
    { text: 'how long does every class run?', expected: ['50 minutes', '1 hour', '45 minutes'] },
    { text: 'and how long are those?', expected: ['50 minutes', '1 hour', '45 minutes'] }
  ],
  notes: [
    {
      text: 'what are the notes?',
      expected: ['Bring problem set', 'Review chapter 7', 'Laptop required']
    },
    {
      text: 'show the notes for each one',
      expected: ['Bring problem set', 'Review chapter 7', 'Laptop required']
    },
    {
      text: 'anything written down about them?',
      expected: ['Bring problem set', 'Review chapter 7', 'Laptop required']
    },
    {
      text: 'what details did I save?',
      expected: ['Bring problem set', 'Review chapter 7', 'Laptop required']
    },
    {
      text: 'tell me their descriptions',
      expected: ['Bring problem set', 'Review chapter 7', 'Laptop required']
    },
    {
      text: 'and the notes on those?',
      expected: ['Bring problem set', 'Review chapter 7', 'Laptop required']
    }
  ],
  recurrence: [
    { text: 'how often do those repeat?', expected: ['Monday', 'Wednesday', 'Friday'] },
    { text: 'what is their recurrence?', expected: ['Monday', 'Wednesday', 'Friday'] },
    { text: 'which weekdays are those classes?', expected: ['Monday', 'Wednesday', 'Friday'] },
    { text: 'when do they happen every week?', expected: ['Monday', 'Wednesday', 'Friday'] },
    { text: 'show the repeat pattern for both', expected: ['Monday', 'Wednesday', 'Friday'] },
    { text: 'and what days do those recur?', expected: ['Monday', 'Wednesday', 'Friday'] }
  ],
  ordinal: [
    { text: 'where is the first one?', expected: ['Linear Algebra', 'Science Hall 130'] },
    { text: 'what time is the second?', expected: ['Calculus III', '11:00 AM'] },
    { text: 'tell me more about the third one', expected: ['Data Structures'] },
    { text: 'which room is number two in?', expected: ['Calculus III', 'Adams Hall 311'] },
    { text: 'when does the last class start?', expected: ['Data Structures', '2:00 PM'] },
    { text: 'details for the 1st item please', expected: ['Linear Algebra'] }
  ],
  subset: [
    {
      text: 'what times are the first and third?',
      expected: ['Linear Algebra', '9:00 AM', 'Data Structures', '2:00 PM']
    },
    { text: 'where are items one and two?', expected: ['Science Hall 130', 'Adams Hall 311'] },
    {
      text: 'tell me about the second and last ones',
      expected: ['Calculus III', 'Data Structures']
    },
    {
      text: 'show only Linear Algebra and Data Structures',
      expected: ['Linear Algebra', 'Data Structures']
    },
    { text: 'times for the first two please', expected: ['9:00 AM', '11:00 AM'] },
    { text: 'locations for numbers 2 and 3', expected: ['Adams Hall 311', 'Learning Center 1426'] }
  ],
  'all-items': [
    { text: 'show all of them', expected: ['Linear Algebra', 'Calculus III', 'Data Structures'] },
    { text: 'give me every item', expected: ['Linear Algebra', 'Calculus III', 'Data Structures'] },
    {
      text: 'what about all three?',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    },
    {
      text: 'list every class you just found',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    },
    {
      text: 'include the whole set',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    },
    { text: 'all of those please', expected: ['Linear Algebra', 'Calculus III', 'Data Structures'] }
  ],
  summary: [
    { text: 'summarize those', expected: ['Linear Algebra', 'Calculus III', 'Data Structures'] },
    {
      text: 'quick summary please',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    },
    {
      text: 'give me the short version',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    },
    { text: 'recap my day', expected: ['Linear Algebra', 'Calculus III', 'Data Structures'] },
    { text: 'sum all that up', expected: ['Linear Algebra', 'Calculus III', 'Data Structures'] },
    {
      text: 'briefly walk me through them',
      expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
    }
  ]
}

const noisyPairs: Array<{ first: string; follow: FollowUp }> = [
  {
    first: 'do i hav anythng tmr?',
    follow: { text: 'wht times?', expected: ['9:00 AM', '11:00 AM', '2:00 PM'] }
  },
  {
    first: 'whats  on   my calender tomorrow',
    follow: {
      text: 'were r they?',
      expected: ['Science Hall 130', 'Adams Hall 311', 'Learning Center 1426']
    }
  },
  {
    first: 'shwo me evrything i have tmrw',
    follow: { text: 'wat r there times', expected: ['9:00 AM', '11:00 AM', '2:00 PM'] }
  },
  {
    first: 'what dose tomorow look like',
    follow: {
      text: 'locatons?',
      expected: ['Science Hall 130', 'Adams Hall 311', 'Learning Center 1426']
    }
  },
  {
    first: 'list my plans 4 tmr',
    follow: { text: 'sumarize em', expected: ['Linear Algebra', 'Calculus III', 'Data Structures'] }
  },
  {
    first: 'walk me thru my scheduel tommorrow',
    follow: { text: '1st n 3rd times?', expected: ['9:00 AM', '2:00 PM'] }
  }
]

const topicTurns = [
  'say something encouraging about studying',
  'hello, how are you?',
  'give me one short focus tip',
  'what can you help with?',
  'tell me a tiny joke about homework',
  'write one calm sentence'
]

const returnFollowUps: FollowUp[] = [
  { text: 'anyway, what times were those?', expected: ['9:00 AM', '11:00 AM', '2:00 PM'] },
  {
    text: 'back to my schedule—where were they?',
    expected: ['Science Hall 130', 'Adams Hall 311', 'Learning Center 1426']
  },
  { text: 'what about the second class again?', expected: ['Calculus III'] },
  {
    text: 'returning to those, summarize them',
    expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
  },
  {
    text: 'okay, show all those events again',
    expected: ['Linear Algebra', 'Calculus III', 'Data Structures']
  },
  { text: 'now where is the last one?', expected: ['Data Structures', 'Learning Center 1426'] }
]

function expectedTitles(world: { events: readonly { title: string }[] }): string[] {
  return world.events.map((event) => event.title)
}

function familyScenario(family: Family, combination: number): AssistantEvaluationScenario {
  const initialIndex = combination % 6
  const followIndex = Math.floor(combination / 6)
  const world = family === 'recurrence' ? recurringWorld(combination) : standardWorld(combination)
  const titles = expectedTitles(world)
  const initial =
    family === 'recurrence'
      ? (recurringQueries[initialIndex] ?? recurringQueries[0]!)
      : family === 'typo-spacing'
        ? (noisyPairs[initialIndex]?.first ?? noisyPairs[0]!.first)
        : (initialQueries[initialIndex] ?? initialQueries[0]!)
  const turns: Array<Record<string, unknown>> = [
    {
      text: initial,
      expect: {
        responseKinds: ['answer'],
        textAll: titles,
        relatedEventMin: titles.length
      }
    }
  ]

  if (family === 'topic-switch') {
    turns.push({
      text: topicTurns[followIndex] ?? topicTurns[0]!,
      expect: { responseKinds: ['answer'] }
    })
    const returning = returnFollowUps[initialIndex] ?? returnFollowUps[0]!
    turns.push({
      text: returning.text,
      expect: { responseKinds: ['answer'], textAll: returning.expected, relatedEventMin: 1 }
    })
  } else {
    const follow =
      family === 'typo-spacing'
        ? (noisyPairs[followIndex]?.follow ?? noisyPairs[0]!.follow)
        : (followUps[family][followIndex] ?? followUps[family][0]!)
    turns.push({
      text: follow.text,
      expect: { responseKinds: ['answer'], textAll: follow.expected, relatedEventMin: 1 }
    })
  }

  return scenario({
    id: `context0.${family}.${suffix(combination)}`,
    category: 'multi-turn',
    source: 'developer-challenge',
    inDomain: true,
    trainingExcluded: true,
    tags: [
      'synthetic',
      'phase0-regression',
      'contextual-follow-up',
      family,
      ...(family === 'typo-spacing' ? ['typo', 'spacing', 'asr-noise'] : []),
      ...(family === 'topic-switch' ? ['context-return'] : [])
    ],
    world,
    turns
  })
}

function exactScreenshotScenario(): AssistantEvaluationScenario {
  const world = standardWorld(9999)
  return scenario({
    id: 'context0.screenshot.anything-tomorrow.what-times',
    category: 'multi-turn',
    source: 'user-reported',
    inDomain: true,
    trainingExcluded: true,
    tags: [
      'synthetic-world',
      'phase0-regression',
      'screenshot-regression',
      'plural-time-follow-up'
    ],
    world,
    turns: [
      {
        text: 'do I have anything tomorrow?',
        expect: {
          responseKinds: ['answer'],
          textAll: expectedTitles(world),
          relatedEventMin: 3
        }
      },
      {
        text: 'what times?',
        expect: {
          responseKinds: ['answer'],
          textAll: ['9:00 AM', '11:00 AM', '2:00 PM'],
          relatedEventMin: 3
        }
      }
    ]
  })
}

function generate(): AssistantEvaluationScenario[] {
  return [
    exactScreenshotScenario(),
    ...families.flatMap((family) =>
      Array.from({ length: combinationsPerFamily }, (_, index) => familyScenario(family, index))
    )
  ]
}

async function main(): Promise<void> {
  const scenarios = generate()
  const suite = `${scenarios.map((item) => JSON.stringify(item)).join('\n')}\n`
  const manifest = assistantSuiteManifestSchema.parse({
    schemaVersion: 1,
    suiteVersion,
    path: 'evals/assistant/contextual-phase0/scenarios.jsonl',
    sha256: digest(suite),
    scenarios: scenarios.length,
    turns: scenarios.reduce((total, item) => total + item.turns.length, 0),
    trainingExcluded: true,
    frozen: true,
    independentHumanBlind: false
  })
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`

  if (process.argv.includes('--check')) {
    const [existingSuite, existingManifest] = await Promise.all([
      readFile(suitePath, 'utf8'),
      readFile(manifestPath, 'utf8')
    ])
    if (existingSuite !== suite || existingManifest !== serializedManifest) {
      throw new Error('The frozen Phase 0 contextual suite is stale; regenerate it first.')
    }
    console.log(`Phase 0 contextual suite is current (${scenarios.length} scenarios).`)
    return
  }

  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    writeFile(suitePath, suite, 'utf8'),
    writeFile(manifestPath, serializedManifest, 'utf8')
  ])
  console.log(
    `Wrote ${scenarios.length} Phase 0 contextual scenarios (${manifest.turns} turns, ${families.length} language families).`
  )
}

await main()
