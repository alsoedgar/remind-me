import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assistantCapabilityRegistry,
  type AssistantCapabilityDefinition
} from '@remind-me/assistant-core'
import type { AssistantCapabilityId } from '@remind-me/contracts'

type Split = 'train' | 'development' | 'challenge'
type CoarseRoute = 'calendar' | 'conversation' | 'memory' | 'broad-chat' | 'app' | 'document'
type NoiseProfile = 'clean' | 'typo' | 'extra-space' | 'asr' | 'punctuation'

interface CorpusConfig {
  schemaVersion: number
  corpusVersion: string
  seed: number
  materializationsPerTemplate: number
  teacherParaphrasesPerJob: number
  minimumAcceptedTeacherTemplates: number
  minimumTeacherCapabilityCoverage: number
  teacherModelId: string
  teacherByteLength: number
  teacherSha256: string
  teacherLicense: string
  frozenEvaluationManifest: string
  frozenEvaluationSuite: string
  evaluationSimilarityThreshold: number
}

interface SeedSpec {
  cues: readonly string[]
  templates: readonly [string, string, string]
}

interface TeacherJob {
  id: string
  capabilityId: AssistantCapabilityId
  meaning: string
  seedTemplate: string
  placeholders: string[]
  cues: readonly string[]
  split: Split
  familyId: string
}

interface TemplateRecord {
  id: string
  capabilityId: AssistantCapabilityId
  route: CoarseRoute
  template: string
  placeholders: string[]
  split: Split
  familyId: string
  source: 'project-seed' | 'qwen-paraphrase'
  teacherJobId: string | null
  executableNow: boolean
  confirmation: AssistantCapabilityDefinition['confirmation']
}

interface SlotSpan {
  name: string
  value: string
  start: number
  end: number
}

interface CorpusRow {
  id: string
  split: Split
  text: string
  route: CoarseRoute
  actions: Array<{
    capabilityId: AssistantCapabilityId
    executableNow: boolean
    confirmation: AssistantCapabilityDefinition['confirmation']
  }>
  slots: SlotSpan[]
  context: null | {
    focusedKind: 'event' | 'reminder' | 'mixed' | 'memory'
    focusedCount: number
    ordinal: number | null
    priorCapabilityId: AssistantCapabilityId | null
    pendingCapabilityId: AssistantCapabilityId | null
  }
  familyId: string
  source:
    | 'project-seed'
    | 'qwen-paraphrase'
    | 'project-composition'
    | 'project-dialogue'
    | 'project-hard-negative'
  noise: NoiseProfile
  teacherJobId: string | null
}

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(SCRIPT_DIRECTORY, '..')
const ROOT = resolve(WORKSPACE, 'ml', 'assistant_corpus')
const CONFIG_PATH = resolve(ROOT, 'config.json')
const JOBS_PATH = resolve(ROOT, 'raw', 'teacher-jobs.json')
const REPAIR_JOBS_PATH = resolve(ROOT, 'raw', 'teacher-repair-jobs.json')
const TEACHER_RAW_PATH = resolve(ROOT, 'raw', 'qwen-paraphrases.json')
const ACCEPTED_PATH = resolve(ROOT, 'accepted', 'templates.json')
const REPORT_PATH = resolve(ROOT, 'reports', 'curation.json')
const DATA_DIRECTORY = resolve(ROOT, 'data')
const MANIFEST_PATH = resolve(DATA_DIRECTORY, 'manifest.json')

const OUTCOME_ONLY_CAPABILITIES = new Set<AssistantCapabilityId>([
  'calendar.import.propose',
  'assistant.clarify',
  'assistant.reject',
  'assistant.unsupported'
])

