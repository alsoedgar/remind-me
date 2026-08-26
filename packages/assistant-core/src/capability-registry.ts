import {
  assistantCapabilityIdSchema,
  assistantPlanSchema,
  type AssistantCapabilityId,
  type AssistantPlan
} from '@remind-me/contracts'

export type AssistantCapabilityStatus = 'assistant-ready' | 'conditional' | 'app-ready' | 'planned'

export type AssistantCapabilityHandler =
  'calendar-ir' | 'assistant-service' | 'document-import' | 'renderer' | 'main-process' | 'none'

type AssistantArgumentKind = AssistantPlan['actions'][number]['arguments']['kind']
type AssistantTargetKind = AssistantPlan['actions'][number]['target']['kind']

export interface AssistantCapabilityDefinition {
  id: AssistantCapabilityId
  domain: 'calendar' | 'reminder' | 'conversation' | 'memory' | 'document' | 'app' | 'model'
  title: string
  description: string
  status: AssistantCapabilityStatus
  handler: AssistantCapabilityHandler
  argumentKind: AssistantArgumentKind
  targetKind: AssistantTargetKind
  confirmation: 'never' | 'preview' | 'always'
  supportsMultiAction: boolean
  requiresOptionalModel: boolean
  aliases: readonly string[]
}

type CapabilityInput = Omit<AssistantCapabilityDefinition, 'id'>

function definition(
  id: AssistantCapabilityId,
  input: CapabilityInput
): AssistantCapabilityDefinition {
  return Object.freeze({ id, ...input, aliases: Object.freeze([...input.aliases]) })
}

const calendarMutation = (
  title: string,
  description: string,
  confirmation: AssistantCapabilityDefinition['confirmation'] = 'preview'
): CapabilityInput => ({
  domain: 'calendar',
  title,
  description,
  status: 'assistant-ready',
  handler: 'calendar-ir',
  argumentKind: 'calendar',
  targetKind: 'calendar',
  confirmation,
  supportsMultiAction: true,
  requiresOptionalModel: false,
  aliases: []
})

const reminderMutation = (
  title: string,
  description: string,
  confirmation: AssistantCapabilityDefinition['confirmation'] = 'preview'
): CapabilityInput => ({
  ...calendarMutation(title, description, confirmation),
  domain: 'reminder'
})

const calendarQuery = (
  title: string,
  description: string,
  aliases: readonly string[] = []
): CapabilityInput => ({
  domain: 'calendar',
  title,
  description,
  status: 'assistant-ready',
  handler: 'calendar-ir',
  argumentKind: 'calendar',
  targetKind: 'calendar',
  confirmation: 'never',
  supportsMultiAction: true,
  requiresOptionalModel: false,
  aliases
})

const localConversation = (
  title: string,
  description: string,
  aliases: readonly string[] = []
): CapabilityInput => ({
  domain: 'conversation',
  title,
  description,
  status: 'assistant-ready',
  handler: 'assistant-service',
  argumentKind: 'conversation',
  targetKind: 'none',
  confirmation: 'never',
  supportsMultiAction: false,
  requiresOptionalModel: false,
  aliases
})

const memoryCapability = (title: string, description: string): CapabilityInput => ({
  domain: 'memory',
  title,
  description,
  status: 'assistant-ready',
  handler: 'assistant-service',
  argumentKind: 'memory',
  targetKind: 'none',
  confirmation: 'never',
  supportsMultiAction: false,
  requiresOptionalModel: false,
  aliases: []
})

