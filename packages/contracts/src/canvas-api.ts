import { z } from 'zod'
import { calendarMutationResultSchema, calendarSnapshotRequestSchema } from './calendar-api'
import { identifierSchema, isoInstantSchema } from './common'

const canvasInstanceUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'https:' &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0
      )
    } catch {
      return false
    }
  }, 'Enter your Canvas site address, beginning with https://')

export const canvasConnectionStatusSchema = z
  .object({
    configured: z.boolean(),
    instanceUrl: canvasInstanceUrlSchema.nullable(),
    credentialStorageAvailable: z.boolean(),
    lastSyncedAt: isoInstantSchema.nullable(),
    lastError: z.string().max(1_000).nullable()
  })
  .strict()

export const canvasConnectRequestSchema = z
  .object({
    instanceUrl: canvasInstanceUrlSchema,
    accessToken: z.string().trim().min(1).max(4_096)
  })
  .strict()

export const canvasAssignmentImportKindSchema = z.enum(['reminder', 'all-day-event'])

export const canvasAssignmentSchema = z
  .object({
    sourceKey: identifierSchema,
    assignmentId: z.string().trim().min(1).max(128),
    courseId: z.string().trim().min(1).max(128),
    courseName: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(1_000),
    dueAtUtc: isoInstantSchema,
    description: z.string().max(10_000),
    pointsPossible: z.number().finite().nonnegative().nullable(),
    importKind: canvasAssignmentImportKindSchema.nullable()
  })
  .strict()

export const canvasAssignmentsResponseSchema = z
  .object({
    assignments: z.array(canvasAssignmentSchema).max(500),
    withoutDueDateCount: z.number().int().nonnegative(),
    fetchedAt: isoInstantSchema
  })
  .strict()

export const canvasImportAssignmentsRequestSchema = z
  .object({
    sourceKeys: z.array(identifierSchema).min(1).max(50),
    kind: canvasAssignmentImportKindSchema,
    range: calendarSnapshotRequestSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.sourceKeys).size !== request.sourceKeys.length) {
      context.addIssue({
        code: 'custom',
        message: 'Choose each Canvas assignment only once',
        path: ['sourceKeys']
      })
    }
  })

export const canvasImportAssignmentsResponseSchema = z
  .object({
    result: calendarMutationResultSchema,
    createdCount: z.number().int().nonnegative(),
    updatedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative()
  })
  .strict()

export const canvasDisconnectRequestSchema = z.object({}).strict()

export type CanvasConnectionStatus = z.infer<typeof canvasConnectionStatusSchema>
export type CanvasAssignment = z.infer<typeof canvasAssignmentSchema>
export type CanvasAssignmentImportKind = z.infer<typeof canvasAssignmentImportKindSchema>
export type CanvasAssignmentsResponse = z.infer<typeof canvasAssignmentsResponseSchema>
export type CanvasImportAssignmentsRequest = z.infer<typeof canvasImportAssignmentsRequestSchema>
export type CanvasImportAssignmentsResponse = z.infer<typeof canvasImportAssignmentsResponseSchema>