const SEED_CATALOG: Record<string, SeedSpec> = {
  'calendar.event.create': {
    cues: ['add', 'book', 'calendar', 'schedule', 'set'],
    templates: [
      'put <TITLE> on my calendar for <DATE> at <TIME>',
      'book <TITLE> at <LOCATION> on <DATE>',
      'set up <TITLE> for <DATE> at <TIME> and repeat <RECURRENCE>'
    ]
  },
  'calendar.event.duplicate': {
    cues: ['copy', 'duplicate', 'another', 'same'],
    templates: [
      'copy <TARGET> to <DATE> at <TIME>',
      'make another <TARGET> on <DATE>',
      'duplicate <TARGET> across <RECURRENCE>'
    ]
  },
  'calendar.event.update': {
    cues: ['change', 'rename', 'update', 'edit'],
    templates: [
      'rename <TARGET> to <NEW_TITLE>',
      'change the location for <TARGET> to <LOCATION>',
      'update <TARGET> so it repeats <RECURRENCE>'
    ]
  },
  'calendar.event.move': {
    cues: ['move', 'shift', 'reschedule', 'push'],
    templates: [
      'move <TARGET> to <DATE> at <TIME>',
      'shift <TARGET> from <SOURCE_DATE> to <DATE>',
      'reschedule <TARGET> for <DATE> at <TIME>'
    ]
  },
  'calendar.event.delete': {
    cues: ['cancel', 'delete', 'remove', 'drop'],
    templates: [
      'cancel the event called <TARGET>',
      'remove <TARGET> from <DATE>',
      'delete the <TARGET> series'
    ]
  },
  'calendar.reminder.create': {
    cues: ['remind', 'reminder', 'nudge', 'alert'],
    templates: [
      'remind me to <TITLE> on <DATE> at <TIME>',
      'give me a nudge to <TITLE> <RECURRENCE>',
      'set a reminder for <TITLE> before <TARGET>'
    ]
  },
  'calendar.reminder.update': {
    cues: ['change', 'edit', 'rename', 'update'],
    templates: [
      'change reminder <TARGET> to <NEW_TITLE>',
      'move my <TARGET> reminder to <DATE> at <TIME>',
      'update reminder <TARGET> so it repeats <RECURRENCE>'
    ]
  },
  'calendar.reminder.complete': {
    cues: ['complete', 'done', 'finish', 'check'],
    templates: [
      'mark reminder <TARGET> complete',
      'check off <TARGET> as done',
      'finish the reminder named <TARGET>'
    ]
  },
  'calendar.reminder.delete': {
    cues: ['delete', 'dismiss', 'remove', 'clear'],
    templates: [
      'delete my <TARGET> reminder',
      'dismiss the reminder about <TARGET>',
      'remove reminder <TARGET> from <DATE>'
    ]
  },
  'calendar.query.list': {
    cues: ['agenda', 'calendar', 'plans', 'scheduled'],
    templates: [
      'list my plans for <DATE>',
      'show the calendar between <DATE> and <END_DATE>',
      'give me the agenda around <TIME> on <DATE>'
    ]
  },
  'calendar.query.search': {
    cues: ['find', 'locate', 'search', 'where', 'when'],
    templates: [
      'find <TARGET> in my calendar',
      'where is <TARGET> happening',
      'search my plans for anything at <LOCATION>'
    ]
  },
  'calendar.query.availability': {
    cues: ['available', 'free', 'open', 'gap'],
    templates: [
      'am I available on <DATE> at <TIME>',
      'find an open <DURATION> window on <DATE>',
      'do I have a gap between <TIME> and <END_TIME>'
    ]
  },
  'calendar.query.conflicts': {
    cues: ['conflict', 'overlap', 'double', 'clash'],
    templates: [
      'check for conflicts on <DATE>',
      'which plans overlap between <TIME> and <END_TIME>',
      'am I double booked around <TIME> on <DATE>'
    ]
  },
  'calendar.query.next': {
    cues: ['next', 'upcoming', 'soonest'],
    templates: [
      'tell me the next thing on my agenda',
      'which appointment is coming up soonest',
      'show my next reminder or event after <TIME>'
    ]
  },
  'calendar.query.details': {
    cues: ['details', 'location', 'information', 'tell'],
    templates: [
      'show the details for <TARGET>',
      'what location do I have for <TARGET>',
      'tell me more information about <TARGET>'
    ]
  },
  'calendar.query.summary': {
    cues: ['summarize', 'overview', 'shape', 'busy'],
    templates: [
      'summarize how <DATE> looks',
      'give me a quick overview of <RANGE>',
      'explain how busy my calendar is during <RANGE>'
    ]
  },
  'calendar.schedule.copy-day': {
    cues: ['copy', 'mirror', 'repeat', 'reuse'],
    templates: [
      'copy everything from <SOURCE_DATE> onto <DESTINATION_DAYS>',
      'mirror my <SOURCE_DATE> schedule on <DESTINATION_DAYS>',
      'repeat the full plan from <SOURCE_DATE> across <DESTINATION_DAYS>'
    ]
  },
  'calendar.schedule.clear': {
    cues: ['clear', 'delete', 'remove', 'wipe'],
    templates: [
      'clear all events within <RANGE>',
      'remove every reminder from <DATE>',
      'wipe both events and reminders during <RANGE>'
    ]
  },
  'calendar.import.document': {
    cues: ['import', 'read', 'scan', 'attach'],
    templates: [
      'read the attached <FILE_KIND> and propose its dates',
      'scan this <FILE_KIND> for classes and meetings',
      'import plans from the attached <FILE_KIND>'
    ]
  },
  'calendar.import.file': {
    cues: ['import', 'restore', 'load', 'open'],
    templates: [
      'import my <FILE_KIND> calendar file',
      'restore calendar items from this <FILE_KIND>',
      'load the attached <FILE_KIND> into a review'
    ]
  },
  'calendar.export.file': {
    cues: ['export', 'backup', 'save', 'download'],
    templates: [
      'export my calendar as <FILE_KIND>',
      'make a local backup in <FILE_KIND> format',
      'save all my plans to a <FILE_KIND> file'
    ]
  },
  'assistant.chat.respond': {
    cues: ['explain', 'idea', 'think', 'help', 'tell'],
    templates: [
      'explain <TOPIC> in simple terms',
      'help me think through <TOPIC>',
      'tell me an interesting idea about <TOPIC>'
    ]
  },
  'assistant.help': {
    cues: ['help', 'examples', 'requests', 'features'],
    templates: [
      'show me examples of requests you understand',
      'give me a quick tour of your calendar features',
      'how can you help me manage my time'
    ]
  },
  'assistant.identity': {
    cues: ['name', 'assistant', 'introduce', 'yourself'],
    templates: [
      'introduce yourself to me',
      'what is the name of this assistant',
      'tell me who I am chatting with'
    ]
  },
  'assistant.architecture': {
    cues: ['model', 'local', 'private', 'built'],
    templates: [
      'which local models power this app',
      'explain how you keep my calendar private',
      'tell me how this assistant was built'
    ]
  },
  'assistant.local-time': {
    cues: ['time', 'date', 'day', 'clock'],
    templates: [
      'read the current time from my device',
      'tell me today’s local date',
      'which day does my calendar think it is'
    ]
  },
  'assistant.wellbeing': {
    cues: ['doing', 'there', 'encourage', 'hello', 'morning'],
    templates: [
      'hello there, how are you doing',
      'are you there and ready to chat',
      'give me a short word of encouragement'
    ]
  },
  'assistant.thanks': {
    cues: ['thank', 'appreciate', 'helpful'],
    templates: [
      'thank you for sorting that out',
      'I appreciate your help with that',
      'that was helpful, many thanks'
    ]
  },
  'assistant.goodbye': {
    cues: ['goodbye', 'later', 'night', 'signing'],
    templates: ['goodbye for now', 'I will talk to you again later', 'good night, I am signing off']
  },
  'assistant.memory.set-name': {
    cues: ['name', 'call', 'remember'],
    templates: [
      'remember that my name is <NAME>',
      'please call me <NAME> from now on',
      'set my preferred name to <NAME>'
    ]
  },
  'assistant.memory.remember': {
    cues: ['remember', 'preference', 'keep', 'note'],
    templates: [
      'remember that <MEMORY>',
      'keep this preference locally: <MEMORY>',
      'make a private note that <MEMORY>'
    ]
  },
  'assistant.memory.recall': {
    cues: ['remember', 'memory', 'saved', 'know'],
    templates: [
      'what have you remembered about me',
      'show my locally saved preferences',
      'list the personal memory you know'
    ]
  },
  'assistant.memory.forget': {
    cues: ['forget', 'remove', 'erase', 'memory'],
    templates: [
      'forget the preference about <MEMORY>',
      'remove <MEMORY> from local memory',
      'erase what you remember about <MEMORY>'
    ]
  },
  'assistant.memory.forget-all': {
    cues: ['forget', 'clear', 'erase', 'memory'],
    templates: [
      'forget every personal detail you stored',
      'clear all of my assistant memories',
      'erase the complete local memory profile'
    ]
  },
  'app.navigation.open': {
    cues: ['open', 'show', 'go', 'view'],
    templates: ['open the <VIEW> view', 'take me to <VIEW>', 'show the <VIEW> section of the app']
  },
  'app.appearance.update': {
    cues: ['theme', 'color', 'appearance', 'density'],
    templates: [
      'change the accent color to <COLOR>',
      'switch the app theme to <THEME>',
      'make the interface density <DENSITY>'
    ]
  },
  'app.window.set-mode': {
    cues: ['window', 'widget', 'glance', 'mode'],
    templates: [
      'switch the window into <MODE> mode',
      'show the calendar as a <MODE> widget',
      'make this app use the <MODE> view'
    ]
  },
  'app.window.set-pinned': {
    cues: ['pin', 'top', 'desktop', 'window'],
    templates: [
      'pin this window above my other apps',
      'keep the calendar on top of the desktop',
      'unpin the widget from always on top'
    ]
  },
  'app.startup.configure': {
    cues: ['startup', 'login', 'launch', 'computer'],
    templates: [
      'launch the app when I sign in',
      'disable opening Remind Me at startup',
      'start in <MODE> mode with my computer'
    ]
  },
  'app.model.install': {
    cues: ['install', 'language', 'model', 'fallback'],
    templates: [
      'install the optional local language model',
      'open the language pack installation flow',
      'set up the <MODEL> fallback on this device'
    ]
  },
  'app.model.enable': {
    cues: ['enable', 'disable', 'model', 'fallback'],
    templates: [
      'enable the installed language fallback',
      'turn off the optional local model',
      'use <MODEL> for broad requests'
    ]
  },
  'app.model.remove': {
    cues: ['remove', 'uninstall', 'delete', 'model'],
    templates: [
      'remove the optional language pack',
      'uninstall <MODEL> from this device',
      'delete the local fallback model files'
    ]
  }
}

interface CompoundProgram {
  id: string
  split: Split
  template: string
  capabilities: readonly AssistantCapabilityId[]
}