const registryRecord: Record<AssistantCapabilityId, AssistantCapabilityDefinition> = {
  'calendar.event.create': definition(
    'calendar.event.create',
    calendarMutation('Create event', 'Create one reviewed event from grounded user fields.')
  ),
  'calendar.event.duplicate': definition(
    'calendar.event.duplicate',
    calendarMutation('Duplicate event', 'Copy an existing event to another date or recurrence.')
  ),
  'calendar.event.update': definition(
    'calendar.event.update',
    calendarMutation('Update event', 'Rename or update event details and recurrence.')
  ),
  'calendar.event.move': definition(
    'calendar.event.move',
    calendarMutation('Move event', 'Move an event while retaining its validated duration.')
  ),
  'calendar.event.delete': definition(
    'calendar.event.delete',
    calendarMutation('Delete event', 'Delete a selected event after explicit review.', 'always')
  ),
  'calendar.reminder.create': definition(
    'calendar.reminder.create',
    reminderMutation('Create reminder', 'Create one reviewed reminder.')
  ),
  'calendar.reminder.update': definition(
    'calendar.reminder.update',
    reminderMutation('Update reminder', 'Update reminder text, time, or recurrence.')
  ),
  'calendar.reminder.complete': definition(
    'calendar.reminder.complete',
    reminderMutation('Complete reminder', 'Complete a selected reminder.')
  ),
  'calendar.reminder.delete': definition(
    'calendar.reminder.delete',
    reminderMutation(
      'Delete reminder',
      'Delete a selected reminder after explicit review.',
      'always'
    )
  ),
  'calendar.query.list': definition(
    'calendar.query.list',
    calendarQuery('List schedule', 'List grounded event and reminder names for a time range.', [
      'what do I have',
      'agenda'
    ])
  ),
  'calendar.query.search': definition(
    'calendar.query.search',
    calendarQuery('Search schedule', 'Search local titles, locations, and details.', [
      'find',
      'where'
    ])
  ),
  'calendar.query.availability': definition(
    'calendar.query.availability',
    calendarQuery('Check availability', 'Answer whether a grounded time window is free.', [
      'am I free',
      'open time'
    ])
  ),
  'calendar.query.conflicts': definition(
    'calendar.query.conflicts',
    calendarQuery('Check conflicts', 'Find overlapping local event occurrences.', [
      'overlap',
      'double booked'
    ])
  ),
  'calendar.query.next': definition('calendar.query.next', {
    ...calendarQuery('Next item', 'Return the next relevant event or reminder briefly.', [
      'next event',
      'what is next'
    ]),
    handler: 'assistant-service',
    argumentKind: 'query'
  }),
  'calendar.query.details': definition('calendar.query.details', {
    ...calendarQuery('Item details', 'Return requested details for a focused calendar item.'),
    handler: 'assistant-service',
    argumentKind: 'query'
  }),
  'calendar.query.summary': definition('calendar.query.summary', {
    ...calendarQuery(
      'Schedule summary',
      'Summarize a grounded day or range at the requested detail level.'
    ),
    handler: 'assistant-service',
    argumentKind: 'query'
  }),
  'calendar.schedule.copy-day': definition('calendar.schedule.copy-day', {
    ...calendarMutation(
      'Copy day schedule',
      'Copy every event from one day into reviewed weekday recurrences.'
    ),
    handler: 'assistant-service'
  }),
  'calendar.schedule.clear': definition('calendar.schedule.clear', {
    ...calendarMutation(
      'Clear schedule',
      'Capture exact event or reminder IDs for one undoable destructive review.',
      'always'
    ),
    handler: 'assistant-service',
    targetKind: 'calendar-bulk'
  }),
  'calendar.import.propose': definition('calendar.import.propose', {
    ...calendarMutation(
      'Propose imported item',
      'Represent one source-grounded document proposal before the import review.',
      'always'
    ),
    domain: 'document',
    handler: 'document-import'
  }),
  'calendar.import.document': definition('calendar.import.document', {
    domain: 'document',
    title: 'Import document',
    description: 'Extract reviewed proposals from a local PDF or image.',
    status: 'app-ready',
    handler: 'document-import',
    argumentKind: 'import',
    targetKind: 'none',
    confirmation: 'always',
    supportsMultiAction: true,
    requiresOptionalModel: false,
    aliases: ['import PDF', 'scan schedule']
  }),
  'calendar.import.file': definition('calendar.import.file', {
    domain: 'calendar',
    title: 'Import calendar file',
    description: 'Import a reviewed local ICS or backup file.',
    status: 'app-ready',
    handler: 'main-process',
    argumentKind: 'import',
    targetKind: 'none',
    confirmation: 'always',
    supportsMultiAction: true,
    requiresOptionalModel: false,
    aliases: ['import ICS']
  }),
  'calendar.export.file': definition('calendar.export.file', {
    domain: 'calendar',
    title: 'Export calendar',
    description: 'Export local data through the existing save dialog.',
    status: 'app-ready',
    handler: 'main-process',
    argumentKind: 'import',
    targetKind: 'none',
    confirmation: 'never',
    supportsMultiAction: false,
    requiresOptionalModel: false,
    aliases: ['export calendar', 'backup']
  }),
  'assistant.chat.respond': definition('assistant.chat.respond', {
    domain: 'conversation',
    title: 'Broad local conversation',
    description: 'Answer broader dialogue through the optional local language pack.',
    status: 'conditional',
    handler: 'assistant-service',
    argumentKind: 'conversation',
    targetKind: 'none',
    confirmation: 'never',
    supportsMultiAction: false,
    requiresOptionalModel: true,
    aliases: ['general question', 'chat']
  }),
  'assistant.help': definition(
    'assistant.help',
    localConversation('Help', 'Explain available capabilities and example requests.', [
      'what can you do'
    ])
  ),
  'assistant.identity': definition(
    'assistant.identity',
    localConversation('Identity', 'Explain what Remind Me is.', ['who are you'])
  ),
  'assistant.architecture': definition(
    'assistant.architecture',
    localConversation(
      'Architecture',
      'Explain the original models, fallback, validation, and privacy.',
      ['how do you work', 'what models']
    )
  ),
  'assistant.local-time': definition(
    'assistant.local-time',
    localConversation('Local time', 'Answer the current local date and time from device settings.')
  ),
  'assistant.wellbeing': definition(
    'assistant.wellbeing',
    localConversation('Wellbeing', 'Handle a short wellbeing turn naturally.')
  ),
  'assistant.thanks': definition(
    'assistant.thanks',
    localConversation('Thanks', 'Acknowledge thanks without repeating help text.')
  ),
  'assistant.goodbye': definition(
    'assistant.goodbye',
    localConversation('Goodbye', 'Close a conversational turn briefly.')
  ),
  'assistant.memory.set-name': definition(
    'assistant.memory.set-name',
    memoryCapability('Remember name', 'Store an approved preferred name locally.')
  ),
  'assistant.memory.remember': definition(
    'assistant.memory.remember',
    memoryCapability('Remember preference', 'Store one explicit user-approved memory locally.')
  ),
  'assistant.memory.recall': definition(
    'assistant.memory.recall',
    memoryCapability('Recall memory', 'List approved local memories.')
  ),
  'assistant.memory.forget': definition(
    'assistant.memory.forget',
    memoryCapability('Forget memory', 'Remove one matching local memory.')
  ),
  'assistant.memory.forget-all': definition(
    'assistant.memory.forget-all',
    memoryCapability('Forget all memories', 'Remove all approved local memories.')
  ),
  'assistant.clarify': definition('assistant.clarify', {
    ...calendarMutation('Clarify request', 'Ask for a missing or ambiguous calendar fact.'),
    domain: 'conversation',
    confirmation: 'never',
    supportsMultiAction: false
  }),
  'assistant.reject': definition('assistant.reject', {
    ...calendarMutation(
      'Reject unsafe plan',
      'Stop a request that fails deterministic validation.'
    ),
    domain: 'conversation',
    confirmation: 'never',
    supportsMultiAction: false
  }),
  'assistant.unsupported': definition('assistant.unsupported', {
    ...calendarMutation('Unsupported request', 'Explain a truthful local capability boundary.'),
    domain: 'conversation',
    confirmation: 'never',
    supportsMultiAction: false
  }),
  'app.navigation.open': definition('app.navigation.open', {
    domain: 'app',
    title: 'Open view',
    description: 'Navigate to an existing app view.',
    status: 'app-ready',
    handler: 'renderer',
    argumentKind: 'navigation',
    targetKind: 'view',
    confirmation: 'never',
    supportsMultiAction: true,
    requiresOptionalModel: false,
    aliases: ['show calendar', 'open settings']
  }),
  'app.appearance.update': definition('app.appearance.update', {
    domain: 'app',
    title: 'Update appearance',
    description: 'Change existing local theme and density preferences.',
    status: 'app-ready',
    handler: 'renderer',
    argumentKind: 'appearance',
    targetKind: 'setting',
    confirmation: 'preview',
    supportsMultiAction: true,
    requiresOptionalModel: false,
    aliases: ['change color', 'liquid theme']
  }),
  'app.window.set-mode': definition('app.window.set-mode', {
    domain: 'app',
    title: 'Set window mode',
    description: 'Switch among full, widget, and glance window modes.',
    status: 'app-ready',
    handler: 'main-process',
    argumentKind: 'window',
    targetKind: 'setting',
    confirmation: 'never',
    supportsMultiAction: true,
    requiresOptionalModel: false,
    aliases: ['mini view', 'widget', 'glance']
  }),
  'app.window.set-pinned': definition('app.window.set-pinned', {
    domain: 'app',
    title: 'Pin window',
    description: 'Toggle the existing always-on-top window behavior.',
    status: 'app-ready',
    handler: 'main-process',
    argumentKind: 'window',
    targetKind: 'setting',
    confirmation: 'never',
    supportsMultiAction: true,
    requiresOptionalModel: false,
    aliases: ['keep on top', 'unpin']
  }),
  'app.startup.configure': definition('app.startup.configure', {
    domain: 'app',
    title: 'Configure startup',
    description: 'Configure launch-at-login and the startup window mode.',
    status: 'app-ready',
    handler: 'main-process',
    argumentKind: 'startup',
    targetKind: 'setting',
    confirmation: 'preview',
    supportsMultiAction: false,
    requiresOptionalModel: false,
    aliases: ['start with computer', 'launch at login']
  }),
  'app.model.install': definition('app.model.install', {
    domain: 'model',
    title: 'Install language pack',
    description: 'Open the existing verified optional-model installation flow.',
    status: 'app-ready',
    handler: 'main-process',
    argumentKind: 'model',
    targetKind: 'model',
    confirmation: 'always',
    supportsMultiAction: false,
    requiresOptionalModel: false,
    aliases: ['install fallback']
  }),
  'app.model.enable': definition('app.model.enable', {
    domain: 'model',
    title: 'Enable language pack',
    description: 'Enable or disable an installed optional local model.',
    status: 'app-ready',
    handler: 'main-process',
    argumentKind: 'model',
    targetKind: 'model',
    confirmation: 'preview',
    supportsMultiAction: false,
    requiresOptionalModel: true,
    aliases: ['enable fallback', 'disable fallback']
  }),
  'app.model.remove': definition('app.model.remove', {
    domain: 'model',
    title: 'Remove language pack',
    description: 'Remove the optional model only through its explicit settings flow.',
    status: 'app-ready',
    handler: 'main-process',
    argumentKind: 'model',
    targetKind: 'model',
    confirmation: 'always',
    supportsMultiAction: false,
    requiresOptionalModel: true,
    aliases: ['uninstall fallback']
  })
}

