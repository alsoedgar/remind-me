import { z } from 'zod'
import {
  identifierSchema,
  ianaTimeZoneSchema,
  isoInstantSchema,
  localeSchema,
  localDateSchema
} from './common'
import { calendarOperationSchema, riskLevelSchema } from './calendar-ir'
import { recurrenceRuleSchema, weekdaySchema } from './recurrence'
import { documentImportIdentitySchema } from './document-identity'
import { responseSpeechActSchema, responseStyleSchema } from './response-plan'

export const calendarEntitySchema = z
  .object({
    id: identifierSchema,
    name: z.string().min(1).max(200),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    timezone: ianaTimeZoneSchema,
    isDefault: z.boolean(),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema
  })
  .strict()

export const eventEntitySchema = z
  .object({
    id: identifierSchema,
    calendarId: identifierSchema,
    title: z.string().min(1).max(1_000),
    description: z.string().max(10_000),
    location: z.string().max(1_000),
    startUtc: isoInstantSchema,
    endUtc: isoInstantSchema,
    timezone: ianaTimeZoneSchema,
    allDay: z.boolean(),
    recurrence: recurrenceRuleSchema.nullable(),
    status: z.enum(['active', 'cancelled']),
    provenance: z.enum(['manual', 'assistant', 'import']),
    importIdentity: documentImportIdentitySchema.nullable().optional(),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (Date.parse(event.endUtc) <= Date.parse(event.startUtc)) {
      context.addIssue({
        code: 'custom',
        message: 'Event end must be after start',
        path: ['endUtc']
      })
    }
  })

export const reminderEntitySchema = z
  .object({
    id: identifierSchema,
    calendarId: identifierSchema,
    title: z.string().min(1).max(1_000),
    notes: z.string().max(10_000),
    dueAtUtc: isoInstantSchema.nullable(),
    timezone: ianaTimeZoneSchema,
    recurrence: recurrenceRuleSchema.nullable(),
    status: z.enum(['active', 'completed', 'cancelled']),
    completedAt: isoInstantSchema.nullable(),
    provenance: z.enum(['manual', 'assistant', 'import']),
    importIdentity: documentImportIdentitySchema.nullable().optional(),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema
  })
  .strict()
  .superRefine((reminder, context) => {
    if (reminder.dueAtUtc === null && reminder.recurrence !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A repeating reminder needs a due date',
        path: ['recurrence']
      })
    }
  })

export const recurrenceExceptionEntitySchema = z
  .object({
    id: identifierSchema,
    parentEventId: identifierSchema,
    originalDate: localDateSchema,
    kind: z.enum(['cancelled', 'modified']),
    replacementEventId: identifierSchema.nullable(),
    createdAt: isoInstantSchema
  })
  .strict()

export const attachmentEntitySchema = z
  .object({
    id: identifierSchema,
    ownerKind: z.enum(['event', 'reminder', 'conversation', 'import-draft']),
    ownerId: identifierSchema,
    mediaType: z.string().min(1).max(200),
    displayName: z.string().min(1).max(500),
    localPathToken: identifierSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().nonnegative(),
    createdAt: isoInstantSchema
  })
  .strict()

export const conversationTurnEntitySchema = z
  .object({
    id: identifierSchema,
    conversationId: identifierSchema,
    role: z.enum(['user', 'assistant', 'system']),
    inputKind: z.enum(['text', 'voice', 'image', 'pdf', 'action']),
    text: z.string().max(50_000),
    requestId: identifierSchema.nullable(),
    createdAt: isoInstantSchema
  })
  .strict()

export const actionHistoryEntitySchema = z
  .object({
    id: identifierSchema,
    requestId: identifierSchema,
    transactionId: identifierSchema.nullable(),
    actor: z.enum(['manual', 'assistant', 'import']),
    operation: calendarOperationSchema,
    risk: riskLevelSchema,
    status: z.enum(['staged', 'confirmed', 'applied', 'undone', 'failed', 'rejected']),
    beforeStateJson: z.string().max(50_000_000),
    afterStateJson: z.string().max(50_000_000),
    reversible: z.boolean(),
    createdAt: isoInstantSchema,
    appliedAt: isoInstantSchema.nullable(),
    undoneAt: isoInstantSchema.nullable()
  })
  .strict()