const COMPOUND_PROGRAMS: readonly CompoundProgram[] = [
  {
    id: 'mixed-create',
    split: 'train',
    template: 'schedule <TITLE_1> on <DATE_1> at <TIME_1>, and remind me to <TITLE_2> at <TIME_2>',
    capabilities: ['calendar.event.create', 'calendar.reminder.create']
  },
  {
    id: 'shared-date-two-events',
    split: 'train',
    template: 'on <DATE_1>, add <TITLE_1> at <TIME_1> and <TITLE_2> at <TIME_2>',
    capabilities: ['calendar.event.create', 'calendar.event.create']
  },
  {
    id: 'move-two-events',
    split: 'train',
    template:
      'move <TARGET_1> to <DATE_1> at <TIME_1>, then shift <TARGET_2> to <DATE_2> at <TIME_2>',
    capabilities: ['calendar.event.move', 'calendar.event.move']
  },
  {
    id: 'complete-and-delete',
    split: 'train',
    template: 'mark <TARGET_1> done and delete the reminder <TARGET_2>',
    capabilities: ['calendar.reminder.complete', 'calendar.reminder.delete']
  },
  {
    id: 'list-and-free',
    split: 'train',
    template: 'show my plans for <DATE_1> and check whether <TIME_1> to <END_TIME_1> is free',
    capabilities: ['calendar.query.list', 'calendar.query.availability']
  },
  {
    id: 'rename-and-move',
    split: 'development',
    template: 'rename <TARGET_1> to <NEW_TITLE_1> and move it to <DATE_1> at <TIME_1>',
    capabilities: ['calendar.event.update', 'calendar.event.move']
  },
  {
    id: 'two-reminders',
    split: 'development',
    template: 'remind me to <TITLE_1> on <DATE_1> and to <TITLE_2> on <DATE_2> at <TIME_2>',
    capabilities: ['calendar.reminder.create', 'calendar.reminder.create']
  },
  {
    id: 'show-and-widget',
    split: 'development',
    template: 'open <VIEW_1>, then put the window in <MODE_1> mode',
    capabilities: ['app.navigation.open', 'app.window.set-mode']
  },
  {
    id: 'remove-event-and-reminder',
    split: 'challenge',
    template: 'cancel event <TARGET_1> and dismiss reminder <TARGET_2>',
    capabilities: ['calendar.event.delete', 'calendar.reminder.delete']
  },
  {
    id: 'three-class-blocks',
    split: 'challenge',
    template:
      'on <DATE_1> add <TITLE_1> at <TIME_1>, <TITLE_2> at <TIME_2>, and <TITLE_3> at <TIME_3>',
    capabilities: ['calendar.event.create', 'calendar.event.create', 'calendar.event.create']
  },
  {
    id: 'theme-and-glance',
    split: 'challenge',
    template: 'use the <THEME_1> theme with <COLOR_1>, then switch to <MODE_1> mode',
    capabilities: ['app.appearance.update', 'app.window.set-mode']
  },
  {
    id: 'search-and-details',
    split: 'challenge',
    template: 'find <TARGET_1> and tell me its location and details',
    capabilities: ['calendar.query.search', 'calendar.query.details']
  }
]

interface DialogueProgram {
  id: string
  split: Split
  template: string
  capabilityId: AssistantCapabilityId
  context: NonNullable<CorpusRow['context']>
}

const DIALOGUE_PROGRAMS: readonly DialogueProgram[] = [
  {
    id: 'move-focused-event',
    split: 'train',
    template: 'move it to <DATE> at <TIME>',
    capabilityId: 'calendar.event.move',
    context: {
      focusedKind: 'event',
      focusedCount: 1,
      ordinal: null,
      priorCapabilityId: 'calendar.query.search',
      pendingCapabilityId: null
    }
  },
  {
    id: 'rename-focused-event',
    split: 'train',
    template: 'rename that one to <NEW_TITLE>',
    capabilityId: 'calendar.event.update',
    context: {
      focusedKind: 'event',
      focusedCount: 1,
      ordinal: null,
      priorCapabilityId: 'calendar.query.details',
      pendingCapabilityId: null
    }
  },
  {
    id: 'complete-focused-reminder',
    split: 'train',
    template: 'mark that reminder done',
    capabilityId: 'calendar.reminder.complete',
    context: {
      focusedKind: 'reminder',
      focusedCount: 1,
      ordinal: null,
      priorCapabilityId: 'calendar.query.list',
      pendingCapabilityId: null
    }
  },
  {
    id: 'details-second-result',
    split: 'train',
    template: 'tell me more about the second one',
    capabilityId: 'calendar.query.details',
    context: {
      focusedKind: 'mixed',
      focusedCount: 3,
      ordinal: 2,
      priorCapabilityId: 'calendar.query.list',
      pendingCapabilityId: null
    }
  },
  {
    id: 'copy-focused-event',
    split: 'development',
    template: 'copy that to <DATE> at <TIME>',
    capabilityId: 'calendar.event.duplicate',
    context: {
      focusedKind: 'event',
      focusedCount: 1,
      ordinal: null,
      priorCapabilityId: 'calendar.query.details',
      pendingCapabilityId: null
    }
  },
  {
    id: 'delete-third-result',
    split: 'development',
    template: 'cancel the third event',
    capabilityId: 'calendar.event.delete',
    context: {
      focusedKind: 'event',
      focusedCount: 4,
      ordinal: 3,
      priorCapabilityId: 'calendar.query.search',
      pendingCapabilityId: null
    }
  },
  {
    id: 'clarified-create-time',
    split: 'development',
    template: '<DATE> at <TIME>',
    capabilityId: 'calendar.event.create',
    context: {
      focusedKind: 'event',
      focusedCount: 0,
      ordinal: null,
      priorCapabilityId: null,
      pendingCapabilityId: 'calendar.event.create'
    }
  },
  {
    id: 'details-pronoun',
    split: 'challenge',
    template: 'where is it and when does it start',
    capabilityId: 'calendar.query.details',
    context: {
      focusedKind: 'event',
      focusedCount: 1,
      ordinal: null,
      priorCapabilityId: 'calendar.query.next',
      pendingCapabilityId: null
    }
  },
  {
    id: 'delete-focused-reminder',
    split: 'challenge',
    template: 'get rid of that one',
    capabilityId: 'calendar.reminder.delete',
    context: {
      focusedKind: 'reminder',
      focusedCount: 1,
      ordinal: null,
      priorCapabilityId: 'calendar.query.list',
      pendingCapabilityId: null
    }
  },
  {
    id: 'forget-focused-memory',
    split: 'challenge',
    template: 'forget that preference',
    capabilityId: 'assistant.memory.forget',
    context: {
      focusedKind: 'memory',
      focusedCount: 1,
      ordinal: null,
      priorCapabilityId: 'assistant.memory.recall',
      pendingCapabilityId: null
    }
  }
]

interface HardNegativeProgram {
  id: string
  split: Split
  text: string
}