export const assistantCapabilityRegistry: readonly AssistantCapabilityDefinition[] = Object.freeze(
  assistantCapabilityIdSchema.options.map((id) => registryRecord[id])
)

export interface AssistantCapabilityIssue {
  actionId: string
  capabilityId: AssistantCapabilityId
  code: 'argument-kind' | 'target-kind' | 'not-assistant-ready' | 'multi-action' | 'review-policy'
  message: string
}

export function getAssistantCapability(
  capabilityId: AssistantCapabilityId
): AssistantCapabilityDefinition {
  return registryRecord[capabilityId]
}

export function listAssistantCapabilities(
  input: {
    status?: AssistantCapabilityStatus
    domain?: AssistantCapabilityDefinition['domain']
  } = {}
): readonly AssistantCapabilityDefinition[] {
  return assistantCapabilityRegistry.filter(
    (capability) =>
      (!input.status || capability.status === input.status) &&
      (!input.domain || capability.domain === input.domain)
  )
}

export function validateAssistantPlanCapabilities(
  inputPlan: AssistantPlan,
  options: { requireAssistantReady?: boolean } = {}
): AssistantCapabilityIssue[] {
  const plan = assistantPlanSchema.parse(inputPlan)
  const issues: AssistantCapabilityIssue[] = []
  for (const action of plan.actions) {
    const capability = getAssistantCapability(action.capabilityId)
    if (action.arguments.kind !== capability.argumentKind) {
      issues.push({
        actionId: action.id,
        capabilityId: action.capabilityId,
        code: 'argument-kind',
        message: `${action.capabilityId} requires ${capability.argumentKind} arguments`
      })
    }
    if (action.target.kind !== capability.targetKind) {
      issues.push({
        actionId: action.id,
        capabilityId: action.capabilityId,
        code: 'target-kind',
        message: `${action.capabilityId} requires a ${capability.targetKind} target`
      })
    }
    if (options.requireAssistantReady && capability.status !== 'assistant-ready') {
      issues.push({
        actionId: action.id,
        capabilityId: action.capabilityId,
        code: 'not-assistant-ready',
        message: `${action.capabilityId} is ${capability.status}, not assistant-ready`
      })
    }
    if (plan.actions.length > 1 && !capability.supportsMultiAction) {
      issues.push({
        actionId: action.id,
        capabilityId: action.capabilityId,
        code: 'multi-action',
        message: `${action.capabilityId} cannot be combined with another action yet`
      })
    }
    const reviewIsSafe =
      capability.confirmation === 'never' ||
      (capability.confirmation === 'preview' && action.review !== 'none') ||
      (capability.confirmation === 'always' && action.review === 'explicit-confirmation')
    if (!reviewIsSafe) {
      issues.push({
        actionId: action.id,
        capabilityId: action.capabilityId,
        code: 'review-policy',
        message: `${action.capabilityId} requires ${capability.confirmation} review policy`
      })
    }
  }
  return issues
}

export function assertAssistantPlanExecutable(plan: AssistantPlan): void {
  const issues = validateAssistantPlanCapabilities(plan, { requireAssistantReady: true })
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('; '))
}
