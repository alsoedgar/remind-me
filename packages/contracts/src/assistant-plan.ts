import { z } from 'zod'
import {
  actionScopeSchema,
  ambiguitySchema,
  calendarIRFieldsSchema,
  calendarSelectionSchema,
  evidenceSchema,
  referenceSchema,
  riskLevelSchema,
  sourcedTextSchema,
  sourcedTemporalWindowSchema
} from './calendar-ir'
import { identifierSchema } from './common'
import { documentSourceKindSchema } from './document-api'
import { recurrenceRuleSchema } from './recurrence'
import { appWindowModeSchema } from './window-api'

export const assistantPlanVersionSchema = z.literal('2')

export const assistantCapabilityIdSchema = z.enum([
  'calendar.event.create',
  'calendar.event.duplicate',
  'calendar.event.update',
  'calendar.event.move',
  'calendar.event.delete',
  'calendar.reminder.create',
  'calendar.reminder.update',
  'calendar.reminder.complete',
  'calendar.reminder.delete',
  'calendar.query.list',
  'calendar.query.search',
  'calendar.query.availability',
  'calendar.query.conflicts',
  'calendar.query.next',
  'calendar.query.details',
  'calendar.query.summary',
  'calendar.schedule.copy-day',
  'calendar.schedule.clear',
  'calendar.import.propose',
  'calendar.import.document',
  'calendar.import.file',
  'calendar.export.file',
  'assistant.chat.respond',
  'assistant.help',
  'assistant.identity',
  'assistant.architecture',
  'assistant.local-time',
  'assistant.wellbeing',
  'assistant.thanks',
  'assistant.goodbye',
  'assistant.memory.set-name',
  'assistant.memory.remember',
  'assistant.memory.recall',
  'assistant.memory.forget',
  'assistant.memory.forget-all',
  'assistant.clarify',
  'assistant.reject',
  'assistant.unsupported',
  'app.navigation.open',
  'app.appearance.update',
  'app.window.set-mode',
  'app.window.set-pinned',
  'app.startup.configure',
  'app.model.install',
  'app.model.enable',
  'app.model.remove'
])

export const assistantPlannerSourceSchema = z.enum([
  'deterministic',
  'remindcore',
  'qwen-fallback',
  'planscan',
  'dialogue',
  'hybrid'
])

export const assistantResponseGoalSchema = z
  .object({
    mode: z.enum(['answer', 'preview', 'receipt', 'clarification', 'conversation', 'unsupported']),
    detail: z.enum(['brief', 'standard', 'detailed']),
    include: z
      .array(
        z.enum([
          'title',
          'date',
          'time',
          'location',
          'description',
          'recurrence',
          'status',
          'availability',
          'conflicts',
          'count'
        ])
      )
      .max(10),
    maxItems: z.number().int().positive().max(100),
    maxWords: z.number().int().positive().max(2_000)
  })
  .strict()

export const assistantPlanTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('calendar'),
      selection: calendarSelectionSchema.nullable(),
      references: z.array(referenceSchema).max(20)
    })
    .strict(),
  z
    .object({
      kind: z.literal('calendar-bulk'),
      scope: z.enum(['events', 'reminders', 'both']),
      eventIds: z.array(identifierSchema).max(50_000),
      reminderIds: z.array(identifierSchema).max(50_000)
    })
    .strict()
    .superRefine((target, context) => {
      if (target.eventIds.length === 0 && target.reminderIds.length === 0) {
        context.addIssue({ code: 'custom', message: 'A bulk target requires at least one item' })
      }
      if (
        new Set(target.eventIds).size !== target.eventIds.length ||
        new Set(target.reminderIds).size !== target.reminderIds.length
      ) {
        context.addIssue({ code: 'custom', message: 'Bulk target IDs must be unique' })
      }
      if (target.scope === 'events' && target.reminderIds.length > 0) {
        context.addIssue({ code: 'custom', message: 'An events target cannot include reminders' })
      }
      if (target.scope === 'reminders' && target.eventIds.length > 0) {
        context.addIssue({ code: 'custom', message: 'A reminders target cannot include events' })
      }
    }),
  z
    .object({
      kind: z.literal('view'),
      view: z.enum(['today', 'calendar', 'reminders', 'settings', 'assistant', 'import'])
    })
    .strict(),
  z.object({ kind: z.literal('setting'), key: identifierSchema }).strict(),
  z.object({ kind: z.literal('model'), modelId: identifierSchema }).strict()
])

const themeColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/u)

export const assistantPlanArgumentsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('calendar'),
      fields: calendarIRFieldsSchema,
      recurrence: recurrenceRuleSchema.nullable(),
      ambiguities: z.array(ambiguitySchema).max(20)
    })
    .strict(),
  z
    .object({
      kind: z.literal('query'),
      query: sourcedTextSchema.nullable(),
      when: sourcedTemporalWindowSchema.nullable(),
      detail: z.enum(['brief', 'standard', 'detailed'])
    })
    .strict(),
  z
    .object({
      kind: z.literal('conversation'),
      intent: z.string().trim().min(1).max(100),
      message: sourcedTextSchema.nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal('navigation'),
      view: z.enum(['today', 'calendar', 'reminders', 'settings', 'assistant', 'import'])
    })
    .strict(),
  z
    .object({
      kind: z.literal('appearance'),
      accentColor: themeColorSchema.optional(),
      backgroundColor: themeColorSchema.optional(),
      surfaceColor: themeColorSchema.optional(),
      cardColor: themeColorSchema.optional(),
      textColor: themeColorSchema.optional(),
      surfaceStyle: z.enum(['paper', 'frosted', 'liquid']).optional(),
      density: z.enum(['comfortable', 'compact']).optional()
    })
    .strict()
    .refine((value) => Object.keys(value).length > 1, 'Appearance updates require a value'),
  z
    .object({
      kind: z.literal('window'),
      mode: appWindowModeSchema.optional(),
      pinned: z.boolean().optional()
    })
    .strict()
    .refine(
      (value) => value.mode !== undefined || value.pinned !== undefined,
      'Window updates require a mode or pinned state'
    ),
  z
    .object({
      kind: z.literal('startup'),
      enabled: z.boolean(),
      mode: appWindowModeSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('memory'),
      value: sourcedTextSchema.nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal('model'),
      modelId: identifierSchema,
      enabled: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('import'),
      sourceKind: z.union([documentSourceKindSchema, z.enum(['ics', 'json', 'unknown'])])
    })
    .strict()
])

export const assistantPlanActionSchema = z
  .object({
    id: identifierSchema,
    requestId: identifierSchema,
    capabilityId: assistantCapabilityIdSchema,
    target: assistantPlanTargetSchema,
    arguments: assistantPlanArgumentsSchema,
    scope: actionScopeSchema,
    dependsOn: z.array(identifierSchema).max(50),
    evidenceIds: z.array(identifierSchema).min(1).max(100),
    confidence: z.number().min(0).max(1),
    risk: riskLevelSchema,
    review: z.enum(['none', 'preview', 'explicit-confirmation'])
  })
  .strict()