const HARD_NEGATIVE_PROGRAMS: readonly HardNegativeProgram[] = [
  {
    id: 'move-past-procrastination',
    split: 'train',
    text: 'help me move past procrastination without changing my calendar'
  },
  {
    id: 'remove-repeated-words',
    split: 'train',
    text: 'remove the repeated words from this sentence'
  },
  {
    id: 'essay-plan',
    split: 'train',
    text: 'help me plan the structure of an essay'
  },
  {
    id: 'date-fruit',
    split: 'train',
    text: 'why do date palms grow well in dry climates'
  },
  {
    id: 'historical-events',
    split: 'development',
    text: 'which historical events changed modern computing'
  },
  {
    id: 'copy-tone',
    split: 'development',
    text: 'copy the tone of this paragraph in a friendlier style'
  },
  {
    id: 'free-software',
    split: 'development',
    text: 'tell me why free software matters'
  },
  {
    id: 'busy-chat',
    split: 'development',
    text: 'I feel busy and would rather just chat for a minute'
  },
  {
    id: 'clear-up-concept',
    split: 'challenge',
    text: 'clear up the difference between weather and climate'
  },
  {
    id: 'schedule-data-structure',
    split: 'challenge',
    text: 'explain what a schedule means in operating systems'
  },
  {
    id: 'remind-why-practice',
    split: 'challenge',
    text: 'remind me why deliberate practice is useful'
  },
  {
    id: 'good-plan',
    split: 'challenge',
    text: 'what makes a plan realistic and easy to follow'
  }
]

const SLOT_VALUES: Record<string, readonly string[]> = {
  TITLE: ['Design review', 'Guitar practice', 'Study group', 'Lunch with Sam', 'Project demo'],
  TARGET: [
    'Design review',
    'Guitar practice',
    'the budget check-in',
    'Project demo',
    'Study group'
  ],
  NEW_TITLE: ['Final review', 'Focused work block', 'Team sync', 'Evening practice'],
  DATE: [
    'next Thursday',
    'September 14',
    'this Saturday',
    'in two weeks',
    'the day after tomorrow'
  ],
  SOURCE_DATE: ['this Monday', 'September 8', 'next Tuesday', 'the first Friday of October'],
  END_DATE: ['next Sunday', 'September 18', 'the end of this month'],
  TIME: ['9:30 am', 'noon', '2:15 pm', '6 pm', '8:45 in the morning'],
  END_TIME: ['11 am', '3:30 pm', '7 pm', '10:15 in the morning'],
  DURATION: ['thirty minute', 'one hour', 'ninety minute', 'two hour'],
  LOCATION: ['the library', 'Room 214', 'the north campus studio', 'online'],
  RECURRENCE: ['every weekday', 'on Mondays and Wednesdays', 'once a month', 'every other Friday'],
  RANGE: ['next week', 'the rest of this month', 'September 10 through September 20'],
  DESTINATION_DAYS: ['Wednesday and Friday', 'Tuesday and Thursday', 'every weekday'],
  FILE_KIND: ['PDF', 'image', 'ICS', 'JSON'],
  TOPIC: ['building a study habit', 'why seasons change', 'planning a balanced week'],
  NAME: ['Alex', 'Jordan', 'Riley', 'Morgan'],
  MEMORY: [
    'I prefer short replies',
    'mornings work best for focused tasks',
    'my week starts on Monday'
  ],
  VIEW: ['calendar', 'reminders', 'today', 'settings'],
  COLOR: ['sage green', 'deep blue', 'warm amber', 'soft lavender'],
  THEME: ['translucent', 'liquid glass', 'sunset', 'high contrast'],
  DENSITY: ['compact', 'comfortable', 'roomy'],
  MODE: ['widget', 'glance', 'full'],
  MODEL: ['Qwen local', 'the compact language pack', 'the optional fallback']
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path: string): Promise<string> {
  return sha256Text(await readFile(path, 'utf8'))
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeOutput(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, 'utf8')
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/<([A-Z][A-Z0-9_]*)>/gu, '<slot>')
    .replace(/[^a-z0-9<>]+/gu, ' ')
    .trim()
}

function tokens(value: string): Set<string> {
  return new Set(normalized(value).split(/\s+/u).filter(Boolean))
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((token) => right.has(token)).length
  const union = new Set([...left, ...right]).size
  return union === 0 ? 0 : intersection / union
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/<([A-Z][A-Z0-9_]*)>/gu)].map((match) => match[1] ?? '')
}

function splitForSeed(index: number): Split {
  if (index === 0) return 'train'
  if (index === 1) return 'development'
  return 'challenge'
}

function routeFor(capability: AssistantCapabilityDefinition): CoarseRoute {
  if (capability.id === 'assistant.chat.respond') return 'broad-chat'
  if (capability.domain === 'memory') return 'memory'
  if (capability.domain === 'conversation') return 'conversation'
  if (capability.domain === 'document') return 'document'
  if (capability.domain === 'app' || capability.domain === 'model') return 'app'
  return 'calendar'
}

function capabilityMap(): Map<AssistantCapabilityId, AssistantCapabilityDefinition> {
  return new Map(assistantCapabilityRegistry.map((capability) => [capability.id, capability]))
}