export const assistantProfileSchema = z
  .object({
    preferredName: z.string().trim().max(80),
    customInstructions: z.string().trim().max(2_000),
    memoryEnabled: z.boolean(),
    memories: z.array(z.string().trim().min(1).max(500)).max(20)
  })
  .strict()

export const responsePreferenceEntrySchema = z
  .object({
    templateFingerprint: z.string().regex(/^[a-f0-9]{8}$/u),
    speechAct: responseSpeechActSchema,
    score: z.number().int().min(-3).max(3),
    updatedAt: isoInstantSchema
  })
  .strict()

export const responseAdaptationSchema = z
  .object({
    enabled: z.boolean(),
    feedbackCount: z.number().int().nonnegative().max(10_000),
    entries: z.array(responsePreferenceEntrySchema).max(64)
  })
  .strict()

export const themeColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const themePaletteSchema = z
  .object({
    backgroundColor: themeColorSchema,
    surfaceColor: themeColorSchema,
    cardColor: themeColorSchema,
    textColor: themeColorSchema,
    mutedTextColor: themeColorSchema,
    accentColor: themeColorSchema,
    borderColor: themeColorSchema
  })
  .strict()

export const savedThemeSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(32),
    palette: themePaletteSchema
  })
  .strict()

export const preferencesEntitySchema = z
  .object({
    id: z.literal('local'),
    themeId: identifierSchema,
    accentColor: themeColorSchema,
    backgroundColor: themeColorSchema.default('#f7f0e3'),
    surfaceColor: themeColorSchema.default('#fdfaf3'),
    cardColor: themeColorSchema.default('#ebd9c5'),
    textColor: themeColorSchema.default('#3c2f2f'),
    mutedTextColor: themeColorSchema.default('#6f5b50'),
    borderColor: themeColorSchema.default('#3c2f2f'),
    surfaceStyle: z.enum(['paper', 'frosted', 'liquid']).default('paper'),
    glassOpacity: z.number().int().min(0).max(100).default(78),
    glassBlur: z.number().int().min(0).max(48).default(26),
    glassSaturation: z.number().int().min(90).max(160).default(122),
    savedThemes: z.array(savedThemeSchema).max(8).default([]),
    density: z.enum(['comfortable', 'compact']),
    weekStartsOn: weekdaySchema,
    locale: localeSchema,
    timezone: ianaTimeZoneSchema,
    reduceMotion: z.boolean(),
    notificationsEnabled: z.boolean(),
    launchAtLogin: z.boolean().default(false),
    startupWindowMode: z.enum(['full', 'widget', 'glance']).default('glance'),
    privacyMode: z.literal('local-only'),
    responseStyle: responseStyleSchema,
    assistantProfile: assistantProfileSchema.default({
      preferredName: '',
      customInstructions: '',
      memoryEnabled: true,
      memories: []
    }),
    responseAdaptation: responseAdaptationSchema.default({
      enabled: true,
      feedbackCount: 0,
      entries: []
    }),
    updatedAt: isoInstantSchema
  })
  .strict()

export type CalendarEntity = z.infer<typeof calendarEntitySchema>
export type EventEntity = z.infer<typeof eventEntitySchema>
export type ReminderEntity = z.infer<typeof reminderEntitySchema>
export type RecurrenceExceptionEntity = z.infer<typeof recurrenceExceptionEntitySchema>
export type AttachmentEntity = z.infer<typeof attachmentEntitySchema>
export type ConversationTurnEntity = z.infer<typeof conversationTurnEntitySchema>
export type ActionHistoryEntity = z.infer<typeof actionHistoryEntitySchema>
export type AssistantProfile = z.infer<typeof assistantProfileSchema>
export type ResponsePreferenceEntry = z.infer<typeof responsePreferenceEntrySchema>
export type ResponseAdaptation = z.infer<typeof responseAdaptationSchema>
export type ThemePalette = z.infer<typeof themePaletteSchema>
export type SavedTheme = z.infer<typeof savedThemeSchema>
export type PreferencesEntity = z.infer<typeof preferencesEntitySchema>