export const assistantPlanSchema = z
  .object({
    version: assistantPlanVersionSchema,
    requestId: identifierSchema,
    sourceText: z.string().min(1).max(50_000),
    plannerSource: assistantPlannerSourceSchema,
    status: z.enum(['ready', 'clarification', 'unsupported']),
    actions: z.array(assistantPlanActionSchema).min(1).max(50),
    responseGoal: assistantResponseGoalSchema,
    evidence: z.array(evidenceSchema).min(1).max(100),
    confidence: z.number().min(0).max(1)
  })
  .strict()
  .superRefine((plan, context) => {
    const actionIds = plan.actions.map((action) => action.id)
    if (new Set(actionIds).size !== actionIds.length) {
      context.addIssue({ code: 'custom', message: 'Assistant plan action IDs must be unique' })
    }
    const evidenceIds = plan.evidence.map((evidence) => evidence.id)
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      context.addIssue({ code: 'custom', message: 'Assistant plan evidence IDs must be unique' })
    }
    const knownEvidence = new Set(evidenceIds)
    for (const [index, action] of plan.actions.entries()) {
      if (new Set(action.evidenceIds).size !== action.evidenceIds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Action evidence references must be unique',
          path: ['actions', index, 'evidenceIds']
        })
      }
      if (new Set(action.dependsOn).size !== action.dependsOn.length) {
        context.addIssue({
          code: 'custom',
          message: 'Action dependencies must be unique',
          path: ['actions', index, 'dependsOn']
        })
      }
      for (const evidenceId of action.evidenceIds) {
        if (!knownEvidence.has(evidenceId)) {
          context.addIssue({
            code: 'custom',
            message: `Action references unknown evidence ${evidenceId}`,
            path: ['actions', index, 'evidenceIds']
          })
        }
      }
      const previousIds = new Set(actionIds.slice(0, index))
      for (const dependencyId of action.dependsOn) {
        if (!previousIds.has(dependencyId)) {
          context.addIssue({
            code: 'custom',
            message: 'Dependencies must reference an earlier action in the same plan',
            path: ['actions', index, 'dependsOn']
          })
        }
      }
    }
    if (new Set(plan.responseGoal.include).size !== plan.responseGoal.include.length) {
      context.addIssue({
        code: 'custom',
        message: 'Response fact classes must be unique',
        path: ['responseGoal', 'include']
      })
    }
    for (const [index, evidence] of plan.evidence.entries()) {
      if (
        (evidence.sourceKind === 'text' || evidence.sourceKind === 'voice') &&
        evidence.sourceId === null &&
        evidence.sourceSpan &&
        plan.sourceText.slice(evidence.sourceSpan.start, evidence.sourceSpan.end) !== evidence.text
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Text evidence must be an exact slice of the plan source',
          path: ['evidence', index, 'sourceSpan']
        })
      }
    }
    if (
      plan.status === 'clarification' &&
      !plan.actions.some((action) => action.capabilityId === 'assistant.clarify')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A clarification plan requires an assistant.clarify action',
        path: ['status']
      })
    }
    if (
      plan.status === 'unsupported' &&
      !plan.actions.some((action) => action.capabilityId === 'assistant.unsupported')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An unsupported plan requires an assistant.unsupported action',
        path: ['status']
      })
    }
    const containsUnsupported = plan.actions.some(
      (action) => action.capabilityId === 'assistant.unsupported'
    )
    const containsClarification = plan.actions.some(
      (action) => action.capabilityId === 'assistant.clarify'
    )
    if (containsUnsupported && plan.status !== 'unsupported') {
      context.addIssue({
        code: 'custom',
        message: 'A plan containing assistant.unsupported must use unsupported status',
        path: ['status']
      })
    }
    if (!containsUnsupported && containsClarification && plan.status !== 'clarification') {
      context.addIssue({
        code: 'custom',
        message: 'A plan containing assistant.clarify must use clarification status',
        path: ['status']
      })
    }
  })

export type AssistantCapabilityId = z.infer<typeof assistantCapabilityIdSchema>
export type AssistantPlannerSource = z.infer<typeof assistantPlannerSourceSchema>
export type AssistantResponseGoal = z.infer<typeof assistantResponseGoalSchema>
export type AssistantPlanTarget = z.infer<typeof assistantPlanTargetSchema>
export type AssistantPlanArguments = z.infer<typeof assistantPlanArgumentsSchema>
export type AssistantPlanAction = z.infer<typeof assistantPlanActionSchema>
export type AssistantPlan = z.infer<typeof assistantPlanSchema>
