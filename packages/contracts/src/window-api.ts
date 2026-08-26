import { z } from 'zod'

export const appWindowModeSchema = z.enum(['full', 'widget', 'glance'])

export const appWindowStateSchema = z
  .object({
    mode: appWindowModeSchema,
    pinned: z.boolean(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
  .strict()

export const appWindowGetStateRequestSchema = z.object({}).strict()

export const appWindowSetModeRequestSchema = z.object({ mode: appWindowModeSchema }).strict()

export const appWindowSetPinnedRequestSchema = z.object({ pinned: z.boolean() }).strict()

export type AppWindowMode = z.infer<typeof appWindowModeSchema>
export type AppWindowState = z.infer<typeof appWindowStateSchema>
