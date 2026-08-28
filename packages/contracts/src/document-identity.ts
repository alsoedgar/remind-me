import { z } from 'zod'
import { identifierSchema, localDateSchema } from './common'
import { weekdaySchema } from './recurrence'

export const documentScheduleComponentSchema = z.enum([
  'lecture',
  'lecture-discussion',
  'laboratory',
  'laboratory-discussion',
  'discussion',
  'seminar',
  'studio',
  'clinical',
  'practicum',
  'primary-section',
  'linked-section',
  'class-meeting'
])

export const documentImportSourceIdentitySchema = z
  .object({
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceRowId: z.string().regex(/^row:[a-f0-9]{16}$/u)
  })
  .strict()

export const documentImportCourseIdentitySchema = z
  .object({
    courseCode: z.string().trim().min(1).max(80),
    sectionCode: z.string().trim().min(1).max(80).nullable(),
    crn: z.string().trim().min(1).max(80).nullable(),
    component: documentScheduleComponentSchema,
    termStartDate: localDateSchema,
    termEndDate: localDateSchema,
    weekdays: z.array(weekdaySchema).min(1).max(7)
  })
  .strict()
  .superRefine((course, context) => {
    if (new Set(course.weekdays).size !== course.weekdays.length) {
      context.addIssue({
        code: 'custom',
        message: 'Document import course weekdays must be unique',
        path: ['weekdays']
      })
    }
    if (course.termEndDate < course.termStartDate) {
      context.addIssue({
        code: 'custom',
        message: 'Document import course term end cannot precede its start',
        path: ['termEndDate']
      })
    }
  })

export const documentImportIdentitySchema = z
  .object({
    ...documentImportSourceIdentitySchema.shape,
    semanticKind: z.enum(['class-event', 'event', 'reminder']),
    semanticKey: z.string().regex(/^(?:class|event|reminder):[a-f0-9]{16}$/u),
    course: documentImportCourseIdentitySchema.nullable()
  })
  .strict()
  .superRefine((identity, context) => {
    if ((identity.semanticKind === 'class-event') !== (identity.course !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only class-event identities can contain course identity',
        path: ['course']
      })
    }
    const expectedPrefix = identity.semanticKind === 'class-event' ? 'class' : identity.semanticKind
    if (!identity.semanticKey.startsWith(`${expectedPrefix}:`)) {
      context.addIssue({
        code: 'custom',
        message: 'Document semantic key does not match its identity kind',
        path: ['semanticKey']
      })
    }
  })

export const documentReconciliationMatchSchema = z
  .object({
    entityKind: z.enum(['event', 'reminder']),
    entityId: identifierSchema,
    title: z.string().trim().min(1).max(1_000),
    detail: z.string().trim().min(1).max(500),
    relationship: z.enum([
      'same-source-row',
      'same-semantic-item',
      'likely-semantic-overlap',
      'protected-distinct-course'
    ])
  })
  .strict()

export const documentReconciliationSchema = z
  .object({
    state: z.enum(['new', 'same-source', 'likely-duplicate', 'protected-distinct']),
    recommendedSelected: z.boolean(),
    matches: z.array(documentReconciliationMatchSchema).max(5)
  })
  .strict()
  .superRefine((reconciliation, context) => {
    const relationships = new Set(reconciliation.matches.map((match) => match.relationship))
    if (reconciliation.state === 'new' && reconciliation.matches.length !== 0) {
      context.addIssue({ code: 'custom', message: 'New document items cannot contain matches' })
    }
    if (reconciliation.state === 'same-source' && !relationships.has('same-source-row')) {
      context.addIssue({
        code: 'custom',
        message: 'Same-source reconciliation requires a source-row match',
        path: ['matches']
      })
    }
    if (
      reconciliation.state === 'likely-duplicate' &&
      !relationships.has('same-semantic-item') &&
      !relationships.has('likely-semantic-overlap')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Likely duplicates require a semantic match',
        path: ['matches']
      })
    }
    if (
      reconciliation.state === 'protected-distinct' &&
      !relationships.has('protected-distinct-course')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Protected course items require a distinct-course match',
        path: ['matches']
      })
    }
    const expectedSelection =
      reconciliation.state === 'new' || reconciliation.state === 'protected-distinct'
    if (reconciliation.recommendedSelected !== expectedSelection) {
      context.addIssue({
        code: 'custom',
        message: 'Reconciliation selection recommendation is inconsistent with its state',
        path: ['recommendedSelected']
      })
    }
  })

export type DocumentScheduleComponent = z.infer<typeof documentScheduleComponentSchema>
export type DocumentImportSourceIdentity = z.infer<typeof documentImportSourceIdentitySchema>
export type DocumentImportCourseIdentity = z.infer<typeof documentImportCourseIdentitySchema>
export type DocumentImportIdentity = z.infer<typeof documentImportIdentitySchema>
export type DocumentReconciliationMatch = z.infer<typeof documentReconciliationMatchSchema>
export type DocumentReconciliation = z.infer<typeof documentReconciliationSchema>
