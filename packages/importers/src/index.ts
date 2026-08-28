import type { CalendarIRDraft } from '@remind-me/contracts'

export * from './ics'
export * from './document-geometry'
export * from './document-text-layout'
export * from './document-planner'
export * from './document-repair'
export * from './document-fallback'
export * from './planscan'

export type ImportKind = 'ics' | 'pdf' | 'image' | 'audio'

export interface ImportSource {
  id: string
  kind: ImportKind
  displayName: string
  mediaType: string
  byteLength: number
}

export interface ImportDraft {
  id: string
  source: ImportSource
  page: number | null
  confidence: number
  proposal: CalendarIRDraft
}

export interface ImportAdapter {
  readonly kind: ImportKind
  extract: (source: ImportSource, signal: AbortSignal) => Promise<ImportDraft[]>
}