function validateCatalog(): void {
  const directCapabilities = assistantCapabilityRegistry.filter(
    (capability) => !OUTCOME_ONLY_CAPABILITIES.has(capability.id)
  )
  const directIds = new Set(directCapabilities.map((capability) => capability.id))
  const catalogIds = new Set(Object.keys(SEED_CATALOG))
  const missing = [...directIds].filter((id) => !catalogIds.has(id))
  const unknown = [...catalogIds].filter((id) => !directIds.has(id as AssistantCapabilityId))
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Assistant corpus catalog drifted from the capability registry (missing=${missing.join(',')}; unknown=${unknown.join(',')})`
    )
  }
  for (const [capabilityId, spec] of Object.entries(SEED_CATALOG)) {
    if (spec.templates.length !== 3)
      throw new Error(`${capabilityId} must define three seed families`)
    for (const template of spec.templates) {
      const markers = placeholders(template)
      if (new Set(markers).size !== markers.length) {
        throw new Error(`${capabilityId} repeats a protected marker in ${template}`)
      }
      if (template.length < 8 || template.length > 220) {
        throw new Error(`${capabilityId} has an invalid template length`)
      }
    }
  }
}

function registryDigest(): string {
  return sha256Text(
    JSON.stringify(
      assistantCapabilityRegistry.map((capability) => ({
        id: capability.id,
        domain: capability.domain,
        status: capability.status,
        confirmation: capability.confirmation,
        supportsMultiAction: capability.supportsMultiAction,
        requiresOptionalModel: capability.requiresOptionalModel
      }))
    )
  )
}

function buildTeacherJobs(config: CorpusConfig): {
  schemaVersion: number
  corpusVersion: string
  generator: string
  seed: number
  paraphrasesPerJob: number
  teacherModelId: string
  teacherSha256: string
  teacherRole: string
  labelAuthority: string
  registrySha256: string
  jobs: TeacherJob[]
} {
  validateCatalog()
  const jobs: TeacherJob[] = []
  let directIndex = 0
  for (const capability of assistantCapabilityRegistry) {
    if (OUTCOME_ONLY_CAPABILITIES.has(capability.id)) continue
    const spec = SEED_CATALOG[capability.id]
    if (!spec) throw new Error(`Missing seed specification for ${capability.id}`)
    const index = directIndex % spec.templates.length
    const seedTemplate = spec.templates[index]
    if (!seedTemplate) throw new Error(`Missing rotating teacher seed for ${capability.id}`)
    jobs.push({
      id: `assistant:${capability.id}:${index + 1}`,
      capabilityId: capability.id,
      meaning: capability.title,
      seedTemplate,
      placeholders: placeholders(seedTemplate),
      cues: spec.cues,
      split: splitForSeed(index),
      familyId: `single:${capability.id}:${index + 1}`
    })
    directIndex += 1
  }
  if (jobs.length !== 42) {
    throw new Error(`Expected 42 teacher jobs for 42 direct capabilities; found ${jobs.length}`)
  }
  return {
    schemaVersion: 1,
    corpusVersion: config.corpusVersion,
    generator: 'scripts/build-assistant-corpus.ts prepare',
    seed: config.seed,
    paraphrasesPerJob: config.teacherParaphrasesPerJob,
    teacherModelId: config.teacherModelId,
    teacherSha256: config.teacherSha256,
    teacherRole: 'delexicalized surface paraphrase only',
    labelAuthority: 'project-authored capability registry and seed programs',
    registrySha256: registryDigest(),
    jobs
  }
}

interface FrozenEvaluation {
  manifest: {
    sha256: string
    scenarios: number
    trainingExcluded: boolean
    frozen: boolean
  }
  texts: string[]
  suiteSha256: string
}

async function loadFrozenEvaluation(config: CorpusConfig): Promise<FrozenEvaluation> {
  const manifestPath = resolve(WORKSPACE, config.frozenEvaluationManifest)
  const suitePath = resolve(WORKSPACE, config.frozenEvaluationSuite)
  const manifest = await readJson<FrozenEvaluation['manifest']>(manifestPath)
  const suiteText = await readFile(suitePath, 'utf8')
  const suiteSha256 = sha256Text(suiteText)
  if (!manifest.trainingExcluded || !manifest.frozen || manifest.sha256 !== suiteSha256) {
    throw new Error('The frozen assistant evaluation boundary failed its manifest check')
  }
  const scenarios = suiteText
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          turns?: Array<{ text?: unknown }>
        }
    )
  if (scenarios.length !== manifest.scenarios) {
    throw new Error('The frozen assistant evaluation scenario count changed')
  }
  const texts = scenarios.flatMap((scenario) =>
    (scenario.turns ?? [])
      .map((turn) => turn.text)
      .filter((text): text is string => typeof text === 'string')
  )
  return { manifest, texts, suiteSha256 }
}

function evaluationCollision(
  candidate: string,
  evaluationTexts: readonly string[],
  threshold: number
): string | null {
  const candidateNormalized = normalized(candidate)
  const candidateTokens = tokens(candidate)
  for (const evaluationText of evaluationTexts) {
    if (candidateNormalized === normalized(evaluationText)) return 'exact'
    const evaluationTokens = tokens(evaluationText)
    if (
      candidateTokens.size >= 6 &&
      evaluationTokens.size >= 6 &&
      jaccard(candidateTokens, evaluationTokens) >= threshold
    ) {
      return 'near-duplicate'
    }
  }
  return null
}

interface TeacherRaw {
  kind?: unknown
  teacher?: {
    modelId?: unknown
    byteLength?: unknown
    sha256?: unknown
    license?: unknown
  }
  batches?: Array<{
    output?: {
      items?: Array<{
        id?: unknown
        paraphrases?: unknown
      }>
    }
  }>
}

function sortedMarkers(value: string): string[] {
  return placeholders(value).sort()
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function curateTemplates(
  config: CorpusConfig,
  enforceMinimum = true
): Promise<{
  accepted: {
    schemaVersion: number
    corpusVersion: string
    provenance: Record<string, unknown>
    templates: TemplateRecord[]
  }
  report: Record<string, unknown>
  evaluation: FrozenEvaluation
}> {
  const prepared = buildTeacherJobs(config)
  const committedJobs = await readJson<ReturnType<typeof buildTeacherJobs>>(JOBS_PATH)
  if (stableStringify(committedJobs) !== stableStringify(prepared)) {
    throw new Error('Teacher jobs do not match the deterministic preparation output')
  }
  const evaluation = await loadFrozenEvaluation(config)
  const capabilities = capabilityMap()
  const templates: TemplateRecord[] = []
  const seen = new Set<string>()
  for (const capability of assistantCapabilityRegistry) {
    if (OUTCOME_ONLY_CAPABILITIES.has(capability.id)) continue
    const spec = SEED_CATALOG[capability.id]
    if (!spec) throw new Error(`Missing seed specification for ${capability.id}`)
    spec.templates.forEach((seedTemplate, index) => {
      const collision = evaluationCollision(
        seedTemplate,
        evaluation.texts,
        config.evaluationSimilarityThreshold
      )
      if (collision) {
        throw new Error(
          `Project seed ${capability.id}:${index + 1} collides with frozen evaluation data (${collision})`
        )
      }
      const key = normalized(seedTemplate)
      if (seen.has(key)) throw new Error(`Duplicate project seed surface: ${seedTemplate}`)
      seen.add(key)
      templates.push({
        id: `project-${sha256Text(`${capability.id}:${seedTemplate}`).slice(0, 14)}`,
        capabilityId: capability.id,
        route: routeFor(capability),
        template: seedTemplate,
        placeholders: placeholders(seedTemplate),
        split: splitForSeed(index),
        familyId: `single:${capability.id}:${index + 1}`,
        source: 'project-seed',
        teacherJobId: null,
        executableNow: capability.status === 'assistant-ready',
        confirmation: capability.confirmation
      })
    })
  }

  const raw = await readJson<TeacherRaw>(TEACHER_RAW_PATH)
  if (
    raw.kind !== 'assistant-paraphrases' ||
    raw.teacher?.modelId !== config.teacherModelId ||
    raw.teacher?.byteLength !== config.teacherByteLength ||
    raw.teacher?.sha256 !== config.teacherSha256 ||
    raw.teacher?.license !== config.teacherLicense
  ) {
    throw new Error('Assistant teacher output does not match the pinned local Qwen model')
  }

  const jobMap = new Map(prepared.jobs.map((job) => [job.id, job]))
  const repairJobsPayload = await readJson<
    ReturnType<typeof buildTeacherJobs> & {
      parentJobsSha256?: unknown
      repairRound?: unknown
    }
  >(REPAIR_JOBS_PATH)
  if (
    repairJobsPayload.teacherModelId !== config.teacherModelId ||
    repairJobsPayload.teacherSha256 !== config.teacherSha256 ||
    repairJobsPayload.parentJobsSha256 !== (await sha256File(JOBS_PATH)) ||
    repairJobsPayload.repairRound !== 1
  ) {
    throw new Error('Assistant curation-repair jobs do not match the protected parent job set')
  }
  const repairJobIds = new Set<string>()
  for (const repairJob of repairJobsPayload.jobs) {
    const parent = jobMap.get(repairJob.id)
    if (!parent || stableStringify(parent) !== stableStringify(repairJob)) {
      throw new Error(`Invalid AssistantPlan curation-repair job ${repairJob.id}`)
    }
    if (repairJobIds.has(repairJob.id)) {
      throw new Error(`Duplicate AssistantPlan curation-repair job ${repairJob.id}`)
    }
    repairJobIds.add(repairJob.id)
  }
  const rejected = new Map<string, number>()
  const bump = (reason: string): void => {
    rejected.set(reason, (rejected.get(reason) ?? 0) + 1)
  }
  const rawByJob = new Map<string, string[]>()
  for (const batch of raw.batches ?? []) {
    for (const item of batch.output?.items ?? []) {
      if (typeof item.id !== 'string' || !jobMap.has(item.id)) {
        bump('unknown-job')
        continue
      }
      if (!Array.isArray(item.paraphrases)) {
        bump('invalid-schema')
        continue
      }
      const values = rawByJob.get(item.id) ?? []
      for (const paraphrase of item.paraphrases) {
        if (typeof paraphrase === 'string') values.push(paraphrase)
        else bump('invalid-schema')
      }
      rawByJob.set(item.id, values)
    }
  }
  const missingTeacherJobs = prepared.jobs.filter((job) => !rawByJob.has(job.id))
  if (missingTeacherJobs.length > 0) {
    throw new Error(
      `Assistant teacher output is incomplete; ${missingTeacherJobs.length} protected jobs are missing`
    )
  }

  const teacherCoverage = new Set<AssistantCapabilityId>()
  let rawCandidates = 0
  for (const job of prepared.jobs) {
    const candidates = rawByJob.get(job.id) ?? []
    if (candidates.length === 0) bump('missing-job')
    for (const rawCandidate of candidates) {
      rawCandidates += 1
      const candidate = rawCandidate.normalize('NFKC').replace(/\s+/gu, ' ').trim()
      if (candidate.length < 8 || candidate.length > 220 || candidate.includes('\n')) {
        bump('length')
        continue
      }
      if (!arraysEqual(sortedMarkers(candidate), [...job.placeholders].sort())) {
        bump('placeholder-signature')
        continue
      }
      if (/<[^>]*>/gu.test(candidate.replace(/<[A-Z][A-Z0-9_]*>/gu, ''))) {
        bump('unknown-placeholder')
        continue
      }
      const staticText = candidate.replace(/<[A-Z][A-Z0-9_]*>/gu, '')
      if (/\d/u.test(staticText)) {
        bump('unprotected-specific')
        continue
      }
      const staticTokenCount = normalized(staticText).split(/\s+/u).filter(Boolean).length
      if ((job.placeholders.length === 0 && staticTokenCount < 4) || staticTokenCount < 2) {
        bump('not-user-voice')
        continue
      }
      const capability = capabilities.get(job.capabilityId)
      if (!capability) throw new Error(`Unknown capability ${job.capabilityId}`)
      const lowered = candidate.toLocaleLowerCase()
      const titleCue = capability.title.split(/\s+/u)[0]?.toLocaleLowerCase()
      const semanticCues = titleCue ? [...job.cues, titleCue] : job.cues
      if (!semanticCues.some((cue) => lowered.includes(cue))) {
        bump('semantic-cue')
        continue
      }
      if (/^(?:certainly|done|here(?:'s| is)|i (?:have|will)|okay|sure)\b/iu.test(candidate)) {
        bump('assistant-answer')
        continue
      }
      if (
        /\b(?:for (?:approval|review)|to be (?:added|changed|deleted|duplicated|moved|removed|reviewed|shifted|updated))\b/iu.test(
          candidate
        )
      ) {
        bump('not-user-voice')
        continue
      }
      if (/\b(?:anchor|capability|intent|marker|seed)\b/iu.test(staticText)) {
        bump('instruction-leakage')
        continue
      }
      const collision = evaluationCollision(
        candidate,
        evaluation.texts,
        config.evaluationSimilarityThreshold
      )
      if (collision) {
        bump(`evaluation-${collision}`)
        continue
      }
      const key = normalized(candidate)
      if (seen.has(key)) {
        bump('duplicate')
        continue
      }
      seen.add(key)
      teacherCoverage.add(job.capabilityId)
      templates.push({
        id: `qwen-${sha256Text(`${job.capabilityId}:${candidate}`).slice(0, 14)}`,
        capabilityId: job.capabilityId,
        route: routeFor(capability),
        template: candidate,
        placeholders: job.placeholders,
        split: job.split,
        familyId: job.familyId,
        source: 'qwen-paraphrase',
        teacherJobId: job.id,
        executableNow: capability.status === 'assistant-ready',
        confirmation: capability.confirmation
      })
    }
  }

  const acceptedTeacherTemplates = templates.filter(
    (template) => template.source === 'qwen-paraphrase'
  ).length
  if (enforceMinimum && acceptedTeacherTemplates < config.minimumAcceptedTeacherTemplates) {
    throw new Error(
      `Only ${acceptedTeacherTemplates} Qwen paraphrases passed curation; require ${config.minimumAcceptedTeacherTemplates}. Rejections: ${JSON.stringify(Object.fromEntries(rejected))}`
    )
  }
  if (enforceMinimum && teacherCoverage.size < config.minimumTeacherCapabilityCoverage) {
    throw new Error(
      `Qwen paraphrases cover ${teacherCoverage.size} capabilities; require ${config.minimumTeacherCapabilityCoverage}`
    )
  }

  const sourceCounts = Object.fromEntries(
    ['project-seed', 'qwen-paraphrase'].map((source) => [
      source,
      templates.filter((template) => template.source === source).length
    ])
  )
  const splitCounts = Object.fromEntries(
    (['train', 'development', 'challenge'] as const).map((split) => [
      split,
      templates.filter((template) => template.split === split).length
    ])
  )
  const accepted = {
    schemaVersion: 1,
    corpusVersion: config.corpusVersion,
    provenance: {
      teacherModelId: config.teacherModelId,
      teacherByteLength: config.teacherByteLength,
      teacherSha256: config.teacherSha256,
      teacherLicense: config.teacherLicense,
      teacherRole: 'delexicalized surface paraphrase only',
      labelAuthority: 'project-authored capability registry and semantic seed programs',
      pretrainedWeightsImportedIntoStudent: false,
      personalCalendarDataUsed: false,
      humanConversationLogsUsed: false,
      humanBlindExamplesUsed: 0,
      rawPath: 'ml/assistant_corpus/raw/qwen-paraphrases.json',
      rawSha256: await sha256File(TEACHER_RAW_PATH),
      jobsPath: 'ml/assistant_corpus/raw/teacher-jobs.json',
      jobsSha256: await sha256File(JOBS_PATH),
      repairJobsPath: 'ml/assistant_corpus/raw/teacher-repair-jobs.json',
      repairJobsSha256: await sha256File(REPAIR_JOBS_PATH),
      registrySha256: registryDigest(),
      frozenEvaluationPath: config.frozenEvaluationSuite,
      frozenEvaluationSha256: evaluation.suiteSha256,
      frozenEvaluationRole: 'contamination rejection only; never supplied to the teacher'
    },
    templates
  }
  return {
    accepted,
    evaluation,
    report: {
      schemaVersion: 1,
      rawCandidates,
      acceptedTemplates: templates.length,
      acceptedTeacherTemplates,
      teacherCapabilityCoverage: teacherCoverage.size,
      directCapabilityCoverage: new Set(templates.map((template) => template.capabilityId)).size,
      sourceCounts,
      splitCounts,
      rejected: Object.fromEntries(
        [...rejected].sort(([left], [right]) => left.localeCompare(right))
      ),
      evaluationContaminationAccepted: 0,
      outcomeOnlyCapabilitiesExcluded: [...OUTCOME_ONLY_CAPABILITIES]
    }
  }
}

function valueForMarker(marker: string, key: string): string {
  const base = marker.replace(/_\d+$/u, '')
  const values = SLOT_VALUES[base]
  if (!values || values.length === 0)
    throw new Error(`No protected values configured for <${marker}>`)
  const numeric = Number.parseInt(sha256Text(`${key}:${marker}`).slice(0, 8), 16)
  return values[numeric % values.length] ?? values[0] ?? ''
}

function instantiate(template: string, key: string): { text: string; slots: SlotSpan[] } {
  let text = ''
  let cursor = 0
  const slots: SlotSpan[] = []
  for (const match of template.matchAll(/<([A-Z][A-Z0-9_]*)>/gu)) {
    const marker = match[1]
    const index = match.index
    if (!marker || index === undefined) continue
    text += template.slice(cursor, index)
    const value = valueForMarker(marker, key)
    const start = text.length
    text += value
    slots.push({ name: marker, value, start, end: text.length })
    cursor = index + match[0].length
  }
  text += template.slice(cursor)
  return { text: text.trim(), slots }
}

function mutateLiteralTypo(value: string, key: string): string {
  const words = [...value.matchAll(/\b[a-zA-Z]{5,}\b/gu)]
  if (words.length === 0) return value
  const numeric = Number.parseInt(sha256Text(key).slice(0, 8), 16)
  const match = words[numeric % words.length]
  if (!match || match.index === undefined) return value
  const word = match[0]
  const swapAt = Math.max(1, Math.min(word.length - 2, numeric % (word.length - 1)))
  const changed = word.slice(0, swapAt) + word[swapAt + 1] + word[swapAt] + word.slice(swapAt + 2)
  return value.slice(0, match.index) + changed + value.slice(match.index + word.length)
}

function transformOutsideMarkers(
  template: string,
  transform: (literal: string, index: number) => string
): string {
  let result = ''
  let cursor = 0
  let literalIndex = 0
  for (const match of template.matchAll(/<[A-Z][A-Z0-9_]*>/gu)) {
    if (match.index === undefined) continue
    result += transform(template.slice(cursor, match.index), literalIndex)
    result += match[0]
    literalIndex += 1
    cursor = match.index + match[0].length
  }
  result += transform(template.slice(cursor), literalIndex)
  return result
}

function applyNoise(template: string, profile: NoiseProfile, key: string): string {
  if (profile === 'clean') return template
  if (profile === 'typo') {
    return transformOutsideMarkers(template, (literal, index) =>
      mutateLiteralTypo(literal, `${key}:${index}`)
    )
  }
  if (profile === 'extra-space') {
    let changed = false
    return transformOutsideMarkers(template, (literal) => {
      if (changed) return literal
      const next = literal.replace(/\s+/u, '   ')
      changed = next !== literal
      return next
    })
  }
  if (profile === 'asr') {
    return transformOutsideMarkers(template, (literal) =>
      literal
        .replace(/[,:;!?]/gu, '')
        .replace(/\bgoing to\b/giu, 'gonna')
        .replace(/\bwant to\b/giu, 'wanna')
    )
  }
  return transformOutsideMarkers(template, (literal) => literal.replace(/[,:;.!?]/gu, ''))
}

function noiseFor(split: Split, index: number): NoiseProfile {
  const profiles: Record<Split, readonly NoiseProfile[]> = {
    train: ['clean', 'clean', 'clean', 'clean', 'typo', 'extra-space'],
    development: ['clean', 'clean', 'clean', 'clean', 'asr', 'punctuation'],
    challenge: ['clean', 'clean', 'clean', 'typo', 'asr', 'extra-space']
  }
  const values = profiles[split]
  return values[index % values.length] ?? 'clean'
}

function actionFor(
  capabilityId: AssistantCapabilityId,
  capabilities: Map<AssistantCapabilityId, AssistantCapabilityDefinition>
): CorpusRow['actions'][number] {
  const capability = capabilities.get(capabilityId)
  if (!capability) throw new Error(`Unknown corpus capability ${capabilityId}`)
  return {
    capabilityId,
    executableNow: capability.status === 'assistant-ready',
    confirmation: capability.confirmation
  }
}

function makeRow(input: {
  split: Split
  template: string
  capabilities: readonly AssistantCapabilityId[]
  context: CorpusRow['context']
  familyId: string
  source: CorpusRow['source']
  teacherJobId: string | null
  materializationIndex: number
  capabilityDefinitions: Map<AssistantCapabilityId, AssistantCapabilityDefinition>
}): CorpusRow {
  const routeCapability = input.capabilityDefinitions.get(
    input.capabilities[0] ?? 'assistant.chat.respond'
  )
  if (!routeCapability) throw new Error('A corpus row requires at least one capability')
  const noise = noiseFor(input.split, input.materializationIndex)
  const noisyTemplate = applyNoise(
    input.template,
    noise,
    `${input.familyId}:${input.materializationIndex}`
  )
  const materialized = instantiate(noisyTemplate, `${input.familyId}:${input.materializationIndex}`)
  return {
    id: `assistant-row-${sha256Text(
      `${input.split}:${materialized.text}:${input.capabilities.join(',')}:${JSON.stringify(input.context)}`
    ).slice(0, 16)}`,
    split: input.split,
    text: materialized.text,
    route: routeFor(routeCapability),
    actions: input.capabilities.map((capabilityId) =>
      actionFor(capabilityId, input.capabilityDefinitions)
    ),
    slots: materialized.slots,
    context: input.context,
    familyId: input.familyId,
    source: input.source,
    noise,
    teacherJobId: input.teacherJobId
  }
}

async function buildDataset(
  config: CorpusConfig,
  accepted: Awaited<ReturnType<typeof curateTemplates>>['accepted'],
  evaluation: FrozenEvaluation
): Promise<{
  files: Record<string, string>
  manifest: Record<string, unknown>
}> {
  const capabilities = capabilityMap()
  const rows: CorpusRow[] = []
  for (const template of accepted.templates) {
    for (let index = 0; index < config.materializationsPerTemplate; index += 1) {
      rows.push(
        makeRow({
          split: template.split,
          template: template.template,
          capabilities: [template.capabilityId],
          context: null,
          familyId: template.familyId,
          source: template.source,
          teacherJobId: template.teacherJobId,
          materializationIndex: index,
          capabilityDefinitions: capabilities
        })
      )
    }
  }
  for (const program of COMPOUND_PROGRAMS) {
    for (let index = 0; index < config.materializationsPerTemplate; index += 1) {
      rows.push(
        makeRow({
          split: program.split,
          template: program.template,
          capabilities: program.capabilities,
          context: null,
          familyId: `compound:${program.id}`,
          source: 'project-composition',
          teacherJobId: null,
          materializationIndex: index,
          capabilityDefinitions: capabilities
        })
      )
    }
  }
  for (const program of DIALOGUE_PROGRAMS) {
    for (let index = 0; index < config.materializationsPerTemplate; index += 1) {
      rows.push(
        makeRow({
          split: program.split,
          template: program.template,
          capabilities: [program.capabilityId],
          context: program.context,
          familyId: `dialogue:${program.id}`,
          source: 'project-dialogue',
          teacherJobId: null,
          materializationIndex: index,
          capabilityDefinitions: capabilities
        })
      )
    }
  }
  for (const program of HARD_NEGATIVE_PROGRAMS) {
    for (let index = 0; index < config.materializationsPerTemplate; index += 1) {
      rows.push(
        makeRow({
          split: program.split,
          template: program.text,
          capabilities: ['assistant.chat.respond'],
          context: null,
          familyId: `hard-negative:${program.id}`,
          source: 'project-hard-negative',
          teacherJobId: null,
          materializationIndex: index,
          capabilityDefinitions: capabilities
        })
      )
    }
  }

  const generatedMaterializations = rows.length
  const uniqueRows = new Map(rows.map((row) => [row.id, row]))
  rows.splice(0, rows.length, ...uniqueRows.values())
  const deduplicatedMaterializations = generatedMaterializations - rows.length
  const rowIds = new Set<string>()
  const familySplits = new Map<string, Split>()
  for (const row of rows) {
    if (rowIds.has(row.id)) throw new Error(`Duplicate assistant corpus row ID ${row.id}`)
    rowIds.add(row.id)
    const existingSplit = familySplits.get(row.familyId)
    if (existingSplit && existingSplit !== row.split) {
      throw new Error(`Template family ${row.familyId} leaked across splits`)
    }
    familySplits.set(row.familyId, row.split)
    for (const slot of row.slots) {
      if (row.text.slice(slot.start, slot.end) !== slot.value) {
        throw new Error(`Slot span drift in ${row.id}`)
      }
    }
    const collision = evaluationCollision(
      row.text,
      evaluation.texts,
      config.evaluationSimilarityThreshold
    )
    if (collision)
      throw new Error(`Corpus row ${row.id} collides with frozen evaluation (${collision})`)
  }

  const files: Record<string, string> = {}
  for (const split of ['train', 'development', 'challenge'] as const) {
    const values = rows.filter((row) => row.split === split)
    files[resolve(DATA_DIRECTORY, `${split}.jsonl`)] = `${values
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  }
  const countsBySplit = Object.fromEntries(
    (['train', 'development', 'challenge'] as const).map((split) => [
      split,
      rows.filter((row) => row.split === split).length
    ])
  )
  const countsBySource = Object.fromEntries(
    [
      'project-seed',
      'qwen-paraphrase',
      'project-composition',
      'project-dialogue',
      'project-hard-negative'
    ].map((source) => [source, rows.filter((row) => row.source === source).length])
  )
  const countsByNoise = Object.fromEntries(
    (['clean', 'typo', 'extra-space', 'asr', 'punctuation'] as const).map((noise) => [
      noise,
      rows.filter((row) => row.noise === noise).length
    ])
  )
  const coverageBySplit = Object.fromEntries(
    (['train', 'development', 'challenge'] as const).map((split) => [
      split,
      new Set(
        rows
          .filter((row) => row.split === split)
          .flatMap((row) => row.actions.map((action) => action.capabilityId))
      ).size
    ])
  )
  const datasetDigests = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path.slice(WORKSPACE.length + 1).replaceAll('\\', '/'),
      { rows: text.trim().split(/\r?\n/u).filter(Boolean).length, sha256: sha256Text(text) }
    ])
  )
  const manifest = {
    schemaVersion: 1,
    corpusVersion: config.corpusVersion,
    generator: 'scripts/build-assistant-corpus.ts curate',
    seed: config.seed,
    registrySha256: registryDigest(),
    acceptedTemplatesPath: 'ml/assistant_corpus/accepted/templates.json',
    acceptedTemplatesSha256: sha256Text(stableStringify(accepted)),
    rows: rows.length,
    generatedMaterializations,
    deduplicatedMaterializations,
    countsBySplit,
    countsBySource,
    countsByNoise,
    coverageBySplit,
    multiActionRows: rows.filter((row) => row.actions.length > 1).length,
    contextualRows: rows.filter((row) => row.context !== null).length,
    maximumActions: Math.max(...rows.map((row) => row.actions.length)),
    familySplitOverlap: 0,
    evaluation: {
      path: config.frozenEvaluationSuite,
      sha256: evaluation.suiteSha256,
      acceptedExactOrNearDuplicates: 0,
      humanBlindExamplesUsed: 0
    },
    provenance: {
      projectLabels: true,
      projectSlotValues: true,
      teacherUsed: true,
      teacherModelId: config.teacherModelId,
      teacherSha256: config.teacherSha256,
      teacherAuthoredLabels: 0,
      teacherAuthoredSlotValues: 0,
      pretrainedWeightsUsed: false,
      personalDataUsed: false
    },
    files: datasetDigests
  }
  files[MANIFEST_PATH] = stableStringify(manifest)
  return { files, manifest }
}

async function writeCuratedArtifacts(config: CorpusConfig): Promise<Record<string, unknown>> {
  const curated = await curateTemplates(config)
  const dataset = await buildDataset(config, curated.accepted, curated.evaluation)
  await writeOutput(ACCEPTED_PATH, stableStringify(curated.accepted))
  await writeOutput(REPORT_PATH, stableStringify(curated.report))
  for (const [path, value] of Object.entries(dataset.files)) await writeOutput(path, value)
  return dataset.manifest
}

async function assertFileEquals(path: string, expected: string): Promise<void> {
  const actual = await readFile(path, 'utf8')
  if (actual !== expected) {
    throw new Error(`${path.slice(WORKSPACE.length + 1)} is not the deterministic Phase 4 output`)
  }
}

async function checkArtifacts(config: CorpusConfig): Promise<Record<string, unknown>> {
  const prepared = buildTeacherJobs(config)
  await assertFileEquals(JOBS_PATH, stableStringify(prepared))
  const curated = await curateTemplates(config)
  const dataset = await buildDataset(config, curated.accepted, curated.evaluation)
  await assertFileEquals(ACCEPTED_PATH, stableStringify(curated.accepted))
  await assertFileEquals(REPORT_PATH, stableStringify(curated.report))
  for (const [path, value] of Object.entries(dataset.files)) await assertFileEquals(path, value)
  return dataset.manifest
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'check'
  const config = await readJson<CorpusConfig>(CONFIG_PATH)
  if (command === 'prepare') {
    const prepared = buildTeacherJobs(config)
    await writeOutput(JOBS_PATH, stableStringify(prepared))
    process.stdout.write(
      `Prepared ${prepared.jobs.length} selective Qwen paraphrase jobs across 42 direct capabilities.\n`
    )
    return
  }
  if (command === 'prepare-repairs') {
    const prepared = buildTeacherJobs(config)
    const curated = await curateTemplates(config, false)
    const acceptedJobIds = new Set(
      curated.accepted.templates
        .filter((template) => template.source === 'qwen-paraphrase')
        .map((template) => template.teacherJobId)
        .filter((value): value is string => value !== null)
    )
    const repairJobs = prepared.jobs.filter((job) => !acceptedJobIds.has(job.id))
    const payload = {
      ...prepared,
      generator: 'scripts/build-assistant-corpus.ts prepare-repairs',
      parentJobsSha256: await sha256File(JOBS_PATH),
      repairRound: 1,
      jobs: repairJobs
    }
    await writeOutput(REPAIR_JOBS_PATH, stableStringify(payload))
    process.stdout.write(
      `Prepared ${repairJobs.length} isolated curation-repair jobs after ${acceptedJobIds.size} capabilities cleared the first pass.\n`
    )
    return
  }
  if (command === 'curate' || command === 'all') {
    if (command === 'all') {
      await writeOutput(JOBS_PATH, stableStringify(buildTeacherJobs(config)))
    }
    const manifest = await writeCuratedArtifacts(config)
    process.stdout.write(
      `Curated ${String(manifest.rows)} AssistantPlan training rows with zero accepted evaluation collisions.\n`
    )
    return
  }
  if (command === 'check') {
    const manifest = await checkArtifacts(config)
    process.stdout.write(
      `Assistant corpus checks passed (${String(manifest.rows)} rows; 42 direct capabilities).\n`
    )
    return
  }
  throw new Error(`Unknown assistant corpus command: ${command}`)
}

await main()
